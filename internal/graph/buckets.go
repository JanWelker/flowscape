package graph

import (
	"sort"

	"github.com/JanWelker/flowscape/internal/protocol"
)

// ring holds one counter set per second for the retention window. A slot is
// reused lazily: it is zeroed when a flow lands in a second that maps to it
// but carries a different epoch.
type ring struct {
	epoch  []int64
	counts [][4]uint32
}

func newRing(seconds int) ring {
	return ring{epoch: make([]int64, seconds), counts: make([][4]uint32, seconds)}
}

func (r *ring) add(sec int64, v uint8) {
	i := int(sec % int64(len(r.epoch)))
	if r.epoch[i] != sec {
		r.epoch[i] = sec
		r.counts[i] = [4]uint32{}
	}
	r.counts[i][v]++
}

// sparse returns the non-empty slots newer than since, oldest first.
func (r *ring) sparse(since int64) []protocol.Bucket {
	var out []protocol.Bucket
	for i, sec := range r.epoch {
		if sec <= since {
			continue
		}
		c := r.counts[i]
		if c == [4]uint32{} {
			continue
		}
		out = append(out, protocol.Bucket{sec, int64(c[0]), int64(c[1]), int64(c[2]), int64(c[3])})
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out
}
