// Package replay reads flows captured with `hubble observe -o jsonpb`, one
// GetFlowsResponse per line, and plays them back with their original pacing
// shifted to the present.
package replay

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/cilium/cilium/api/v1/observer"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/JanWelker/flowscape/internal/hubble"
)

// Source replays a file.
type Source struct {
	Path   string
	Speed  float64 // 1 = real time, 0 = as fast as possible
	Loop   bool
	Status *hubble.Status
}

// Name implements hubble.Source.
func (s *Source) Name() string { return "replay" }

var unmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}

// Decode parses one line.
func Decode(line []byte) (*observer.GetFlowsResponse, error) {
	var resp observer.GetFlowsResponse
	if err := unmarshal.Unmarshal(line, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// ReadAll parses a whole file; used by tests.
func ReadAll(r io.Reader) ([]*observer.GetFlowsResponse, error) {
	var out []*observer.GetFlowsResponse
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	n := 0
	for sc.Scan() {
		n++
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		resp, err := Decode(line)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", n, err)
		}
		out = append(out, resp)
	}
	return out, sc.Err()
}

// Run implements hubble.Source.
func (s *Source) Run(ctx context.Context, sink hubble.Sink) error {
	for {
		if err := s.once(ctx, sink); err != nil {
			return err
		}
		if !s.Loop {
			<-ctx.Done()
			return ctx.Err()
		}
	}
}

func (s *Source) once(ctx context.Context, sink hubble.Sink) error {
	f, err := os.Open(s.Path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if s.Status != nil {
		s.Status.SetConnected(true)
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	var first, start time.Time
	n := 0
	for sc.Scan() {
		n++
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		resp, err := Decode(line)
		if err != nil {
			return fmt.Errorf("%s line %d: %w", s.Path, n, err)
		}
		fl := resp.GetFlow()
		if fl == nil {
			if ns := resp.GetNodeStatus(); ns != nil {
				sink.NodeStatus(ns)
			}
			if lost := resp.GetLostEvents(); lost != nil {
				sink.Lost(lost)
			}
			continue
		}
		t := fl.GetTime().AsTime()
		if first.IsZero() {
			first, start = t, time.Now()
		}
		offset := t.Sub(first)
		if s.Speed > 0 {
			offset = time.Duration(float64(offset) / s.Speed)
			if wait := time.Until(start.Add(offset)); wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}
		fl.Time = timestamppb.New(start.Add(offset))
		sink.Flow(fl)
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
