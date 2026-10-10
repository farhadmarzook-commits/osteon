/**
 * The occlusion editor (spec 0004 §3): draw rectangles, ellipses and polygons over a figure,
 * select/move/resize them, group, label, undo/redo, zoom. Mouse, touch and Apple Pencil all go
 * through Pointer Events.
 */
import { App, Modal, Notice, Platform, setIcon, Setting } from "obsidian";
import { newMaskId, type Mask, type Occlusion } from "../../core/occlusion";
import { createSvg, resolveImage, shapeEl } from "../occlusion-render";

type Tool = "select" | "rect" | "ellipse" | "poly";

interface Point {
  x: number;
  y: number;
}

type Drag =
  | { kind: "draw"; start: Point; mask: Mask }
  | { kind: "move"; start: Point; orig: Map<string, number[]>; moved: boolean }
  | { kind: "handle"; maskId: string; index: number; orig: number[]; moved: boolean }
  | { kind: "pan"; start: { x: number; y: number }; scroll: { left: number; top: number } };

const MIN_SIZE = 0.008;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export class OcclusionEditorModal extends Modal {
  private occ: Occlusion;
  private tool: Tool = "rect";
  private selected = new Set<string>();
  private undoStack: Occlusion[] = [];
  private redoStack: Occlusion[] = [];
  private retired = new Set<string>();
  private drag?: Drag;
  private polyPoints: Point[] = [];
  private zoom = 1;
  private dirty = false;

  private svg!: SVGSVGElement;
  private stage!: HTMLElement;
  private inner!: HTMLElement;
  private toolbar!: HTMLElement;
  private sidebar!: HTMLElement;

  constructor(
    app: App,
    initial: Occlusion,
    private sourcePath: string,
    /** Mask/group IDs that have review history and must never be reused. */
    historical: string[],
    private onSave: (occ: Occlusion) => Promise<boolean>,
  ) {
    super(app);
    this.occ = structuredClone(initial);
    for (const id of historical) this.retired.add(id);
  }

  onOpen(): void {
    this.modalEl.addClass("fc-ioe-modal");
    this.setTitle("Image occlusion");
    const file = resolveImage(this.app, this.occ.image, this.sourcePath);
    if (!file) {
      this.contentEl.createEl("p", { text: `Image not found: ${this.occ.image}` });
      return;
    }
    this.toolbar = this.contentEl.createDiv({ cls: "fc-ioe-toolbar" });
    const body = this.contentEl.createDiv({ cls: "fc-ioe-body" });
    this.stage = body.createDiv({ cls: "fc-ioe-stage" });
    this.sidebar = body.createDiv({ cls: "fc-ioe-sidebar" });
    this.inner = this.stage.createDiv({ cls: "fc-ioe-inner" });
    const img = this.inner.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), draggable: "false" } });
    img.addClass("fc-ioe-img");
    img.addEventListener("load", () => this.redraw());
    this.svg = createSvg();
    this.svg.classList.add("fc-ioe-svg");
    this.inner.appendChild(this.svg);

    this.svg.addEventListener("pointerdown", (e) => this.onDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onUp(e));
    this.svg.addEventListener("pointercancel", () => (this.drag = undefined));
    this.svg.addEventListener("dblclick", () => this.closePolygon());
    this.scope.register(null, null, (e) => this.onKey(e));

    this.renderToolbar();
    this.redraw();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Escape, the ✕ and the backdrop all come here: don't lose a masking session silently. */
  close(): void {
    if (!this.dirty || this.discard) return super.close();
    new DiscardModal(this.app, () => {
      this.discard = true;
      super.close();
    }).open();
  }
  private discard = false;

  // ---- state helpers -----------------------------------------------------------------

  private snapshot(): void {
    this.undoStack.push(structuredClone(this.occ));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.occ));
    this.occ = prev;
    this.selected.clear();
    this.redraw();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.occ));
    this.occ = next;
    this.selected.clear();
    this.redraw();
  }

  private newId(): string {
    const id = newMaskId(this.occ, this.retired);
    return id;
  }

  private point(e: PointerEvent): Point {
    const r = this.svg.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  private mask(id: string): Mask | undefined {
    return this.occ.masks.find((m) => m.id === id);
  }

  private groupOf(id: string): string | undefined {
    return this.occ.groups.find((g) => g.members.includes(id))?.id;
  }

  // ---- pointer handling -----------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.point(e);
    const target = e.target as Element;
    this.svg.setPointerCapture(e.pointerId);

    if (this.tool === "poly") {
      const first = this.polyPoints[0];
      const r = this.svg.getBoundingClientRect();
      if (first && this.polyPoints.length >= 3 && Math.hypot((first.x - p.x) * r.width, (first.y - p.y) * r.height) < 14) {
        this.closePolygon();
      } else {
        this.polyPoints.push(p);
        this.redraw();
      }
      return;
    }

    if (this.tool === "rect" || this.tool === "ellipse") {
      this.drag = { kind: "draw", start: p, mask: { id: this.newId(), shape: this.tool, coords: [p.x, p.y, 0, 0] } };
      return;
    }

    // Select tool.
    const handle = target.getAttribute("data-handle");
    if (handle !== null) {
      const id = target.getAttribute("data-for")!;
      this.drag = { kind: "handle", maskId: id, index: Number(handle), orig: [...this.mask(id)!.coords], moved: false };
      return;
    }
    const hit = target.getAttribute("data-mask");
    if (hit) {
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (this.selected.has(hit)) this.selected.delete(hit);
        else this.selected.add(hit);
      } else if (!this.selected.has(hit)) {
        this.selected = new Set([hit]);
      }
      const orig = new Map<string, number[]>();
      for (const id of this.selected) orig.set(id, [...this.mask(id)!.coords]);
      this.drag = { kind: "move", start: p, orig, moved: false };
      this.redraw();
      return;
    }
    // Empty space: clear the selection and pan (useful when zoomed in, especially on touch).
    this.selected.clear();
    this.drag = { kind: "pan", start: { x: e.clientX, y: e.clientY }, scroll: { left: this.stage.scrollLeft, top: this.stage.scrollTop } };
    this.redraw();
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const p = this.point(e);
    if (d.kind === "draw") {
      const x = Math.min(d.start.x, p.x);
      const y = Math.min(d.start.y, p.y);
      d.mask.coords = [x, y, Math.abs(p.x - d.start.x), Math.abs(p.y - d.start.y)];
      this.redraw(d.mask);
    } else if (d.kind === "move") {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (!d.moved) {
        if (Math.abs(dx) < 0.002 && Math.abs(dy) < 0.002) return;
        d.moved = true;
        this.snapshot();
      }
      for (const [id, orig] of d.orig) {
        const m = this.mask(id)!;
        if (m.shape === "poly") {
          // Move the polygon as a whole, stopping at the image edge (no per-vertex squashing).
          const xs = orig.filter((_, i) => i % 2 === 0);
          const ys = orig.filter((_, i) => i % 2 === 1);
          dx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs));
          dy = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys));
          m.coords = orig.map((v, i) => v + (i % 2 === 0 ? dx : dy));
        } else {
          m.coords = [clamp01(orig[0] + dx), clamp01(orig[1] + dy), orig[2], orig[3]];
          m.coords[0] = Math.min(m.coords[0], 1 - m.coords[2]);
          m.coords[1] = Math.min(m.coords[1], 1 - m.coords[3]);
        }
      }
      this.redraw();
    } else if (d.kind === "handle") {
      if (!d.moved) {
        d.moved = true;
        this.snapshot();
      }
      const m = this.mask(d.maskId)!;
      if (m.shape === "poly") {
        m.coords[d.index * 2] = p.x;
        m.coords[d.index * 2 + 1] = p.y;
      } else {
        // Corners 0..3: top-left, top-right, bottom-right, bottom-left. The opposite corner stays.
        const [x, y, w, h] = d.orig;
        const opp = [
          { x: x + w, y: y + h },
          { x, y: y + h },
          { x, y },
          { x: x + w, y },
        ][d.index];
        m.coords = [Math.min(opp.x, p.x), Math.min(opp.y, p.y), Math.abs(p.x - opp.x), Math.abs(p.y - opp.y)];
      }
      this.redraw();
    } else if (d.kind === "pan") {
      this.stage.scrollLeft = d.scroll.left - (e.clientX - d.start.x);
      this.stage.scrollTop = d.scroll.top - (e.clientY - d.start.y);
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = undefined;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === "handle") {
      // Never leave a box too small to see (it would be an invisible card).
      const m = this.mask(d.maskId);
      if (m && m.shape !== "poly") {
        m.coords[2] = Math.max(m.coords[2], MIN_SIZE);
        m.coords[3] = Math.max(m.coords[3], MIN_SIZE);
        this.redraw();
      }
    }
    if (d.kind === "draw") {
      if (d.mask.coords[2] < MIN_SIZE || d.mask.coords[3] < MIN_SIZE) {
        this.redraw();
        return;
      }
      this.snapshot();
      this.occ.masks.push(d.mask);
      this.selected = new Set([d.mask.id]);
      this.redraw();
      this.focusLabel();
    }
  }

  private closePolygon(): void {
    // A double-click also delivered two single clicks: drop points that repeat the previous one.
    this.polyPoints = this.polyPoints.filter(
      (p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.004,
    );
    if (this.tool !== "poly" || this.polyPoints.length < 3) return;
    this.snapshot();
    const m: Mask = { id: this.newId(), shape: "poly", coords: this.polyPoints.flatMap((p) => [p.x, p.y]) };
    this.occ.masks.push(m);
    this.polyPoints = [];
    this.selected = new Set([m.id]);
    this.redraw();
    this.focusLabel();
  }

  // ---- commands --------------------------------------------------------------------------

  private deleteSelected(): void {
    if (!this.selected.size) return;
    this.snapshot();
    for (const id of this.selected) this.retired.add(id);
    this.occ.masks = this.occ.masks.filter((m) => !this.selected.has(m.id));
    this.occ.groups = this.occ.groups
      .map((g) => ({ ...g, members: g.members.filter((x) => !this.selected.has(x)) }))
      .filter((g) => {
        if (g.members.length >= 2) return true;
        this.retired.add(g.id);
        return false;
      });
    this.selected.clear();
    this.redraw();
  }

  private group(): void {
    const ids = [...this.selected];
    if (ids.length < 2) {
      new Notice("Select two or more boxes to group them (⇧-click, or tap boxes in Select mode).");
      return;
    }
    this.snapshot();
    this.ungroupIds(ids);
    this.occ.groups.push({ id: this.newId(), members: this.occ.masks.map((m) => m.id).filter((id) => ids.includes(id)) });
    this.redraw();
  }

  private ungroup(): void {
    if (!this.selected.size) return;
    this.snapshot();
    this.ungroupIds([...this.selected]);
    this.redraw();
  }

  private ungroupIds(ids: string[]): void {
    this.occ.groups = this.occ.groups.filter((g) => {
      if (!g.members.some((m) => ids.includes(m))) return true;
      this.retired.add(g.id);
      return false;
    });
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.polyPoints = [];
    this.renderToolbar();
    this.redraw();
  }

  private setZoom(z: number): void {
    this.zoom = Math.min(6, Math.max(1, z));
    this.inner.style.width = `${this.zoom * 100}%`;
    window.requestAnimationFrame(() => this.redraw());
  }

  private async save(): Promise<void> {
    if (!this.occ.masks.length) {
      new Notice("Draw at least one box first.");
      return;
    }
    if (await this.onSave(structuredClone(this.occ))) {
      this.dirty = false;
      this.close();
    }
  }

  private onKey(e: KeyboardEvent): boolean {
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return true;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z") e.shiftKey ? this.redo() : this.undo();
    else if (mod && k === "s") void this.save();
    else if (k === "delete" || k === "backspace") this.deleteSelected();
    else if (k === "escape") {
      if (this.polyPoints.length) {
        this.polyPoints = [];
        this.redraw();
      } else return true;
    } else if (k === "enter") this.closePolygon();
    else if (k === "g") e.shiftKey ? this.ungroup() : this.group();
    else if (k === "v") this.setTool("select");
    else if (k === "r") this.setTool("rect");
    else if (k === "o") this.setTool("ellipse");
    else if (k === "p") this.setTool("poly");
    else return true;
    return false;
  }

  // ---- rendering ---------------------------------------------------------------------------

  private renderToolbar(): void {
    const tb = this.toolbar;
    tb.empty();
    const btn = (icon: string, label: string, fn: () => void, active = false) => {
      const b = tb.createEl("button", { cls: `clickable-icon ${active ? "is-active" : ""}`, attr: { "aria-label": label } });
      setIcon(b, icon);
      b.onclick = fn;
    };
    btn("mouse-pointer-2", "Select / move / pan (V)", () => this.setTool("select"), this.tool === "select");
    btn("square", "Rectangle (R)", () => this.setTool("rect"), this.tool === "rect");
    btn("circle", "Ellipse (O)", () => this.setTool("ellipse"), this.tool === "ellipse");
    btn("pentagon", "Polygon (P): tap points, tap the first point or press Enter to close", () => this.setTool("poly"), this.tool === "poly");
    tb.createDiv({ cls: "fc-ioe-sep" });
    btn("group", "Group selected (G)", () => this.group());
    btn("ungroup", "Ungroup (⇧G)", () => this.ungroup());
    btn("trash-2", "Delete selected (⌫)", () => this.deleteSelected());
    tb.createDiv({ cls: "fc-ioe-sep" });
    btn("undo-2", "Undo (⌘Z)", () => this.undo());
    btn("redo-2", "Redo (⌘⇧Z)", () => this.redo());
    btn("zoom-out", "Zoom out", () => this.setZoom(this.zoom / 1.5));
    btn("zoom-in", "Zoom in", () => this.setZoom(this.zoom * 1.5));
    tb.createDiv({ cls: "fc-ioe-spacer" });
    const cancel = tb.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const save = tb.createEl("button", { text: "Save", cls: "mod-cta" });
    save.onclick = () => void this.save();
  }

  private labelInput?: HTMLInputElement;

  private focusLabel(): void {
    // On a phone this would pop the keyboard after every box; labels are optional.
    if (Platform.isMobile) return;
    window.setTimeout(() => this.labelInput?.focus(), 0);
  }

  private renderSidebar(): void {
    const sb = this.sidebar;
    sb.empty();
    const mode = sb.createDiv({ cls: "fc-ioe-field" });
    mode.createEl("label", { text: "Mode" });
    const sel = mode.createEl("select", { cls: "dropdown" });
    sel.createEl("option", { value: "hide-all", text: "Hide all, guess one" });
    sel.createEl("option", { value: "hide-one", text: "Hide one, guess one" });
    sel.value = this.occ.mode;
    sel.onchange = () => {
      this.snapshot();
      this.occ.mode = sel.value as Occlusion["mode"];
    };
    const header = sb.createDiv({ cls: "fc-ioe-field" });
    header.createEl("label", { text: "Header (shown above the figure)" });
    const hi = header.createEl("input", { type: "text", value: this.occ.header ?? "" });
    // Write as you type: the sidebar is redrawn on every canvas change, which would drop an
    // uncommitted value.
    hi.onfocus = () => this.snapshot();
    hi.oninput = () => (this.occ.header = hi.value.trim() || undefined);

    const sel1 = this.selected.size === 1 ? this.mask([...this.selected][0]) : undefined;
    const label = sb.createDiv({ cls: "fc-ioe-field" });
    label.createEl("label", { text: sel1 ? "Label for the selected box (optional)" : "Select one box to label it" });
    const li = label.createEl("input", { type: "text", value: sel1?.label ?? "" });
    li.disabled = !sel1;
    li.onfocus = () => this.snapshot();
    li.oninput = () => {
      if (sel1) sel1.label = li.value.trim() || undefined;
    };
    li.onchange = () => this.renderSidebar();
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") li.blur();
    });
    this.labelInput = li;

    const cards = sb.createDiv({ cls: "fc-ioe-field" });
    const grouped = new Set(this.occ.groups.flatMap((g) => g.members));
    const n = this.occ.groups.length + this.occ.masks.filter((m) => !grouped.has(m.id)).length;
    cards.createEl("label", { text: `${this.occ.masks.length} box${this.occ.masks.length === 1 ? "" : "es"} → ${n} card${n === 1 ? "" : "s"}` });
    const ul = cards.createEl("ul", { cls: "fc-ioe-list" });
    for (const m of this.occ.masks) {
      const li2 = ul.createEl("li", { cls: this.selected.has(m.id) ? "is-selected" : "" });
      const g = this.groupOf(m.id);
      li2.setText(`${m.label ?? "(no label)"}${g ? `  · group ${g}` : ""}`);
      li2.onclick = () => {
        this.selected = new Set([m.id]);
        this.tool = "select";
        this.renderToolbar();
        this.redraw();
      };
    }
    sb.createDiv({
      cls: "fc-muted fc-ioe-help",
      text: "Drag to draw. Select mode: tap to select, ⇧-click to add, drag to move, drag corners to resize, drag empty space to pan.",
    });
  }

  private redraw(draft?: Mask): void {
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const groupColour = new Map<string, number>();
    this.occ.groups.forEach((g, i) => groupColour.set(g.id, i % 6));
    for (const m of this.occ.masks) {
      const el = shapeEl(m);
      el.classList.add("fc-ioe-shape");
      const g = this.groupOf(m.id);
      if (g) el.classList.add(`fc-ioe-group-${groupColour.get(g)}`);
      if (this.selected.has(m.id)) el.classList.add("is-selected");
      svg.appendChild(el);
    }
    if (draft) {
      const el = shapeEl(draft);
      el.classList.add("fc-ioe-shape", "is-draft");
      svg.appendChild(el);
    }
    if (this.polyPoints.length) {
      const pl = window.createSvg("polyline");
      pl.setAttribute("points", this.polyPoints.map((p) => `${p.x},${p.y}`).join(" "));
      pl.setAttribute("vector-effect", "non-scaling-stroke");
      pl.classList.add("fc-ioe-shape", "is-draft");
      svg.appendChild(pl);
    }
    // Resize handles for a single selected shape.
    if (this.tool === "select" && this.selected.size === 1) {
      const m = this.mask([...this.selected][0]);
      if (m) {
        const pts: Point[] =
          m.shape === "poly"
            ? Array.from({ length: m.coords.length / 2 }, (_, i) => ({ x: m.coords[i * 2], y: m.coords[i * 2 + 1] }))
            : [
                { x: m.coords[0], y: m.coords[1] },
                { x: m.coords[0] + m.coords[2], y: m.coords[1] },
                { x: m.coords[0] + m.coords[2], y: m.coords[1] + m.coords[3] },
                { x: m.coords[0], y: m.coords[1] + m.coords[3] },
              ];
        const r = this.svg.getBoundingClientRect();
        // ~11px handles (finger-sized), recomputed on every redraw so zoom doesn't shrink them.
        const rx = r.width ? 11 / r.width : 0.015;
        const ry = r.height ? 11 / r.height : 0.015;
        pts.forEach((p, i) => {
          const h = window.createSvg("ellipse");
          h.setAttribute("cx", String(p.x));
          h.setAttribute("cy", String(p.y));
          h.setAttribute("rx", String(rx));
          h.setAttribute("ry", String(ry));
          h.setAttribute("data-handle", String(i));
          h.setAttribute("data-for", m.id);
          h.classList.add("fc-ioe-handle");
          svg.appendChild(h);
        });
      }
    }
    this.renderSidebar();
  }
}

/** Asks before a figure's unsaved boxes are thrown away. */
class DiscardModal extends Modal {
  constructor(
    app: App,
    private onDiscard: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Discard your changes to this figure?");
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Keep editing").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Discard").setClass("mod-warning").onClick(() => {
          this.close();
          this.onDiscard();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
