import { MODULE_ID, SETTINGS } from "../constants.js";
import { DEFAULT_BRIDGE_URL } from "./protocol.js";

export function registerStreamDeckSettings(onChange = () => {}) {
  // The switch lives in Connections: no line in Configure Settings.
  game.settings.register(MODULE_ID, SETTINGS.streamDeckEnabled, {
    scope: "client", config: false, type: Boolean, default: false, onChange,
  });
  for (const [key, initial] of [[SETTINGS.streamDeckUrl, DEFAULT_BRIDGE_URL], [SETTINGS.streamDeckKey, ""]]) {
    game.settings.register(MODULE_ID, key, { scope: "client", config: false, type: String, default: initial, onChange });
  }
}
