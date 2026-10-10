/**
 * Reads every device's review logs and appends to this device's own (spec 0001 §4.2).
 * Files are never rewritten or truncated; only appended to.
 */
import { App, normalizePath, Platform, TFile } from "obsidian";
import { formatEvent, logFileName, logHeader, parseLog, sessionLine, type LogEvent } from "../core/log";

const DEVICE_KEY = "flashcards-device-id";

/** A per-device ID, kept in Obsidian's vault-scoped local storage, which is never synced. */
export function deviceId(app: App): string {
  const saved: unknown = app.loadLocalStorage(DEVICE_KEY);
  if (typeof saved === "string" && /^[a-z]+-[a-z0-9]{4}$/.test(saved)) return saved;
  const kind = Platform.isIosApp ? (Platform.isTablet ? "ipad" : "iphone") : Platform.isAndroidApp ? "android" : Platform.isMacOS ? "mac" : "desktop";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const id = `${kind}-${Array.from(bytes, (b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("")}`;
  app.saveLocalStorage(DEVICE_KEY, id);
  return id;
}

/** What a device's log files say about it: its newest event and the plugin version that wrote last. */
export interface DeviceInfo {
  last?: string;
  version?: string;
  versionAt?: string;
}

export interface LoadResult {
  events: LogEvent[];
  bad: Array<{ path: string; lines: number[] }>;
  devices: Record<string, DeviceInfo>;
}

/** "iphone-ab12" → "iPhone". */
export function deviceLabel(id: string): string {
  const kind = id.split("-")[0];
  return ({ iphone: "iPhone", ipad: "iPad", mac: "Mac", android: "Android", desktop: "Desktop" } as Record<string, string>)[kind] ?? id;
}

export class LogStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** The session line goes out with this session's first event (no extra write). */
  private stamped = false;

  constructor(
    private app: App,
    private folder: () => string,
    readonly device: string,
    private version?: string,
  ) {}

  get reviewsFolder(): string {
    return normalizePath(`${this.folder()}/reviews`);
  }

  isLogFile(path: string): boolean {
    return path.startsWith(this.reviewsFolder + "/") && path.endsWith(".md");
  }

  deviceOf(path: string): string {
    return path.slice(this.reviewsFolder.length + 1).split("/")[0];
  }

  isOwn(path: string): boolean {
    return this.isLogFile(path) && this.deviceOf(path) === this.device;
  }

  async loadAll(): Promise<LoadResult> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.isLogFile(f.path));
    const result: LoadResult = { events: [], bad: [], devices: {} };
    // Read every file at once, then parse in a fixed order.
    const texts = await Promise.all(files.map((f) => this.app.vault.read(f)));
    for (const [i, f] of files.entries()) {
      const text = texts[i];
      const parsed = parseLog(text, this.deviceOf(f.path));
      result.events.push(...parsed.events);
      if (parsed.badLines.length) result.bad.push({ path: f.path, lines: parsed.badLines });
      const d = (result.devices[this.deviceOf(f.path)] ??= {});
      if (parsed.last && (!d.last || parsed.last > d.last)) d.last = parsed.last;
      if (parsed.session && (!d.versionAt || parsed.session.ts > d.versionAt)) {
        d.version = parsed.session.version;
        d.versionAt = parsed.session.ts;
      }
    }
    return result;
  }

  /** Append one event to this device's file for the event's month. Writes are serialised. */
  append(e: LogEvent): Promise<void> {
    const run = this.queue.then(() => this.write(e));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(e: LogEvent): Promise<void> {
    const dir = normalizePath(`${this.reviewsFolder}/${this.device}`);
    await this.ensureFolder(dir);
    const path = normalizePath(`${dir}/${logFileName(e.ts)}`);
    const stamp = this.version && !this.stamped ? sessionLine(new Date().toISOString(), this.version) + "\n" : "";
    const line = stamp + formatEvent(e) + "\n";
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, line);
    } else {
      await this.app.vault.create(path, `${logHeader(this.device)}\n\n${line}`);
    }
    this.stamped = true;
  }

  private async ensureFolder(dir: string): Promise<void> {
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          // Created meanwhile (e.g. by sync); fine.
        }
      }
    }
  }
}

/** "today 7:46 PM", "yesterday 6:10 PM", "Oct 1, 2:14 PM" in the device's own time zone. */
function when(ts: string, now: Date): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** One line per other device for the deck list, newest first; flags a version that differs from ours. */
export function syncLines(devices: Record<string, DeviceInfo>, own: string, version: string, now: Date): string[] {
  const others = Object.entries(devices).filter(([id, d]) => id !== own && d.last);
  const kinds = others.map(([id]) => deviceLabel(id));
  return others
    .sort((a, b) => (a[1].last! < b[1].last! ? 1 : -1))
    .map(([id, d]) => {
      const label = deviceLabel(id);
      const name = kinds.filter((k) => k === label).length > 1 ? `${label} (${id.split("-")[1]})` : label;
      // The version is the one that wrote that device's last answer, so an older one only means it
      // hasn't answered since updating. A newer one means this device is behind.
      const cmp = d.version ? compareVersions(d.version, version) : 0;
      const ver = !d.version
        ? ""
        : cmp > 0
          ? ` · Osteon ${d.version} (newer than this device: restart Obsidian here to update)`
          : cmp < 0
            ? ` · that answer was on Osteon ${d.version}`
            : ` · Osteon ${d.version}`;
      return `Latest from ${name}: ${when(d.last!, now)}${ver}`;
    });
}
