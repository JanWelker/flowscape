// Package graph aggregates Hubble flows into workloads and the conversations
// between them, keeps a short ring of per-second counters per conversation,
// and hands out snapshots and deltas for the WebSocket hub.
package graph

import (
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cilium/cilium/api/v1/flow"

	"github.com/JanWelker/flowscape/internal/protocol"
)

// Node is a vertex of the graph.
type Node struct {
	Key       NodeKey
	ID        string
	Labels    map[string]string
	FQDN      string
	FirstSeen time.Time
	LastSeen  time.Time
	edges     int
	// machines counts the cluster nodes this workload's pods were seen on;
	// Machine is the most frequent one.
	machines map[string]uint32
	Machine  string
}

// Edge is a directed conversation.
type Edge struct {
	Key      EdgeKey
	ID       string
	Counts   [4]uint64
	LastSeen time.Time
	drops    topCounter
	l7       l7Summary
	ring     ring
}

// Result of ingesting one flow.
type Result struct {
	EdgeID  string
	Verdict uint8
	Skipped string // non-empty when the flow was ignored, with the reason
}

// Graph is safe for concurrent use.
type Graph struct {
	mu        sync.Mutex
	retention time.Duration
	nodes     map[string]*Node
	edges     map[string]*Edge

	newNodes  map[string]*Node
	dirtyNode map[string]*Node
	dirty     map[string]*[4]uint64
	dirtyL7   map[string]bool
	goneNodes []string
	goneEdges []string
	unknown   uint64
	nodeIPs   map[string]string
}

// New returns an empty graph keeping retention seconds of history.
func New(retention time.Duration) *Graph {
	if retention < 10*time.Second {
		retention = 10 * time.Second
	}
	return &Graph{
		retention: retention,
		nodes:     map[string]*Node{},
		edges:     map[string]*Edge{},
		newNodes:  map[string]*Node{},
		dirtyNode: map[string]*Node{},
		dirty:     map[string]*[4]uint64{},
		dirtyL7:   map[string]bool{},
		nodeIPs:   map[string]string{},
	}
}

// Retention is the history depth.
func (g *Graph) Retention() time.Duration { return g.retention }

func verdictCode(v flow.Verdict) (uint8, bool) {
	switch v {
	case flow.Verdict_FORWARDED, flow.Verdict_REDIRECTED, flow.Verdict_TRACED, flow.Verdict_TRANSLATED:
		return protocol.VerdictForwarded, true
	case flow.Verdict_DROPPED:
		return protocol.VerdictDropped, true
	case flow.Verdict_AUDIT:
		return protocol.VerdictAudit, true
	case flow.Verdict_ERROR:
		return protocol.VerdictError, true
	default:
		return 0, false
	}
}

// Ingest adds one flow.
func (g *Graph) Ingest(f *flow.Flow) Result {
	if f.GetIsReply().GetValue() {
		return Result{Skipped: "reply"}
	}
	v, ok := verdictCode(f.GetVerdict())
	if !ok {
		return Result{Skipped: "verdict"}
	}
	t := f.GetTime().AsTime()
	if t.IsZero() {
		return Result{Skipped: "time"}
	}
	observer := f.GetNodeName()
	if i := strings.Index(observer, "/"); i >= 0 {
		observer = observer[i+1:] // cluster/node
	}
	proto, port := l4Key(f.GetL4())

	g.mu.Lock()
	defer g.mu.Unlock()
	src := endpointKey(f.GetSource(), f.GetSourceNames(), f.GetIP().GetSource(), observer, g.nodeIPs, g.retireAddress)
	dst := endpointKey(f.GetDestination(), f.GetDestinationNames(), f.GetIP().GetDestination(), observer, g.nodeIPs, g.retireAddress)
	if src == dst {
		return Result{Skipped: "self"}
	}
	ek := EdgeKey{Src: src, Dst: dst, Proto: proto, Port: port}
	if src.Namespace == "unknown" || dst.Namespace == "unknown" {
		g.unknown++
	}
	sn := g.touchNode(src, f.GetSource(), t, len(f.GetSourceNames()) > 0)
	dn := g.touchNode(dst, f.GetDestination(), t, len(f.GetDestinationNames()) > 0)
	// The agent that saw the flow runs on the source's machine for egress
	// and on the destination's for ingress.
	switch f.GetTrafficDirection() {
	case flow.TrafficDirection_EGRESS:
		g.placeOn(sn, observer)
	case flow.TrafficDirection_INGRESS:
		g.placeOn(dn, observer)
	}

	id := ek.ID()
	e, ok := g.edges[id]
	if !ok {
		e = &Edge{Key: ek, ID: id, ring: newRing(int(g.retention / time.Second))}
		g.edges[id] = e
		g.nodes[src.ID()].edges++
		g.nodes[dst.ID()].edges++
	}
	e.Counts[v]++
	if t.After(e.LastSeen) {
		e.LastSeen = t
	}
	e.ring.add(t.Unix(), v)
	if v == protocol.VerdictDropped && f.GetDropReasonDesc() != flow.DropReason_DROP_REASON_UNKNOWN {
		e.drops.add(f.GetDropReasonDesc().String())
	}
	if l7 := f.GetL7(); l7 != nil {
		e.l7.observe(l7)
		g.dirtyL7[id] = true
	}
	d := g.dirty[id]
	if d == nil {
		d = &[4]uint64{}
		g.dirty[id] = d
	}
	d[v]++
	return Result{EdgeID: id, Verdict: v}
}

