import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
} from "three";
import type { Edges } from "./edges";
import { theme } from "./theme";

const CAPACITY = 16384;

const vertex = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (320.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const fragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    float a = smoothstep(1.0, 0.15, r);
    gl_FragColor = vec4(vColor * a * 1.6, a);
  }
`;

const colors = [theme.forwarded, theme.dropped, theme.audit, theme.error].map((c) => c.clone());
const tmp = new Color();

/** Sparks travelling along the edge arcs. */
export class Particles {
  readonly points: Points;
  private readonly pos = new Float32Array(CAPACITY * 3);
  private readonly col = new Float32Array(CAPACITY * 3);
  private readonly size = new Float32Array(CAPACITY);
  private readonly t = new Float32Array(CAPACITY);
  private readonly speed = new Float32Array(CAPACITY);
  private readonly cp = new Int32Array(CAPACITY);
  private readonly verdict = new Uint8Array(CAPACITY);
  private readonly baseSize = new Float32Array(CAPACITY);
  private alive = 0;
  private readonly geom: BufferGeometry;

  constructor(private readonly edges: Edges) {
    this.geom = new BufferGeometry();
    this.geom.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    this.geom.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    this.geom.setAttribute("size", new Float32BufferAttribute(this.size, 1));
    this.geom.setDrawRange(0, 0);
    const mat = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geom, mat);
    this.points.frustumCulled = false;
  }

  get count(): number {
    return this.alive;
  }

  spawn(cpSlot: number, verdict: number, big = false): void {
    if (this.alive >= CAPACITY || !this.edges.cpValid[cpSlot]) return;
    const i = this.alive++;
    this.t[i] = 0;
    this.cp[i] = cpSlot;
    this.verdict[i] = verdict;
    const base = verdict === 2 ? 0.55 : 0.8;
    this.speed[i] = base * (0.85 + Math.random() * 0.3);
    this.baseSize[i] = (verdict === 0 ? 0.55 : 0.8) * (big ? 1.6 : 1) * (0.8 + Math.random() * 0.4);
    this.size[i] = this.baseSize[i]!;
    tmp.copy(colors[verdict] ?? colors[0]!);
    this.col[i * 3] = tmp.r;
    this.col[i * 3 + 1] = tmp.g;
    this.col[i * 3 + 2] = tmp.b;
  }

  update(dt: number): void {
    const cps = this.edges.controlPoints;
    let i = 0;
    while (i < this.alive) {
      const slot = this.cp[i]!;
      if (!this.edges.cpValid[slot]) {
        this.kill(i);
        continue;
      }
      let t = this.t[i]! + this.speed[i]! * dt;
      const v = this.verdict[i]!;
      let fade = 1;
      if (v === 1) {
        // Dropped: stops short and bursts.
        if (t > 0.72) {
          const k = (t - 0.72) / 0.14;
          this.size[i] = this.baseSize[i]! * (1 + k * 3);
          fade = 1 - k;
          if (k >= 1) {
            this.kill(i);
            continue;
          }
          t = Math.min(t, 0.72 + 0.14);
        }
      } else if (t >= 1) {
        this.kill(i);
        continue;
      } else {
        const tail = 1 - Math.max(0, (t - 0.9) / 0.1);
        fade = Math.min(1, t / 0.08) * tail;
        this.size[i] = this.baseSize[i]!;
      }
      this.t[i] = t;
      const o = slot * 9;
      const u = 1 - t;
      const w0 = u * u;
      const w1 = 2 * u * t;
      const w2 = t * t;
      this.pos[i * 3] = w0 * cps[o]! + w1 * cps[o + 3]! + w2 * cps[o + 6]!;
      this.pos[i * 3 + 1] = w0 * cps[o + 1]! + w1 * cps[o + 4]! + w2 * cps[o + 7]!;
      this.pos[i * 3 + 2] = w0 * cps[o + 2]! + w1 * cps[o + 5]! + w2 * cps[o + 8]!;
      tmp.copy(colors[v] ?? colors[0]!).multiplyScalar(fade);
      this.col[i * 3] = tmp.r;
      this.col[i * 3 + 1] = tmp.g;
      this.col[i * 3 + 2] = tmp.b;
      i++;
    }
    this.geom.setDrawRange(0, this.alive);
    (this.geom.getAttribute("position") as Float32BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("color") as Float32BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("size") as Float32BufferAttribute).needsUpdate = true;
  }

  private kill(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    this.t[i] = this.t[last]!;
    this.speed[i] = this.speed[last]!;
    this.cp[i] = this.cp[last]!;
    this.verdict[i] = this.verdict[last]!;
    this.baseSize[i] = this.baseSize[last]!;
    this.size[i] = this.size[last]!;
    this.pos[i * 3] = this.pos[last * 3]!;
    this.pos[i * 3 + 1] = this.pos[last * 3 + 1]!;
    this.pos[i * 3 + 2] = this.pos[last * 3 + 2]!;
    this.col[i * 3] = this.col[last * 3]!;
    this.col[i * 3 + 1] = this.col[last * 3 + 1]!;
    this.col[i * 3 + 2] = this.col[last * 3 + 2]!;
  }
}
