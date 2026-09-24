// Package httpserver serves the embedded frontend and the API.
package httpserver

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/JanWelker/flowscape/internal/graph"
	"github.com/JanWelker/flowscape/internal/hub"
)

// Handler builds the mux.
func Handler(h *hub.Hub, g *graph.Graph, reg *prometheus.Registry, dist fs.FS, version string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		nodes, edges := g.Size()
		writeJSON(w, map[string]any{
			"version": version, "status": h.Status(), "nodes": nodes, "edges": edges,
			"unknown_endpoints": g.Unknown(), "ready": h.Ready(),
		})
	})
	mux.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, g.Snapshot(time.Now()))
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if !h.Ready() {
			http.Error(w, "source not started", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	mux.Handle("/", static(dist))
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// static serves the Vite build: hashed assets immutable, everything else
// no-cache, unknown paths fall back to index.html for the SPA.
func static(dist fs.FS) http.Handler {
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if _, err := fs.Stat(dist, p); err != nil {
			if strings.Contains(r.Header.Get("Accept"), "text/html") {
				r.URL.Path = "/"
			} else {
				http.NotFound(w, r)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
}
