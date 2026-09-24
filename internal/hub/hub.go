// Package hub ingests flows into the graph and fans ticks out to browsers.
package hub

import (
	"context"
	"encoding/json"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"github.com/cilium/cilium/api/v1/relay"
	"github.com/coder/websocket"

	"github.com/JanWelker/flowscape/internal/graph"
	"github.com/JanWelker/flowscape/internal/hubble"
	"github.com/JanWelker/flowscape/internal/metrics"
	"github.com/JanWelker/flowscape/internal/protocol"
)

// Options configure a Hub.
type Options struct {
	Version        string
	SourceName     string
	Tick           time.Duration
	Window         time.Duration
	SparkRate      int // sparks per second per client
	AllowedOrigins []string
	Log            *slog.Logger
}

const (
	sendQueue    = 32
	resyncAfter  = 8
	sparkBacklog = 4096
)

// Hub implements hubble.Sink and serves /ws.
type Hub struct {
	opts   Options
	g      *graph.Graph
	status *hubble.Status
	m      *metrics.Metrics
	log    *slog.Logger

	mu      sync.Mutex
	clients map[*client]struct{}
	sparks  []protocol.Spark
	ready   atomic.Bool

	flows     atomic.Uint64
	lastFlows uint64
	lastTick  time.Time
	rate      float64
}

type client struct {
	send   chan []byte
	behind int
	resync bool
}

// New wires a hub to a graph.
func New(g *graph.Graph, status *hubble.Status, m *metrics.Metrics, opts Options) *Hub {
	if opts.Tick <= 0 {
		opts.Tick = 100 * time.Millisecond
	}
	if opts.SparkRate <= 0 {
		opts.SparkRate = 200
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Hub{opts: opts, g: g, status: status, m: m, log: opts.Log, clients: map[*client]struct{}{}}
}

// SetReady marks the source as started.
func (h *Hub) SetReady(v bool) { h.ready.Store(v) }

// Ready reports whether the source goroutine is running.
func (h *Hub) Ready() bool { return h.ready.Load() }

// Flow implements hubble.Sink.
func (h *Hub) Flow(f *flow.Flow) {
	r := h.g.Ingest(f)
	if r.Skipped != "" {
		h.m.FlowsSkipped.WithLabelValues(r.Skipped).Inc()
		return
	}
	h.flows.Add(1)
	h.m.FlowsReceived.WithLabelValues(verdictName(r.Verdict)).Inc()
	h.mu.Lock()
	if len(h.sparks) < sparkBacklog {
		h.sparks = append(h.sparks, protocol.Spark{E: r.EdgeID, V: r.Verdict})
	} else if r.Verdict != protocol.VerdictForwarded {
		// Keep the rare verdicts when the backlog is full.
		h.sparks[rand.IntN(sparkBacklog)] = protocol.Spark{E: r.EdgeID, V: r.Verdict}
	}
	h.mu.Unlock()
}

func verdictName(v uint8) string {
	switch v {
	case protocol.VerdictDropped:
		return "dropped"
	case protocol.VerdictAudit:
		return "audit"
	case protocol.VerdictError:
		return "error"
	default:
		return "forwarded"
	}
}

// NodeStatus implements hubble.Sink.
func (h *Hub) NodeStatus(ev *relay.NodeStatusEvent) {
	h.status.Apply(ev)
	h.m.RelayUnavailable.Set(float64(len(h.status.Unavailable())))
	h.log.Info("relay node status", "state", ev.GetStateChange().String(), "nodes", ev.GetNodeNames(), "message", ev.GetMessage())
}

// Lost implements hubble.Sink.
func (h *Hub) Lost(l *flow.LostEvent) {
	h.m.LostEvents.WithLabelValues(l.GetSource().String()).Add(float64(l.GetNumEventsLost()))
}

// Status is the current source status.
func (h *Hub) Status() protocol.Status {
	relayState := "connected"
	if !h.status.Connected() {
		relayState = "reconnecting"
	}
	if h.opts.SourceName != "relay" {
		relayState = "n/a"
	}
	h.mu.Lock()
	n := len(h.clients)
	rate := h.rate
	h.mu.Unlock()
	return protocol.Status{Source: h.opts.SourceName, Relay: relayState, Unavailable: h.status.Unavailable(), FlowsPerS: rate, Clients: n}
}

// Run drives the ticker until ctx ends.
func (h *Hub) Run(ctx context.Context) error {
	ticker := time.NewTicker(h.opts.Tick)
	defer ticker.Stop()
	h.lastTick = time.Now()
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for c := range h.clients {
				close(c.send)
				delete(h.clients, c)
			}
			h.mu.Unlock()
			return ctx.Err()
		case now := <-ticker.C:
			h.tick(now)
		}
	}
}

