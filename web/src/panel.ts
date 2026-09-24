import type { EdgeState, GraphState, NodeState } from "./graph-state";
import type { Pick } from "./picking";
import { verdictCssColor } from "./theme";

/** Right-hand detail panel for the selection. */
export class Panel {
  private readonly root: HTMLElement;
  private current: Pick = null;
  private spark: HTMLCanvasElement | null = null;
  onClose: () => void = () => {};
  onNavigate: (p: Pick) => void = () => {};

  constructor(
    root: HTMLElement,
    private readonly state: GraphState,
  ) {
    this.root = root;
    root.hidden = true;
  }

  show(p: Pick): void {
    this.current = p;
    if (!p) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.render();
  }

  /** Called every few hundred ms so rates stay live. */
  refresh(nowSec: number, windowSec: number): void {
    if (!this.current || this.root.hidden) return;
    const p = this.current;
    if (p.kind === "edge") {
      const e = this.state.edges.get(p.id);
      if (!e) return this.show(null);
      const r = this.state.rate(e, windowSec, nowSec);
      this.root.querySelector("#rates")!.innerHTML = rateRow(r, windowSec);
      this.drawSparkline(this.state.series(e, windowSec, nowSec));
    } else {
      const n = this.state.nodes.get(p.id);
      if (!n) return this.show(null);
      this.root.querySelector("#edges")!.innerHTML = this.edgeList(n, nowSec, windowSec);
      this.bindLinks();
    }
  }

