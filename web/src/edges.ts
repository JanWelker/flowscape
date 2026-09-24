import {
  AdditiveBlending,
  Box3,
  Color,
  type InterleavedBuffer,
  type InterleavedBufferAttribute,
  Sphere,
  Vector3,
} from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { EdgeState } from "./graph-state";
import { Layout, type Vec3 } from "./layout";
import type { Nodes } from "./nodes";
import { verdictColor } from "./theme";

export const SEGMENTS = 14;
const CAPACITY = 2048; // per width batch
const WIDTHS = [1.2, 2.6, 5];

interface Batch {
  geom: LineSegmentsGeometry;
  mesh: LineSegments2;
  pos: Float32Array;
  col: Float32Array;
  posBuf: InterleavedBuffer;
  colBuf: InterleavedBuffer;
  free: number[];
  posDirty: boolean;
  colDirty: boolean;
}

export interface EdgeSlot {
  id: string;
  batch: number;
  index: number;
  /** Global control-point slot for the particles. */
  cp: number;
  same: boolean;
  color: Color;
  alpha: number;
  hidden: boolean;
  rate: number;
}

const a = new Vector3();
const b = new Vector3();
const c: Vec3 = { x: 0, y: 0, z: 0 };
const white = new Color(1, 1, 1);

/** Arcs between nodes, batched into three fat-line meshes by width. */
export class Edges {
  readonly batches: Batch[] = [];
  readonly slots = new Map<string, EdgeSlot>();
  /** p0, c, p1 per global slot, read by the particle system. */
  readonly controlPoints = new Float32Array(CAPACITY * WIDTHS.length * 9);
  readonly cpValid = new Uint8Array(CAPACITY * WIDTHS.length);
  readonly bySlot: (EdgeSlot | undefined)[] = new Array(CAPACITY * WIDTHS.length);
  selected: string | null = null;
  hovered: string | null = null;
  private emphasisedNode: string | null = null;

  constructor(private readonly nodes: Nodes) {
    for (let w = 0; w < WIDTHS.length; w++) {
      const pos = new Float32Array(CAPACITY * SEGMENTS * 6);
      const col = new Float32Array(CAPACITY * SEGMENTS * 6);
      const geom = new LineSegmentsGeometry();
      geom.setPositions(pos);
      geom.setColors(col);
      // Segments are rewritten in place; the bounds computed from zeros
      // would make every raycast miss.
      geom.boundingSphere = new Sphere(new Vector3(), 1e4);
      geom.boundingBox = new Box3(new Vector3(-1e4, -1e4, -1e4), new Vector3(1e4, 1e4, 1e4));
      const mat = new LineMaterial({
        linewidth: WIDTHS[w]!,
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        worldUnits: false,
        fog: true,
      });
      const mesh = new LineSegments2(geom, mat);
      mesh.frustumCulled = false;
      mesh.userData.batch = w;
      const free: number[] = [];
      for (let i = CAPACITY - 1; i >= 0; i--) free.push(i);
      this.batches.push({
        geom,
        mesh,
        pos,
        col,
        posBuf: (geom.getAttribute("instanceStart") as InterleavedBufferAttribute).data,
        colBuf: (geom.getAttribute("instanceColorStart") as InterleavedBufferAttribute).data,
        free,
        posDirty: false,
        colDirty: false,
      });
    }
  }

  setResolution(w: number, h: number): void {
    for (const bt of this.batches) bt.mesh.material.resolution.set(w, h);
  }

  add(e: EdgeState, sameNamespace: boolean): void {
    if (this.slots.has(e.id)) return;
    this.place(e.id, 0, sameNamespace);
  }

  private place(id: string, batch: number, same: boolean): EdgeSlot | undefined {
    const bt = this.batches[batch]!;
    const index = bt.free.pop();
    if (index === undefined) return undefined;
    const cp = batch * CAPACITY + index;
    const slot: EdgeSlot = {
      id,
      batch,
      index,
      cp,
      same,
      color: new Color(),
      alpha: 1,
      hidden: false,
      rate: 0,
    };
    this.slots.set(id, slot);
    this.bySlot[cp] = slot;
    return slot;
  }

  remove(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    this.clear(slot);
  }

  private clear(slot: EdgeSlot): void {
    const bt = this.batches[slot.batch]!;
    bt.pos.fill(0, slot.index * SEGMENTS * 6, (slot.index + 1) * SEGMENTS * 6);
    bt.col.fill(0, slot.index * SEGMENTS * 6, (slot.index + 1) * SEGMENTS * 6);
    bt.posDirty = bt.colDirty = true;
    bt.free.push(slot.index);
    this.cpValid[slot.cp] = 0;
    this.bySlot[slot.cp] = undefined;
  }

  idAt(batch: number, segmentIndex: number): string | null {
    const index = Math.floor(segmentIndex / SEGMENTS);
    return this.bySlot[batch * CAPACITY + index]?.id ?? null;
  }

