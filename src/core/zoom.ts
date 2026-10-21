/**
 * Pure maths for the picture viewer (a card's pictures opened full screen, zoomed and panned).
 * The picture is drawn centred in the stage at its fitted size; `scale` multiplies that size and
 * `x`/`y` move it, in screen pixels, from the centred position.
 */

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** The zoom a double-click or double-tap jumps to from the fitted picture. */
export const DOUBLE_TAP_SCALE = 2.5;

export const FIT: View = { scale: 1, x: 0, y: 0 };

/** Keep the zoomed picture covering the stage: never pan past its edges, centre it when it is smaller. */
export function clampView(v: View, fitted: Size, stage: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
  const maxX = Math.max(0, (fitted.w * scale - stage.w) / 2);
  const maxY = Math.max(0, (fitted.h * scale - stage.h) / 2);
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, v.x)),
    y: Math.min(maxY, Math.max(-maxY, v.y)),
  };
}

/**
 * Zoom by `factor` keeping the point under the cursor or fingers (`at`, relative to the stage's
 * centre) where it is.
 */
export function zoomAt(v: View, factor: number, at: { x: number; y: number }, fitted: Size, stage: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return clampView({ scale, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, fitted, stage);
}

/** Double-click / double-tap: zoom in on the point, or back to the fitted picture when already zoomed. */
export function toggleZoom(v: View, at: { x: number; y: number }, fitted: Size, stage: Size): View {
  if (v.scale > 1.01) return FIT;
  return zoomAt(v, DOUBLE_TAP_SCALE / v.scale, at, fitted, stage);
}

/** The largest size that fits the picture inside the stage without enlarging it beyond `maxUpscale`. */
export function fitSize(natural: Size, stage: Size, maxUpscale = 2): Size {
  if (natural.w <= 0 || natural.h <= 0) return { w: stage.w, h: stage.h };
  const k = Math.min(stage.w / natural.w, stage.h / natural.h, maxUpscale);
  return { w: natural.w * k, h: natural.h * k };
}

/**
 * Width to show a small picture at on a card: at least `min` px, but never more than `maxUpscale`
 * times its own width (so it does not turn to mush). Returns undefined when the picture is big enough.
 */
export function minDisplayWidth(naturalWidth: number, min = 240, maxUpscale = 2): number | undefined {
  if (!naturalWidth || naturalWidth >= min) return undefined;
  return Math.round(Math.min(min, naturalWidth * maxUpscale));
}

/** Alt text worth showing as a caption: not empty and not just the file's name. */
export function captionFor(alt: string | null | undefined, src: string | null | undefined): string {
  const a = (alt ?? "").trim();
  if (!a) return "";
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i.test(a)) return "";
  const file = decodeURIComponent((src ?? "").split("?")[0].split("/").pop() ?? "");
  if (file && (a === file || a === file.replace(/\.[^.]+$/, ""))) return "";
  return a;
}

/** The pictures to step through: each source once, in card order. */
export function gallery(srcs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of srcs) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** The next picture's index for an arrow key, wrapping at the ends. */
export function step(i: number, n: number, dir: 1 | -1): number {
  if (n <= 0) return 0;
  return (((i + dir) % n) + n) % n;
}

/**
 * Swipe to close: a drag on the un-zoomed picture in any direction closes the viewer when it went
 * far enough (a sixth of the shorter screen side, at least 80 px) or was a quick flick.
 */
export function isSwipeOut(dx: number, dy: number, ms: number, stage: Size): boolean {
  const dist = Math.hypot(dx, dy);
  const far = Math.max(80, Math.min(stage.w, stage.h) / 6);
  if (dist >= far) return true;
  return dist >= 30 && ms > 0 && dist / ms > 0.6;
}

/** Background opacity while the picture is being swiped away: fades to 0.35 by half a screen. */
export function swipeFade(dx: number, dy: number, stage: Size): number {
  const half = Math.max(1, Math.min(stage.w, stage.h) / 2);
  return 1 - 0.65 * Math.min(1, Math.hypot(dx, dy) / half);
}
