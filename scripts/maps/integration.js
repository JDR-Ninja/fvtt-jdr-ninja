import { I18N } from "../constants.js";
import { MapImportPanel } from "./panel.js";

/** The module's directory shortcuts share one compact row, `div.jn-directory-actions`: reuse it, create it only when absent. */
function shortcutRow(host) {
  let row = host.querySelector(".jn-directory-actions");
  if (!row) {
    row = document.createElement("div");
    row.className = "jn-directory-actions";
    host.append(row);
  }
  return row;
}

/**
 * The Scenes directory shortcut: an icon and the label, the full title as its tooltip and accessible name. Only a GM
 * sees it; the window itself explains a missing permission to upload files.
 */
export function renderMapButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelectorAll(".jdr-ninja-map-open").forEach(button => button.remove());
  // Our button may have been the row's only content: leave no empty row behind.
  root.querySelectorAll(".jn-directory-actions").forEach(row => { if (!row.childElementCount) row.remove(); });
  if (game.user?.isGM !== true) return;
  const title = game.i18n.localize(`${I18N}.maps.title`);
  const button = document.createElement("button"), glyph = document.createElement("i"), label = document.createElement("span");
  button.type = "button"; button.className = "jdr-ninja-map-open jn-directory-button";
  button.setAttribute("data-tooltip", title); button.setAttribute("aria-label", title);
  glyph.className = "fa-solid fa-map"; glyph.setAttribute("aria-hidden", "true");
  label.textContent = game.i18n.localize(`${I18N}.maps.shortcut`);
  button.append(glyph, label);
  button.addEventListener("click", () => MapImportPanel.open());
  shortcutRow(root.querySelector(".header-actions") || root.querySelector(".directory-footer") || root).append(button);
}

export function registerMapIntegration() {
  Hooks.on("renderSceneDirectory", renderMapButton);
}