  private render(): void {
    const p = this.current!;
    if (p.kind === "node") {
      const n = this.state.nodes.get(p.id);
      if (!n) return this.show(null);
      const labels = n.labels
        ? Object.entries(n.labels)
            .map(([k, v]) => `<span class="tag">${esc(k)}=${esc(v)}</span>`)
            .join("")
        : "";
      this.root.innerHTML = `
        <header><span class="kind">${esc(n.kind)}</span><button class="close" title="esc">×</button></header>
        <h2>${esc(n.name)}</h2>
        <div class="sub">${esc(n.ns)}${n.fqdn ? ` · ${esc(n.fqdn)}` : ""}${n.machine ? ` · on ${esc(n.machine)}` : ""}</div>
        <div class="tags">${labels}</div>
        <div class="kv"><span>first seen</span><span>${ago(n.first)}</span><span>last seen</span><span>${ago(n.last)}</span></div>
        <h3>Conversations</h3>
        <div id="edges"></div>
        <button class="copy" id="copy">copy as JSON</button>`;
      this.root.querySelector<HTMLButtonElement>("#copy")!.onclick = () =>
        navigator.clipboard?.writeText(JSON.stringify({ ...n, edges: [...n.edges] }, null, 2));
    } else {
      const e = this.state.edges.get(p.id);
      if (!e) return this.show(null);
      const src = this.state.nodes.get(e.src);
      const dst = this.state.nodes.get(e.dst);
      const drops = e.drops
        ? Object.entries(e.drops)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `<span class="tag drop">${esc(k)} ×${v}</span>`)
            .join("")
        : "";
      const l7 = e.l7
        ? [
            ...Object.entries(e.l7.http ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `<div class="l7"><code>${esc(k)}</code><span>${v}</span></div>`),
            ...Object.entries(e.l7.dns ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `<div class="l7"><code>${esc(k)}</code><span>${v}</span></div>`),
          ].join("")
        : "";
      this.root.innerHTML = `
        <header><span class="kind">${esc(e.proto)} :${e.port}</span><button class="close" title="esc">×</button></header>
        <h2><a href="#" data-node="${esc(e.src)}">${esc(short(src, e.src))}</a><span class="arrow">→</span><a href="#" data-node="${esc(e.dst)}">${esc(short(dst, e.dst))}</a></h2>
        <div class="sub">${esc(src?.ns ?? "?")} → ${esc(dst?.ns ?? "?")}</div>
        <div id="rates"></div>
        <canvas id="spark" width="280" height="48"></canvas>
        <div class="kv">
          <span>forwarded</span><span>${e.totals[0]}</span>
          <span>dropped</span><span>${e.totals[1]}</span>
          <span>audit</span><span>${e.totals[2]}</span>
          <span>error</span><span>${e.totals[3]}</span>
          ${e.latencyMs ? `<span>latency</span><span>${e.latencyMs.toFixed(1)} ms</span>` : ""}
          ${e.l7?.status ? `<span>last status</span><span>${e.l7.status}</span>` : ""}
          <span>last seen</span><span>${ago(e.last)}</span>
        </div>
        ${drops ? `<h3>Drop reasons</h3><div class="tags">${drops}</div>` : ""}
        ${l7 ? `<h3>Requests</h3><div class="l7list">${l7}</div>` : ""}
        <button class="copy" id="copy">copy as JSON</button>`;
      this.spark = this.root.querySelector("#spark");
      this.root.querySelector<HTMLButtonElement>("#copy")!.onclick = () =>
        navigator.clipboard?.writeText(
          JSON.stringify({ ...e, ring: undefined, epochs: undefined }, null, 2),
        );
    }
    this.root.querySelector<HTMLButtonElement>(".close")!.onclick = () => this.onClose();
    this.bindLinks();
  }

  private bindLinks(): void {
    this.root.querySelectorAll<HTMLAnchorElement>("a[data-node]").forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        this.onNavigate({ kind: "node", id: a.dataset.node! });
      };
    });
    this.root.querySelectorAll<HTMLAnchorElement>("a[data-edge]").forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        this.onNavigate({ kind: "edge", id: a.dataset.edge! });
      };
    });
  }

  private edgeList(n: NodeState, nowSec: number, windowSec: number): string {
    const rows: { html: string; rate: number }[] = [];
    for (const id of n.edges) {
      const e = this.state.edges.get(id);
      if (!e) continue;
      const r = this.state.rate(e, windowSec, nowSec);
      const total = r[0] + r[1] + r[2] + r[3];
      const out = e.src === n.id;
      const other = this.state.nodes.get(out ? e.dst : e.src);
      const dominant = r[1] > 0 ? 1 : r[2] > 0 ? 2 : r[3] > 0 ? 3 : 0;
      rows.push({
        rate: total,
        html: `<a href="#" class="edge-row" data-edge="${esc(id)}"><span class="dir">${out ? "→" : "←"}</span><span class="who">${esc(short(other, out ? e.dst : e.src))}</span><span class="port">${esc(e.proto)}:${e.port}</span><span class="rate" style="color:${verdictCssColor(dominant)}">${fmtRate(total)}</span></a>`,
      });
    }
    rows.sort((a, b) => b.rate - a.rate);
    return rows.map((r) => r.html).join("") || `<div class="empty">nothing in the window</div>`;
  }

  private drawSparkline(series: number[]): void {
    const c = this.spark;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1, ...series);
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = (i / Math.max(1, series.length - 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#35d6ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(53, 214, 255, 0.12)";
    ctx.fill();
  }
}

function rateRow(r: [number, number, number, number], windowSec: number): string {
  const cell = (v: number, i: number) =>
    `<div class="rate-cell" style="--c:${verdictCssColor(i)}"><b>${fmtRate(v)}</b><span>${["fwd", "drop", "audit", "err"][i]}</span></div>`;
  return `<div class="rates">${r.map(cell).join("")}</div><div class="sub">per second over ${windowSec}s</div>`;
}

function fmtRate(v: number): string {
  if (v === 0) return "0";
  if (v < 0.1) return v.toFixed(2);
  if (v < 10) return v.toFixed(1);
  return v.toFixed(0);
}

function short(n: NodeState | undefined, id: string): string {
  return n ? n.name : id;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${s.toFixed(0)}s ago`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export type { EdgeState };
