// Package metrics holds the Prometheus collectors.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

const ns = "flowscape"

// Metrics is the set of collectors, registered on Registry.
type Metrics struct {
	Registry *prometheus.Registry

	FlowsReceived    *prometheus.CounterVec
	FlowsSkipped     *prometheus.CounterVec
	RelayConnected   prometheus.Gauge
	RelayReconnects  prometheus.Counter
	RelayUnavailable prometheus.Gauge
	LostEvents       *prometheus.CounterVec
	GraphNodes       prometheus.Gauge
	GraphEdges       prometheus.Gauge
	WSClients        prometheus.Gauge
	WSDropped        prometheus.Counter
	TickDuration     prometheus.Histogram
}

// New builds and registers the collectors.
func New(version string) *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		Registry: reg,
		FlowsReceived: prometheus.NewCounterVec(prometheus.CounterOpts{Namespace: ns, Name: "flows_received_total",
			Help: "Flows ingested into the graph, by verdict."}, []string{"verdict"}),
		FlowsSkipped: prometheus.NewCounterVec(prometheus.CounterOpts{Namespace: ns, Name: "flows_skipped_total",
			Help: "Flows the graph ignored, by reason."}, []string{"reason"}),
		RelayConnected: prometheus.NewGauge(prometheus.GaugeOpts{Namespace: ns, Name: "relay_connected",
			Help: "1 while a GetFlows stream from Hubble Relay is open."}),
		RelayReconnects: prometheus.NewCounter(prometheus.CounterOpts{Namespace: ns, Name: "relay_reconnects_total",
			Help: "Times the Relay stream was reopened."}),
		RelayUnavailable: prometheus.NewGauge(prometheus.GaugeOpts{Namespace: ns, Name: "relay_unavailable_nodes",
			Help: "Nodes Relay reports as unavailable."}),
		LostEvents: prometheus.NewCounterVec(prometheus.CounterOpts{Namespace: ns, Name: "relay_lost_events_total",
			Help: "Events Hubble reports as lost, by source."}, []string{"source"}),
		GraphNodes: prometheus.NewGauge(prometheus.GaugeOpts{Namespace: ns, Name: "graph_nodes", Help: "Nodes in the graph."}),
		GraphEdges: prometheus.NewGauge(prometheus.GaugeOpts{Namespace: ns, Name: "graph_edges", Help: "Edges in the graph."}),
		WSClients:  prometheus.NewGauge(prometheus.GaugeOpts{Namespace: ns, Name: "ws_clients", Help: "Connected browsers."}),
		WSDropped: prometheus.NewCounter(prometheus.CounterOpts{Namespace: ns, Name: "ws_messages_dropped_total",
			Help: "Ticks dropped because a client could not keep up."}),
		TickDuration: prometheus.NewHistogram(prometheus.HistogramOpts{Namespace: ns, Name: "tick_duration_seconds",
			Help: "Time to build and fan out one tick.", Buckets: prometheus.ExponentialBuckets(0.0001, 4, 8)}),
	}
	build := prometheus.NewGauge(prometheus.GaugeOpts{Namespace: ns, Name: "build_info", Help: "Build version.",
		ConstLabels: prometheus.Labels{"version": version}})
	build.Set(1)
	reg.MustRegister(m.FlowsReceived, m.FlowsSkipped, m.RelayConnected, m.RelayReconnects, m.RelayUnavailable,
		m.LostEvents, m.GraphNodes, m.GraphEdges, m.WSClients, m.WSDropped, m.TickDuration, build,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}
