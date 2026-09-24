// Package protocol holds the JSON messages exchanged over the WebSocket.
// web/src/protocol.ts mirrors every type here; change both together.
package protocol

// Verdict codes as sent in sparks and used as bucket indexes.
const (
	VerdictForwarded uint8 = 0
	VerdictDropped   uint8 = 1
	VerdictAudit     uint8 = 2
	VerdictError     uint8 = 3
)

// Hello is the first message a client receives.
type Hello struct {
	T          string `json:"t"`
	Version    string `json:"version"`
	Source     string `json:"source"`
	RetentionS int    `json:"retention_s"`
	WindowS    int    `json:"window_s"`
	TickMs     int    `json:"tick_ms"`
	ServerTime int64  `json:"server_time"`
}

// Node is a workload, pod or reserved entity.
type Node struct {
	ID   string `json:"id"`
	Ns   string `json:"ns"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	FQDN string `json:"fqdn,omitempty"`
	// Machine is the cluster node the workload's pods run on, learned from
	// which agent observes its flows. Empty for reserved entities.
	Machine string            `json:"machine,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
	First   int64             `json:"first"`
	Last    int64             `json:"last"`
}

// Bucket is one second of counters: [unixSec, forwarded, dropped, audit, error].
type Bucket [5]int64

// L7 summarises the proxied requests seen on an edge.
type L7 struct {
	HTTP   map[string]uint32 `json:"http,omitempty"`
	DNS    map[string]uint32 `json:"dns,omitempty"`
	Status uint32            `json:"status,omitempty"`
}

// Edge is a directed src→dst conversation on one protocol and port.
// In a snapshot the counters are totals; in a tick they are increments
// since the previous tick.
type Edge struct {
	ID        string            `json:"id"`
	Src       string            `json:"src"`
	Dst       string            `json:"dst"`
	Proto     string            `json:"proto"`
	Port      uint32            `json:"port"`
	F         uint64            `json:"f"`
	D         uint64            `json:"d"`
	A         uint64            `json:"a"`
	E         uint64            `json:"e"`
	Last      int64             `json:"last"`
	LatencyMs float64           `json:"latency_ms,omitempty"`
	L7        *L7               `json:"l7,omitempty"`
	Drops     map[string]uint32 `json:"drops,omitempty"`
	Buckets   []Bucket          `json:"buckets,omitempty"`
}

// Snapshot is the whole graph, sent on connect and to a client that fell behind.
type Snapshot struct {
	T     string `json:"t"`
	Ts    int64  `json:"ts"`
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// Spark is one sampled flow event for the particle animation.
type Spark struct {
	E string `json:"e"`
	V uint8  `json:"v"`
}

// Gone lists ids expired since the previous tick.
type Gone struct {
	Nodes []string `json:"nodes,omitempty"`
	Edges []string `json:"edges,omitempty"`
}

// Status describes the flow source.
type Status struct {
	Source      string   `json:"source"`
	Relay       string   `json:"relay"`
	Unavailable []string `json:"unavailable,omitempty"`
	FlowsPerS   float64  `json:"flows_s"`
	Clients     int      `json:"clients"`
}

// Tick is the periodic delta.
type Tick struct {
	T      string  `json:"t"`
	Ts     int64   `json:"ts"`
	Nodes  []Node  `json:"nodes,omitempty"`
	Edges  []Edge  `json:"edges,omitempty"`
	Gone   Gone    `json:"gone"`
	Sparks []Spark `json:"sparks,omitempty"`
	Status Status  `json:"status"`
}
