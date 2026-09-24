package graph

import (
	"strconv"
	"strings"

	"github.com/cilium/cilium/api/v1/flow"
)

// NodeKey identifies a workload, a pod without a known workload, or a
// reserved entity such as world or kube-apiserver.
type NodeKey struct {
	Namespace string
	Kind      string
	Name      string
}

// ReservedNamespace is the pseudo namespace of reserved identities.
const ReservedNamespace = "reserved"

// ID is the stable string id used on the wire.
func (k NodeKey) ID() string { return k.Namespace + "/" + k.Kind + "/" + k.Name }

// EdgeKey identifies a directed conversation on one protocol and port.
type EdgeKey struct {
	Src   NodeKey
	Dst   NodeKey
	Proto string
	Port  uint32
}

// ID is the stable string id used on the wire.
func (k EdgeKey) ID() string {
	return k.Src.ID() + "|" + k.Dst.ID() + "|" + k.Proto + "|" + strconv.FormatUint(uint64(k.Port), 10)
}

// workloadKinds that Cilium reports and the display kind they collapse to.
var workloadKinds = map[string]string{
	"Deployment":  "Deployment",
	"StatefulSet": "StatefulSet",
	"DaemonSet":   "DaemonSet",
	"Job":         "Job",
	"CronJob":     "CronJob",
	"ReplicaSet":  "Deployment",
	"Cluster":     "Cluster",
	"Pod":         "Pod",
}

// endpointKey derives the node for one side of a flow. names are the DNS
// names Hubble resolved for that side, ip its address.
func endpointKey(ep *flow.Endpoint, names []string, ip string) NodeKey {
	if ep == nil {
		return NodeKey{"unknown", "ip", ip}
	}
	if ep.GetNamespace() != "" {
		if wl := ep.GetWorkloads(); len(wl) > 0 && wl[0].GetName() != "" {
			kind := workloadKinds[wl[0].GetKind()]
			name := wl[0].GetName()
			if kind == "" {
				kind = wl[0].GetKind()
			}
			if wl[0].GetKind() == "ReplicaSet" {
				name = stripHash(name)
			}
			return NodeKey{ep.GetNamespace(), kind, name}
		}
		if ep.GetPodName() != "" {
			return NodeKey{ep.GetNamespace(), "Pod", ep.GetPodName()}
		}
		return NodeKey{ep.GetNamespace(), "Namespace", ep.GetNamespace()}
	}
	var cidr, reserved string
	for _, l := range ep.GetLabels() {
		switch {
		case strings.HasPrefix(l, "reserved:"):
			reserved = strings.TrimPrefix(l, "reserved:")
		case strings.HasPrefix(l, "cidr:"):
			cidr = strings.TrimPrefix(l, "cidr:")
		}
	}
	switch reserved {
	case "":
		if cidr != "" {
			return NodeKey{ReservedNamespace, "world", cidr}
		}
	case "world", "world-ipv4", "world-ipv6":
		name := "world"
		if len(names) > 0 {
			name = names[0]
		} else if cidr != "" {
			name = cidr
		}
		return NodeKey{ReservedNamespace, "world", name}
	default:
		return NodeKey{ReservedNamespace, reserved, reserved}
	}
	return NodeKey{"unknown", "ip", ip}
}

// stripHash removes the pod-template hash from a ReplicaSet name.
func stripHash(name string) string {
	i := strings.LastIndex(name, "-")
	if i <= 0 {
		return name
	}
	suffix := name[i+1:]
	if len(suffix) < 5 || len(suffix) > 10 {
		return name
	}
	for _, c := range suffix {
		if (c < '0' || c > '9') && (c < 'a' || c > 'z') {
			return name
		}
	}
	return name[:i]
}

// l4Key returns the protocol name and destination port (ICMP type for ICMP).
func l4Key(l4 *flow.Layer4) (string, uint32) {
	switch p := l4.GetProtocol().(type) {
	case *flow.Layer4_TCP:
		return "TCP", p.TCP.GetDestinationPort()
	case *flow.Layer4_UDP:
		return "UDP", p.UDP.GetDestinationPort()
	case *flow.Layer4_SCTP:
		return "SCTP", p.SCTP.GetDestinationPort()
	case *flow.Layer4_ICMPv4:
		return "ICMP", p.ICMPv4.GetType()
	case *flow.Layer4_ICMPv6:
		return "ICMP", p.ICMPv6.GetType()
	default:
		return "L3", 0
	}
}

// labelSubset keeps the labels worth showing in the UI.
func labelSubset(labels []string) map[string]string {
	var out map[string]string
	for _, l := range labels {
		l = strings.TrimPrefix(l, "k8s:")
		k, v, ok := strings.Cut(l, "=")
		if !ok || !strings.HasPrefix(k, "app.kubernetes.io/") {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[strings.TrimPrefix(k, "app.kubernetes.io/")] = v
	}
	return out
}
