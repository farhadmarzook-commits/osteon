import { type App, Modal, Platform, setIcon } from "obsidian";
import { captionFor, clampView, FIT, fitSize, isSwipeOut, type Size, step, swipeFade, toggleZoom, type View, zoomAt } from "../../core/zoom";

export interface ViewerPicture {
  src: string;
  alt?: string | null;
}

/**
 * A card's pictures, full screen: fit to the screen, zoom with the wheel, a trackpad pinch,
 * double-click, or a two-finger pinch / double-tap on the phone, drag to pan, arrows to step
 * through the card's other pictures, and swipe the un-zoomed picture away in any direction to close. While it is open the review screen's keys are inactive
 * (a modal has its own key scope), and Esc closes only the viewer.
 */
export class ImageViewer extends Modal {
  private i: number;
  private view: View = FIT;
  private img!: HTMLImageElement;
  private stage!: HTMLElement;
  private captionEl!: HTMLElement;
  private countEl!: HTMLElement;
  private natural: Size = { w: 0, h: 0 };
  private fitted: Size = { w: 0, h: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch?: { dist: number; view: View; mid: { x: number; y: number } };
  private drag?: { x: number; y: number; view: View; moved: boolean; t: number };
  private lastTap = 0;

  constructor(
    app: App,
    private pictures: ViewerPicture[],
    start: number,
  ) {
    super(app);
    this.i = Math.max(0, Math.min(pictures.length - 1, start));
  }

  onOpen(): void {
    this.modalEl.addClass("fc-lightbox");
    this.containerEl.addClass("fc-lightbox-container");
    const el = this.contentEl;
    el.empty();
    this.stage = el.createDiv({ cls: "fc-lightbox-stage" });
    this.img = this.stage.createEl("img", { cls: "fc-lightbox-img" });
    this.img.draggable = false;
    this.img.addEventListener("load", () => this.measure());

    const bar = el.createDiv({ cls: "fc-lightbox-bar" });
    this.captionEl = bar.createDiv({ cls: "fc-lightbox-caption" });
    this.countEl = bar.createDiv({ cls: "fc-lightbox-count" });
    if (this.pictures.length > 1) {
      this.navButton("chevron-left", "Previous picture (←)", "fc-lightbox-prev", -1);
      this.navButton("chevron-right", "Next picture (→)", "fc-lightbox-next", 1);
    }

    this.scope.register([], "ArrowLeft", () => (this.go(-1), false));
    this.scope.register([], "ArrowRight", () => (this.go(1), false));
    this.scope.register([], "0", () => (this.set(FIT), false));
    this.scope.register([], "=", () => (this.zoomCentre(1.5), false));
    this.scope.register([], "-", () => (this.zoomCentre(1 / 1.5), false));
    // Swallow every other key, so nothing reaches the review screen underneath.
    this.scope.register(null, null, () => false);

    this.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.set(toggleZoom(this.view, this.point(e), this.fitted, this.stageSize()));
    });
    this.stage.addEventListener("pointerdown", (e) => this.onDown(e));
    this.stage.addEventListener("pointermove", (e) => this.onMove(e));
    this.stage.addEventListener("pointerup", (e) => this.onUp(e));
    this.stage.addEventListener("pointercancel", (e) => this.onUp(e));
    window.addEventListener("resize", this.onResize);
    this.placeClose();
    this.show();
  }

  onClose(): void {
    window.removeEventListener("resize", this.onResize);
    this.contentEl.empty();
  }

  private onResize = () => {
    this.placeClose();
    this.measure();
  };

  /**
   * Keep the close button below the phone's status bar (clock, battery). Set inline so it wins over
   * any theme or app rule, from the real safe-area inset measured with a probe (Obsidian's own
   * --safe-area-inset-top read 0 on an iPhone), with a 47 px floor on phones.
   */
  private placeClose(): void {
    if (!Platform.isMobile) return;
    const btn = this.modalEl.querySelector<HTMLElement>(".modal-close-button");
    if (!btn) return;
    const probe = document.body.createDiv();
    probe.setCssStyles({ position: "fixed", top: "0", left: "0", visibility: "hidden", paddingTop: "env(safe-area-inset-top, 0px)" });
    const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    const top = Math.max(inset, Platform.isPhone ? 47 : 0) + 12;
    btn.setCssStyles({ top: `${top}px`, right: "16px" });
  }

  private navButton(icon: string, label: string, cls: string, dir: 1 | -1): void {
    const b = this.modalEl.createEl("button", { cls: `fc-lightbox-nav ${cls}`, attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.go(dir);
    });
  }

  private go(dir: 1 | -1): void {
    if (this.pictures.length < 2) return;
    this.i = step(this.i, this.pictures.length, dir);
    this.show();
  }

  private show(): void {
    const p = this.pictures[this.i];
    this.view = FIT;
    this.natural = { w: 0, h: 0 };
    this.img.src = p.src;
    this.img.alt = p.alt ?? "";
    const caption = captionFor(p.alt, p.src);
    this.captionEl.setText(caption);
    this.captionEl.toggleClass("fc-lightbox-hidden", !caption);
    this.countEl.setText(this.pictures.length > 1 ? `${this.i + 1} / ${this.pictures.length}` : "");
    if (this.img.complete && this.img.naturalWidth) this.measure();
  }

  private stageSize(): Size {
    const r = this.stage.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  /** Fit the picture to the stage (small pictures grow up to 2x so they are readable). */
  private measure(): void {
    if (!this.img.naturalWidth) return;
    this.natural = { w: this.img.naturalWidth, h: this.img.naturalHeight };
    this.fitted = fitSize(this.natural, this.stageSize(), 2);
    this.img.setCssProps({ "--fc-lb-w": `${this.fitted.w}px`, "--fc-lb-h": `${this.fitted.h}px` });
    this.set(this.view);
  }

  private set(v: View): void {
    this.view = clampView(v, this.fitted, this.stageSize());
    this.img.setCssProps({
      "--fc-lb-x": `${this.view.x}px`,
      "--fc-lb-y": `${this.view.y}px`,
      "--fc-lb-scale": `${this.view.scale}`,
    });
    this.stage.toggleClass("is-zoomed", this.view.scale > 1.01);
  }

  /** Move the un-zoomed picture with the finger and fade the background, for swipe to close. */
  private swipeTo(dx: number, dy: number): void {
    this.img.setCssProps({ "--fc-lb-x": `${dx}px`, "--fc-lb-y": `${dy}px`, "--fc-lb-scale": "1" });
    const fade = swipeFade(dx, dy, this.stageSize());
    this.modalEl.setCssProps({ "--fc-lb-fade": `${fade}` });
    this.containerEl.setCssProps({ "--fc-lb-fade": `${fade}` });
    this.stage.toggleClass("is-swiping", dx !== 0 || dy !== 0);
  }

  /** A point on the stage, relative to its centre. */
  private point(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
  }

  private zoomCentre(factor: number): void {
    this.set(zoomAt(this.view, factor, { x: 0, y: 0 }, this.fitted, this.stageSize()));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // A trackpad pinch arrives as a wheel event with ctrlKey; a two-finger scroll pans once zoomed.
    if (!e.ctrlKey && this.view.scale > 1.01 && e.deltaMode === 0 && Math.abs(e.deltaX) + Math.abs(e.deltaY) < 60) {
      this.set({ ...this.view, x: this.view.x - e.deltaX, y: this.view.y - e.deltaY });
      return;
    }
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    this.set(zoomAt(this.view, factor, this.point(e), this.fitted, this.stageSize()));
  }

  private onDown(e: PointerEvent): void {
    this.stage.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), view: this.view, mid: this.point({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }) };
      this.drag = undefined;
    } else if (this.pointers.size === 1) {
      this.drag = { x: e.clientX, y: e.clientY, view: this.view, moved: false, t: Date.now() };
    }
  }

  private onMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch.dist > 0) this.set(zoomAt(this.pinch.view, dist / this.pinch.dist, this.pinch.mid, this.fitted, this.stageSize()));
      return;
    }
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.view.scale > 1.01) this.set({ ...this.drag.view, x: this.drag.view.x + dx, y: this.drag.view.y + dy });
      else if (this.drag.moved) this.swipeTo(dx, dy);
    }
  }

  private onUp(e: PointerEvent): void {
    const wasPinch = !!this.pinch;
    const drag = this.drag;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = undefined;
    if (this.pointers.size > 0) return;
    this.drag = undefined;
    if (!wasPinch && drag && drag.moved && drag.view.scale <= 1.01) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (e.type !== "pointercancel" && isSwipeOut(dx, dy, Date.now() - drag.t, this.stageSize())) this.close();
      else this.swipeTo(0, 0);
      return;
    }
    if (wasPinch || !drag || drag.moved || e.type === "pointercancel") return;
    // A tap: on the phone two quick taps toggle zoom; a single tap outside the picture closes.
    const now = Date.now();
    if (e.pointerType === "touch" && now - this.lastTap < 300) {
      this.lastTap = 0;
      this.set(toggleZoom(this.view, this.point(e), this.fitted, this.stageSize()));
      return;
    }
    this.lastTap = now;
    if (e.target !== this.img && this.view.scale <= 1.01) {
      window.setTimeout(() => {
        if (this.lastTap === now) this.close();
      }, e.pointerType === "touch" ? 300 : 0);
    }
  }
}
