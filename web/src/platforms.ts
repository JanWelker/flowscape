import {
  AdditiveBlending,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  TorusGeometry,
} from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Layout } from "./layout";
import { namespaceColor } from "./theme";

interface PlatformObjects {
  group: Group;
  disc: Mesh<CylinderGeometry, MeshPhysicalMaterial>;
  rim: Mesh<TorusGeometry, MeshBasicMaterial>;
  label: CSS2DObject;
  dimmed: boolean;
}

const discGeometry = new CylinderGeometry(1, 1, 0.08, 72, 1);
const rimGeometry = new TorusGeometry(1, 0.03, 6, 128);

/** One translucent disc and glowing rim per namespace. */
export class Platforms {
  readonly group = new Group();
  private readonly items = new Map<string, PlatformObjects>();

  sync(layout: Layout): void {
    for (const [ns, item] of this.items) {
      if (!layout.platforms.has(ns)) {
        this.group.remove(item.group);
        item.label.element.remove();
        this.items.delete(ns);
      }
    }
    for (const p of layout.platforms.values()) {
      let item = this.items.get(p.ns);
      if (!item) {
        const color = namespaceColor(p.ns);
        const disc = new Mesh(
          discGeometry,
          new MeshPhysicalMaterial({
            color,
            transparent: true,
            opacity: 0.16,
            roughness: 0.25,
            metalness: 0.4,
            depthWrite: false,
          }),
        );
        const rim = new Mesh(
          rimGeometry,
          new MeshBasicMaterial({
            color: namespaceColor(p.ns, 0.9, 0.62),
            transparent: true,
            opacity: 0.9,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
        );
        rim.rotation.x = Math.PI / 2;
        const el = document.createElement("div");
        el.className = "ns-label";
        el.textContent = p.ns;
        el.style.setProperty("--ns", `#${color.getHexString()}`);
        const label = new CSS2DObject(el);
        const group = new Group();
        group.add(disc, rim, label);
        item = { group, disc, rim, label, dimmed: false };
        this.items.set(p.ns, item);
        this.group.add(group);
      }
      item.group.position.set(p.center.x, 0, p.center.z);
      item.disc.scale.set(p.radius, 1, p.radius);
      item.rim.scale.set(p.radius, p.radius, 1);
      item.label.position.set(0, 0.05, p.radius + 0.9);
    }
  }

  setDimmed(ns: string, dimmed: boolean): void {
    const item = this.items.get(ns);
    if (!item || item.dimmed === dimmed) return;
    item.dimmed = dimmed;
    item.disc.material.opacity = dimmed ? 0.03 : 0.16;
    item.rim.material.opacity = dimmed ? 0.15 : 0.9;
    item.label.element.classList.toggle("dimmed", dimmed);
  }
}
