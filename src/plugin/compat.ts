import { requireApiVersion, type ButtonComponent } from "obsidian";

/**
 * Style a button as the filled red one for deleting something. Obsidian 1.13 spells it destructive +
 * primary (what its old `setWarning` now does); older versions get the class `setWarning` used to add.
 */
export function destructive(b: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) b.setDestructive().setCta();
  else b.buttonEl.addClass("mod-warning");
  return b;
}
