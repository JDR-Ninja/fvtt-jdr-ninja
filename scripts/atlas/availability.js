import { MODULE_ID, SETTINGS } from "../constants.js";
import { LEGACY_MODULE_ID, STATUS } from "./constants.js";
import { systemGuard } from "./system-guard.js";
let revision = 0;
const operations = new Set();
export function watchAtlasOperation(controller) {
  operations.add(controller);
  return () => operations.delete(controller);
}
export function invalidateAtlasWork() {
  revision++;
  for (const controller of operations) controller.abort();
}

export function atlasEnabled() {
  return game.settings.get(MODULE_ID, SETTINGS.atlasEnabled) === true;
}

/** Every entry point, including the HTTP client, checks the world switch and GM permissions. */
export function atlasAccess() {
  if (game.user?.isGM !== true) return { ok: false, status: STATUS.GM_REQUIRED, body: {} };
  if (!atlasEnabled()) return { ok: false, status: STATUS.INTEGRATION_DISABLED, body: {} };
  if (game.modules?.get(LEGACY_MODULE_ID)?.active) {
    return { ok: false, status: STATUS.LEGACY_MODULE_ACTIVE, body: {} };
  }
  if (!systemGuard().ok) {
    return { ok: false, status: STATUS.VALIDATION_FAILED,
      body: { errors: [{ code: "SYSTEM_MISMATCH", path: "systemSlug" }] } };
  }
  return { ok: true };
}

/** Capture the connection so switching worlds/credentials during conversion cannot redirect a write. */
export function connectionStamp() {
  return JSON.stringify([game.settings.get(MODULE_ID, SETTINGS.atlasOrigin),
    game.settings.get(MODULE_ID, SETTINGS.atlasToken), revision]);
}

export function canContinue(stamp) {
  const access = atlasAccess();
  if (!access.ok) return access;
  return stamp === connectionStamp() ? { ok: true }
    : { ok: false, status: STATUS.OPERATION_CANCELLED, body: {} };
}
