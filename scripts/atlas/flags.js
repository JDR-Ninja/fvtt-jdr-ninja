import { MODULE_ID, LEGACY_MODULE_ID, FLAG_LINK } from "./constants.js";

/** Prefer unified metadata; old actor links remain readable even when the old module is uninstalled. */
export function getLink(actor) {
  return actor?.getFlag(MODULE_ID, FLAG_LINK) ?? actor?.flags?.[LEGACY_MODULE_ID]?.link ?? null;
}
export function isLinked(actor) { return Boolean(getLink(actor)?.atlasCharacterId); }
export function setLink(actor, atlasCharacterId) {
  return actor.setFlag(MODULE_ID, FLAG_LINK, { atlasCharacterId, syncedAtUtc: null, portraitHash: null });
}
export function markSynced(actor, { syncedAtUtc, portraitHash } = {}) {
  const next = { ...getLink(actor) };
  if (syncedAtUtc !== undefined) next.syncedAtUtc = syncedAtUtc;
  if (portraitHash !== undefined) next.portraitHash = portraitHash;
  return actor.setFlag(MODULE_ID, FLAG_LINK, next);
}
export function clearLink(actor) {
  // Clear both bags so unlinking cannot reveal the legacy fallback again. V14's forced-deletion
  // operator, the form Document#unsetFlag uses; the `-=key` syntax is deprecated since 14. Not
  // unsetFlag itself: it throws for a scope whose module is not active, as the legacy one is not.
  const { ForcedDeletion } = foundry.data.operators;
  return actor.update({ flags: {
    [MODULE_ID]: { [FLAG_LINK]: new ForcedDeletion() },
    [LEGACY_MODULE_ID]: { link: new ForcedDeletion() },
  } });
}
