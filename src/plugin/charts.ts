/** Small SVG charts for the Stats screen: stacked bars with an optional line, and a donut. */
import { tooltip } from "./heatmap";

const SVG = "http://www.w3.org/2000/svg";

export interface Segment {
  value: number;
  cls: string;
  label: string;
}

export interface Bar {
  /** Label under the axis (shown sparsely); also the tooltip title. */
  label: string;
  title: string;
  segments: Segment[];
  /** Optional click handler (e.g. open Browse). */
  onClick?: () => void;
}

export interface BarChartOptions {
  bars: Bar[];
  /** A line over the bars, on its own right-hand axis (cumulative total, % correct). */
  line?: { values: number[]; label: string; format: (v: number) => string; max?: number };
  format?: (v: number) => string;
  height?: number;
  /** How many x labels to show at most. */
  xTicks?: number;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v * 10) / 10));

export function barChart(host: HTMLElement, o: BarChartOptions): void {
  const wrap = host.createDiv({ cls: "fc-chart" });
  const tip = tooltip(wrap);
  const W = 600;
  const H = o.height ?? 200;
  const L = 40;
  const R = o.line ? 44 : 10;
  const T = 8;
  const B = 22;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "fc-chart-svg" }, wrap);
  const totals = o.bars.map((b) => b.segments.reduce((a, s) => a + s.value, 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = W - L - R;
  const plotH = H - T - B;
  const bw = plotW / Math.max(1, o.bars.length);
  const y = (v: number) => T + plotH - (v / max) * plotH;
  const f = o.format ?? fmt;

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "fc-grid" }, svg);
    el("text", { x: L - 4, y: y(v) + 3, class: "fc-axis", "text-anchor": "end" }, svg).textContent = f(v);
  }

  const ticks = o.xTicks ?? 8;
  const every = Math.max(1, Math.ceil(o.bars.length / ticks));
  o.bars.forEach((b, i) => {
    let base = 0;
    const x = L + i * bw;
    const g = el("g", { class: b.onClick ? "fc-bar fc-clickable" : "fc-bar" }, svg);
    // A full-height hit area so thin bars are easy to hover.
    el("rect", { x, y: T, width: bw, height: plotH, class: "fc-hit" }, g);
    for (const s of b.segments) {
      if (s.value <= 0) continue;
      el("rect", { x: x + bw * 0.1, y: y(base + s.value), width: Math.max(0.5, bw * 0.8), height: y(base) - y(base + s.value), class: s.cls }, g);
      base += s.value;
    }
    const lines = [b.title, ...b.segments.filter((s) => s.value > 0).map((s) => `${s.label}: ${f(s.value)}`)];
    if (b.segments.length > 1 && totals[i] > 0) lines.push(`Total: ${f(totals[i])}`);
    if (o.line) lines.push(`${o.line.label}: ${o.line.format(o.line.values[i])}`);
    g.addEventListener("mousemove", (e) => tip.show(e, lines.join("\n")));
    g.addEventListener("mouseleave", () => tip.hide());
    if (b.onClick) g.addEventListener("click", b.onClick);
    if (i % every === 0) el("text", { x: x + bw / 2, y: H - 6, class: "fc-axis", "text-anchor": "middle" }, svg).textContent = b.label;
  });

  if (o.line && o.line.values.length) {
    const lmax = o.line.max ?? niceMax(Math.max(0, ...o.line.values));
    const ly = (v: number) => T + plotH - (v / lmax) * plotH;
    const pts = o.line.values.map((v, i) => `${L + i * bw + bw / 2},${ly(v)}`).join(" ");
    el("polyline", { points: pts, class: "fc-line" }, svg);
    for (let i = 0; i <= 4; i++) {
      const v = (lmax / 4) * i;
      el("text", { x: W - R + 4, y: ly(v) + 3, class: "fc-axis" }, svg).textContent = o.line.format(v);
    }
  }
}

export interface Slice {
  label: string;
  value: number;
  cls: string;
}

/** Anki's Card Counts pie, as a donut with a table beside it. */
export function donut(host: HTMLElement, slices: Slice[]): void {
  const wrap = host.createDiv({ cls: "fc-donut" });
  const tip = tooltip(wrap);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const svg = el("svg", { viewBox: "0 0 120 120", class: "fc-donut-svg" }, wrap);
  const r = 50;
  const c = 2 * Math.PI * r;
  let offset = 0;
  for (const s of slices) {
    if (!s.value) continue;
    const len = (s.value / total) * c;
    const arc = el(
      "circle",
      { cx: 60, cy: 60, r, fill: "none", "stroke-width": 18, "stroke-dasharray": `${len} ${c - len}`, "stroke-dashoffset": -offset, transform: "rotate(-90 60 60)", class: `fc-slice ${s.cls}` },
      svg,
    );
    const pct = ((s.value / total) * 100).toFixed(1);
    arc.addEventListener("mousemove", (e) => tip.show(e, `${s.label}: ${s.value} (${pct}%)`));
    arc.addEventListener("mouseleave", () => tip.hide());
    offset += len;
  }
  if (!total) el("circle", { cx: 60, cy: 60, r, fill: "none", "stroke-width": 18, class: "fc-grid" }, svg);
  const table = wrap.createEl("table", { cls: "fc-donut-table" });
  for (const s of slices) {
    const tr = table.createEl("tr");
    tr.createEl("td").createSpan({ cls: `fc-swatch ${s.cls}` });
    tr.createEl("td", { text: s.label });
    tr.createEl("td", { text: String(s.value), cls: "fc-num" });
    tr.createEl("td", { text: total ? `${((s.value / total) * 100).toFixed(1)}%` : "", cls: "fc-num fc-muted" });
  }
  const tr = table.createEl("tr", { cls: "fc-total" });
  tr.createEl("td");
  tr.createEl("td", { text: "Total" });
  tr.createEl("td", { text: String(total), cls: "fc-num" });
  tr.createEl("td");
}