func (h *Hub) tick(now time.Time) {
	started := time.Now()
	t := h.g.Tick(now)
	nodes, edges := h.g.Size()
	h.m.GraphNodes.Set(float64(nodes))
	h.m.GraphEdges.Set(float64(edges))

	h.mu.Lock()
	total := h.flows.Load()
	if dt := now.Sub(h.lastTick).Seconds(); dt > 0 {
		inst := float64(total-h.lastFlows) / dt
		h.rate += (inst - h.rate) * 0.2
	}
	h.lastFlows, h.lastTick = total, now
	sparks := h.sparks
	h.sparks = nil
	budget := int(float64(h.opts.SparkRate) * h.opts.Tick.Seconds())
	if len(sparks) > budget {
		// Interesting verdicts first, then a uniform sample of the rest.
		kept := sparks[:0:0]
		var rest []protocol.Spark
		for _, s := range sparks {
			if s.V != protocol.VerdictForwarded && len(kept) < budget {
				kept = append(kept, s)
			} else {
				rest = append(rest, s)
			}
		}
		rand.Shuffle(len(rest), func(i, j int) { rest[i], rest[j] = rest[j], rest[i] })
		if room := budget - len(kept); room > 0 && room < len(rest) {
			rest = rest[:room]
		} else if room <= 0 {
			rest = nil
		}
		kept = append(kept, rest...)
		sparks = kept
	}
	t.Sparks = sparks
	t.Status = h.statusLocked()
	if len(h.clients) == 0 {
		h.mu.Unlock()
		h.m.TickDuration.Observe(time.Since(started).Seconds())
		return
	}
	msg, err := json.Marshal(t)
	if err != nil {
		h.mu.Unlock()
		h.log.Error("encode tick", "err", err)
		return
	}
	// Fan out under the lock: offers never block, and a handler that is
	// closing its channel does so under the same lock, so no send can race
	// the close.
	var snapshot []byte
	for c := range h.clients {
		if c.resync {
			if snapshot == nil {
				snapshot, _ = json.Marshal(h.g.Snapshot(now))
			}
			if h.offer(c, snapshot) {
				c.resync = false
				c.behind = 0
			}
			continue
		}
		if !h.offer(c, msg) {
			c.behind++
			h.m.WSDropped.Inc()
			if c.behind >= resyncAfter {
				c.resync = true
			}
		} else {
			c.behind = 0
		}
	}
	h.mu.Unlock()
	h.m.TickDuration.Observe(time.Since(started).Seconds())
}

func (h *Hub) statusLocked() protocol.Status {
	relayState := "connected"
	if !h.status.Connected() {
		relayState = "reconnecting"
	}
	if h.opts.SourceName != "relay" {
		relayState = "n/a"
	}
	return protocol.Status{Source: h.opts.SourceName, Relay: relayState, Unavailable: h.status.Unavailable(), FlowsPerS: h.rate, Clients: len(h.clients)}
}

func (h *Hub) offer(c *client, msg []byte) bool {
	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

// ServeHTTP upgrades /ws.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  h.opts.AllowedOrigins,
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		h.log.Warn("websocket accept", "err", err, "origin", r.Header.Get("Origin"))
		return
	}
	ctx := r.Context()
	c := &client{send: make(chan []byte, sendQueue)}

	hello, _ := json.Marshal(protocol.Hello{T: "hello", Version: h.opts.Version, Source: h.opts.SourceName,
		RetentionS: int(h.g.Retention().Seconds()), WindowS: int(h.opts.Window.Seconds()),
		TickMs: int(h.opts.Tick.Milliseconds()), ServerTime: time.Now().UnixMilli()})
	snapshot, _ := json.Marshal(h.g.Snapshot(time.Now()))
	c.send <- hello
	c.send <- snapshot

	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.m.WSClients.Set(float64(len(h.clients)))
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if _, ok := h.clients[c]; ok {
			delete(h.clients, c)
			close(c.send)
		}
		h.m.WSClients.Set(float64(len(h.clients)))
		h.mu.Unlock()
	}()

	readCtx := conn.CloseRead(ctx)
	for {
		select {
		case <-readCtx.Done():
			_ = conn.Close(websocket.StatusNormalClosure, "bye")
			return
		case msg, ok := <-c.send:
			if !ok {
				_ = conn.Close(websocket.StatusGoingAway, "shutdown")
				return
			}
			wctx, cancel := context.WithTimeout(readCtx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
