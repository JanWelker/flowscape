import { describe, expect, it } from "vitest";
import { Layout } from "./layout";
import type { NodeState } from "./graph-state";

const mk = (id: string, machine?: string): [string, NodeState] => {
  const [ns, kind, name] = id.split("/") as [string, string, string];
  return [id, { id, ns, kind, name, machine, first: 0, last: 0, edges: new Set() }];
};

describe("Layout", () => {
  it("is stable when unrelated nodes appear", () => {
    const l = new Layout();
    l.rebuild(
      new Map([mk("a/Deployment/x"), mk("b/Deployment/y"), mk("reserved/world/github.com")]),
    );
    const x1 = { ...l.targets.get("a/Deployment/x")! };
    l.rebuild(
      new Map([
        mk("a/Deployment/x"),
        mk("b/Deployment/y"),
        mk("b/Deployment/z"),
        mk("reserved/world/github.com"),
      ]),
    );
    const x2 = l.targets.get("a/Deployment/x")!;
    expect(x2).toEqual(x1);
    expect(l.platforms.get("b")!.nodes).toEqual(["b/Deployment/y", "b/Deployment/z"]);
  });

  it("keeps workloads inside their platform and reserved outside the ring", () => {
    const l = new Layout();
    const nodes = new Map<string, NodeState>();
    for (let i = 0; i < 12; i++) nodes.set(...mk(`ns/Deployment/w${i}`));
    nodes.set(...mk("reserved/kube-apiserver/kube-apiserver"));
    l.rebuild(nodes);
    const p = l.platforms.get("ns")!;
    for (const id of p.nodes) {
      const t = l.targets.get(id)!;
      expect(Math.hypot(t.x - p.center.x, t.z - p.center.z)).toBeLessThan(p.radius);
    }
    const api = l.targets.get("reserved/kube-apiserver/kube-apiserver")!;
    expect(Math.hypot(api.x, api.z)).toBeGreaterThan(l.ringRadius);
  });

  it("regroups by machine and parks the unplaced last", () => {
    const l = new Layout();
    const nodes = new Map<string, NodeState>([
      mk("a/Deployment/x", "w1"),
      mk("b/Deployment/y", "w2"),
      mk("b/Deployment/z", "w1"),
      mk("c/Deployment/q"),
      mk("reserved/node/w1"),
      mk("reserved/node/w2"),
      mk("reserved/kube-apiserver/kube-apiserver"),
    ]);
    l.rebuild(nodes);
    expect([...l.platforms.keys()]).toEqual(["a", "b", "c"]);
    l.groupBy = "machine";
    l.rebuild(nodes);
    expect([...l.platforms.keys()]).toEqual(["w1", "w2", "unplaced"]);
    expect(l.platforms.get("w1")!.nodes).toEqual(["a/Deployment/x", "b/Deployment/z"]);
    expect(l.platforms.get("w1")!.kind).toBe("machine");
    for (const id of ["reserved/node/w1", "reserved/node/w2"]) {
      const t = l.targets.get(id)!;
      expect(Math.hypot(t.x, t.z)).toBeGreaterThan(l.ringRadius);
      expect(t.z).toBeLessThan(0); // at the back, with the API server
    }
  });
});
