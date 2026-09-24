// Package relay streams flows from Hubble Relay over plaintext gRPC.
package relay

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"github.com/cilium/cilium/api/v1/observer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/JanWelker/flowscape/internal/hubble"
	"github.com/JanWelker/flowscape/internal/metrics"
)

// Client is a hubble.Source backed by Relay.
type Client struct {
	Addr        string
	Window      time.Duration
	ExcludePods []string
	Status      *hubble.Status
	Metrics     *metrics.Metrics
	Log         *slog.Logger

	// Dial is replaced in tests.
	Dial func(ctx context.Context) (observer.ObserverClient, io.Closer, error)
	// Sleep is replaced in tests.
	Sleep func(ctx context.Context, d time.Duration) error

	fieldMask bool
}

const (
	minBackoff = 500 * time.Millisecond
	maxBackoff = 30 * time.Second
	healthy    = 60 * time.Second
)

// Name implements hubble.Source.
func (c *Client) Name() string { return "relay" }

var fieldMaskPaths = []string{
	"time", "verdict", "drop_reason_desc", "traffic_direction", "event_type", "is_reply",
	"IP", "l4", "l7", "source", "destination", "destination_names", "source_names", "node_name",
}

func (c *Client) request(since time.Time) *observer.GetFlowsRequest {
	req := &observer.GetFlowsRequest{
		Follow: true,
		Since:  timestamppb.New(since),
		Blacklist: []*flow.FlowFilter{
			{Reply: []bool{true}},
		},
	}
	if len(c.ExcludePods) > 0 {
		req.Blacklist = append(req.Blacklist,
			&flow.FlowFilter{SourcePod: c.ExcludePods},
			&flow.FlowFilter{DestinationPod: c.ExcludePods})
	}
	if c.fieldMask {
		req.FieldMask = &fieldmaskpb.FieldMask{Paths: fieldMaskPaths}
	}
	return req
}

func (c *Client) dial(ctx context.Context) (observer.ObserverClient, io.Closer, error) {
	if c.Dial != nil {
		return c.Dial(ctx)
	}
	conn, err := grpc.NewClient(c.Addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, err
	}
	return observer.NewObserverClient(conn), conn, nil
}

func (c *Client) sleep(ctx context.Context, d time.Duration) error {
	if c.Sleep != nil {
		return c.Sleep(ctx, d)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// Run implements hubble.Source. It reconnects forever with exponential
// backoff and resumes from the last flow seen.
func (c *Client) Run(ctx context.Context, sink hubble.Sink) error {
	if c.Log == nil {
		c.Log = slog.Default()
	}
	c.fieldMask = true
	client, closer, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = closer.Close() }()

	since := time.Now().Add(-c.Window)
	backoff := minBackoff
	for {
		started := time.Now()
		err := c.stream(ctx, client, sink, &since)
		c.setConnected(false)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if status.Code(err) == codes.InvalidArgument && c.fieldMask {
			c.Log.Warn("relay rejected the field mask, retrying without it", "err", err)
			c.fieldMask = false
			continue
		}
		if time.Since(started) > healthy {
			backoff = minBackoff
		}
		c.Log.Warn("relay stream ended", "err", err, "retry_in", backoff)
		if c.Metrics != nil {
			c.Metrics.RelayReconnects.Inc()
		}
		jitter := time.Duration(rand.Int64N(int64(backoff / 4)))
		if err := c.sleep(ctx, backoff+jitter); err != nil {
			return err
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (c *Client) setConnected(v bool) {
	if c.Status != nil {
		c.Status.SetConnected(v)
	}
	if c.Metrics != nil {
		if v {
			c.Metrics.RelayConnected.Set(1)
		} else {
			c.Metrics.RelayConnected.Set(0)
		}
	}
}

func (c *Client) stream(ctx context.Context, client observer.ObserverClient, sink hubble.Sink, since *time.Time) error {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := client.GetFlows(sctx, c.request(*since))
	if err != nil {
		return err
	}
	watchdog := 2 * c.Window
	if watchdog < 30*time.Second {
		watchdog = 30 * time.Second
	}
	timer := time.AfterFunc(watchdog, func() {
		c.Log.Warn("no message from relay, reconnecting", "after", watchdog)
		cancel()
	})
	defer timer.Stop()
	connected := false
	for {
		resp, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("relay closed the stream")
			}
			return err
		}
		timer.Reset(watchdog)
		if !connected {
			connected = true
			c.setConnected(true)
			c.Log.Info("relay stream open", "addr", c.Addr, "since", since.Format(time.RFC3339))
		}
		switch r := resp.GetResponseTypes().(type) {
		case *observer.GetFlowsResponse_Flow:
			if t := r.Flow.GetTime().AsTime(); t.After(*since) {
				*since = t
			}
			sink.Flow(r.Flow)
		case *observer.GetFlowsResponse_NodeStatus:
			sink.NodeStatus(r.NodeStatus)
		case *observer.GetFlowsResponse_LostEvents:
			sink.Lost(r.LostEvents)
		}
	}
}
