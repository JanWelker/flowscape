import type { Bucket, L7, Snapshot, Spark, Tick, WireEdge, WireNode } from "./protocol";

export interface NodeState {
  id: string;
  ns: string;
  kind: string;
  name: string;
  fqdn?: string;
  labels?: Record<string, string>;
  first: number;
  last: number;
  /** Edge ids touching this node. */
  edges: Set<string>;
}

export interface EdgeState {
  id: string;
  src: string;
  dst: string;
  proto: string;
  port: number;
  totals: [number, number, number, number];
  last: number;
  latencyMs: number;
  l7?: L7;
  drops?: Record<string, number>;
  /** One second per slot, four verdict counters each. */
  ring: Uint32Array;
  epochs: Float64Array;
}

/** Everything that changed since the last consume(). */
export interface Changes {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
  /** Edges whose counters or details moved. */
  touchedEdges: string[];
  sparks: Spark[];
  /** Latest tick timestamp in ms. */
  ts: number;
  reset: boolean;
}

export class GraphState {
  readonly nodes = new Map<string, NodeState>();
  readonly edges = new Map<string, EdgeState>();
  retention: number;
  private addedNodes = new Set<string>();
  private removedNodes = new Set<string>();
  private addedEdges = new Set<string>();
  private removedEdges = new Set<string>();
  private touchedEdges = new Set<string>();
  private sparks: Spark[] = [];
  private ts = 0;
  private reset = false;

  constructor(retentionSeconds = 300) {
    this.retention = Math.max(10, retentionSeconds);
  }

  applySnapshot(s: Snapshot): void {
    for (const id of this.nodes.keys()) this.removedNodes.add(id);
    for (const id of this.edges.keys()) this.removedEdges.add(id);
    this.nodes.clear();
    this.edges.clear();
    this.addedNodes.clear();
    this.addedEdges.clear();
    this.touchedEdges.clear();
    for (const n of s.nodes) this.upsertNode(n);
    for (const e of s.edges) {
      const es = this.upsertEdge(e);
      es.totals = [e.f, e.d, e.a, e.e];
      for (const b of e.buckets ?? []) this.setBucket(es, b);
    }
    // A node that was removed and re-added in the same snapshot is neither.
    for (const id of this.addedNodes) if (this.removedNodes.delete(id)) this.addedNodes.delete(id);
    for (const id of this.addedEdges) if (this.removedEdges.delete(id)) this.addedEdges.delete(id);
    this.ts = s.ts;
    this.reset = true;
  }

  applyTick(t: Tick): void {
    const sec = Math.floor(t.ts / 1000);
    for (const n of t.nodes ?? []) this.upsertNode(n);
    for (const e of t.edges ?? []) {
      const es = this.upsertEdge(e);
      es.totals[0] += e.f;
      es.totals[1] += e.d;
      es.totals[2] += e.a;
      es.totals[3] += e.e;
      this.addBucket(es, sec, e.f, e.d, e.a, e.e);
      if (e.last > es.last) es.last = e.last;
      if (e.l7) es.l7 = e.l7;
      if (e.drops) es.drops = e.drops;
      if (e.latency_ms) es.latencyMs = e.latency_ms;
      this.touchedEdges.add(e.id);
    }
    for (const id of t.gone.edges ?? []) this.removeEdge(id);
    for (const id of t.gone.nodes ?? []) this.removeNode(id);
    if (t.sparks) for (const s of t.sparks) this.sparks.push(s);
    this.ts = t.ts;
  }

