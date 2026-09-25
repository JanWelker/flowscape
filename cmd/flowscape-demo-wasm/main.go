//go:build js && wasm

// Command flowscape-demo-wasm runs the demo source and the graph inside the
// browser, so the GitHub Pages demo is the same code as the server, minus
// the WebSocket: ticks go straight to a JavaScript callback.
package main

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"sync"
	"syscall/js"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"github.com/cilium/cilium/api/v1/relay"

	"github.com/JanWelker/flowscape/internal/graph"
	"github.com/JanWelker/flowscape/internal/hubble"
	"github.com/JanWelker/flowscape/internal/hubble/fake"
	"github.com/JanWelker/flowscape/internal/protocol"
)

// version is set by the linker.
var version = "dev"

const (
	tick      = 100 * time.Millisecond
	window    = 60 * time.Second
	retention = 300 * time.Second
	sparkRate = 200
)

type sink struct {
	g      *graph.Graph
	mu     sync.Mutex
	sparks []protocol.Spark
	flows  uint64
}

func (s *sink) Flow(f *flow.Flow) {
	r := s.g.Ingest(f)
	if r.Skipped != "" {
		return
	}
	s.mu.Lock()
	s.flows++
	if len(s.sparks) < 4096 {
		s.sparks = append(s.sparks, protocol.Spark{E: r.EdgeID, V: r.Verdict})
	} else if r.Verdict != protocol.VerdictForwarded {
		s.sparks[rand.IntN(len(s.sparks))] = protocol.Spark{E: r.EdgeID, V: r.Verdict}
	}
	s.mu.Unlock()
}

func (s *sink) NodeStatus(*relay.NodeStatusEvent) {}
func (s *sink) Lost(*flow.LostEvent)              {}

func main() {
	js.Global().Set("flowscapeDemoStart", js.FuncOf(start))
	select {}
}

// start(callback, scale, speed) begins the stream; callback receives one
// JSON message at a time, the same messages the WebSocket would carry.
func start(_ js.Value, args []js.Value) any {
	cb := args[0]
	scale, speed := 1, 1.0
	if len(args) > 1 && !args[1].IsUndefined() {
		scale = args[1].Int()
	}
	if len(args) > 2 && !args[2].IsUndefined() {
		speed = args[2].Float()
	}
	go run(cb, scale, speed)
	return nil
}

func run(cb js.Value, scale int, speed float64) {
	send := func(v any) {
		b, err := json.Marshal(v)
		if err != nil {
			return
		}
		cb.Invoke(string(b))
	}
	g := graph.New(retention)
	st := &hubble.Status{}
	s := &sink{g: g}
	src := &fake.Source{Scale: scale, Speed: speed, Status: st, Seed: uint64(time.Now().UnixNano())}
	go func() { _ = src.Run(context.Background(), s) }()

	send(protocol.Hello{T: "hello", Version: version, Source: "demo", RetentionS: int(retention.Seconds()),
		WindowS: int(window.Seconds()), TickMs: int(tick.Milliseconds()), ServerTime: time.Now().UnixMilli()})
	send(g.Snapshot(time.Now()))

	var last uint64
	lastAt := time.Now()
	rate := 0.0
	budget := int(sparkRate * tick.Seconds())
	for now := range time.Tick(tick) {
		t := g.Tick(now)
		s.mu.Lock()
		total := s.flows
		sparks := s.sparks
		s.sparks = nil
		s.mu.Unlock()
		if dt := now.Sub(lastAt).Seconds(); dt > 0 {
			rate += (float64(total-last)/dt - rate) * 0.2
		}
		last, lastAt = total, now
		if len(sparks) > budget {
			kept := sparks[:0:0]
			var rest []protocol.Spark
			for _, sp := range sparks {
				if sp.V != protocol.VerdictForwarded && len(kept) < budget {
					kept = append(kept, sp)
				} else {
					rest = append(rest, sp)
				}
			}
			rand.Shuffle(len(rest), func(i, j int) { rest[i], rest[j] = rest[j], rest[i] })
			if room := budget - len(kept); room > 0 && room < len(rest) {
				rest = rest[:room]
			} else if room <= 0 {
				rest = nil
			}
			sparks = append(kept, rest...)
		}
		t.Sparks = sparks
		t.Status = protocol.Status{Source: "demo", Relay: "n/a", FlowsPerS: rate, Clients: 1}
		send(t)
	}
}
