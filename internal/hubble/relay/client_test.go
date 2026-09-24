package relay

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"github.com/cilium/cilium/api/v1/observer"
	"github.com/cilium/cilium/api/v1/relay"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/JanWelker/flowscape/internal/hubble"
)

type fakeStream struct {
	grpc.ClientStream
	ctx   context.Context
	items []*observer.GetFlowsResponse
	err   error
}

func (s *fakeStream) Recv() (*observer.GetFlowsResponse, error) {
	if len(s.items) == 0 {
		if s.err != nil {
			return nil, s.err
		}
		<-s.ctx.Done()
		return nil, s.ctx.Err()
	}
	it := s.items[0]
	s.items = s.items[1:]
	return it, nil
}

type fakeObserver struct {
	observer.ObserverClient
	mu       sync.Mutex
	requests []*observer.GetFlowsRequest
	plan     []*fakeStream
}

func (f *fakeObserver) GetFlows(ctx context.Context, in *observer.GetFlowsRequest, _ ...grpc.CallOption) (grpc.ServerStreamingClient[observer.GetFlowsResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, in)
	if len(f.plan) == 0 {
		return nil, status.Error(codes.Unavailable, "no plan")
	}
	s := f.plan[0]
	f.plan = f.plan[1:]
	s.ctx = ctx
	return s, nil
}

type nopCloser struct{}

func (nopCloser) Close() error { return nil }

type recSink struct {
	mu    sync.Mutex
	flows []*flow.Flow
	nodes []*relay.NodeStatusEvent
}

func (s *recSink) Flow(f *flow.Flow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flows = append(s.flows, f)
}
func (s *recSink) NodeStatus(ev *relay.NodeStatusEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes = append(s.nodes, ev)
}
func (s *recSink) Lost(*flow.LostEvent) {}

func flowAt(t time.Time) *observer.GetFlowsResponse {
	return &observer.GetFlowsResponse{ResponseTypes: &observer.GetFlowsResponse_Flow{Flow: &flow.Flow{Time: timestamppb.New(t)}}}
}

func TestReconnectResumesFromLastFlow(t *testing.T) {
	t0 := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	obs := &fakeObserver{plan: []*fakeStream{
		{items: []*observer.GetFlowsResponse{flowAt(t0), flowAt(t0.Add(time.Second)),
			{ResponseTypes: &observer.GetFlowsResponse_NodeStatus{NodeStatus: &relay.NodeStatusEvent{StateChange: relay.NodeState_NODE_UNAVAILABLE, NodeNames: []string{"w3"}}}}},
			err: status.Error(codes.Unavailable, "relay restarting")},
		{items: []*observer.GetFlowsResponse{flowAt(t0.Add(2 * time.Second))}, err: io.EOF},
		{items: []*observer.GetFlowsResponse{flowAt(t0.Add(3 * time.Second))}}, // then blocks until ctx is cancelled
	}}
	var slept []time.Duration
	st := &hubble.Status{}
	c := &Client{Addr: "test", Window: time.Minute, ExcludePods: []string{"kube-system/hubble-relay"}, Status: st,
		Dial: func(context.Context) (observer.ObserverClient, io.Closer, error) { return obs, nopCloser{}, nil },
		Sleep: func(ctx context.Context, d time.Duration) error {
			slept = append(slept, d)
			return nil
		},
	}
	sink := &recSink{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx, sink) }()

	deadline := time.After(5 * time.Second)
	for {
		obs.mu.Lock()
		n := len(obs.requests)
		obs.mu.Unlock()
		if n == 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("saw %d requests, want 3", n)
		case <-time.After(10 * time.Millisecond):
		}
	}
	for i := 0; i < 100 && !st.Connected(); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if !st.Connected() {
		t.Error("status not connected after third stream delivered a flow")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v", err)
	}
	if len(sink.flows) != 4 || len(sink.nodes) != 1 {
		t.Fatalf("sink got %d flows %d node events", len(sink.flows), len(sink.nodes))
	}
	if got := obs.requests[1].GetSince().AsTime(); !got.Equal(t0.Add(time.Second)) {
		t.Errorf("second request since = %v, want %v", got, t0.Add(time.Second))
	}
	if got := obs.requests[2].GetSince().AsTime(); !got.Equal(t0.Add(2 * time.Second)) {
		t.Errorf("third request since = %v", got)
	}
	if len(slept) != 2 || slept[0] < minBackoff || slept[1] < 2*minBackoff {
		t.Errorf("backoff sleeps = %v", slept)
	}
	req := obs.requests[0]
	if !req.GetFollow() || len(req.GetBlacklist()) != 3 || req.GetFieldMask() == nil {
		t.Errorf("request = %v", req)
	}
}
