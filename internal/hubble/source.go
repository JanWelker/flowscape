// Package hubble defines the contract between a flow source (Relay, replay
// file or demo generator) and the consumer.
package hubble

import (
	"context"
	"sort"
	"sync"

	"github.com/cilium/cilium/api/v1/flow"
	"github.com/cilium/cilium/api/v1/relay"
)

// Sink receives what a source produces.
type Sink interface {
	Flow(*flow.Flow)
	NodeStatus(*relay.NodeStatusEvent)
	Lost(*flow.LostEvent)
}

// Source streams flows until ctx ends.
type Source interface {
	Name() string
	Run(ctx context.Context, sink Sink) error
}

// Status is what the UI shows about the source. Sources update it.
type Status struct {
	mu          sync.Mutex
	connected   bool
	unavailable map[string]struct{}
}

// SetConnected records whether the source currently delivers flows.
func (s *Status) SetConnected(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.connected = v
}

// Connected reports whether the source currently delivers flows.
func (s *Status) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

// Apply folds a Relay node status event into the unavailable set.
func (s *Status) Apply(ev *relay.NodeStatusEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable == nil {
		s.unavailable = map[string]struct{}{}
	}
	for _, n := range ev.GetNodeNames() {
		switch ev.GetStateChange() {
		case relay.NodeState_NODE_UNAVAILABLE, relay.NodeState_NODE_ERROR:
			s.unavailable[n] = struct{}{}
		default:
			delete(s.unavailable, n)
		}
	}
}

// Unavailable lists nodes Relay cannot reach, sorted.
func (s *Status) Unavailable() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.unavailable))
	for n := range s.unavailable {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
