/**
 * Orchestration: glue the converter, the HTTP client and the actor flags together for the two write
 * paths (push an already-linked actor, create-on-sync an unlinked one). Each function returns the API
 * result envelope ({ ok, status, body }, plus `portraitNotice` when a too-large portrait was left out
 * of the request) and writes the flags back on success.
 */

import { STATUS, PORTRAIT_OUTCOME, localizeStatus, localizeValidationError, formatRetryDelay } from "./constants.js";
import { AtlasApi } from "./api.js";
import { buildPayload, dropOversizedPortrait, portraitLimitMegabytes } from "./converter.js";
import { getLink, setLink, markSynced } from "./flags.js";
import { atlasAccess, connectionStamp, canContinue, watchAtlasOperation } from "./availability.js";

const pendingActors = new Set();

/** `result.portraitNotice` when the portrait was left out of a request because it was too large. */
export const PORTRAIT_NOTICE = { TOO_LARGE: "TOO_LARGE" };

/**
 * The portrait hash to record after a successful write: the one sent, when Atlas now holds that image
 * (it stored it, or already had it, e.g. after linking to a character synced from this actor before).
 * Without a portrait in the request, or when Atlas skipped or failed it, the previous hash stays.
 */
function syncedPortraitHash(result, payload) {
  if (!payload.portraitHash) return undefined;
  return [PORTRAIT_OUTCOME.UPDATED, PORTRAIT_OUTCOME.UNCHANGED].includes(result.body?.portrait)
    ? payload.portraitHash : undefined;
}

/** Adds the portrait notice to a result without touching the shared access/guard objects. */
function withPortraitNotice(result, portraitTooLarge) {
  return portraitTooLarge ? { ...result, portraitNotice: PORTRAIT_NOTICE.TOO_LARGE } : result;
}

async function withActor(actor, action) {
  const access = atlasAccess();
  if (!access.ok) return access;
  if (actor?.type !== "character") return { ok: false, status: STATUS.CHARACTER_NOT_FOUND, body: {} };
  if (pendingActors.has(actor.id)) return { ok: false, status: STATUS.SYNC_IN_PROGRESS, body: {} };
  pendingActors.add(actor.id);
  const controller = new AbortController();
  const finish = watchAtlasOperation(controller);
  try { return await action(connectionStamp(), controller.signal); }
  finally { pendingActors.delete(actor.id); finish(); }
}

/** Pushes a linked actor's sheet (+ portrait if changed and small enough) into its Atlas PC. */
export async function pushActor(actor) {
  return withActor(actor, async (stamp, signal) => {
    const link = getLink(actor);
    if (!link?.atlasCharacterId) {
      return { ok: false, status: STATUS.CHARACTER_NOT_FOUND, body: {} };
    }

    const payload = await buildPayload(actor, { previousPortraitHash: link.portraitHash, signal });
    const portraitTooLarge = dropOversizedPortrait(payload);
    const ready = canContinue(stamp);
    if (!ready.ok) return ready;
    const result = await AtlasApi.push(link.atlasCharacterId, payload);

    if (result.ok) {
      const current = canContinue(stamp);
      if (!current.ok) return current;
      await markSynced(actor, {
        syncedAtUtc: result.body.syncedAtUtc ?? new Date().toISOString(),
        portraitHash: syncedPortraitHash(result, payload),
      });
    }
    return withPortraitNotice(result, portraitTooLarge);
  });
}

/** Creates a new Atlas PC from an unlinked actor, then links the actor to it. */
export async function createActor(actor, campaignId, markCreatedAsClaimable) {
  return withActor(actor, async (stamp, signal) => {
    const payload = await buildPayload(actor, { previousPortraitHash: null, signal });
    payload.name = actor.name;
    payload.markClaimable = Boolean(markCreatedAsClaimable);
    const portraitTooLarge = dropOversizedPortrait(payload);

    const ready = canContinue(stamp);
    if (!ready.ok) return ready;
    const result = await AtlasApi.create(campaignId, payload);

    if (result.ok && result.body.id) {
      const current = canContinue(stamp);
      if (!current.ok) return current;
      await setLink(actor, result.body.id);
      await markSynced(actor, {
        syncedAtUtc: result.body.syncedAtUtc ?? new Date().toISOString(),
        portraitHash: syncedPortraitHash(result, payload),
      });
    }
    return withPortraitNotice(result, portraitTooLarge);
  });
}

/**
 * The localized warning for a portrait left out of a successful sync, or null. The sheet itself
 * synced, so this comes in addition to the success message, never instead of it.
 */
export function portraitMessage(result) {
  if (!result?.ok || result.portraitNotice !== PORTRAIT_NOTICE.TOO_LARGE) return null;
  return game.i18n.format("JDRNINJA_ATLAS_SYNC.notify.portraitTooLarge", { size: portraitLimitMegabytes() });
}

/**
 * The localized, user-facing message for a failed API result: rate-limit-aware, and specific for
 * the validation failures the GM can act on (a wrong game system, a sheet over the server cap, a
 * body the server could not read); any other error code keeps the generic status string.
 */
export function resultMessage(result) {
  // Rate limited: the server tells us the cooldown remaining, so say when to retry.
  if (result.status === STATUS.RATE_LIMITED && result.body?.retryAfterSeconds > 0) {
    return game.i18n.format("JDRNINJA_ATLAS_SYNC.status.RATE_LIMITED_RETRY", {
      delay: formatRetryDelay(result.body.retryAfterSeconds),
    });
  }
  // Validation failed: the body carries `errors: [{ code, path }]`; the first code names the cause.
  if (result.status === STATUS.VALIDATION_FAILED) {
    const specific = localizeValidationError(result.body?.errors?.[0]?.code);
    if (specific) return specific;
  }
  return localizeStatus(result.status);
}

/** Surfaces an API result to the user as a localized notification, plus a portrait left out. */
export function notify(result, successKey = "JDRNINJA_ATLAS_SYNC.notify.synced") {
  if (result.ok) {
    ui.notifications.info(game.i18n.localize(successKey));
    const portrait = portraitMessage(result);
    if (portrait) ui.notifications.warn(portrait);
    return;
  }
  ui.notifications.warn(resultMessage(result));
}
