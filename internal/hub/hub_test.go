package hub

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/JanWelker/flowscape/internal/graph"
	"github.com/JanWelker/flowscape/internal/hubble"
	"github.com/JanWelker/flowscape/internal/hubble/fake"
	"github.com/JanWelker/flowscape/internal/metrics"
)

func TestHelloSnapshotTick(t *testing.T) {
	g := graph.New(time.Minute)
	st := &hubble.Status{}
	m := metrics.New("test")
	h := New(g, st, m, Options{Version: "test", SourceName: "demo", Tick: 20 * time.Millisecond, Window: 30 * time.Second, AllowedOrigins: []string{"*"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = h.Run(ctx) }()
	src := &fake.Source{Speed: 5, Status: st, Seed: 1}
	go func() { _ = src.Run(ctx, h) }()

	srv := httptest.NewServer(h)
	defer srv.Close()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil) //nolint:bodyclose // the library closes it
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow() //nolint:errcheck // test teardown
	conn.SetReadLimit(1 << 24)

	read := func() map[string]any {
		t.Helper()
		rctx, c := context.WithTimeout(ctx, 3*time.Second)
		defer c()
		_, data, err := conn.Read(rctx)
		if err != nil {
			t.Fatal(err)
		}
		var v map[string]any
		if err := json.Unmarshal(data, &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	if v := read(); v["t"] != "hello" || v["source"] != "demo" {
		t.Fatalf("first message %v", v)
	}
	if v := read(); v["t"] != "snapshot" {
		t.Fatalf("second message %v", v)
	}
	sawEdges := false
	for i := 0; i < 50 && !sawEdges; i++ {
		v := read()
		if v["t"] != "tick" {
			t.Fatalf("message %d = %v", i, v["t"])
		}
		if edges, ok := v["edges"].([]any); ok && len(edges) > 0 {
			sawEdges = true
			status := v["status"].(map[string]any)
			if status["clients"].(float64) != 1 || status["relay"] != "n/a" {
				t.Errorf("status = %v", status)
			}
		}
	}
	if !sawEdges {
		t.Fatal("no tick carried edges")
	}
}

func TestStalledClientIsResynced(t *testing.T) {
	g := graph.New(time.Minute)
	st := &hubble.Status{}
	m := metrics.New("test")
	h := New(g, st, m, Options{SourceName: "demo", Tick: 5 * time.Millisecond})
	c := &client{send: make(chan []byte, 1)}
	c.send <- []byte("stuck") // full: every offer fails
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	now := time.Now()
	for i := 0; i < resyncAfter; i++ {
		h.tick(now.Add(time.Duration(i) * h.opts.Tick))
	}
	if !c.resync || c.behind != resyncAfter {
		t.Fatalf("resync=%v behind=%d", c.resync, c.behind)
	}
	<-c.send // the client catches up
	h.tick(now.Add(time.Second))
	if c.resync {
		t.Fatal("resync flag not cleared after the snapshot was queued")
	}
	if !strings.Contains(string(<-c.send), `"t":"snapshot"`) {
		t.Fatal("client did not get a snapshot")
	}
}
