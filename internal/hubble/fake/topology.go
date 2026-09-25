package fake

// The demo topology mirrors what runs on the homelab cluster, so the demo
// looks like the real thing and the layout code is exercised on realistic
// namespace and workload counts.

type workload struct {
	ns, kind, name string
	labels         []string
}

type reserved struct {
	name string
	ip   string
}

type conversation struct {
	src, dst   string  // workload key "ns/name" or "reserved/name" or "world/<fqdn>"
	proto      string  // TCP, UDP, ICMP
	port       uint32  // destination port
	rate       float64 // events per second
	drop       float64 // share of DROPPED
	audit      float64 // share of AUDIT
	dropReason string
	http       []string // "METHOD /path" for L7 HTTP requests
	dns        string   // query name for L7 DNS
}

var workloads = []workload{
	{"nextcloud", "Deployment", "nextcloud", []string{"app.kubernetes.io/name=nextcloud", "app.kubernetes.io/component=app"}},
	{"nextcloud", "CronJob", "nextcloud-cron", []string{"app.kubernetes.io/name=nextcloud", "app.kubernetes.io/component=cron"}},
	{"nextcloud", "Cluster", "nextcloud-db", []string{"cnpg.io/cluster=nextcloud-db"}},
	{"home-assistant", "Deployment", "home-assistant", []string{"app.kubernetes.io/name=home-assistant"}},
	{"home-assistant", "Cluster", "home-assistant-db", []string{"cnpg.io/cluster=home-assistant-db"}},
	{"monitoring", "StatefulSet", "prometheus", []string{"app.kubernetes.io/name=prometheus"}},
	{"monitoring", "Deployment", "grafana", []string{"app.kubernetes.io/name=grafana"}},
	{"monitoring", "StatefulSet", "alertmanager", []string{"app.kubernetes.io/name=alertmanager"}},
	{"monitoring", "Deployment", "kube-state-metrics", []string{"app.kubernetes.io/name=kube-state-metrics"}},
	{"authentik", "Deployment", "authentik-server", []string{"app.kubernetes.io/name=authentik", "app.kubernetes.io/component=server"}},
	{"authentik", "Deployment", "authentik-worker", []string{"app.kubernetes.io/name=authentik", "app.kubernetes.io/component=worker"}},
	{"authentik", "StatefulSet", "authentik-postgresql", []string{"app.kubernetes.io/name=postgresql"}},
	{"kube-system", "Deployment", "coredns", []string{"k8s-app=kube-dns"}},
	{"kube-system", "Deployment", "hubble-relay", []string{"k8s-app=hubble-relay"}},
	{"kube-system", "Deployment", "hubble-ui", []string{"k8s-app=hubble-ui"}},
	{"kube-system", "Deployment", "metrics-server", []string{"app.kubernetes.io/name=metrics-server"}},
	{"cnpg-system", "Deployment", "cnpg-controller-manager", []string{"app.kubernetes.io/name=cloudnative-pg"}},
	{"logging", "StatefulSet", "loki", []string{"app.kubernetes.io/name=loki"}},
	{"logging", "DaemonSet", "alloy", []string{"app.kubernetes.io/name=alloy"}},
	{"argocd", "Deployment", "argocd-server", []string{"app.kubernetes.io/name=argocd-server"}},
	{"argocd", "StatefulSet", "argocd-application-controller", []string{"app.kubernetes.io/name=argocd-application-controller"}},
	{"argocd", "Deployment", "argocd-repo-server", []string{"app.kubernetes.io/name=argocd-repo-server"}},
	{"external-secrets", "Deployment", "external-secrets", []string{"app.kubernetes.io/name=external-secrets"}},
	{"openbao", "StatefulSet", "openbao", []string{"app.kubernetes.io/name=openbao"}},
	{"flowscape", "Deployment", "flowscape", []string{"app.kubernetes.io/name=flowscape"}},
}

