import { I18N } from "../constants.js";
import { MapImportPanel } from "./panel.js";
import { removeShortcuts, shortcutRow, shortcutButton } from "../ui/directory.js";

/**
 * The Scenes directory shortcut: an icon and the label, the full title as its tooltip and accessible name. Only a GM
 * sees it; the window itself explains a missing permission to upload files.
 */
export function renderMapButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  removeShortcuts(root, ".jdr-ninja-map-open");
  if (game.user?.isGM !== true) return;
  shortcutRow(root).append(shortcutButton({
    className: "jdr-ninja-map-open", icon: "fa-solid fa-map",
    title: game.i18n.localize(`${I18N}.maps.title`), label: game.i18n.localize(`${I18N}.maps.shortcut`),
    onClick: () => MapImportPanel.open(),
  }));
}

export function registerMapIntegration() {
  Hooks.on("renderSceneDirectory", renderMapButton);
}
