// Package config parses flags, each with an environment fallback.
package config

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the runtime configuration.
type Config struct {
	Listen         string
	RelayAddr      string
	Window         time.Duration
	Retention      time.Duration
	Tick           time.Duration
	SparkRate      int
	AllowedOrigins []string
	ExcludePods    []string
	Demo           bool
	DemoScale      int
	DemoSpeed      float64
	ReplayFile     string
	ReplaySpeed    float64
	ReplayLoop     bool
	LogLevel       string
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

// Parse reads args (without the program name).
func Parse(args []string) (*Config, error) {
	c := &Config{}
	fs := flag.NewFlagSet("flowscape", flag.ContinueOnError)
	var origins, exclude string
	fs.StringVar(&c.Listen, "listen", env("LISTEN_ADDR", ":8080"), "address to serve on (LISTEN_ADDR)")
	fs.StringVar(&c.RelayAddr, "hubble-relay-addr", env("HUBBLE_RELAY_ADDR", "hubble-relay.kube-system.svc.cluster.local:80"), "Hubble Relay gRPC address (HUBBLE_RELAY_ADDR)")
	fs.DurationVar(&c.Window, "window", envDuration("WINDOW", 60*time.Second), "default rate window and Relay warm-up (WINDOW)")
	fs.DurationVar(&c.Retention, "retention", envDuration("RETENTION", 300*time.Second), "history depth and idle expiry (RETENTION)")
	fs.DurationVar(&c.Tick, "tick", envDuration("TICK", 100*time.Millisecond), "WebSocket tick interval (TICK)")
	fs.IntVar(&c.SparkRate, "spark-rate", envInt("SPARK_RATE", 200), "sampled flow events per second sent to each client (SPARK_RATE)")
	fs.StringVar(&origins, "allowed-origins", env("ALLOWED_ORIGINS", "localhost:*,127.0.0.1:*"), "comma-separated WebSocket origin patterns (ALLOWED_ORIGINS)")
	fs.StringVar(&exclude, "exclude-pods", env("EXCLUDE_PODS", "kube-system/hubble-relay,kube-system/hubble-ui,flowscape/flowscape"), "comma-separated namespace/pod-prefix pairs to hide (EXCLUDE_PODS)")
	fs.BoolVar(&c.Demo, "demo", envBool("DEMO", false), "generate flows instead of reading Relay (DEMO)")
	fs.IntVar(&c.DemoScale, "demo-scale", envInt("DEMO_SCALE", 1), "replicate the demo topology N times (DEMO_SCALE)")
	fs.Float64Var(&c.DemoSpeed, "demo-speed", envFloat("DEMO_SPEED", 1), "multiply every demo rate (DEMO_SPEED)")
	fs.StringVar(&c.ReplayFile, "replay-file", env("REPLAY_FILE", ""), "replay a `hubble observe -o jsonpb` file (REPLAY_FILE)")
	fs.Float64Var(&c.ReplaySpeed, "replay-speed", envFloat("REPLAY_SPEED", 1), "replay pace, 0 = as fast as possible (REPLAY_SPEED)")
	fs.BoolVar(&c.ReplayLoop, "replay-loop", envBool("REPLAY_LOOP", true), "restart the replay at its end (REPLAY_LOOP)")
	fs.StringVar(&c.LogLevel, "log-level", env("LOG_LEVEL", "info"), "debug, info, warn or error (LOG_LEVEL)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	c.AllowedOrigins = split(origins)
	c.ExcludePods = split(exclude)
	if c.Demo && c.ReplayFile != "" {
		return nil, errors.New("--demo and --replay-file are mutually exclusive")
	}
	if c.Window > c.Retention {
		return nil, fmt.Errorf("window %s exceeds retention %s", c.Window, c.Retention)
	}
	return c, nil
}

func split(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Source names which flow source the config selects.
func (c *Config) Source() string {
	switch {
	case c.Demo:
		return "demo"
	case c.ReplayFile != "":
		return "replay"
	default:
		return "relay"
	}
}
