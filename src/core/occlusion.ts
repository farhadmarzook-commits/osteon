/**
 * Image occlusion blocks (spec 0004 §2). A fenced `fc-occlusion` block in a note:
 *
 *   image: [[knee-lateral.png]]
 *   mode: hide-all
 *   header: Lateral knee radiograph
 *   k7fq rect 0.412 0.228 0.12 0.06 "Patella"
 *   9c0d ellipse 0.301 0.64 0.08 0.08 "Tibial tubercle"
 *   p4e1 poly 0.51,0.44 0.57,0.43 0.58,0.49 "Blumensaat's line"
 *   group b8zn = r5tw w1ky
 *   id: fc-k3x9m2qa
 *
 * Coordinates are fractions of the image (0–1). rect and ellipse are x y w h (bounding box).
 * Mask and group IDs are the card slots (spec 0001): assigned once, never reused.
 */

export type OcclusionMode = "hide-all" | "hide-one";

export interface Mask {
  id: string;
  shape: "rect" | "ellipse" | "poly";
  /** rect/ellipse: [x, y, w, h]; poly: [x1, y1, x2, y2, ...] */
  coords: number[];
  label?: string;
}

export interface MaskGroup {
  id: string;
  members: string[];
}

export interface Occlusion {
  image: string;
  mode: OcclusionMode;
  header?: string;
  masks: Mask[];
  groups: MaskGroup[];
  id?: string;
}

export const OCCLUSION_LANG = "fc-occlusion";

const ID4 = /^[a-z0-9]{4}$/;
const num = (s: string) => Number(s);
const valid = (n: number) => Number.isFinite(n) && n >= -0.001 && n <= 1.001;

export function parseOcclusion(source: string): Occlusion {
  const occ: Occlusion = { image: "", mode: "hide-all", masks: [], groups: [] };
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^image:\s*(.+)$/.exec(line))) {
      occ.image = m[1].trim().replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
    } else if ((m = /^mode:\s*(hide-all|hide-one)\s*$/.exec(line))) {
      occ.mode = m[1] as OcclusionMode;
    } else if ((m = /^header:\s*(.*)$/.exec(line))) {
      occ.header = m[1].trim() || undefined;
    } else if ((m = /^id:\s*fc-([a-z0-9]{8})\s*$/.exec(line))) {
      occ.id = m[1];
    } else if ((m = /^group\s+([a-z0-9]{4})\s*=\s*([a-z0-9 ]+)$/.exec(line))) {
      occ.groups.push({ id: m[1], members: m[2].trim().split(/\s+/).filter((x) => ID4.test(x)) });
    } else if ((m = /^([a-z0-9]{4})\s+(rect|ellipse)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(".*"))?$/.exec(line))) {
      const coords = [m[3], m[4], m[5], m[6]].map(num);
      if (coords.every(valid)) occ.masks.push({ id: m[1], shape: m[2] as "rect" | "ellipse", coords, label: parseLabel(m[7]) });
    } else if ((m = /^([a-z0-9]{4})\s+poly\s+((?:\S+,\S+\s*)+?)(?:\s+(".*"))?$/.exec(line))) {
      const coords = m[2].trim().split(/\s+/).flatMap((p) => p.split(",").map(num));
      if (coords.length >= 6 && coords.length % 2 === 0 && coords.every(valid)) {
        occ.masks.push({ id: m[1], shape: "poly", coords, label: parseLabel(m[3]) });
      }
    }
  }
  // Groups may only reference existing masks.
  const ids = new Set(occ.masks.map((x) => x.id));
  occ.groups = occ.groups.map((g) => ({ ...g, members: g.members.filter((x) => ids.has(x)) })).filter((g) => g.members.length);
  return occ;
}

function parseLabel(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

function fmt(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

export function serializeOcclusion(o: Occlusion): string {
  const lines = [`image: [[${o.image}]]`, `mode: ${o.mode}`];
  if (o.header) lines.push(`header: ${o.header.replace(/\n/g, " ")}`);
  for (const m of o.masks) {
    const label = m.label ? ` ${JSON.stringify(m.label)}` : "";
    if (m.shape === "poly") {
      const pts: string[] = [];
      for (let i = 0; i < m.coords.length; i += 2) pts.push(`${fmt(m.coords[i])},${fmt(m.coords[i + 1])}`);
      lines.push(`${m.id} poly ${pts.join(" ")}${label}`);
    } else {
      lines.push(`${m.id} ${m.shape} ${m.coords.map(fmt).join(" ")}${label}`);
    }
  }
  for (const g of o.groups) lines.push(`group ${g.id} = ${g.members.join(" ")}`);
  if (o.id) lines.push(`id: fc-${o.id}`);
  return lines.join("\n");
}

/** The card slots of a figure: each group, plus each mask not in a group (spec 0004 §2). */
export function occlusionSlots(o: Occlusion): string[] {
  const grouped = new Set(o.groups.flatMap((g) => g.members));
  const slots: string[] = [];
  for (const m of o.masks) {
    const g = o.groups.find((x) => x.members.includes(m.id));
    if (g) {
      if (!slots.includes(g.id)) slots.push(g.id);
    } else if (!grouped.has(m.id)) {
      slots.push(m.id);
    }
  }
  return slots;
}

/** The masks a slot asks about. */
export function masksForSlot(o: Occlusion, slot: string): string[] {
  const g = o.groups.find((x) => x.id === slot);
  return g ? g.members : [slot];
}

/** A new 4-character mask/group ID not used before in this figure (or in `retired`). */
export function newMaskId(o: Occlusion, retired: Iterable<string> = [], random = Math.random): string {
  const used = new Set([...o.masks.map((m) => m.id), ...o.groups.map((g) => g.id), ...retired]);
  for (;;) {
    let id = "";
    for (let i = 0; i < 4; i++) id += "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(random() * 36)];
    if (!used.has(id)) return id;
  }
}

/** A short text for lists (browser, card info): the asked labels, or "Image occlusion". */
export function occlusionTitle(o: Occlusion, slot: string): string {
  const labels = masksForSlot(o, slot)
    .map((id) => o.masks.find((m) => m.id === id)?.label)
    .filter(Boolean);
  const name = o.image.split("/").pop() ?? o.image;
  return `🖼 ${name}${labels.length ? ` — ${labels.join(", ")}` : ""}`;
}
