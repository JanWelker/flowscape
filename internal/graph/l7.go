package graph

import (
	"strings"

	"github.com/cilium/cilium/api/v1/flow"
)

const topN = 8

// topCounter is a bounded map: once it holds topN keys, anything new lands
// in "other".
type topCounter map[string]uint32

func (t *topCounter) add(key string) {
	if *t == nil {
		*t = topCounter{}
	}
	if _, ok := (*t)[key]; !ok && len(*t) >= topN {
		key = "other"
	}
	(*t)[key]++
}

// l7Summary is what the UI shows for proxied traffic.
type l7Summary struct {
	http    topCounter
	dns     topCounter
	status  uint32
	latency float64 // EWMA in ms
}

func (s *l7Summary) observe(l7 *flow.Layer7) {
	switch r := l7.GetRecord().(type) {
	case *flow.Layer7_Http:
		if l7.GetType() == flow.L7FlowType_RESPONSE {
			if r.Http.GetCode() != 0 {
				s.status = r.Http.GetCode()
			}
		} else {
			s.http.add(r.Http.GetMethod() + " " + pathPrefix(r.Http.GetUrl()))
		}
	case *flow.Layer7_Dns:
		if q := r.Dns.GetQuery(); q != "" {
			s.dns.add(strings.TrimSuffix(q, "."))
		}
	}
	if ns := l7.GetLatencyNs(); ns > 0 {
		ms := float64(ns) / 1e6
		if s.latency == 0 {
			s.latency = ms
		} else {
			s.latency += (ms - s.latency) * 0.2
		}
	}
}

// pathPrefix keeps the first two path segments of a URL, without query.
func pathPrefix(u string) string {
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
		if j := strings.Index(u, "/"); j >= 0 {
			u = u[j:]
		} else {
			u = "/"
		}
	}
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	parts := strings.SplitN(strings.TrimPrefix(u, "/"), "/", 3)
	switch len(parts) {
	case 0:
		return "/"
	case 1, 2:
		return "/" + strings.Join(parts, "/")
	default:
		return "/" + parts[0] + "/" + parts[1] + "/…"
	}
}
