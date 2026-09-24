import "./style.css";
import { AmbientLight, DirectionalLight, Vector3 } from "three";
import { Edges } from "./edges";
import { FiltersPanel } from "./filters";
import { GraphState } from "./graph-state";
import { Layout } from "./layout";
import { Nodes } from "./nodes";
import { Panel } from "./panel";
import { Particles } from "./particles";
import { Picking, type Pick } from "./picking";
import { Platforms } from "./platforms";
import { SceneHost } from "./scene";
import { WSClient, type ConnState } from "./ws-client";
import type { Message, Status } from "./protocol";

const app = document.getElementById("app")!;
const host = new SceneHost(app);
const state = new GraphState(300);
const layout = new Layout();
const platforms = new Platforms();
const nodes = new Nodes();
const edges = new Edges(nodes);
const particles = new Particles(edges);
const filters = new FiltersPanel(document.getElementById("filters")!, 60);
const panel = new Panel(document.getElementById("panel")!, state);

host.scene.add(platforms.group, nodes.mesh, nodes.halo, nodes.reservedMesh, particles.points);
for (const b of edges.batches) host.scene.add(b.mesh);
host.scene.add(new AmbientLight(0x8899bb, 0.6));
const key = new DirectionalLight(0xffffff, 1.2);
key.position.set(20, 40, 10);
host.scene.add(key);

let conn: ConnState = "connecting";
let status: Status | null = null;
let clockOffset = 0;
let membershipDirty = false;
let layoutMovingUntil = 0;
let selected: Pick = null;
let gotSnapshot = false;
const cameraPos = new Vector3();
/** Two workloads share a platform in the current grouping. */
const samePlatform = (src: string, dst: string) => {
  const a = state.nodes.get(src);
  const b = state.nodes.get(dst);
  if (!a || !b) return src.split("/")[0] === dst.split("/")[0];
  if (a.ns === "reserved" || b.ns === "reserved") return false;
  return layout.groupOf(a) === layout.groupOf(b);
};
const machines = new Set<string>();

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const ws = new WSClient(
  wsUrl,
  (m: Message) => {
    if (m.t === "hello") {
      clockOffset = m.server_time - Date.now();
      state.retention = m.retention_s;
      filters.setMaxWindow(m.retention_s);
      document.title = `Flowscape · ${m.source}`;
    } else if (m.t === "snapshot") {
      state.applySnapshot(m);
      gotSnapshot = true;
    } else {
      state.applyTick(m);
      status = m.status;
      nodes.setUnavailable(m.status.unavailable ?? []);
      if (m.status.unavailable?.length) filters.syncMachines(machines, m.status.unavailable);
    }
  },
  (s) => {
    conn = s;
  },
);
ws.connect();

const nowSec = () => Math.floor((Date.now() + clockOffset) / 1000);

function applyChanges(): void {
  const c = state.consume();
  if (c.reset) {
    for (const id of c.removedEdges) edges.remove(id);
    for (const id of c.removedNodes) nodes.remove(id);
  }
  for (const id of c.removedEdges) edges.remove(id);
  for (const id of c.removedNodes) nodes.remove(id);
  for (const id of c.touchedNodes) {
    const n = state.nodes.get(id);
    if (n?.machine) nodes.setMachine(id, n.machine);
  }
  if (c.addedNodes.length || c.removedNodes.length || c.reset) membershipDirty = true;
  if (c.touchedNodes.length && layout.groupBy === "machine") membershipDirty = true;
  if (membershipDirty) {
    layout.rebuild(state.nodes);
    platforms.sync(layout);
    machines.clear();
    for (const n of state.nodes.values()) {
      if (n.machine) machines.add(n.machine);
      if (n.ns === "reserved" && n.kind === "node") machines.add(n.name);
    }
    filters.syncMachines(machines, status?.unavailable ?? []);
    filters.syncNamespaces(
      new Set([...state.nodes.values()].filter((n) => n.ns !== "reserved").map((n) => n.ns)),
    );
    edges.setSame(samePlatform, state.edges);
    for (const [id, target] of layout.targets) {
      if (nodes.has(id)) nodes.setTarget(id, target);
      else {
        const n = state.nodes.get(id);
        if (n) nodes.add(n, target);
      }
    }
    membershipDirty = false;
    layoutMovingUntil = performance.now() + 1500;
  }
  for (const id of c.addedEdges) {
    const e = state.edges.get(id);
    if (e) edges.add(e, samePlatform(e.src, e.dst));
  }
  for (const s of c.sparks) {
    const slot = edges.slots.get(s.e);
    if (slot && !slot.hidden && filters.filters.verdicts[s.v])
      particles.spawn(slot.cp, s.v, s.v !== 0);
  }
}

