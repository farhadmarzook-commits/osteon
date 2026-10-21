import { describe, expect, it } from "vitest";
import { captionFor, clampView, FIT, fitSize, gallery, isSwipeOut, minDisplayWidth, step, swipeFade, toggleZoom, zoomAt } from "../src/core/zoom";

const fitted = { w: 800, h: 600 };
const stage = { w: 800, h: 600 };

describe("picture viewer maths", () => {
  it("fits a picture inside the stage and enlarges small ones at most 2x", () => {
    expect(fitSize({ w: 1600, h: 600 }, stage)).toEqual({ w: 800, h: 300 });
    expect(fitSize({ w: 100, h: 50 }, stage)).toEqual({ w: 200, h: 100 });
    expect(fitSize({ w: 0, h: 0 }, stage)).toEqual({ w: 800, h: 600 });
  });

  it("never zooms out past the fitted picture or beyond the maximum", () => {
    expect(zoomAt(FIT, 0.5, { x: 0, y: 0 }, fitted, stage).scale).toBe(1);
    expect(zoomAt(FIT, 100, { x: 0, y: 0 }, fitted, stage).scale).toBe(8);
  });

  it("keeps the point under the cursor in place while zooming", () => {
    const v = zoomAt(FIT, 2, { x: 100, y: 50 }, fitted, stage);
    expect(v.scale).toBe(2);
    expect(v.x).toBe(-100);
    expect(v.y).toBe(-50);
  });

  it("cannot pan the picture off the screen", () => {
    const v = clampView({ scale: 2, x: 5000, y: -5000 }, fitted, stage);
    expect(v.x).toBe(400);
    expect(v.y).toBe(-300);
    expect(clampView({ scale: 1, x: 50, y: 50 }, fitted, stage)).toEqual(FIT);
  });

  it("double-click zooms in, and back out when already zoomed", () => {
    const zoomed = toggleZoom(FIT, { x: 0, y: 0 }, fitted, stage);
    expect(zoomed.scale).toBe(2.5);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, fitted, stage)).toEqual(FIT);
  });

  it("gives small card pictures a minimum width without blowing them up more than 2x", () => {
    expect(minDisplayWidth(600)).toBeUndefined();
    expect(minDisplayWidth(240)).toBeUndefined();
    expect(minDisplayWidth(200)).toBe(240);
    expect(minDisplayWidth(80)).toBe(160);
    expect(minDisplayWidth(0)).toBeUndefined();
  });

  it("captions only real alt text, not file names", () => {
    expect(captionFor("a28f7409cd78f3da379ec763a3c065d0.webp", "app://x/Anki/media/a28f7409cd78f3da379ec763a3c065d0.webp")).toBe("");
    expect(captionFor("photo", "app://x/photo.png?123")).toBe("");
    expect(captionFor("Hook test, normal and abnormal", "app://x/a.webp")).toBe("Hook test, normal and abnormal");
    expect(captionFor("", "x.png")).toBe("");
  });

  it("steps through each picture once, wrapping at the ends", () => {
    expect(gallery(["a", "b", "a", "", "c"])).toEqual(["a", "b", "c"]);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 0, 1)).toBe(0);
  });
  it("closes on a long enough swipe in any direction, or a quick flick", () => {
    const stage = { w: 390, h: 800 };
    expect(isSwipeOut(0, 90, 400, stage)).toBe(true);
    expect(isSwipeOut(-90, 0, 400, stage)).toBe(true);
    expect(isSwipeOut(60, -60, 400, stage)).toBe(true);
    expect(isSwipeOut(0, 40, 400, stage)).toBe(false);
    expect(isSwipeOut(0, 40, 50, stage)).toBe(true);
    expect(isSwipeOut(0, 10, 5, stage)).toBe(false);
  });

  it("fades the background as the picture is swiped away", () => {
    const stage = { w: 400, h: 800 };
    expect(swipeFade(0, 0, stage)).toBe(1);
    expect(swipeFade(0, 200, stage)).toBeCloseTo(0.35);
    expect(swipeFade(0, 1000, stage)).toBeCloseTo(0.35);
  });
});
