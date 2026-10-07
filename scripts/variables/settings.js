import { MODULE_ID, I18N } from "../constants.js";
import { emptyStore } from "./schema.js";
import { variableService, STORE_KEYS } from "./service.js";

/** `panelMenu` and `macroMenu` are menu launchers (see `menuLauncher` in ../settings.js), not the windows. */
export function registerVariableSettings(panelMenu, macroMenu) {
  for (const scope of ["world", "personal"]) game.settings.register(MODULE_ID, STORE_KEYS[scope], {
    scope: scope === "personal" ? "user" : "world", config: false, type: Object, default: emptyStore(),
    // The callback userId is the author, not the owner of a user-scoped Setting.
    onChange: () => variableService.invalidate(scope),
  });
  for (const [key, type, icon] of [["variables", panelMenu, "fa-solid fa-sliders"], ["macroArguments", macroMenu, "fa-solid fa-code"]]) {
    if (!type) continue;
    game.settings.registerMenu(MODULE_ID, key, { name: `${I18N}.variables.menu.${key}`, label: `${I18N}.variables.menu.${key}`,
      hint: `${I18N}.variables.menu.hint`, icon, type, restricted: false });
  }
}
