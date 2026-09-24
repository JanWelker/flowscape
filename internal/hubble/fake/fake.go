// Package fake synthesises flows for development without a cluster.
package fake

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/JanWelker/flowscape/internal/hubble"
)

// Source generates flows from the scripted topology.
type Source struct {
	Scale  int     // replicate every namespace this many times (1 = as is)
	Speed  float64 // multiplies every rate
	Status *hubble.Status
	Seed   uint64
}

// Name implements hubble.Source.
func (s *Source) Name() string { return "demo" }

type endpoint struct {
	ep    *flow.Endpoint
	ip    string
	names []string
}

type conv struct {
	conversation
	src, dst endpoint
	acc      float64
}

func (s *Source) build() []*conv {
	scale := s.Scale
	if scale < 1 {
		scale = 1
	}
	eps := map[string]endpoint{}
	identity := uint32(10000)
	for i, w := range workloads {
		for r := 1; r <= scale; r++ {
			ns := w.ns
			if r > 1 {
				ns = fmt.Sprintf("%s-%d", w.ns, r)
			}
			labels := []string{"k8s:io.kubernetes.pod.namespace=" + ns}
			for _, l := range w.labels {
				labels = append(labels, "k8s:"+l)
			}
			identity++
			pod := w.name + "-" + hash(uint64(i*31+r))
			if w.kind == "Cluster" || w.kind == "StatefulSet" {
				pod = w.name + "-1"
			}
			eps[fmt.Sprintf("%s/%s", ns, w.name)] = endpoint{
				ep: &flow.Endpoint{Identity: identity, Namespace: ns, PodName: pod, Labels: labels,
					Workloads: []*flow.Workload{{Name: w.name, Kind: w.kind}}},
				ip: fmt.Sprintf("10.244.%d.%d", (i/8+r)%250+1, i%250+2),
			}
		}
	}
	reservedIdentity := map[string]uint32{"host": 1, "world": 2, "remote-node": 6, "kube-apiserver": 7, "ingress": 8}
	for _, r := range reservedEndpoints {
		eps["reserved/"+r.name] = endpoint{ep: &flow.Endpoint{Identity: reservedIdentity[r.name], Labels: []string{"reserved:" + r.name}}, ip: r.ip}
	}
	world := func(name string) endpoint {
		e := endpoint{ep: &flow.Endpoint{Identity: 2, Labels: []string{"reserved:world"}}, ip: "203.0.113.7"}
		if strings.ContainsAny(name, "abcdefghijklmnopqrstuvwxyz") {
			e.names = []string{name}
		} else {
			e.ip = name
			e.ep.Labels = append(e.ep.Labels, "cidr:"+name+"/32")
		}
		return e
	}
	var out []*conv
	for r := 1; r <= scale; r++ {
		for _, c := range conversations {
			resolve := func(key string) endpoint {
				if strings.HasPrefix(key, "world/") {
					return world(strings.TrimPrefix(key, "world/"))
				}
				if r > 1 && !strings.HasPrefix(key, "reserved/") {
					ns, name, _ := strings.Cut(key, "/")
					key = fmt.Sprintf("%s-%d/%s", ns, r, name)
				}
				return eps[key]
			}
			out = append(out, &conv{conversation: c, src: resolve(c.src), dst: resolve(c.dst), acc: rand.Float64()})
		}
	}
	return out
}

func hash(n uint64) string {
	const alphabet = "bcdfghjklmnpqrstvwxz2456789"
	var b strings.Builder
	for i := 0; i < 9; i++ {
		b.WriteByte(alphabet[(n*2654435761+uint64(i)*97)%uint64(len(alphabet))])
		n /= 3
	}
	return b.String()
}

