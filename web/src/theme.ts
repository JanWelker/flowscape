import { Color } from "three";

export const theme = {
  background: 0x05070d,
  fog: 0x05070d,
  forwarded: new Color("#35d6ff"),
  dropped: new Color("#ff3b5c"),
  audit: new Color("#ffb020"),
  error: new Color("#c084fc"),
  reserved: new Color("#9aa7b8"),
  label: "rgba(226, 232, 240, 0.9)",
  bloom: { strength: 1.15, radius: 0.45, threshold: 0.55 },
  maxPixelRatio: 1.5,
};

const hueCache = new Map<string, number>();

/** Golden-angle hue from a namespace name, stable across reloads. */
export function namespaceHue(ns: string): number {
  let h = hueCache.get(ns);
  if (h !== undefined) return h;
  let x = 2166136261;
  for (let i = 0; i < ns.length; i++) {
    x ^= ns.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  h = ((x % 1000) / 1000 + 0.618033988749895 * (x % 7)) % 1;
  hueCache.set(ns, h);
  return h;
}

export function namespaceColor(ns: string, s = 0.7, l = 0.6): Color {
  if (ns === "reserved") return theme.reserved.clone();
  return new Color().setHSL(namespaceHue(ns), s, l);
}

/** Blend the verdict colours by their share of an edge's traffic. */
/** Machines get a second, paler family of hues so a halo tint never
 * reads as a namespace. */
export function machineColor(name: string): Color {
  return new Color().setHSL((namespaceHue(name) + 0.37) % 1, 0.5, 0.72);
}

export function verdictColor(f: number, d: number, a: number, e: number, out = new Color()): Color {
  const total = f + d + a + e;
  if (total <= 0) return out.copy(theme.forwarded);
  out.copy(theme.forwarded).multiplyScalar(f / total);
  out.r += (theme.dropped.r * d + theme.audit.r * a + theme.error.r * e) / total;
  out.g += (theme.dropped.g * d + theme.audit.g * a + theme.error.g * e) / total;
  out.b += (theme.dropped.b * d + theme.audit.b * a + theme.error.b * e) / total;
  return out;
}

export function verdictCssColor(v: number): string {
  switch (v) {
    case 1:
      return "#ff3b5c";
    case 2:
      return "#ffb020";
    case 3:
      return "#c084fc";
    default:
      return "#35d6ff";
  }
}
