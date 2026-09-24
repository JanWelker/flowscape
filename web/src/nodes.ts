import {
  AdditiveBlending,
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Object3D,
  Sphere,
  Vector3,
} from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { NodeState } from "./graph-state";
import type { Vec3 } from "./layout";
import { machineColor, namespaceColor, theme } from "./theme";

const CAPACITY = 2048;
const LERP = 6;

interface Slot {
  index: number;
  id: string;
  ns: string;
  reserved: boolean;
  target: Vec3;
  /** 0..1 activity for brightness and scale. */
  activity: number;
  hidden: boolean;
  label: CSS2DObject | null;
  labelText: string;
  base: Color;
  /** Cluster node the workload runs on; halo tint. */
  machine: string;
  /** Reserved machine anchor Relay cannot reach. */
  unavailable: boolean;
}

const red = new Color("#ff3b5c");

const dummy = new Object3D();
const tmpColor = new Color();
const hidden = new Matrix4().makeScale(0, 0, 0);

/** Every workload as one instance of a glowing polyhedron, plus a halo. */
export class Nodes {
  readonly mesh: InstancedMesh;
  readonly halo: InstancedMesh;
  readonly reservedMesh: InstancedMesh;
  readonly positions = new Float32Array(CAPACITY * 3);
  private readonly slots = new Map<string, Slot>();
  private readonly byIndex: (Slot | undefined)[] = new Array(CAPACITY);
  private readonly free: number[] = [];
  private labelBudget = 40;
  selected: string | null = null;
  hovered: string | null = null;
  /** Machine whose workloads are emphasised, null for none. */
  emphasisedMachine: string | null = null;

