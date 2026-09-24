import type { NodeState } from "./graph-state";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Platform {
  ns: string;
  center: Vec3;
  radius: number;
  angle: number;
  nodes: string[];
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Fixed angles for the reserved anchors on the outer ring, world in front. */
const reservedAngles: Record<string, number> = {
  world: Math.PI / 2,
  ingress: Math.PI / 2 - 0.6,
  "kube-apiserver": -Math.PI / 2,
  host: -Math.PI / 2 + 0.8,
  "remote-node": -Math.PI / 2 - 0.8,
};

/**
 * Deterministic layout: namespaces on a ring, workloads on a sunflower
 * spiral inside their platform, reserved entities on an outer ring. Nothing
 * depends on traffic, so a new flow never moves what is already there.
 */
export class Layout {
  readonly platforms = new Map<string, Platform>();
  readonly targets = new Map<string, Vec3>();
  ringRadius = 14;
  outerRadius = 24;
  maxWorld = 24;

  rebuild(nodes: Map<string, NodeState>): void {
    const byNs = new Map<string, string[]>();
    const reserved: string[] = [];
    const world: string[] = [];
    for (const n of nodes.values()) {
      if (n.ns === "reserved") {
        if (n.kind === "world") world.push(n.id);
        else reserved.push(n.id);
        continue;
      }
      let list = byNs.get(n.ns);
      if (!list) byNs.set(n.ns, (list = []));
      list.push(n.id);
    }
    const names = [...byNs.keys()].sort();
    this.platforms.clear();
    this.targets.clear();
    const count = names.length;
    let sumRadius = 0;
    const radii = names.map((ns) => {
      const r = 2.2 + 0.7 * Math.sqrt(byNs.get(ns)!.length);
      sumRadius += r;
      return r;
    });
    // Ring long enough that neighbouring platforms keep a gap.
    this.ringRadius = Math.max(10, (sumRadius * 2 * 1.6) / (2 * Math.PI), 3.5 * count);
    this.outerRadius = this.ringRadius + 9;
    names.forEach((ns, i) => {
      const angle = (i / Math.max(count, 1)) * Math.PI * 2 + Math.PI / count;
      const center = {
        x: Math.cos(angle) * this.ringRadius,
        y: 0,
        z: Math.sin(angle) * this.ringRadius,
      };
      const ids = byNs.get(ns)!.sort();
      const radius = radii[i]!;
      this.platforms.set(ns, { ns, center, radius, angle, nodes: ids });
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
    world.sort();
    const shown = world.slice(0, this.maxWorld);
    const base = reservedAngles.world!;
    const spread = Math.min(1.6, 0.14 * shown.length);
    shown.forEach((id, i) => {
      const t = shown.length === 1 ? 0 : i / (shown.length - 1) - 0.5;
      const angle = base + t * spread;
      const r = this.outerRadius + 3 + (i % 2) * 1.5;
      this.targets.set(id, {
        x: Math.cos(angle) * r,
        y: 0.6 + (i % 3) * 0.5,
        z: Math.sin(angle) * r,
      });
    });
    for (const id of world.slice(this.maxWorld)) {
      this.targets.set(id, { x: 0, y: 0.6, z: this.outerRadius + 6 });
    }
  }

  /** Bézier control point: cross-platform arcs lift with distance. */
  static control(a: Vec3, b: Vec3, sameNamespace: boolean, out: Vec3): Vec3 {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    out.x = (a.x + b.x) / 2;
    out.z = (a.z + b.z) / 2;
    out.y = (a.y + b.y) / 2 + (sameNamespace ? 0.35 + dist * 0.15 : 2 + dist * 0.16);
    return out;
  }
}
