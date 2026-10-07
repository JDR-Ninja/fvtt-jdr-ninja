import { MODULE_ID, I18N, SETTINGS } from "../constants.js";
import { DEFAULT_BRIDGE_URL } from "./protocol.js";

export function registerStreamDeckSettings(onChange = () => {}) {
  game.settings.register(MODULE_ID, SETTINGS.streamDeckEnabled, {
    name: `${I18N}.streamDeck.enable`, hint: `${I18N}.streamDeck.enableHint`,
    scope: "client", config: true, type: Boolean, default: false, onChange,
  });
  for (const [key, initial] of [[SETTINGS.streamDeckUrl, DEFAULT_BRIDGE_URL], [SETTINGS.streamDeckKey, ""]]) {
    game.settings.register(MODULE_ID, key, { scope: "client", config: false, type: String, default: initial, onChange });
  }
}