var reservedEndpoints = []reserved{
	{"world", "0.0.0.0"},
	{"host", "10.9.2.11"},
	{"remote-node", "10.9.2.12"},
	{"kube-apiserver", "10.9.2.1"},
	{"ingress", "10.244.0.20"},
}

var conversations = []conversation{
	// Users arriving through the Gateway.
	{src: "reserved/ingress", dst: "authentik/authentik-server", proto: "TCP", port: 9000, rate: 6, http: []string{"GET /outpost.goauthentik.io/auth/nginx", "GET /if/flow/default-authentication-flow/", "POST /api/v3/flows/executor/default-authentication-flow/"}},
	{src: "reserved/ingress", dst: "nextcloud/nextcloud", proto: "TCP", port: 80, rate: 9, http: []string{"GET /index.php/apps/files/", "PROPFIND /remote.php/dav/files/jan/", "GET /index.php/apps/photos/", "PUT /remote.php/dav/files/jan/Photos/"}},
	{src: "reserved/ingress", dst: "monitoring/grafana", proto: "TCP", port: 3000, rate: 2, http: []string{"GET /api/ds/query", "GET /d/cilium-hubble/"}},
	{src: "reserved/ingress", dst: "argocd/argocd-server", proto: "TCP", port: 8080, rate: 1.5, http: []string{"GET /api/v1/applications", "GET /api/v1/stream/applications"}},
	{src: "reserved/ingress", dst: "monitoring/prometheus", proto: "TCP", port: 9090, rate: 0.5, http: []string{"GET /api/v1/query_range"}},
	// The Authentik outpost proxying to the apps behind it.
	{src: "authentik/authentik-server", dst: "home-assistant/home-assistant", proto: "TCP", port: 8123, rate: 4, http: []string{"GET /api/websocket", "GET /lovelace/0", "GET /api/history/period"}},
	{src: "authentik/authentik-server", dst: "kube-system/hubble-ui", proto: "TCP", port: 8081, rate: 1},
	{src: "authentik/authentik-server", dst: "flowscape/flowscape", proto: "TCP", port: 8080, rate: 1.2, http: []string{"GET /ws", "GET /api/status"}},
	{src: "authentik/authentik-server", dst: "monitoring/prometheus", proto: "TCP", port: 9090, rate: 0.5},
	// Apps and their databases.
	{src: "nextcloud/nextcloud", dst: "nextcloud/nextcloud-db", proto: "TCP", port: 5432, rate: 25},
	{src: "nextcloud/nextcloud-cron", dst: "nextcloud/nextcloud-db", proto: "TCP", port: 5432, rate: 3},
	{src: "home-assistant/home-assistant", dst: "home-assistant/home-assistant-db", proto: "TCP", port: 5432, rate: 12},
	{src: "authentik/authentik-server", dst: "authentik/authentik-postgresql", proto: "TCP", port: 5432, rate: 8},
	{src: "authentik/authentik-worker", dst: "authentik/authentik-postgresql", proto: "TCP", port: 5432, rate: 3},
	{src: "authentik/authentik-worker", dst: "authentik/authentik-server", proto: "TCP", port: 9000, rate: 0.5},
	// OIDC logins.
	{src: "nextcloud/nextcloud", dst: "authentik/authentik-server", proto: "TCP", port: 9000, rate: 0.8, http: []string{"POST /application/o/token/", "GET /application/o/userinfo/"}},
	{src: "argocd/argocd-server", dst: "authentik/authentik-server", proto: "TCP", port: 9000, rate: 0.3},
	{src: "monitoring/grafana", dst: "authentik/authentik-server", proto: "TCP", port: 9000, rate: 0.3},
	// Operators and the API server.
	{src: "cnpg-system/cnpg-controller-manager", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 3},
	{src: "cnpg-system/cnpg-controller-manager", dst: "nextcloud/nextcloud-db", proto: "TCP", port: 8000, rate: 1, audit: 0.35},
	{src: "cnpg-system/cnpg-controller-manager", dst: "home-assistant/home-assistant-db", proto: "TCP", port: 8000, rate: 1, audit: 0.35},
	{src: "nextcloud/nextcloud-db", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 0.7},
	{src: "home-assistant/home-assistant-db", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 0.7},
	{src: "argocd/argocd-application-controller", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 6},
	{src: "argocd/argocd-server", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 1},
	{src: "argocd/argocd-application-controller", dst: "argocd/argocd-repo-server", proto: "TCP", port: 8081, rate: 2},
	{src: "external-secrets/external-secrets", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 1.5},
	{src: "external-secrets/external-secrets", dst: "openbao/openbao", proto: "TCP", port: 8200, rate: 1.2, http: []string{"GET /v1/kv/data/nextcloud/config", "POST /v1/auth/kubernetes/login"}},
	{src: "kube-system/metrics-server", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 1},
	{src: "kube-system/metrics-server", dst: "reserved/host", proto: "TCP", port: 10250, rate: 2},
	{src: "kube-system/hubble-ui", dst: "kube-system/hubble-relay", proto: "TCP", port: 4245, rate: 1},
	{src: "flowscape/flowscape", dst: "kube-system/hubble-relay", proto: "TCP", port: 4245, rate: 0.4},
	{src: "kube-system/hubble-relay", dst: "reserved/host", proto: "TCP", port: 4244, rate: 2},
	{src: "kube-system/hubble-relay", dst: "reserved/remote-node", proto: "TCP", port: 4244, rate: 4},
	{src: "monitoring/kube-state-metrics", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 2},
	// Scraping and logs.
	{src: "monitoring/prometheus", dst: "nextcloud/nextcloud", proto: "TCP", port: 9205, rate: 0.5, http: []string{"GET /metrics"}},
	{src: "monitoring/prometheus", dst: "nextcloud/nextcloud-db", proto: "TCP", port: 9187, rate: 0.5, http: []string{"GET /metrics"}},
	{src: "monitoring/prometheus", dst: "home-assistant/home-assistant-db", proto: "TCP", port: 9187, rate: 0.5, http: []string{"GET /metrics"}},
	{src: "monitoring/prometheus", dst: "authentik/authentik-server", proto: "TCP", port: 9300, rate: 0.5, http: []string{"GET /metrics"}},
	{src: "monitoring/prometheus", dst: "kube-system/coredns", proto: "TCP", port: 9153, rate: 0.5, http: []string{"GET /metrics"}},
	{src: "monitoring/prometheus", dst: "monitoring/kube-state-metrics", proto: "TCP", port: 8080, rate: 0.5},
	{src: "monitoring/prometheus", dst: "flowscape/flowscape", proto: "TCP", port: 8080, rate: 0.3, http: []string{"GET /metrics"}},
	{src: "monitoring/prometheus", dst: "argocd/argocd-server", proto: "TCP", port: 8083, rate: 0.5},
	{src: "monitoring/prometheus", dst: "reserved/host", proto: "TCP", port: 9100, rate: 2},
	{src: "monitoring/prometheus", dst: "reserved/remote-node", proto: "TCP", port: 9100, rate: 4},
	{src: "monitoring/grafana", dst: "monitoring/prometheus", proto: "TCP", port: 9090, rate: 3, http: []string{"POST /api/v1/query_range", "GET /api/v1/labels"}},
	{src: "monitoring/grafana", dst: "logging/loki", proto: "TCP", port: 3100, rate: 1.5, http: []string{"GET /loki/api/v1/query_range"}},
	{src: "monitoring/prometheus", dst: "monitoring/alertmanager", proto: "TCP", port: 9093, rate: 0.5, http: []string{"POST /api/v2/alerts"}},
	{src: "logging/alloy", dst: "logging/loki", proto: "TCP", port: 3100, rate: 10, http: []string{"POST /loki/api/v1/push"}},
	{src: "logging/alloy", dst: "reserved/kube-apiserver", proto: "TCP", port: 6443, rate: 1},
	// DNS from everyone.
	{src: "nextcloud/nextcloud", dst: "kube-system/coredns", proto: "UDP", port: 53, rate: 2, dns: "auth.k8s.wlkr.ch"},
	{src: "home-assistant/home-assistant", dst: "kube-system/coredns", proto: "UDP", port: 53, rate: 1.5, dns: "alerts.home-assistant.io"},
	{src: "authentik/authentik-server", dst: "kube-system/coredns", proto: "UDP", port: 53, rate: 2, dns: "home-assistant.home-assistant.svc.cluster.local"},
	{src: "monitoring/grafana", dst: "kube-system/coredns", proto: "UDP", port: 53, rate: 1, dns: "kube-prometheus-stack-prometheus.monitoring.svc.cluster.local"},
	{src: "argocd/argocd-repo-server", dst: "kube-system/coredns", proto: "UDP", port: 53, rate: 1, dns: "github.com"},
	{src: "external-secrets/external-secrets", dst: "kube-system/coredns", proto: "UDP", port: 53, rate: 0.5, dns: "openbao.openbao.svc.cluster.local"},
	// Out to the world.
	{src: "nextcloud/nextcloud", dst: "world/auth.k8s.wlkr.ch", proto: "TCP", port: 443, rate: 0.8},
	{src: "nextcloud/nextcloud", dst: "world/apps.nextcloud.com", proto: "TCP", port: 443, rate: 0.2},
	{src: "nextcloud/nextcloud", dst: "world/github.com", proto: "TCP", port: 443, rate: 0.1},
	{src: "home-assistant/home-assistant", dst: "world/alerts.home-assistant.io", proto: "TCP", port: 443, rate: 0.2},
	{src: "home-assistant/home-assistant", dst: "world/224.0.0.251", proto: "UDP", port: 5353, rate: 0.5},
	{src: "argocd/argocd-repo-server", dst: "world/github.com", proto: "TCP", port: 443, rate: 1},
	{src: "monitoring/alertmanager", dst: "world/smtp.mailbox.org", proto: "TCP", port: 465, rate: 0.05},
	{src: "kube-system/coredns", dst: "world/10.9.2.1", proto: "UDP", port: 53, rate: 3},
	{src: "monitoring/grafana", dst: "world/grafana.com", proto: "TCP", port: 443, rate: 0.1, drop: 1, dropReason: "POLICY_DENIED"},
	{src: "logging/loki", dst: "world/stats.grafana.org", proto: "TCP", port: 443, rate: 0.15, drop: 1, dropReason: "POLICY_DENIED"},
	{src: "nextcloud/nextcloud", dst: "world/push-notifications.nextcloud.com", proto: "TCP", port: 443, rate: 0.2, drop: 0.7, dropReason: "POLICY_DENIED"},
	// Probes from the nodes.
	{src: "reserved/host", dst: "nextcloud/nextcloud", proto: "TCP", port: 80, rate: 0.3},
	{src: "reserved/host", dst: "home-assistant/home-assistant", proto: "TCP", port: 8123, rate: 0.3},
	{src: "reserved/remote-node", dst: "authentik/authentik-server", proto: "TCP", port: 9000, rate: 0.3},
	{src: "reserved/remote-node", dst: "monitoring/prometheus", proto: "ICMP", port: 8, rate: 0.6},
	// cilium-health pings every node's health endpoint from every other node.
	{src: "reserved/remote-node", dst: "kube-system/coredns", proto: "ICMP", port: 8, rate: 1.5},
}

var nodeNames = []string{"cp1", "cp2", "cp3", "w1", "w2", "w3"}

// One address per machine, the way host and remote-node flows carry them.
var nodeIPs = map[string]string{"cp1": "10.9.2.11", "cp2": "10.9.2.12", "cp3": "10.9.2.13", "w1": "10.9.2.21", "w2": "10.9.2.22", "w3": "10.9.2.23"}
