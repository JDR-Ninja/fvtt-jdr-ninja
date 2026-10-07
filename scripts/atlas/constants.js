/**
 * Shared constants for Atlas Character Sync.
 */

import { MODULE_ID, SETTINGS as ROOT_SETTINGS, DEFAULT_ORIGIN } from "../constants.js";
export { MODULE_ID };
export const LEGACY_MODULE_ID = "jdr-ninja-atlas-sync";

/**
 * The game systems this module can sync, keyed by Foundry `game.system.id`. Per entry: `min` is the
 * lowest system version whose data paths the matching converter was checked against (older → the
 * guard reports tooOld), `atlasSlug` is the Atlas RPG module the sheet is validated and stored under
 * (sent as `systemSlug`, alongside `sourceSystemId` = the key). The guard (system-guard.js), the
 * converter dispatch (converters/index.js) and the payload (converter.js) all read this table, so
 * adding a system is one entry here + one converter file. tor2e's floor is the first release built
 * on Foundry data models (6.0.0); pf2e's is the last data-path move its converter reads (speeds at
 * `system.movement.speeds`, 7.5.0); sf2e's is the first release that can host a V14 module at all
 * (1.0.0), every path predating it; wfrp4e's is the first V13 line of that system (its data
 * migration has not moved since the V12 line; paths checked against 9.6.4).
 */
export const SUPPORTED_SYSTEMS = {
  dnd5e: { min: "3.0.0", atlasSlug: "dnd5e-compatible" },
  tor2e: { min: "6.0.0", atlasSlug: "tor2e-compatible" },
  pf2e: { min: "7.5.0", atlasSlug: "pf2e-compatible" },
  sf2e: { min: "1.0.0", atlasSlug: "sf2e-compatible" },
  wfrp4e: { min: "9.0.0", atlasSlug: "wfrp4e-compatible" },
};

/** The supported system ids as one readable list, for the guard messages ("dnd5e, wfrp4e"). */
export function supportedSystemIds() {
  return Object.keys(SUPPORTED_SYSTEMS).join(", ");
}

/** World-scope settings keys. */
export const SETTINGS = {
  token: ROOT_SETTINGS.atlasToken,
  apiBaseUrl: ROOT_SETTINGS.atlasOrigin,
  campaignId: ROOT_SETTINGS.atlasCampaignId,
  markCreatedAsClaimable: ROOT_SETTINGS.atlasMarkClaimable,
};

/** Default Atlas API origin. */
export const DEFAULT_API_BASE_URL = DEFAULT_ORIGIN;

/** Path of the actor flag bag that links an actor to its Atlas PC. */
export const FLAG_LINK = "atlasLink";

/** The `contractVersion` every push/create body carries. */
export const CONTRACT_VERSION = 1;

/**
 * The Atlas API accepts push/create bodies up to 3 MiB. A larger body may be refused
 * without an Atlas JSON envelope.
 */
export const MAX_WRITE_BODY_BYTES = 3 * 1024 * 1024;

/** Headroom kept under MAX_WRITE_BODY_BYTES, so a body measured just under the cap is never refused. */
export const WRITE_BODY_HEADROOM_BYTES = 64 * 1024;

/**
 * The API's `portrait` outcomes of a successful push/create. Both
 * mean Atlas now holds the image whose hash was sent: it stored it, or it already had it.
 */
export const PORTRAIT_OUTCOME = {
  UPDATED: "updated",
  UNCHANGED: "unchanged",
};

/**
 * Machine status codes. The module owns the localized string for each
 * (see lang/*.json `JDRNINJA_ATLAS_SYNC.status.<CODE>`); the server never localizes. The first
 * ten come from the server's envelope; the others are set by the module itself, for a request that
 * never reached the server or came back without the envelope (NETWORK_ERROR, REQUEST_TOO_LARGE,
 * SERVER_ERROR) and for its own guards.
 */
export const STATUS = {
  OK: "OK",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  TIER_REQUIRED: "TIER_REQUIRED",
  CAMPAIGN_NOT_FOUND: "CAMPAIGN_NOT_FOUND",
  CHARACTER_NOT_FOUND: "CHARACTER_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  LIMIT_REACHED: "LIMIT_REACHED",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  NETWORK_ERROR: "NETWORK_ERROR",
  REQUEST_TOO_LARGE: "REQUEST_TOO_LARGE",
  SERVER_ERROR: "SERVER_ERROR",
  INTEGRATION_DISABLED: "INTEGRATION_DISABLED",
  LEGACY_MODULE_ACTIVE: "LEGACY_MODULE_ACTIVE",
  GM_REQUIRED: "GM_REQUIRED",
  OPERATION_CANCELLED: "OPERATION_CANCELLED",
  SYNC_IN_PROGRESS: "SYNC_IN_PROGRESS",
};

/** Localizes an API status code via the module's lang files. */
export function localizeStatus(code) {
  const key = `JDRNINJA_ATLAS_SYNC.status.${code}`;
  const translated = game.i18n.localize(key);
  // Fall back to a generic message if a new server code has no string yet.
  return translated === key ? game.i18n.localize("JDRNINJA_ATLAS_SYNC.status.UNKNOWN") : translated;
}

/**
 * The `errors[].code` values of a VALIDATION_FAILED response the module has a specific string for
 * (`JDRNINJA_ATLAS_SYNC.error.<CODE>`). The server also sends REQUIRED and VALIDATION_FAILED itself
 * as codes; those keep the generic status string, like any code added server-side later.
 */
export const VALIDATION_ERROR = {
  SYSTEM_MISMATCH: "SYSTEM_MISMATCH",
  TOO_LARGE: "TOO_LARGE",
  MALFORMED_BODY: "MALFORMED_BODY",
};

/**
 * Localizes the first error code of a VALIDATION_FAILED result, or returns null when the code is
 * not one of VALIDATION_ERROR (or its string is missing), so the caller falls back to the generic
 * status message.
 */
export function localizeValidationError(code) {
  if (typeof code !== "string" || !Object.hasOwn(VALIDATION_ERROR, code)) return null;
  const key = `JDRNINJA_ATLAS_SYNC.error.${code}`;
  const translated = game.i18n.localize(key);
  return translated === key ? null : translated;
}

/** Humanizes a cooldown (seconds) into a compact "23 h 5 min" style string for the retry hint. */
export function formatRetryDelay(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const u = (unit) => game.i18n.localize(`JDRNINJA_ATLAS_SYNC.time.${unit}`);
  const parts = [];
  if (h > 0) parts.push(`${h} ${u("hours")}`);
  if (m > 0) parts.push(`${m} ${u("minutes")}`);
  // Under a minute (or an exact hour with no minutes left): show seconds so it is never empty.
  if (parts.length === 0) parts.push(`${s % 60} ${u("seconds")}`);
  return parts.join(" ");
}