/** A reserved machine anchor whose machine chip is switched off. */
function machineAnchorHidden(id: string): boolean {
  const n = state.nodes.get(id);
  return (
    n !== undefined &&
    n.ns === "reserved" &&
    n.kind === "node" &&
    filters.filters.machines.has(n.name)
  );
}

const rates = new Map<string, [number, number, number, number]>();
const activity = new Map<string, number>();
let lastRates = 0;
function refreshRates(force = false): void {
  const now = performance.now();
  if (!force && now - lastRates < 250) return;
  lastRates = now;
  const f = filters.filters;
  const sec = nowSec();
  activity.clear();
  const nowMs = Date.now() + clockOffset;
  for (const e of state.edges.values()) {
    const r = state.rate(e, f.windowSec, sec);
    const v: [number, number, number, number] = [
      f.verdicts[0] ? r[0] : 0,
      f.verdicts[1] ? r[1] : 0,
      f.verdicts[2] ? r[2] : 0,
      f.verdicts[3] ? r[3] : 0,
    ];
    rates.set(e.id, v);
    const total = v[0] + v[1] + v[2] + v[3];
    const srcNs = e.src.split("/")[0]!;
    const dstNs = e.dst.split("/")[0]!;
    const hidden =
      f.namespaces.has(srcNs) ||
      f.namespaces.has(dstNs) ||
      f.machines.has(nodes.machineOf(e.src)) ||
      f.machines.has(nodes.machineOf(e.dst)) ||
      (f.machines.size > 0 && (machineAnchorHidden(e.src) || machineAnchorHidden(e.dst))) ||
      f.protocols.has(e.proto) ||
      (f.hideReserved && (srcNs === "reserved" || dstNs === "reserved")) ||
      total === 0;
    edges.setHidden(e.id, hidden);
    edges.setRate(e.id, total);
    const idle = Math.max(0, (nowMs - e.last) / 1000);
    const alpha = 0.18 + 0.82 * Math.exp(-idle / 25);
    edges.setColor(e.id, v[0], v[1], v[2], v[3], alpha);
    if (!hidden) {
      const a = Math.min(1, Math.log1p(total) / 3.5);
      activity.set(e.src, Math.max(activity.get(e.src) ?? 0, a));
      activity.set(e.dst, Math.max(activity.get(e.dst) ?? 0, a));
    }
  }
  for (const n of state.nodes.values()) {
    const hidden =
      f.namespaces.has(n.ns) ||
      (f.hideReserved && n.ns === "reserved") ||
      (n.machine !== undefined && f.machines.has(n.machine)) ||
      machineAnchorHidden(n.id);
    nodes.setHidden(n.id, hidden);
    nodes.setActivity(n.id, activity.get(n.id) ?? 0);
  }
  for (const p of layout.platforms.values()) {
    platforms.setDimmed(
      p.group,
      p.kind === "namespace" ? f.namespaces.has(p.group) : f.machines.has(p.group),
    );
  }
  panel.refresh(sec, f.windowSec);
}

filters.onChange = () => {
  ws.setPaused(filters.filters.paused);
  if (layout.groupBy !== filters.filters.groupBy) {
    layout.groupBy = filters.filters.groupBy;
    membershipDirty = true;
    applyChanges();
    host.fit(layout.outerRadius + 6);
  }
  refreshRates(true);
};
filters.onMachineHover = (name) => {
  nodes.emphasisedMachine = name;
};
filters.onFit = () => host.fit(layout.outerRadius + 6);