  /** Move an edge to the width batch its rate calls for. */
  setRate(id: string, rate: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.rate = rate;
    const want = rate < 1 ? 0 : rate < 20 ? 1 : 2;
    if (want === slot.batch) return;
    const same = slot.same;
    const color = slot.color.clone();
    this.slots.delete(id);
    this.clear(slot);
    const moved = this.place(id, want, same);
    if (moved) {
      moved.color.copy(color);
      moved.alpha = slot.alpha;
      moved.hidden = slot.hidden;
      moved.rate = rate;
    }
  }

  setColor(id: string, f: number, d: number, a: number, e: number, alpha: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    verdictColor(f, d, a, e, slot.color);
    slot.alpha = alpha;
    this.batches[slot.batch]!.colDirty = true;
  }

  setHidden(id: string, h: boolean): void {
    const slot = this.slots.get(id);
    if (slot && slot.hidden !== h) {
      slot.hidden = h;
      this.batches[slot.batch]!.colDirty = true;
    }
  }

  /** Highlight every edge touching a node; null clears. */
  emphasiseNode(id: string | null): void {
    this.emphasisedNode = id;
    for (const bt of this.batches) bt.colDirty = true;
  }

  update(edges: Map<string, EdgeState>, layoutMoving: boolean): void {
    const anyEmphasis =
      this.selected !== null || this.hovered !== null || this.emphasisedNode !== null;
    for (const slot of this.slots.values()) {
      const e = edges.get(slot.id);
      if (!e) continue;
      const bt = this.batches[slot.batch]!;
      if (layoutMoving || !this.cpValid[slot.cp]) {
        if (!this.nodes.positionOf(e.src, a) || !this.nodes.positionOf(e.dst, b)) continue;
        Layout.control(a, b, slot.same, c);
        const o = slot.cp * 9;
        this.controlPoints[o] = a.x;
        this.controlPoints[o + 1] = a.y;
        this.controlPoints[o + 2] = a.z;
        this.controlPoints[o + 3] = c.x;
        this.controlPoints[o + 4] = c.y;
        this.controlPoints[o + 5] = c.z;
        this.controlPoints[o + 6] = b.x;
        this.controlPoints[o + 7] = b.y;
        this.controlPoints[o + 8] = b.z;
        this.cpValid[slot.cp] = 1;
        const base = slot.index * SEGMENTS * 6;
        for (let s = 0; s < SEGMENTS; s++) {
          const t0 = s / SEGMENTS;
          const t1 = (s + 1) / SEGMENTS;
          const p = base + s * 6;
          bt.pos[p] = bez(a.x, c.x, b.x, t0);
          bt.pos[p + 1] = bez(a.y, c.y, b.y, t0);
          bt.pos[p + 2] = bez(a.z, c.z, b.z, t0);
          bt.pos[p + 3] = bez(a.x, c.x, b.x, t1);
          bt.pos[p + 4] = bez(a.y, c.y, b.y, t1);
          bt.pos[p + 5] = bez(a.z, c.z, b.z, t1);
        }
        bt.posDirty = true;
      }
      if (bt.colDirty || anyEmphasis) {
        const emphasised =
          slot.id === this.selected ||
          slot.id === this.hovered ||
          (this.emphasisedNode !== null &&
            (e.src === this.emphasisedNode || e.dst === this.emphasisedNode));
        let k = slot.hidden ? 0 : slot.alpha;
        if (anyEmphasis) k *= emphasised ? 1.6 : 0.18;
        const r = (emphasised ? white.r * 0.4 + slot.color.r * 0.6 : slot.color.r) * k;
        const g = (emphasised ? white.g * 0.4 + slot.color.g * 0.6 : slot.color.g) * k;
        const bl = (emphasised ? white.b * 0.4 + slot.color.b * 0.6 : slot.color.b) * k;
        const base = slot.index * SEGMENTS * 6;
        for (let s = 0; s < SEGMENTS; s++) {
          // Brighter towards the destination so direction reads at a glance.
          const f0 = 0.45 + 0.55 * (s / SEGMENTS);
          const f1 = 0.45 + 0.55 * ((s + 1) / SEGMENTS);
          const p = base + s * 6;
          bt.col[p] = r * f0;
          bt.col[p + 1] = g * f0;
          bt.col[p + 2] = bl * f0;
          bt.col[p + 3] = r * f1;
          bt.col[p + 4] = g * f1;
          bt.col[p + 5] = bl * f1;
        }
        bt.colDirty = true;
      }
    }
    for (const bt of this.batches) {
      if (bt.posDirty) bt.posBuf.needsUpdate = true;
      if (bt.colDirty) bt.colBuf.needsUpdate = true;
      bt.posDirty = bt.colDirty = false;
    }
  }
}

function bez(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}
