/**
 * The old "Image Occlusion Enhanced" add-on (spec 0006 §2): one Anki note per box, sharing an
 * image and an "original mask" SVG that holds every box. Box IDs look like
 *   <figure id>-ao-<n>   (hide all, guess one)
 *   <figure id>-oa-<n>   (hide one, guess one)
 * Grouped boxes are a <g id="…-ao-n"> around several shapes. Pure: SVG text in, shapes out.
 */
import type { Mask } from "../occlusion";

export interface IoeShape {
  shape: Mask["shape"];
  /** Fractions of the image: rect/ellipse x y w h; poly x1 y1 x2 y2 … */
  coords: number[];
}

export interface IoeMasks {
  width: number;
  height: number;
  /** Box ID (e.g. "abc…-ao-3") → its shapes. */
  boxes: Map<string, IoeShape[]>;
}

/** Split "<figure>-ao-3" into its parts. */
export function parseIoeId(id: string): { figure: string; hideAll: boolean; n: number } | null {
  const m = /^(.+)-(ao|oa)-(\d+)$/.exec(id.trim());
  return m ? { figure: m[1], hideAll: m[2] === "ao", n: Number(m[3]) } : null;
}

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out.set(m[1].toLowerCase(), m[3] ?? m[4] ?? "");
  return out;
}

export function parseIoeSvg(svg: string): IoeMasks | null {
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) return null;
  const ra = attrs(root[0]);
  const width = parseFloat(ra.get("width") ?? "");
  const height = parseFloat(ra.get("height") ?? "");
  if (!(width > 0 && height > 0)) return null;
  const boxes = new Map<string, IoeShape[]>();
  const add = (id: string, s: IoeShape) => boxes.set(id, [...(boxes.get(id) ?? []), s]);
  const n = (a: Map<string, string>, k: string) => parseFloat(a.get(k) ?? "NaN");

  // Walk the tags in order, remembering the id of the <g> we're inside (for grouped boxes).
  const groups: Array<string | null> = [];
  for (const m of svg.matchAll(/<(\/?)(g|rect|ellipse|circle|polygon)\b([^>]*?)(\/?)>/gi)) {
    const [, close, rawName, body, selfClose] = m;
    const name = rawName.toLowerCase();
    if (name === "g") {
      if (close) groups.pop();
      else if (!selfClose) groups.push(attrs(body).get("id") ?? null);
      continue;
    }
    if (close) continue;
    const a = attrs(body);
    const owner = [...groups].reverse().find((g) => g && parseIoeId(g)) ?? a.get("id");
    if (!owner || !parseIoeId(owner)) continue;
    let shape: IoeShape | null = null;
    if (name === "rect") {
      const c = [n(a, "x") / width, n(a, "y") / height, n(a, "width") / width, n(a, "height") / height];
      if (c.every(Number.isFinite) && c[2] > 0 && c[3] > 0) shape = { shape: "rect", coords: c };
    } else if (name === "ellipse" || name === "circle") {
      const rx = name === "circle" ? n(a, "r") : n(a, "rx");
      const ry = name === "circle" ? n(a, "r") : n(a, "ry");
      const c = [(n(a, "cx") - rx) / width, (n(a, "cy") - ry) / height, (2 * rx) / width, (2 * ry) / height];
      if (c.every(Number.isFinite) && c[2] > 0 && c[3] > 0) shape = { shape: "ellipse", coords: c };
    } else {
      const pts = (a.get("points") ?? "").trim().split(/[\s,]+/).map(Number);
      const c = pts.map((v, i) => v / (i % 2 === 0 ? width : height));
      if (c.length >= 6 && c.length % 2 === 0 && c.every(Number.isFinite)) shape = { shape: "poly", coords: c };
    }
    if (shape) add(owner, { ...shape, coords: shape.coords.map((v) => Math.min(1, Math.max(0, v))) });
  }
  return { width, height, boxes };
}
