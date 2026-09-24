import type { NodeState } from "./graph-state";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What a platform stands for. */
export type GroupBy = "namespace" | "machine";

export interface Platform {
  /** Namespace name or machine name, depending on the mode. */
  group: string;
  kind: GroupBy;
  center: Vec3;
  radius: number;
  angle: number;
  nodes: string[];
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const UNPLACED = "unplaced";

/** Fixed angles for the reserved anchors on the outer ring, world in front. */
const reservedAngles: Record<string, number> = {
  world: Math.PI / 2,
  ingress: Math.PI / 2 - 0.6,
  "kube-apiserver": -Math.PI / 2,
};

/**
 * Deterministic layout: platforms on a ring, workloads on a sunflower
 * spiral inside them, reserved entities on an outer ring. Nothing depends
 * on traffic, so a new flow never moves what is already there. Platforms
 * are namespaces or machines; switching only regroups.
 */
export class Layout {
  readonly platforms = new Map<string, Platform>();
  readonly targets = new Map<string, Vec3>();
  groupBy: GroupBy = "namespace";
  ringRadius = 14;
  outerRadius = 24;
  maxWorld = 24;

  /** The platform a workload belongs to in the current mode. */
  groupOf(n: NodeState): string {
    if (this.groupBy === "namespace") return n.ns;
    return n.machine || UNPLACED;
  }

  rebuild(nodes: Map<string, NodeState>): void {
    const byGroup = new Map<string, string[]>();
    const reserved: string[] = [];
    const machines: string[] = [];
    const world: string[] = [];
    for (const n of nodes.values()) {
      if (n.ns === "reserved") {
        if (n.kind === "world") world.push(n.id);
        else if (n.kind === "node" || n.kind === "host" || n.kind === "remote-node")
          machines.push(n.id);
        else reserved.push(n.id);
        continue;
      }
      const g = this.groupOf(n);
      let list = byGroup.get(g);
      if (!list) byGroup.set(g, (list = []));
      list.push(n.id);
    }
    const names = [...byGroup.keys()].sort((a, b) =>
      a === UNPLACED ? 1 : b === UNPLACED ? -1 : a < b ? -1 : 1,
    );
    this.platforms.clear();
    this.targets.clear();
    const count = names.length;
    let sumRadius = 0;
    const radii = names.map((g) => {
      const r = 2.2 + 0.7 * Math.sqrt(byGroup.get(g)!.length);
      sumRadius += r;
      return r;
    });
    // Ring long enough that neighbouring platforms keep a gap.
    this.ringRadius = Math.max(10, (sumRadius * 2 * 1.6) / (2 * Math.PI), 3.5 * count);
    this.outerRadius = this.ringRadius + 9;
    names.forEach((g, i) => {
      const angle = (i / Math.max(count, 1)) * Math.PI * 2 + Math.PI / count;
      const center = {
        x: Math.cos(angle) * this.ringRadius,
        y: 0,
        z: Math.sin(angle) * this.ringRadius,
      };
      const ids = byGroup.get(g)!.sort();
      const radius = radii[i]!;
      this.platforms.set(g, { group: g, kind: this.groupBy, center, radius, angle, nodes: ids });
      const n = ids.length;
      ids.forEach((id, k) => {
        const rr = n === 1 ? 0 : (radius - 0.6) * Math.sqrt((k + 0.5) / n);
        const th = k * GOLDEN + angle;
        this.targets.set(id, {
          x: center.x + Math.cos(th) * rr,
          y: 0.18,
          z: center.z + Math.sin(th) * rr,
        });
      });
    });
    reserved.sort().forEach((id) => {
      const kind = nodes.get(id)!.kind;
      const angle = reservedAngles[kind] ?? Math.PI + reserved.indexOf(id) * 0.5;
      this.targets.set(id, {
        x: Math.cos(angle) * this.outerRadius,
        y: 0.6,
        z: Math.sin(angle) * this.outerRadius,
      });
    });
    // The machines fan out at the back, either side of the API server.
    machines.sort((a, b) => nodes.get(a)!.name.localeCompare(nodes.get(b)!.name));
    const mSpread = Math.min(2.2, 0.32 * machines.length);
    machines.forEach((id, i) => {
      const t = machines.length === 1 ? 0.5 : i / (machines.length - 1);
      const side = t < 0.5 ? -1 : 1;
      const angle = -Math.PI / 2 + side * (0.45 + Math.abs(t - 0.5) * mSpread);
      const r = this.outerRadius + 1.5;
      this.targets.set(id, { x: Math.cos(angle) * r, y: 0.6, z: Math.sin(angle) * r });
    });
    world.sort();
    const shown = world.slice(0, this.maxWorld);
    const base = reservedAngles.world!;
    // Wide fan in front, alternating radii, so the labels do not stack.
    const spread = Math.min(2.4, 0.22 * shown.length);
    shown.forEach((id, i) => {
      const t = shown.length === 1 ? 0 : i / (shown.length - 1) - 0.5;
      const angle = base + t * spread;
      const r = this.outerRadius + 2.5 + (i % 3) * 2;
      this.targets.set(id, {
        x: Math.cos(angle) * r,
        y: 0.6 + (i % 2) * 0.8,
        z: Math.sin(angle) * r,
      });
    });
    for (const id of world.slice(this.maxWorld)) {
      this.targets.set(id, { x: 0, y: 0.6, z: this.outerRadius + 6 });
    }
  }

  /** Bézier control point: cross-platform arcs lift with distance. */
  static control(a: Vec3, b: Vec3, samePlatform: boolean, out: Vec3): Vec3 {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    out.x = (a.x + b.x) / 2;
    out.z = (a.z + b.z) / 2;
    out.y = (a.y + b.y) / 2 + (samePlatform ? 0.35 + dist * 0.15 : 2 + dist * 0.16);
    return out;
  }
}
