import { describe, expect, it } from "vitest";
import { GraphState } from "./graph-state";
import type { Snapshot, Tick } from "./protocol";

const node = (id: string) => {
  const [ns, kind, name] = id.split("/") as [string, string, string];
  return { id, ns, kind, name, first: 1000, last: 2000 };
};
const edge = (src: string, dst: string, port = 80) => ({
  id: `${src}|${dst}|TCP|${port}`,
  src,
  dst,
  proto: "TCP",
  port,
  f: 0,
  d: 0,
  a: 0,
  e: 0,
  last: 2000,
});

describe("GraphState", () => {
  it("applies a snapshot and reports additions once", () => {
    const g = new GraphState(60);
    const s: Snapshot = {
      t: "snapshot",
      ts: 100_000,
      nodes: [node("a/Deployment/x"), node("b/Deployment/y")],
      edges: [
        {
          ...edge("a/Deployment/x", "b/Deployment/y"),
          f: 5,
          buckets: [
            [99, 3, 0, 0, 0],
            [100, 2, 0, 0, 0],
          ],
        },
      ],
    };
    g.applySnapshot(s);
    const c = g.consume();
    expect(c.addedNodes).toEqual(["a/Deployment/x", "b/Deployment/y"]);
    expect(c.addedEdges).toHaveLength(1);
    expect(c.reset).toBe(true);
    const e = g.edges.get(c.addedEdges[0]!)!;
    expect(e.totals).toEqual([5, 0, 0, 0]);
    expect(g.rate(e, 10, 100)).toEqual([0.5, 0, 0, 0]);
    expect(g.rate(e, 1, 100)).toEqual([2, 0, 0, 0]);
    expect(g.consume().addedNodes).toEqual([]);
  });

  it("folds tick increments into the ring and handles gone", () => {
    const g = new GraphState(60);
    g.applySnapshot({ t: "snapshot", ts: 0, nodes: [node("a/Pod/p"), node("b/Pod/q")], edges: [] });
    g.consume();
    const t: Tick = {
      t: "tick",
      ts: 50_500,
      edges: [{ ...edge("a/Pod/p", "b/Pod/q"), f: 2, d: 1 }],
      gone: {},
      sparks: [{ e: "a/Pod/p|b/Pod/q|TCP|80", v: 1 }],
      status: { source: "demo", relay: "n/a", flows_s: 1, clients: 1 },
    };
    g.applyTick(t);
    g.applyTick({ ...t, ts: 50_900, sparks: [] });
    g.applyTick({ ...t, ts: 51_100, sparks: [] });
    let c = g.consume();
    expect(c.addedEdges).toHaveLength(1);
    expect(c.sparks).toHaveLength(1);
    const e = g.edges.get("a/Pod/p|b/Pod/q|TCP|80")!;
    expect(e.totals).toEqual([6, 3, 0, 0]);
    expect(g.series(e, 3, 51)).toEqual([0, 6, 3]);
    expect(g.rate(e, 2, 51)).toEqual([3, 1.5, 0, 0]);
    expect(g.nodes.get("a/Pod/p")!.edges.size).toBe(1);
    g.applyTick({
      t: "tick",
      ts: 60_000,
      gone: { edges: [e.id], nodes: ["b/Pod/q"] },
      status: t.status,
    });
    c = g.consume();
    expect(c.removedEdges).toEqual([e.id]);
    expect(c.removedNodes).toEqual(["b/Pod/q"]);
    expect(g.nodes.get("a/Pod/p")!.edges.size).toBe(0);
  });

  it("wraps the ring without leaking old seconds", () => {
    const g = new GraphState(10);
    g.applySnapshot({ t: "snapshot", ts: 0, nodes: [node("a/Pod/p"), node("b/Pod/q")], edges: [] });
    const status = { source: "demo", relay: "n/a" as const, flows_s: 0, clients: 0 };
    g.applyTick({
      t: "tick",
      ts: 5_000,
      edges: [{ ...edge("a/Pod/p", "b/Pod/q"), f: 4 }],
      gone: {},
      status,
    });
    g.applyTick({
      t: "tick",
      ts: 15_000,
      edges: [{ ...edge("a/Pod/p", "b/Pod/q"), f: 1 }],
      gone: {},
      status,
    });
    const e = g.edges.get("a/Pod/p|b/Pod/q|TCP|80")!;
    expect(g.rate(e, 10, 15)).toEqual([0.1, 0, 0, 0]);
  });
});
