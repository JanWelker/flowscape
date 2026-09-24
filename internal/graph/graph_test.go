package graph

import (
	"os"
	"testing"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/JanWelker/flowscape/internal/hubble/replay"
	"github.com/JanWelker/flowscape/internal/protocol"
)

func loadFixture(t *testing.T) []*flow.Flow {
	t.Helper()
	f, err := os.Open("testdata/flows-basic.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	resps, err := replay.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	var flows []*flow.Flow
	for _, r := range resps {
		if fl := r.GetFlow(); fl != nil {
			flows = append(flows, fl)
		}
	}
	if len(flows) != 17 {
		t.Fatalf("fixture has %d flows, want 17", len(flows))
	}
	return flows
}

func TestEndpointKey(t *testing.T) {
	cases := []struct {
		name  string
		ep    *flow.Endpoint
		names []string
		ip    string
		want  NodeKey
	}{
		{"deployment", &flow.Endpoint{Namespace: "a", PodName: "x-1", Workloads: []*flow.Workload{{Name: "x", Kind: "Deployment"}}}, nil, "", NodeKey{"a", "Deployment", "x"}},
		{"replicaset hash stripped", &flow.Endpoint{Namespace: "a", PodName: "x-5c8d-zz", Workloads: []*flow.Workload{{Name: "x-5c8d9f", Kind: "ReplicaSet"}}}, nil, "", NodeKey{"a", "Deployment", "x"}},
		{"pod only", &flow.Endpoint{Namespace: "a", PodName: "p"}, nil, "", NodeKey{"a", "Pod", "p"}},
		{"world fqdn", &flow.Endpoint{Labels: []string{"reserved:world"}}, []string{"github.com"}, "1.2.3.4", NodeKey{"reserved", "world", "github.com"}},
		{"world cidr", &flow.Endpoint{Labels: []string{"reserved:world", "cidr:10.9.0.0/16"}}, nil, "10.9.1.1", NodeKey{"reserved", "world", "10.9.0.0/16"}},
		{"world bare", &flow.Endpoint{Labels: []string{"reserved:world"}}, nil, "1.1.1.1", NodeKey{"reserved", "world", "world"}},
		{"apiserver", &flow.Endpoint{Labels: []string{"reserved:kube-apiserver"}}, nil, "", NodeKey{"reserved", "kube-apiserver", "kube-apiserver"}},
		{"unknown", &flow.Endpoint{}, nil, "9.9.9.9", NodeKey{"unknown", "ip", "9.9.9.9"}},
	}
	for _, c := range cases {
		if got := endpointKey(c.ep, c.names, c.ip); got != c.want {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
}

func TestPathPrefix(t *testing.T) {
	cases := map[string]string{
		"http://h/index.php/apps/files/?dir=/": "/index.php/apps/…",
		"/metrics":                             "/metrics",
		"/":                                    "/",
		"/a/b":                                 "/a/b",
		"http://h":                             "/",
	}
	for in, want := range cases {
		if got := pathPrefix(in); got != want {
			t.Errorf("pathPrefix(%q) = %q want %q", in, got, want)
		}
	}
}

func TestIngestFixture(t *testing.T) {
	flows := loadFixture(t)
	g := New(5 * time.Minute)
	var skipped []string
	for _, f := range flows[:16] {
		if r := g.Ingest(f); r.Skipped != "" {
			skipped = append(skipped, r.Skipped)
		}
	}
	if len(skipped) != 2 || skipped[0] != "reply" || skipped[1] != "reply" {
		t.Fatalf("skipped = %v, want two replies", skipped)
	}
	if g.Unknown() != 0 {
		t.Fatalf("unknown endpoints: %d", g.Unknown())
	}
	now := time.Date(2026, 9, 24, 10, 0, 13, 0, time.UTC)
	s := g.Snapshot(now)
	wantNodes := []string{
		"authentik/Deployment/authentik-server",
		"cnpg-system/Deployment/cnpg-controller-manager",
		"home-assistant/Deployment/home-assistant",
		"home-assistant/Pod/lonely-pod",
		"kube-system/Deployment/coredns",
		"monitoring/StatefulSet/prometheus-kube-prometheus-stack-prometheus",
		"nextcloud/Cluster/nextcloud-db",
		"nextcloud/Deployment/nextcloud",
		"reserved/host/host",
		"reserved/ingress/ingress",
		"reserved/kube-apiserver/kube-apiserver",
		"reserved/remote-node/remote-node",
		"reserved/world/github.com",
		"reserved/world/world",
	}
	if len(s.Nodes) != len(wantNodes) {
		t.Fatalf("got %d nodes, want %d: %+v", len(s.Nodes), len(wantNodes), ids(s.Nodes))
	}
	for i, n := range s.Nodes {
		if n.ID != wantNodes[i] {
			t.Errorf("node %d = %s want %s", i, n.ID, wantNodes[i])
		}
	}
	if len(s.Edges) != 13 {
		t.Fatalf("got %d edges: %+v", len(s.Edges), edgeIDs(s.Edges))
	}
	e := findEdge(t, s.Edges, "cnpg-system/Deployment/cnpg-controller-manager|nextcloud/Cluster/nextcloud-db|TCP|8000")
	if e.D != 1 || e.A != 1 || e.F != 0 {
		t.Errorf("cnpg edge counts f=%d d=%d a=%d", e.F, e.D, e.A)
	}
	if e.Drops["POLICY_DENIED"] != 1 {
		t.Errorf("drop reasons = %v", e.Drops)
	}
	if len(e.Buckets) != 2 {
		t.Errorf("buckets = %v", e.Buckets)
	}
	h := findEdge(t, s.Edges, "reserved/ingress/ingress|nextcloud/Deployment/nextcloud|TCP|80")
	if h.L7 == nil || h.L7.HTTP["GET /index.php/apps/…"] != 1 || h.LatencyMs != 12 {
		t.Errorf("http l7 = %+v latency=%v", h.L7, h.LatencyMs)
	}
	d := findEdge(t, s.Edges, "nextcloud/Deployment/nextcloud|kube-system/Deployment/coredns|UDP|53")
	if d.L7 == nil || d.L7.DNS["auth.k8s.wlkr.ch"] != 1 {
		t.Errorf("dns l7 = %+v", d.L7)
	}
	icmp := findEdge(t, s.Edges, "reserved/remote-node/remote-node|nextcloud/Deployment/nextcloud|ICMP|8")
	if icmp.F != 1 {
		t.Errorf("icmp edge = %+v", icmp)
	}
	lbl := findNode(t, s.Nodes, "nextcloud/Deployment/nextcloud")
	if lbl.Labels["name"] != "nextcloud" || lbl.Labels["component"] != "app" {
		t.Errorf("labels = %v", lbl.Labels)
	}
	if findNode(t, s.Nodes, "reserved/world/github.com").FQDN != "github.com" {
		t.Error("world fqdn not set")
	}
}

func TestTickDeltaAndExpiry(t *testing.T) {
	flows := loadFixture(t)
	g := New(5 * time.Minute)
	g.Ingest(flows[0])
	tk := g.Tick(time.Date(2026, 9, 24, 10, 0, 1, 0, time.UTC))
	if len(tk.Nodes) != 2 || len(tk.Edges) != 1 || tk.Edges[0].F != 1 {
		t.Fatalf("first tick = %+v", tk)
	}
	g.Ingest(flows[0])
	g.Ingest(flows[0])
	tk = g.Tick(time.Date(2026, 9, 24, 10, 0, 2, 0, time.UTC))
	if len(tk.Nodes) != 0 || len(tk.Edges) != 1 || tk.Edges[0].F != 2 {
		t.Fatalf("second tick = %+v", tk)
	}
	if tk.Edges[0].L7 != nil || tk.Edges[0].Drops != nil {
		t.Errorf("tick edge carries l7/drops without change: %+v", tk.Edges[0])
	}
	tk = g.Tick(time.Date(2026, 9, 24, 10, 0, 3, 0, time.UTC))
	if len(tk.Edges) != 0 || len(tk.Nodes) != 0 {
		t.Fatalf("idle tick not empty: %+v", tk)
	}
	// The last fixture flow is ten minutes later: everything before expires.
	g.Ingest(flows[16])
	tk = g.Tick(time.Date(2026, 9, 24, 10, 10, 1, 0, time.UTC))
	if len(tk.Gone.Edges) != 0 || len(tk.Gone.Nodes) != 0 {
		t.Fatalf("same edge refreshed but reported gone: %+v", tk.Gone)
	}
	fresh := proto.Clone(flows[2]).(*flow.Flow) // authentik -> nextcloud, re-stamped
	fresh.Time = timestamppb.New(time.Date(2026, 9, 24, 10, 10, 1, 0, time.UTC))
	g.Ingest(fresh)
	tk = g.Tick(time.Date(2026, 9, 24, 10, 10, 2, 0, time.UTC))
	if len(tk.Nodes) != 1 || tk.Nodes[0].ID != "authentik/Deployment/authentik-server" {
		t.Fatalf("new node = %+v", tk.Nodes)
	}
	tk = g.Tick(time.Date(2026, 9, 24, 10, 20, 0, 0, time.UTC))
	if len(tk.Gone.Edges) != 2 || len(tk.Gone.Nodes) != 3 {
		t.Fatalf("expiry: gone = %+v", tk.Gone)
	}
	if n, e := g.Size(); n != 0 || e != 0 {
		t.Fatalf("graph not empty after expiry: %d nodes %d edges", n, e)
	}
}

func TestRingSparse(t *testing.T) {
	r := newRing(10)
	r.add(100, protocol.VerdictForwarded)
	r.add(100, protocol.VerdictDropped)
	r.add(105, protocol.VerdictAudit)
	r.add(115, protocol.VerdictForwarded) // wraps onto slot 5, evicting 105
	got := r.sparse(105)
	want := []protocol.Bucket{{115, 1, 0, 0, 0}}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("sparse = %v want %v", got, want)
	}
	if got := r.sparse(90); len(got) != 2 {
		t.Fatalf("sparse(90) = %v", got)
	}
}

func ids(ns []protocol.Node) []string {
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = n.ID
	}
	return out
}

func edgeIDs(es []protocol.Edge) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.ID
	}
	return out
}

func findEdge(t *testing.T, es []protocol.Edge, id string) protocol.Edge {
	t.Helper()
	for _, e := range es {
		if e.ID == id {
			return e
		}
	}
	t.Fatalf("edge %s missing in %v", id, edgeIDs(es))
	return protocol.Edge{}
}

func findNode(t *testing.T, ns []protocol.Node, id string) protocol.Node {
	t.Helper()
	for _, n := range ns {
		if n.ID == id {
			return n
		}
	}
	t.Fatalf("node %s missing", id)
	return protocol.Node{}
}
