import { MODULE_ID, I18N, SETTINGS } from "../constants.js";

/** `monsterMenu` and `npcMenu` are menu launchers (see `menuLauncher` in ../settings.js), not the windows. */
export function registerCreatureSettings(onChange, monsterMenu, npcMenu) {
  // The switch lives in Connections, the only place that enables a feature: no line in Configure Settings.
  game.settings.register(MODULE_ID, SETTINGS.creaturesEnabled, {
    scope: "client", config: false, type: Boolean, default: false, onChange,
  });
  // The menus reuse the generator windows' icons; each has its own hint, for the window it opens.
  for (const [kind, type, icon] of [["monster", monsterMenu, "fa-solid fa-dragon"], ["npc", npcMenu, "fa-solid fa-masks-theater"]]) {
    if (!type) continue;
    game.settings.registerMenu(MODULE_ID, `${kind}Generator`, {
      name: `${I18N}.creatures.${kind}`, label: `${I18N}.creatures.${kind}Shortcut`, hint: `${I18N}.creatures.${kind}MenuHint`,
      icon, type, restricted: true,
    });
  }
}