// Run implements hubble.Source.
func (s *Source) Run(ctx context.Context, sink hubble.Sink) error {
	rng := rand.New(rand.NewPCG(s.Seed, s.Seed^0x9e3779b97f4a7c15))
	convs := s.build()
	speed := s.Speed
	if speed <= 0 {
		speed = 1
	}
	if s.Status != nil {
		s.Status.SetConnected(true)
	}
	const step = 50 * time.Millisecond
	ticker := time.NewTicker(step)
	defer ticker.Stop()
	start := time.Now()
	var burst *conv
	burstUntil := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case now := <-ticker.C:
			elapsed := now.Sub(start).Seconds()
			// Every ~40s one conversation runs hot for 6s.
			if now.After(burstUntil) {
				if rng.Float64() < float64(step)/float64(40*time.Second) {
					burst = convs[rng.IntN(len(convs))]
					burstUntil = now.Add(6 * time.Second)
				} else {
					burst = nil
				}
			}
			// Every 3min a 10s policy storm: audit verdicts from cnpg to the databases.
			storm := math.Mod(elapsed, 180) < 10
			for _, c := range convs {
				rate := c.rate * speed
				if c == burst {
					rate *= 12
				}
				if storm && c.audit > 0 {
					rate *= 8
				}
				c.acc += rate * step.Seconds()
				for c.acc >= 1 {
					c.acc--
					sink.Flow(s.flow(rng, c, now, storm))
				}
			}
		}
	}
}

func (s *Source) flow(rng *rand.Rand, c *conv, now time.Time, storm bool) *flow.Flow {
	verdict := flow.Verdict_FORWARDED
	var drop flow.DropReason
	audit := c.audit
	if storm && audit > 0 {
		audit = 0.9
	}
	switch p := rng.Float64(); {
	case p < c.drop:
		verdict = flow.Verdict_DROPPED
		drop = flow.DropReason_POLICY_DENIED
		if c.dropReason != "" {
			drop = flow.DropReason(flow.DropReason_value[c.dropReason])
		}
	case p < c.drop+audit:
		verdict = flow.Verdict_AUDIT
	}
	f := &flow.Flow{
		Time:             timestamppb.New(now),
		Verdict:          verdict,
		DropReasonDesc:   drop,
		IP:               &flow.IP{Source: c.src.ip, Destination: c.dst.ip, IpVersion: flow.IPVersion_IPv4},
		Source:           c.src.ep,
		Destination:      c.dst.ep,
		DestinationNames: c.dst.names,
		Type:             flow.FlowType_L3_L4,
		NodeName:         nodeNames[rng.IntN(len(nodeNames))],
		IsReply:          wrapperspb.Bool(false),
		TrafficDirection: flow.TrafficDirection_EGRESS,
		EventType:        &flow.CiliumEventType{Type: 4, SubType: 3},
	}
	sport := uint32(32768 + rng.IntN(28000))
	switch c.proto {
	case "UDP":
		f.L4 = &flow.Layer4{Protocol: &flow.Layer4_UDP{UDP: &flow.UDP{SourcePort: sport, DestinationPort: c.port}}}
	case "ICMP":
		f.L4 = &flow.Layer4{Protocol: &flow.Layer4_ICMPv4{ICMPv4: &flow.ICMPv4{Type: c.port}}}
	default:
		f.L4 = &flow.Layer4{Protocol: &flow.Layer4_TCP{TCP: &flow.TCP{SourcePort: sport, DestinationPort: c.port}}}
	}
	if verdict == flow.Verdict_FORWARDED {
		switch {
		case len(c.http) > 0 && rng.Float64() < 0.5:
			method, path, _ := strings.Cut(c.http[rng.IntN(len(c.http))], " ")
			f.Type = flow.FlowType_L7
			f.EventType = &flow.CiliumEventType{Type: 129}
			f.L7 = &flow.Layer7{Type: flow.L7FlowType_REQUEST, LatencyNs: uint64(2e6 + rng.ExpFloat64()*30e6),
				Record: &flow.Layer7_Http{Http: &flow.HTTP{Method: method, Url: "http://" + c.dst.ep.GetPodName() + path, Protocol: "HTTP/1.1"}}}
		case c.dns != "":
			f.Type = flow.FlowType_L7
			f.EventType = &flow.CiliumEventType{Type: 129}
			f.L7 = &flow.Layer7{Type: flow.L7FlowType_REQUEST, Record: &flow.Layer7_Dns{Dns: &flow.DNS{Query: c.dns + "."}}}
		}
	}
	return f
}
