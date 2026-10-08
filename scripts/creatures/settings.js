import { MODULE_ID, I18N, SETTINGS } from "../constants.js";
import { gmOnlyInSettings } from "../overlay/settings.js";

/** `monsterMenu` and `npcMenu` are menu launchers (see `menuLauncher` in ../settings.js), not the windows. */
export function registerCreatureSettings(onChange, monsterMenu, npcMenu) {
  // Creature generation is a GM feature: players never see this browser switch in Configure Settings.
  game.settings.register(MODULE_ID, SETTINGS.creaturesEnabled, gmOnlyInSettings({
    name: `${I18N}.creatures.enable`, hint: `${I18N}.creatures.enableHint`, scope: "client",
    config: true, type: Boolean, default: false, onChange,
  }));
  // The menus reuse the generator windows' icons.
  for (const [kind, type, icon] of [["monster", monsterMenu, "fa-solid fa-dragon"], ["npc", npcMenu, "fa-solid fa-user"]]) {
    if (!type) continue;
    game.settings.registerMenu(MODULE_ID, `${kind}Generator`, {
      name: `${I18N}.creatures.${kind}`, label: `${I18N}.creatures.${kind}Shortcut`, hint: `${I18N}.creatures.menuHint`,
      icon, type, restricted: true,
    });
  }
}
