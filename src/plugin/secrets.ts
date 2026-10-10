/**
 * Per-device secrets (the AI API key): Obsidian's secret storage when available
 * (1.11.4+), else vault-scoped local storage. Never written to the synced vault or data.json.
 */
import type { App } from "obsidian";

interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

function store(app: App): SecretStore | null {
  const s = (app as unknown as { secretStorage?: SecretStore }).secretStorage;
  return s && typeof s.getSecret === "function" ? s : null;
}

export function getSecret(app: App, id: string): string {
  const s = store(app);
  const v: unknown = s ? s.getSecret(id) : app.loadLocalStorage(id);
  return typeof v === "string" ? v : "";
}

export function setSecret(app: App, id: string, value: string): void {
  const s = store(app);
  if (s) s.setSecret(id, value);
  else app.saveLocalStorage(id, value || null);
}

// ---- optional: the key in a file beside the plugin, so the owner's other devices pick it up ------

/** `<plugin folder>/api-key.json`. It travels with whatever syncs the vault's config folder. */
export function keyFilePath(pluginDir: string): string {
  return `${pluginDir}/api-key.json`;
}

export function parseKeyFile(text: string): string {
  try {
    const v = (JSON.parse(text) as { anthropicKey?: unknown }).anthropicKey;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return ""; // half-synced or hand-edited: treat as no key rather than a wrong one
  }
}

export function formatKeyFile(key: string): string {
  return JSON.stringify({ note: "Osteon: synced AI API key. Keep this file private.", anthropicKey: key }, null, 1);
}

/** Write the synced copy, or remove it when there is no key (or syncing was turned off). */
export async function writeKeyFile(app: App, pluginDir: string, key: string): Promise<void> {
  const path = keyFilePath(pluginDir);
  const { adapter } = app.vault;
  if (key) await adapter.write(path, formatKeyFile(key));
  else if (await adapter.exists(path)) await adapter.remove(path);
}

/** Take the synced key onto this device if it differs. True if this device's key changed. */
export async function pullKeyFile(app: App, pluginDir: string, id: string): Promise<boolean> {
  const path = keyFilePath(pluginDir);
  const { adapter } = app.vault;
  try {
    if (!(await adapter.exists(path))) return false;
    const key = parseKeyFile(await adapter.read(path));
    if (!key || key === getSecret(app, id)) return false;
    setSecret(app, id, key);
    return true;
  } catch {
    return false;
  }
}