func (g *Graph) touchNode(k NodeKey, ep *flow.Endpoint, t time.Time, fqdn bool) *Node {
	id := k.ID()
	n, ok := g.nodes[id]
	if !ok {
		n = &Node{Key: k, ID: id, FirstSeen: t, Labels: labelSubset(ep.GetLabels())}
		if fqdn {
			n.FQDN = k.Name
		}
		g.nodes[id] = n
		g.newNodes[id] = n
	}
	if t.After(n.LastSeen) {
		n.LastSeen = t
	}
	return n
}

// retireAddress drops the anchor a machine had while it was only known by
// address; its conversations reappear under the machine's name. Called
// with g.mu held.
func (g *Graph) retireAddress(ip string) {
	id := NodeKey{ReservedNamespace, "remote-node", ip}.ID()
	if _, ok := g.nodes[id]; !ok {
		return
	}
	for eid, e := range g.edges {
		if e.Key.Src.ID() != id && e.Key.Dst.ID() != id {
			continue
		}
		delete(g.edges, eid)
		delete(g.dirty, eid)
		delete(g.dirtyL7, eid)
		g.nodes[e.Key.Src.ID()].edges--
		g.nodes[e.Key.Dst.ID()].edges--
		g.goneEdges = append(g.goneEdges, eid)
	}
	delete(g.nodes, id)
	delete(g.dirtyNode, id)
	if _, fresh := g.newNodes[id]; fresh {
		delete(g.newNodes, id)
	} else {
		g.goneNodes = append(g.goneNodes, id)
	}
}

// placeOn records that a workload's pod runs on machine; a change of the
// most frequent machine is sent to the clients with the next tick.
func (g *Graph) placeOn(n *Node, machine string) {
	if machine == "" || n.Key.Namespace == ReservedNamespace || n.Key.Namespace == "unknown" {
		return
	}
	if n.machines == nil {
		n.machines = map[string]uint32{}
	}
	n.machines[machine]++
	if n.machines[machine] > n.machines[n.Machine] || n.Machine == "" {
		if n.Machine != machine {
			n.Machine = machine
			if _, fresh := g.newNodes[n.ID]; !fresh {
				g.dirtyNode[n.ID] = n
			}
		}
	}
}

// Unknown is the number of flows whose endpoint could not be classified.
func (g *Graph) Unknown() uint64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.unknown
}

// Size returns the node and edge counts.
func (g *Graph) Size() (nodes, edges int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.nodes), len(g.edges)
}

func nodeJSON(n *Node) protocol.Node {
	return protocol.Node{
		ID: n.ID, Ns: n.Key.Namespace, Kind: n.Key.Kind, Name: n.Key.Name, FQDN: n.FQDN, Machine: n.Machine,
		Labels: n.Labels, First: n.FirstSeen.UnixMilli(), Last: n.LastSeen.UnixMilli(),
	}
}

