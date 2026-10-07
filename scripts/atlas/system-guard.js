/**
 * Gates the whole sync UI on the active game system. Off-table or too-old → the window/context-menu
 * show a disabled state and no API call is ever made. Table-driven: SUPPORTED_SYSTEMS (constants.js)
 * is the single list of what can sync and the minimum version per system.
 */

import { SUPPORTED_SYSTEMS, supportedSystemIds } from "./constants.js";

export function systemGuard() {
  const id = game.system.id;
  const version = game.system.version;
  const supported = SUPPORTED_SYSTEMS[id];

  if (!supported) {
    return { ok: false, reason: "system", id, version };
  }
  if (foundry.utils.isNewerVersion(supported.min, version)) {
    return { ok: false, reason: "version", id, version, min: supported.min };
  }
  return { ok: true, id, version, min: supported.min, atlasSlug: supported.atlasSlug };
}

/**
 * Localized one-line reason the guard failed (for the window banner). The supported-systems list is
 * built from the table at runtime and passed as `{supported}`, so the strings need no edit per system.
 */
export function guardMessage(guard) {
  if (guard.ok) return "";
  const supported = supportedSystemIds();
  if (guard.reason === "system") {
    return game.i18n.format("JDRNINJA_ATLAS_SYNC.guard.wrongSystem", { system: guard.id, supported });
  }
  return game.i18n.format("JDRNINJA_ATLAS_SYNC.guard.tooOld", {
    system: guard.id,
    version: guard.version,
    min: guard.min,
    supported,
  });
}
