/**
 * Debug trace for hunting device-only hangs (e.g. the iPhone). Off unless the file `trace-on`
 * exists in the plugin folder. Records steps, errors and main-thread stalls, and writes them to
 * `trace-<device>-<time>.txt` in the plugin folder after every step, so the file syncs to another device.
 */
import type { App } from "obsidian";

let on = false;
let lines: string[] = [];
let dirty = false;
let last = "start";
let t0 = 0;
let writeNow: () => void = () => undefined;

const stamp = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;

export function trace(step: string): void {
  if (!on) return;
  last = step;
  lines.push(`${stamp()}  ${step}`);
  if (lines.length > 3000) lines = lines.slice(-2000);
  dirty = true;
  writeNow();
}

/** Time a synchronous step. */
export function timed<T>(step: string, fn: () => T): T {
  if (!on) return fn();
  const a = performance.now();
  trace(`${step} …`);
  const out = fn();
  trace(`${step} done ${Math.round(performance.now() - a)}ms`);
  return out;
}

export async function startTrace(app: App, dir: string, device: string, version: string, register: (cb: () => void) => void): Promise<void> {
  if (!(await app.vault.adapter.exists(`${dir}/trace-on`))) return;
  on = true;
  t0 = performance.now();
  // One file per session, so reopening after a freeze doesn't overwrite the freeze.
  const d = new Date();
  const hhmmss = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  const file = `${dir}/trace-${device}-${hhmmss}.txt`;
  // Write after every step (one write in flight at a time): a frozen thread can't flush later.
  let writing = false;
  writeNow = () => {
    if (writing || !dirty) return;
    writing = true;
    dirty = false;
    void app.vault.adapter
      .write(file, lines.join("\n") + "\n")
      .catch(() => undefined)
      .finally(() => {
        writing = false;
        if (dirty) writeNow();
      });
  };
  trace(`trace on · v${version} · ${device} · ${new Date().toISOString()} · ${navigator.userAgent}`);
  const onError = (e: ErrorEvent) => trace(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`);
  const onReject = (e: PromiseRejectionEvent) => trace(`REJECTED ${String(e.reason?.stack ?? e.reason)}`);
  // Every touch, and what it landed on: tells a blocked main thread (touches stop being logged)
  // from something lying over the card (touches logged, but on the wrong element).
  const describe = (n: EventTarget | null) => {
    const e = n instanceof Element ? n : null;
    return e ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}` : "?";
  };
  const onTouch = (e: PointerEvent) => trace(`touch ${describe(e.target)} in ${describe((e.target as Element | null)?.closest?.(".workspace-leaf-content, .modal, .menu, .mobile-navbar, .fc-term-popup") ?? null)} @${Math.round(e.clientX)},${Math.round(e.clientY)}`);
  const onVisible = () => trace(`visibility ${document.visibilityState}`);
  window.addEventListener("pointerdown", onTouch, true);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onReject);
  // A stalled main thread shows up as a late heartbeat.
  let beat = performance.now();
  const hb = window.setInterval(() => {
    const now = performance.now();
    const gap = now - beat - 250;
    if (gap > 1000) trace(`STALL ${Math.round(gap)}ms after: ${last}`);
    beat = now;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem && Math.random() < 0.02) trace(`heap ${Math.round(mem.usedJSHeapSize / 1e6)}MB`);
  }, 250);
  const flush = window.setInterval(() => writeNow(), 1000);
  register(() => {
    window.removeEventListener("pointerdown", onTouch, true);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onReject);
    window.clearInterval(hb);
    window.clearInterval(flush);
    on = false;
  });
}
