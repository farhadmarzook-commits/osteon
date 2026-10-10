/**
 * Redraw a view on "changed" only while it's visible. A hidden tab (the deck list behind the
 * reviewer) just marks itself stale and redraws when it's shown again, so answering a card doesn't
 * pay for redrawing views nobody is looking at.
 */
import type { ItemView } from "obsidian";

export function renderWhenVisible(view: ItemView, render: () => void): () => void {
  let stale = false;
  const visible = () => view.containerEl.isShown();
  const showIfStale = () => {
    if (stale && visible()) {
      stale = false;
      render();
    }
  };
  view.registerEvent(view.app.workspace.on("active-leaf-change", showIfStale));
  view.registerEvent(view.app.workspace.on("layout-change", showIfStale));
  return () => {
    if (visible()) {
      stale = false;
      render();
    } else stale = true;
  };
}
