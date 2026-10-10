/** Draws an image-occlusion figure: the image with an SVG mask overlay (spec 0004 §4). */
import { App, Modal, TFile } from "obsidian";
import type { Mask, Occlusion } from "../core/occlusion";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface FigureOptions {
  /** Masks being asked about (the card's slot). Empty in note view. */
  active: string[];
  /** "front": cover masks; "back": reveal the active ones; "note": faint outlines only. */
  phase: "front" | "back" | "note";
  /** Toggle masks (T): uncover everything on the back. */
  showAll?: boolean;
  /** Tap the figure to open it full-screen. */
  zoomable?: boolean;
}

export function resolveImage(app: App, link: string, sourcePath: string): TFile | null {
  return app.metadataCache.getFirstLinkpathDest(link, sourcePath) ?? app.vault.getFileByPath(link);
}

export function shapeEl(m: Mask): SVGElement {
  const [a, b, c, d] = m.coords;
  let el: SVGElement;
  if (m.shape === "rect") {
    el = document.createElementNS(SVG_NS, "rect");
    el.setAttribute("x", String(a));
    el.setAttribute("y", String(b));
    el.setAttribute("width", String(c));
    el.setAttribute("height", String(d));
  } else if (m.shape === "ellipse") {
    el = document.createElementNS(SVG_NS, "ellipse");
    el.setAttribute("cx", String(a + c / 2));
    el.setAttribute("cy", String(b + d / 2));
    el.setAttribute("rx", String(c / 2));
    el.setAttribute("ry", String(d / 2));
  } else {
    el = document.createElementNS(SVG_NS, "polygon");
    const pts: string[] = [];
    for (let i = 0; i < m.coords.length; i += 2) pts.push(`${m.coords[i]},${m.coords[i + 1]}`);
    el.setAttribute("points", pts.join(" "));
  }
  el.setAttribute("vector-effect", "non-scaling-stroke");
  el.dataset.mask = m.id;
  return el;
}

export function createSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1 1");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("fc-io-svg");
  return svg;
}

/** Render the figure into `container`. Returns false if the image can't be found. */
export function renderFigure(app: App, container: HTMLElement, occ: Occlusion, sourcePath: string, o: FigureOptions): boolean {
  const file = resolveImage(app, occ.image, sourcePath);
  const wrap = container.createDiv({ cls: "fc-io" });
  if (!file) {
    wrap.createDiv({ cls: "fc-io-missing", text: `Image not found: ${occ.image}` });
    return false;
  }
  const img = wrap.createEl("img", { attr: { src: app.vault.getResourcePath(file), alt: occ.image, draggable: "false" } });
  img.addClass("fc-io-img");
  const svg = createSvg();
  const active = new Set(o.active);
  for (const m of occ.masks) {
    const isActive = active.has(m.id);
    let cls: string | null;
    if (o.phase === "note") cls = "fc-io-outline";
    else if (o.phase === "front") cls = isActive ? "fc-io-active" : occ.mode === "hide-all" ? "fc-io-mask" : null;
    else if (o.showAll) cls = isActive ? "fc-io-revealed" : null;
    else cls = isActive ? "fc-io-revealed" : occ.mode === "hide-all" ? "fc-io-mask" : null;
    if (!cls) continue;
    const el = shapeEl(m);
    el.classList.add(cls);
    svg.appendChild(el);
  }
  wrap.appendChild(svg);
  // Size the overlay to the image box itself, so masks line up even when the image is limited
  // by max-height and the wrapper ends up wider than the picture (WebKit on iOS).
  const sync = () => {
    if (!img.clientWidth) return;
    svg.style.width = `${img.clientWidth}px`;
    svg.style.height = `${img.clientHeight}px`;
  };
  img.addEventListener("load", sync);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(img);
  if (o.zoomable) {
    wrap.addClass("fc-io-zoomable");
    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      new FigureZoomModal(app, occ, sourcePath, o).open();
    });
  }
  return true;
}

/** Full-screen figure with zoom (spec 0004 §4: small labels need zooming on the iPhone). */
class FigureZoomModal extends Modal {
  private zoom = 1;

  constructor(
    app: App,
    private occ: Occlusion,
    private sourcePath: string,
    private o: FigureOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("fc-io-zoom-modal");
    const bar = this.contentEl.createDiv({ cls: "fc-io-zoom-bar" });
    const stage = this.contentEl.createDiv({ cls: "fc-io-zoom-stage" });
    const inner = stage.createDiv({ cls: "fc-io-zoom-inner" });
    renderFigure(this.app, inner, this.occ, this.sourcePath, { ...this.o, zoomable: false });
    const apply = () => (inner.style.width = `${this.zoom * 100}%`);
    const btn = (t: string, f: () => void) => bar.createEl("button", { text: t }).addEventListener("click", f);
    btn("−", () => {
      this.zoom = Math.max(1, this.zoom / 1.5);
      apply();
    });
    btn("+", () => {
      this.zoom = Math.min(6, this.zoom * 1.5);
      apply();
    });
    btn("Fit", () => {
      this.zoom = 1;
      apply();
    });
    apply();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