function select(p: Pick): void {
  selected = p;
  nodes.selected = p?.kind === "node" ? p.id : null;
  edges.selected = p?.kind === "edge" ? p.id : null;
  edges.emphasiseNode(p?.kind === "node" ? p.id : null);
  panel.show(p);
  if (p) refreshRates(true);
}
panel.onClose = () => select(null);
panel.onNavigate = (p) => select(p);
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") select(null);
});

const picking = new Picking(
  host.renderer.domElement,
  host.camera,
  nodes,
  edges,
  (p) => {
    nodes.hovered = p?.kind === "node" ? p.id : null;
    edges.hovered = p?.kind === "edge" ? p.id : null;
    if (p?.kind === "node" && !selected) edges.emphasiseNode(p.id);
    else if (!p && !selected) edges.emphasiseNode(null);
    if (p?.kind === "edge") {
      const e = state.edges.get(p.id);
      if (e)
        filters.setHelp(
          `${state.nodes.get(e.src)?.name ?? e.src} → ${state.nodes.get(e.dst)?.name ?? e.dst} ${e.proto}:${e.port}`,
        );
    } else if (p?.kind === "node") {
      const n = state.nodes.get(p.id);
      if (n) filters.setHelp(`${n.ns} / ${n.kind} ${n.name}`);
    } else filters.setHelp("drag to orbit · scroll to zoom · click a node or arc");
  },
  (p) => select(p?.kind === selected?.kind && p?.id === selected?.id ? null : p),
);

// Synthetic sparks keep the density proportional to the rate even though
// the server samples what it sends.
const synthAcc = new Map<string, number>();
function synthesise(dt: number): void {
  for (const [id, r] of rates) {
    const slot = edges.slots.get(id);
    if (!slot || slot.hidden) continue;
    const total = r[0] + r[1] + r[2] + r[3];
    const perSec = Math.min(total, 30) * 0.5;
    const acc = (synthAcc.get(id) ?? Math.random()) + perSec * dt;
    if (acc >= 1) {
      synthAcc.set(id, acc - 1);
      const x = Math.random() * total;
      const v = x < r[1] ? 1 : x < r[1] + r[2] ? 2 : x < r[1] + r[2] + r[3] ? 3 : 0;
      particles.spawn(slot.cp, v);
    } else synthAcc.set(id, acc);
  }
}

let lastStatus = 0;
let fitted = false;
host.onFrame((dt) => {
  applyChanges();
  refreshRates();
  cameraPos.copy(host.camera.position);
  nodes.update(dt, cameraPos, host.scene);
  const moving = performance.now() < layoutMovingUntil;
  edges.setResolution(host.resolution.x, host.resolution.y);
  edges.update(state.edges, moving);
  synthesise(dt);
  particles.update(dt);
  picking.update(performance.now());
  if (performance.now() - lastStatus > 400) {
    lastStatus = performance.now();
    filters.setStatus(conn, status, particles.count);
  }
  if (gotSnapshot && !fitted && layout.platforms.size > 0) {
    fitted = true;
    host.fit(layout.outerRadius + 6, false);
    // Scale the floor glow with the ring.
    host.scene.getObjectByName("floor")?.scale.setScalar(layout.outerRadius * 3.2);
  }
  if (gotSnapshot && host.frames > 10 && document.body.dataset.ready !== "true") {
    document.body.dataset.ready = "true";
  }
});
host.start();

if (new URLSearchParams(location.search).has("debug")) {
  const fps = document.createElement("div");
  fps.className = "fps";
  document.body.appendChild(fps);
  let frames = 0;
  let last = performance.now();
  host.onFrame(() => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) {
      fps.textContent = `${frames} fps · ${state.nodes.size} nodes · ${state.edges.size} edges · ${particles.count} sparks`;
      frames = 0;
      last = now;
    }
  });
}

declare global {
  interface Window {
    flowscape: {
      state: GraphState;
      layout: Layout;
      particles: Particles;
      host: SceneHost;
      picking: Picking;
      select: (p: Pick) => void;
    };
  }
}
window.flowscape = { state, layout, particles, host, picking, select };