func (e *Edge) json(counts [4]uint64, withL7 bool) protocol.Edge {
	out := protocol.Edge{
		ID: e.ID, Src: e.Key.Src.ID(), Dst: e.Key.Dst.ID(), Proto: e.Key.Proto, Port: e.Key.Port,
		F: counts[0], D: counts[1], A: counts[2], E: counts[3], Last: e.LastSeen.UnixMilli(),
	}
	if withL7 {
		if e.l7.http != nil || e.l7.dns != nil || e.l7.status != 0 {
			out.L7 = &protocol.L7{HTTP: e.l7.http, DNS: e.l7.dns, Status: e.l7.status}
		}
		out.LatencyMs = e.l7.latency
		if len(e.drops) > 0 {
			out.Drops = e.drops
		}
	}
	return out
}

// Snapshot returns the whole graph with sparse buckets for the retention window.
func (g *Graph) Snapshot(now time.Time) protocol.Snapshot {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := protocol.Snapshot{T: "snapshot", Ts: now.UnixMilli(), Nodes: make([]protocol.Node, 0, len(g.nodes)), Edges: make([]protocol.Edge, 0, len(g.edges))}
	for _, n := range g.nodes {
		s.Nodes = append(s.Nodes, nodeJSON(n))
	}
	since := now.Add(-g.retention).Unix()
	for _, e := range g.edges {
		j := e.json(e.Counts, true)
		j.Buckets = e.ring.sparse(since)
		s.Edges = append(s.Edges, j)
	}
	sort.Slice(s.Nodes, func(i, j int) bool { return s.Nodes[i].ID < s.Nodes[j].ID })
	sort.Slice(s.Edges, func(i, j int) bool { return s.Edges[i].ID < s.Edges[j].ID })
	return s
}

// Tick expires idle edges and nodes, then returns everything that changed
// since the previous call. Ts, Sparks and Status are filled by the hub.
func (g *Graph) Tick(now time.Time) protocol.Tick {
	g.mu.Lock()
	defer g.mu.Unlock()
	cutoff := now.Add(-g.retention)
	for id, e := range g.edges {
		if e.LastSeen.Before(cutoff) {
			delete(g.edges, id)
			delete(g.dirty, id)
			delete(g.dirtyL7, id)
			g.nodes[e.Key.Src.ID()].edges--
			g.nodes[e.Key.Dst.ID()].edges--
			g.goneEdges = append(g.goneEdges, id)
		}
	}
	for id, n := range g.nodes {
		if n.edges <= 0 && n.LastSeen.Before(cutoff) {
			delete(g.nodes, id)
			delete(g.dirtyNode, id)
			if _, fresh := g.newNodes[id]; fresh {
				delete(g.newNodes, id)
				continue
			}
			g.goneNodes = append(g.goneNodes, id)
		}
	}

	t := protocol.Tick{T: "tick", Ts: now.UnixMilli()}
	for _, n := range g.newNodes {
		t.Nodes = append(t.Nodes, nodeJSON(n))
	}
	for id, n := range g.dirtyNode {
		if _, fresh := g.newNodes[id]; !fresh {
			t.Nodes = append(t.Nodes, nodeJSON(n))
		}
	}
	for id, d := range g.dirty {
		e := g.edges[id]
		if e == nil {
			continue
		}
		t.Edges = append(t.Edges, e.json(*d, g.dirtyL7[id]))
	}
	sort.Slice(t.Nodes, func(i, j int) bool { return t.Nodes[i].ID < t.Nodes[j].ID })
	sort.Slice(t.Edges, func(i, j int) bool { return t.Edges[i].ID < t.Edges[j].ID })
	t.Gone = protocol.Gone{Nodes: g.goneNodes, Edges: g.goneEdges}

	g.newNodes = map[string]*Node{}
	g.dirtyNode = map[string]*Node{}
	g.dirty = map[string]*[4]uint64{}
	g.dirtyL7 = map[string]bool{}
	g.goneNodes = nil
	g.goneEdges = nil
	return t
}