  constructor() {
    for (let i = CAPACITY - 1; i >= 0; i--) this.free.push(i);
    const geom = new IcosahedronGeometry(0.3, 2);
    const mat = new MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.1,
    });
    this.mesh = new InstancedMesh(geom, mat, CAPACITY);
    this.mesh.frustumCulled = false;
    this.halo = new InstancedMesh(
      new IcosahedronGeometry(0.3, 1),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.22,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
      CAPACITY,
    );
    this.halo.frustumCulled = false;
    this.reservedMesh = new InstancedMesh(
      new OctahedronGeometry(0.42, 0),
      new MeshStandardMaterial({
        color: 0xdde3ea,
        emissive: 0xffffff,
        emissiveIntensity: 0.55,
        roughness: 0.2,
        metalness: 0.6,
        flatShading: true,
      }),
      CAPACITY,
    );
    this.reservedMesh.frustumCulled = false;
    // Instances move every frame; a fixed generous sphere keeps raycasts valid.
    const everything = new Sphere(new Vector3(), 1e4);
    this.mesh.boundingSphere = everything;
    this.halo.boundingSphere = everything;
    this.reservedMesh.boundingSphere = everything;
    for (let i = 0; i < CAPACITY; i++) {
      this.mesh.setMatrixAt(i, hidden);
      this.halo.setMatrixAt(i, hidden);
      this.reservedMesh.setMatrixAt(i, hidden);
      this.mesh.setColorAt(i, tmpColor.set(0));
      this.halo.setColorAt(i, tmpColor.set(0));
      this.reservedMesh.setColorAt(i, tmpColor.set(0));
    }
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  idAt(index: number): string | null {
    return this.byIndex[index]?.id ?? null;
  }

  add(n: NodeState, target: Vec3): void {
    if (this.slots.has(n.id)) return;
    const index = this.free.pop();
    if (index === undefined) return;
    const reserved = n.ns === "reserved";
    const slot: Slot = {
      index,
      id: n.id,
      ns: n.ns,
      reserved,
      target,
      activity: 0.4,
      hidden: false,
      label: null,
      labelText: n.name,
      base: reserved ? theme.reserved.clone() : namespaceColor(n.ns, 0.8, 0.62),
      machine: n.machine ?? "",
      unavailable: false,
    };
    this.positions[index * 3] = target.x;
    this.positions[index * 3 + 1] = target.y + 6; // drop in from above
    this.positions[index * 3 + 2] = target.z;
    this.slots.set(n.id, slot);
    this.byIndex[index] = slot;
  }

  remove(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    this.byIndex[slot.index] = undefined;
    this.free.push(slot.index);
    this.mesh.setMatrixAt(slot.index, hidden);
    this.halo.setMatrixAt(slot.index, hidden);
    this.reservedMesh.setMatrixAt(slot.index, hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
    this.reservedMesh.instanceMatrix.needsUpdate = true;
    if (slot.label) {
      slot.label.element.remove();
      slot.label.removeFromParent();
    }
  }

  setTarget(id: string, target: Vec3): void {
    const slot = this.slots.get(id);
    if (slot) slot.target = target;
  }

  setActivity(id: string, activity: number): void {
    const slot = this.slots.get(id);
    if (slot) slot.activity = activity;
  }

  setHidden(id: string, h: boolean): void {
    const slot = this.slots.get(id);
    if (slot) slot.hidden = h;
  }

  setMachine(id: string, machine: string): void {
    const slot = this.slots.get(id);
    if (slot) slot.machine = machine;
  }

  machineOf(id: string): string {
    return this.slots.get(id)?.machine ?? "";
  }

  /** Mark the reserved anchors of machines Relay lost. */
  setUnavailable(names: string[]): void {
    const set = new Set(names);
    for (const slot of this.slots.values()) {
      if (slot.reserved) slot.unavailable = set.has(slot.labelText);
    }
  }

  /** Current (lerped) position of a node. */
  positionOf(id: string, out: Vector3): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    out.set(
      this.positions[slot.index * 3]!,
      this.positions[slot.index * 3 + 1]!,
      this.positions[slot.index * 3 + 2]!,
    );
    return true;
  }

  update(dt: number, cameraPos: Vector3, root: Object3D): void {
    const k = Math.min(1, LERP * dt);
    const labelDist2 = 18 * 18;
    const near: { slot: Slot; d2: number }[] = [];
    for (const slot of this.slots.values()) {
      const i = slot.index * 3;
      this.positions[i] = this.positions[i]! + (slot.target.x - this.positions[i]!) * k;
      this.positions[i + 1] = this.positions[i + 1]! + (slot.target.y - this.positions[i + 1]!) * k;
      this.positions[i + 2] = this.positions[i + 2]! + (slot.target.z - this.positions[i + 2]!) * k;
      const x = this.positions[i]!;
      const y = this.positions[i + 1]!;
      const z = this.positions[i + 2]!;
      const onMachine =
        this.emphasisedMachine !== null &&
        (slot.machine === this.emphasisedMachine ||
          (slot.reserved && slot.labelText === this.emphasisedMachine));
      const emphasised = slot.id === this.selected || slot.id === this.hovered || onMachine;
      const dimmed = this.emphasisedMachine !== null && !onMachine;
      const s = slot.hidden
        ? 0
        : (slot.reserved ? 1 : 0.75 + slot.activity * 0.9) *
          (emphasised ? 1.35 : 1) *
          (dimmed ? 0.7 : 1);
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(s);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      const target = slot.reserved ? this.reservedMesh : this.mesh;
      const other = slot.reserved ? this.mesh : this.reservedMesh;
      target.setMatrixAt(slot.index, dummy.matrix);
      other.setMatrixAt(slot.index, hidden);
      dummy.scale.setScalar(s * (1.9 + slot.activity * 1.2));
      dummy.updateMatrix();
      this.halo.setMatrixAt(slot.index, slot.hidden || slot.reserved ? hidden : dummy.matrix);
      tmpColor.copy(slot.unavailable ? red : slot.base);
      if (emphasised) tmpColor.lerp(new Color(1, 1, 1), 0.7);
      else tmpColor.multiplyScalar((0.55 + slot.activity * 0.9) * (dimmed ? 0.35 : 1));
      target.setColorAt(slot.index, tmpColor);
      // The halo carries the machine's tint, the core the namespace hue.
      if (slot.machine && !emphasised) {
        tmpColor
          .copy(machineColor(slot.machine))
          .multiplyScalar((0.5 + slot.activity * 0.8) * (dimmed ? 0.35 : 1));
      }
      this.halo.setColorAt(slot.index, tmpColor);
      if (!slot.hidden) {
        const d2 = (cameraPos.x - x) ** 2 + (cameraPos.y - y) ** 2 + (cameraPos.z - z) ** 2;
        if (slot.reserved || emphasised || d2 < labelDist2)
          near.push({ slot, d2: emphasised ? -1 : d2 });
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
    this.reservedMesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true;
    if (this.reservedMesh.instanceColor) this.reservedMesh.instanceColor.needsUpdate = true;
    this.updateLabels(near, root);
  }

  private labelTick = 0;
  private updateLabels(near: { slot: Slot; d2: number }[], root: Object3D): void {
    if (++this.labelTick % 12 !== 0) return;
    near.sort((a, b) => a.d2 - b.d2);
    const keep = new Set(near.slice(0, this.labelBudget).map((n) => n.slot));
    for (const slot of this.slots.values()) {
      const want = keep.has(slot);
      if (want && !slot.label) {
        const el = document.createElement("div");
        el.className = "node-label" + (slot.reserved ? " reserved" : "");
        el.textContent = slot.labelText;
        slot.label = new CSS2DObject(el);
        slot.label.center.set(0.5, 1.6);
        root.add(slot.label);
      } else if (!want && slot.label) {
        slot.label.element.remove();
        slot.label.removeFromParent();
        slot.label = null;
      }
      if (slot.label) {
        const i = slot.index * 3;
        slot.label.position.set(this.positions[i]!, this.positions[i + 1]!, this.positions[i + 2]!);
        slot.label.element.classList.toggle(
          "active",
          slot.id === this.selected || slot.id === this.hovered,
        );
      }
    }
  }
}
