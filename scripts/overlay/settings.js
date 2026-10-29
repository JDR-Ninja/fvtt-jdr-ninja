import { MODULE_ID, I18N, SETTINGS } from "../constants.js";

/**
 * The relay and table-command switches restart roll and poll work (`onSwitch`). The filter and the hold are read
 * as each roll arrives, so they only redraw what shows them (`onPreference`). Neither touches the account.
 * None has a line in Configure Settings: the switch is in Connections and the preferences in the overlay window.
 */
export function registerOverlaySettings({ onSwitch = () => {}, onPreference = () => {} } = {}) {
  const prefix = `${I18N}.overlay`;
  for (const [key, type, value, onChange, choices] of [
    ["overlayEnabled", Boolean, false, onSwitch],
    ["overlayForwardFilter", String, "allPublic", onPreference,
      { allPublic: `${prefix}.allPublic`, playersOnly: `${prefix}.playersOnly` }],
    ["overlayCardHoldSeconds", String, "0", onPreference, Object.fromEntries(["0", "1", "2", "3", "5"].map(
      seconds => [seconds, `${prefix}.hold${seconds}`]))],
    ["overlayTableCommandsEnabled", Boolean, false, onSwitch],
  ]) {
    game.settings.register(MODULE_ID, SETTINGS[key], { scope: "client", config: false, type, default: value,
      ...(choices ? { choices } : {}), onChange });
  }
  for (const [key, type, value] of [["overlayLastSuccessAt", Number, 0], ["overlayLastErrorAt", Number, 0],
    ["overlayLastError", String, ""]]) {
    game.settings.register(MODULE_ID, SETTINGS[key], { scope: "client", config: false, type, default: value });
  }
}
