import { Raycaster, Vector2, type Camera } from "three";
import type { Edges } from "./edges";
import type { Nodes } from "./nodes";

export type Pick = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

/** Pointer → node or edge id, throttled. */
export class Picking {
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();
  private pending: { x: number; y: number } | null = null;
  private last = 0;
  hovered: Pick = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly nodes: Nodes,
    private readonly edges: Edges,
    private readonly onHover: (p: Pick) => void,
    onClick: (p: Pick) => void,
  ) {
    this.ray.params.Line2 = { threshold: 6 };
    canvas.addEventListener("pointermove", (ev) => {
      this.pending = { x: ev.clientX, y: ev.clientY };
    });
    canvas.addEventListener("pointerleave", () => {
      this.pending = null;
      this.setHovered(null);
    });
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (ev) => {
      down = { x: ev.clientX, y: ev.clientY };
    });
    canvas.addEventListener("pointerup", (ev) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return;
      down = null;
      onClick(this.pick(ev.clientX, ev.clientY));
    });
  }

  update(now: number): void {
    if (!this.pending || now - this.last < 33) return;
    this.last = now;
    const { x, y } = this.pending;
    this.pending = null;
    this.setHovered(this.pick(x, y));
  }

  private setHovered(p: Pick): void {
    const same = p?.kind === this.hovered?.kind && p?.id === this.hovered?.id;
    if (same) return;
    this.hovered = p;
    this.canvas.style.cursor = p ? "pointer" : "";
    this.onHover(p);
  }

  pick(x: number, y: number): Pick {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const hits = this.ray.intersectObjects([this.nodes.mesh, this.nodes.reservedMesh], false);
    for (const h of hits) {
      if (h.instanceId === undefined) continue;
      const id = this.nodes.idAt(h.instanceId);
      if (id) return { kind: "node", id };
    }
    const lines = this.ray.intersectObjects(
      this.edges.batches.map((b) => b.mesh),
      false,
    );
    for (const h of lines) {
      const batch = h.object.userData.batch as number;
      if (h.faceIndex === undefined || h.faceIndex === null) continue;
      const id = this.edges.idAt(batch, h.faceIndex);
      if (id) return { kind: "edge", id };
    }
    return null;
  }
}
