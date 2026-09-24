import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { theme } from "./theme";

export type FrameFn = (dt: number, elapsed: number) => void;

/** Renderer, camera, controls, post-processing and the frame loop. */
export class SceneHost {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly labels: CSS2DRenderer;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly resolution = new Vector2();
  private readonly frameFns: FrameFn[] = [];
  private last = performance.now();
  private elapsed = 0;
  private interacted = false;
  frames = 0;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, theme.maxPixelRatio));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(theme.background, 1);
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    container.appendChild(this.labels.domElement);

    this.camera = new PerspectiveCamera(50, 1, 0.1, 400);
    this.camera.position.set(0, 30, 46);
    this.scene.fog = new FogExp2(theme.fog, 0.008);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 160;
    this.controls.addEventListener("start", () => {
      this.interacted = true;
      this.controls.autoRotate = false;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new Vector2(1, 1),
      theme.bloom.strength,
      theme.bloom.radius,
      theme.bloom.threshold,
    );
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(starfield(), floorGlow());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  get autoRotating(): boolean {
    return !this.interacted;
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.resolution.set(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
  }

  onFrame(fn: FrameFn): void {
    this.frameFns.push(fn);
  }

  /** Move the camera so a sphere of the given radius around the origin fills the view. */
  fit(radius: number, animate = true): void {
    // Wide views need a little more distance: the near edge of the ring is
    // closer to the camera than the far one.
    const aspectPad = this.camera.aspect > 1.5 ? 0.98 : 0.88;
    const dist = (radius * aspectPad) / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (dir.lengthSq() === 0) dir.set(0, 0.6, 0.8);
    const target = dir.multiplyScalar(dist);
    // About 32 degrees above the ring: high enough to see the layout, low
    // enough that the arcs keep their height.
    target.y = dist * 0.5;
    const horiz = Math.hypot(target.x, target.z) || 1;
    const scale = (dist * 0.85) / horiz;
    target.x *= scale;
    target.z *= scale;
    if (!animate) {
      this.camera.position.copy(target);
      this.controls.target.set(0, 0, 0);
      return;
    }
    const from = this.camera.position.clone();
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(from, target, e);
      this.controls.target.lerp(new Vector3(), e);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  start(): void {
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.elapsed += dt;
      for (const fn of this.frameFns) fn(dt, this.elapsed);
      this.controls.update();
      this.composer.render();
      this.labels.render(this.scene, this.camera);
      this.frames++;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

/** A soft disc of light under the ring so the scene has a floor. */
function floorGlow(): Mesh {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(60, 110, 170, 0.34)");
  g.addColorStop(0.55, "rgba(40, 70, 130, 0.12)");
  g.addColorStop(1, "rgba(5, 7, 13, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  const mesh = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.3;
  mesh.scale.setScalar(90);
  mesh.name = "floor";
  return mesh;
}

function starfield(): Points {
  const n = 1600;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new Color();
  for (let i = 0; i < n; i++) {
    const r = 120 + Math.random() * 160;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 1.6 - 0.6);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    c.setHSL(0.58 + Math.random() * 0.1, 0.4, 0.5 + Math.random() * 0.4);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  const m = new PointsMaterial({
    size: 0.9,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  return new Points(g, m);
}
