import { describe, expect, it } from "vitest";
import type { SettingDefinition } from "obsidian";
import { ACTIONS, FlashcardsSettingTab, getSettingPath, mergeSettings, setSettingPath, type FlashcardsSettings } from "../src/plugin/settings";

type Row = SettingDefinition;

/** A tab over a plugin that has only its settings, as when Obsidian indexes the tab for search at startup. */
function tabFor(settings: FlashcardsSettings) {
  let saves = 0;
  const plugin = { settings, manifest: { version: "0.0.0" }, saveSettings: async () => void saves++ };
  const tab = new FlashcardsSettingTab({} as never, plugin as never);
  const sections = () => tab.getSettingDefinitions().flatMap((d) => ("type" in d ? [d] : []));
  const rows = () => sections().flatMap((g) => g.items);
  const shown = (r: Row) => (typeof r.visible === "function" ? r.visible() : r.visible !== false);
  return { tab, sections, rows, shown, saves: () => saves };
}

describe("setting keys", () => {
  it("reads and writes top-level and nested settings", () => {
    const s = mergeSettings(null);
    expect(getSettingPath(s, "showHeatmap")).toBe(true);
    expect(getSettingPath(s, "ai.enabled")).toBe(false);
    expect(setSettingPath(s, "ai.enabled", true)).toBe(true);
    expect(setSettingPath(s, "showHeatmap", false)).toBe(true);
    expect(s.ai.enabled).toBe(true);
    expect(s.showHeatmap).toBe(false);
  });

  it("refuses a key that is not a setting instead of creating it", () => {
    const s = mergeSettings(null);
    const before = JSON.stringify(s);
    for (const key of ["", "nope", "ai.nope", "nope.enabled", "showHeatmap.x", "ai.__proto__", "constructor.prototype"]) {
      expect(setSettingPath(s, key, true), key).toBe(false);
      expect(getSettingPath(s, key), key).toBeUndefined();
    }
    expect(JSON.stringify(s)).toBe(before);
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });
});

describe("settings tab definitions", () => {
  it("can be listed before the plugin's services exist (Obsidian indexes the tab at startup)", () => {
    expect(() => tabFor(mergeSettings(null)).tab.getSettingDefinitions()).not.toThrow();
  });

  it("binds every control to a real setting of the right kind", () => {
    const s = mergeSettings(null);
    const { tab, rows } = tabFor(s);
    const controls = rows().flatMap((r) => (r.control ? [r.control] : []));
    expect(controls.length).toBeGreaterThan(10);
    for (const c of controls) {
      const value = tab.getControlValue(c.key);
      if (c.type === "toggle") expect(typeof value, c.key).toBe("boolean");
      else if (c.type === "dropdown") expect(Object.keys(c.options), c.key).toContain(value);
      else throw new Error(`${c.key}: the pre-1.13 fallback only draws toggles and dropdowns`);
    }
  });

  it("a control change is written to the settings and saved; an unknown key is not", async () => {
    const s = mergeSettings(null);
    const t = tabFor(s);
    await t.tab.setControlValue("gamepad.enabled", false);
    expect(s.gamepad.enabled).toBe(false);
    expect(t.saves()).toBe(1);
    await t.tab.setControlValue("gamepad.nope", false);
    expect(t.saves()).toBe(1);
  });

  it("keeps the sections in their order, with a key row for every action", () => {
    const { sections } = tabFor(mergeSettings(null));
    expect(sections().map((g) => g.heading)).toEqual(["Decks", "Cards", "Review", "Game controller", "Review keys", "Medical-term hover", "AI helpers"]);
    const keyRows = sections().find((g) => g.heading === "Review keys")!.items.map((r) => r.name);
    for (const label of Object.values(ACTIONS)) expect(keyRows).toContain(label);
  });

  it("gives every row in a section its own key (Obsidian matches rows by control key, else by name, when it redraws)", () => {
    for (const g of tabFor(mergeSettings(null)).sections()) {
      const keys = (g.items ?? []).map((r) => ("control" in r && r.control ? `ctrl:${r.control.key}` : `name:${r.name}`));
      expect(keys.filter((k, i) => keys.indexOf(k) !== i), g.heading).toEqual([]);
      for (const r of g.items ?? []) expect(r.name, g.heading).not.toBe("");
    }
  });

  it("shows the server address and the right model row for each provider", () => {
    const s = mergeSettings(null);
    const { rows, shown } = tabFor(s);
    const ai = () =>
      rows()
        .filter((r) => shown(r) && (r.name === "Server address" || r.name === "Model"))
        .map((r) => `${r.name}:${r.control ? "list" : "text"}`);
    expect(ai()).toEqual(["Model:list"]);
    s.ai.provider = "openai";
    expect(ai()).toEqual(["Model:text"]);
    s.ai.provider = "custom";
    expect(ai()).toEqual(["Server address:text", "Model:text"]);
  });

  it("shows the background picture rows only for the picture theme, without rebuilding the list", () => {
    const s = mergeSettings(null);
    const { rows, shown } = tabFor(s);
    const built = rows().filter((r) => r.name === "Background picture" || r.name === "Dim the picture");
    expect(built.map(shown)).toEqual([false, false]);
    s.cardTheme = "image";
    expect(built.map(shown)).toEqual([true, true]);
  });
});
