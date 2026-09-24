// Command flowscape streams Hubble flows into a 3D map of the cluster.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/JanWelker/flowscape/internal/config"
	"github.com/JanWelker/flowscape/internal/graph"
	"github.com/JanWelker/flowscape/internal/httpserver"
	"github.com/JanWelker/flowscape/internal/hub"
	"github.com/JanWelker/flowscape/internal/hubble"
	"github.com/JanWelker/flowscape/internal/hubble/fake"
	"github.com/JanWelker/flowscape/internal/hubble/relay"
	"github.com/JanWelker/flowscape/internal/hubble/replay"
	"github.com/JanWelker/flowscape/internal/metrics"
	"github.com/JanWelker/flowscape/web"
)

// version is set by the linker.
var version = "dev"

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "flowscape:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		return err
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		return fmt.Errorf("log level: %w", err)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	m := metrics.New(version)
	g := graph.New(cfg.Retention)
	st := &hubble.Status{}
	var source hubble.Source
	switch cfg.Source() {
	case "demo":
		source = &fake.Source{Scale: cfg.DemoScale, Speed: cfg.DemoSpeed, Status: st, Seed: uint64(time.Now().UnixNano())}
	case "replay":
		source = &replay.Source{Path: cfg.ReplayFile, Speed: cfg.ReplaySpeed, Loop: cfg.ReplayLoop, Status: st}
	default:
		source = &relay.Client{Addr: cfg.RelayAddr, Window: cfg.Window, ExcludePods: cfg.ExcludePods, Status: st, Metrics: m, Log: log}
	}
	h := hub.New(g, st, m, hub.Options{
		Version: version, SourceName: source.Name(), Tick: cfg.Tick, Window: cfg.Window,
		SparkRate: cfg.SparkRate, AllowedOrigins: cfg.AllowedOrigins, Log: log,
	})
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           httpserver.Handler(h, g, m.Registry, dist, version),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	eg, ctx := errgroup.WithContext(ctx)
	eg.Go(func() error { return h.Run(ctx) })
	eg.Go(func() error {
		h.SetReady(true)
		err := source.Run(ctx, h)
		h.SetReady(false)
		return err
	})
	eg.Go(func() error {
		log.Info("listening", "addr", cfg.Listen, "source", source.Name(), "version", version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	eg.Go(func() error {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	})
	return eg.Wait()
}