  /** Events per second on an edge over the last windowSec seconds ending at nowSec. */
  rate(e: EdgeState, windowSec: number, nowSec: number): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    const n = this.retention;
    const w = Math.min(windowSec, n);
    for (let s = nowSec - w + 1; s <= nowSec; s++) {
      const i = ((s % n) + n) % n;
      if (e.epochs[i] !== s) continue;
      out[0] += e.ring[i * 4] ?? 0;
      out[1] += e.ring[i * 4 + 1] ?? 0;
      out[2] += e.ring[i * 4 + 2] ?? 0;
      out[3] += e.ring[i * 4 + 3] ?? 0;
    }
    return [out[0] / w, out[1] / w, out[2] / w, out[3] / w];
  }

  /** Per-second series for a sparkline, oldest first. */
  series(e: EdgeState, windowSec: number, nowSec: number): number[] {
    const n = this.retention;
    const w = Math.min(windowSec, n);
    const out: number[] = [];
    for (let s = nowSec - w + 1; s <= nowSec; s++) {
      const i = ((s % n) + n) % n;
      if (e.epochs[i] !== s) {
        out.push(0);
        continue;
      }
      out.push(
        (e.ring[i * 4] ?? 0) +
          (e.ring[i * 4 + 1] ?? 0) +
          (e.ring[i * 4 + 2] ?? 0) +
          (e.ring[i * 4 + 3] ?? 0),
      );
    }
    return out;
  }

  consume(): Changes {
    const c: Changes = {
      addedNodes: [...this.addedNodes],
      removedNodes: [...this.removedNodes],
      addedEdges: [...this.addedEdges],
      removedEdges: [...this.removedEdges],
      touchedEdges: [...this.touchedEdges],
      sparks: this.sparks,
      ts: this.ts,
      reset: this.reset,
    };
    this.addedNodes.clear();
    this.removedNodes.clear();
    this.addedEdges.clear();
    this.removedEdges.clear();
    this.touchedEdges.clear();
    this.sparks = [];
    this.reset = false;
    return c;
  }

  private upsertNode(n: WireNode): NodeState {
    let ns = this.nodes.get(n.id);
    if (!ns) {
      ns = { ...n, edges: new Set() };
      this.nodes.set(n.id, ns);
      this.addedNodes.add(n.id);
      this.removedNodes.delete(n.id);
    } else {
      ns.last = Math.max(ns.last, n.last);
      if (n.labels) ns.labels = n.labels;
    }
    return ns;
  }

  private upsertEdge(e: WireEdge): EdgeState {
    let es = this.edges.get(e.id);
    if (!es) {
      es = {
        id: e.id,
        src: e.src,
        dst: e.dst,
        proto: e.proto,
        port: e.port,
        totals: [0, 0, 0, 0],
        last: e.last,
        latencyMs: e.latency_ms ?? 0,
        l7: e.l7,
        drops: e.drops,
        ring: new Uint32Array(this.retention * 4),
        epochs: new Float64Array(this.retention).fill(-1),
      };
      this.edges.set(e.id, es);
      this.addedEdges.add(e.id);
      this.removedEdges.delete(e.id);
      this.nodes.get(e.src)?.edges.add(e.id);
      this.nodes.get(e.dst)?.edges.add(e.id);
    }
    return es;
  }

  private removeEdge(id: string): void {
    const e = this.edges.get(id);
    if (!e) return;
    this.edges.delete(id);
    this.nodes.get(e.src)?.edges.delete(id);
    this.nodes.get(e.dst)?.edges.delete(id);
    this.touchedEdges.delete(id);
    if (!this.addedEdges.delete(id)) this.removedEdges.add(id);
  }

  private removeNode(id: string): void {
    if (!this.nodes.delete(id)) return;
    if (!this.addedNodes.delete(id)) this.removedNodes.add(id);
  }

  private setBucket(e: EdgeState, b: Bucket): void {
    const i = ((b[0] % this.retention) + this.retention) % this.retention;
    e.epochs[i] = b[0];
    e.ring[i * 4] = b[1];
    e.ring[i * 4 + 1] = b[2];
    e.ring[i * 4 + 2] = b[3];
    e.ring[i * 4 + 3] = b[4];
  }

  private addBucket(e: EdgeState, sec: number, f: number, d: number, a: number, er: number): void {
    const i = ((sec % this.retention) + this.retention) % this.retention;
    if (e.epochs[i] !== sec) {
      e.epochs[i] = sec;
      e.ring.fill(0, i * 4, i * 4 + 4);
    }
    e.ring[i * 4] = (e.ring[i * 4] ?? 0) + f;
    e.ring[i * 4 + 1] = (e.ring[i * 4 + 1] ?? 0) + d;
    e.ring[i * 4 + 2] = (e.ring[i * 4 + 2] ?? 0) + a;
    e.ring[i * 4 + 3] = (e.ring[i * 4 + 3] ?? 0) + er;
  }
}
