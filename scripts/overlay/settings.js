import { MODULE_ID, I18N, SETTINGS } from "../constants.js";

/**
 * The relay and table-command switches restart roll and poll work (`onSwitch`). The filter and the hold are read
 * as each roll arrives, so they only redraw what shows them (`onPreference`). Neither touches the account.
 */
export function registerOverlaySettings({ onSwitch = () => {}, onPreference = () => {} } = {}) {
  const prefix = `${I18N}.overlay`;
  for (const [key, label, type, value, onChange, choices] of [
    ["overlayEnabled", "enable", Boolean, false, onSwitch],
    ["overlayForwardFilter", "filter", String, "allPublic", onPreference,
      { allPublic: `${prefix}.allPublic`, playersOnly: `${prefix}.playersOnly` }],
    ["overlayCardHoldSeconds", "hold", String, "0", onPreference, Object.fromEntries(["0", "1", "2", "3", "5"].map(
      seconds => [seconds, `${prefix}.hold${seconds}`]))],
    ["overlayTableCommandsEnabled", "tableCommands", Boolean, false, onSwitch],
  ]) {
    const options = { name: `${prefix}.${label}`, hint: `${prefix}.${label}Hint`,
      scope: "client", config: true, type, default: value, ...(choices ? { choices } : {}), onChange };
    // Only a GM browser polls Twitch table commands.
    if (key === "overlayTableCommandsEnabled") gmOnlyInSettings(options);
    game.settings.register(MODULE_ID, SETTINGS[key], options);
  }
  for (const [key, type, value] of [["overlayLastSuccessAt", Number, 0], ["overlayLastErrorAt", Number, 0],
    ["overlayLastError", String, ""]]) {
    game.settings.register(MODULE_ID, SETTINGS[key], { scope: "client", config: false, type, default: value });
  }
}

/**
 * V14 Configure Settings hides only world-scope settings from players (`SettingsConfig#_prepareCategoryData`), and
 * it reads `config` each time it lists the settings. A GM-only browser setting therefore answers per user.
 */
export function gmOnlyInSettings(options) {
  return Object.defineProperty(options, "config", { enumerable: true, configurable: true,
    get: () => globalThis.game?.user?.isGM === true });
}
