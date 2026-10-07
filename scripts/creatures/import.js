import { MODULE_ID } from "../constants.js";
import { creatureClient } from "./api.js";
import { buildActor } from "./generated/dnd-foundry/export.mjs";
import { MAPPER_VERSION } from "./generated/dnd-foundry/version.mjs";
import { CreatureError, selectedSource } from "./contract.js";

const locks = new Set();
export async function actorId(resultId, crypto = globalThis.crypto) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(resultId));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
export function matchingImport(actor, result) {
  const flag = actor?.getFlag?.(MODULE_ID, "creatureImport") ?? actor?.flags?.[MODULE_ID]?.creatureImport;
  return flag?.resultId === result.resultId && flag?.kind === result.generatorKind && actor.type === "npc";
}

/** One native create operation preserves item/activity ids and their shared-resource references. */
export async function importCreature(result, { state, folderId = "", name = result.source.name, signal,
  client = creatureClient, getGame = () => game, documentClass = () => Actor, sanitize } = {}) {
  client.assertCurrent(state);
  if (typeof name !== "string" || !name.trim() || name.length > 256) throw new CreatureError("invalidName");
  const id = await actorId(result.resultId), lock = `${state.world}:${id}`;
  client.assertCurrent(state);
  if (locks.has(lock)) throw new CreatureError("importBusy");
  locks.add(lock);
  try {
    // Recheck remotely even for a retained preview or a previously uncertain create response.
    await client.check(signal, state);
    client.assertCurrent(state);
    if (signal?.aborted) throw new CreatureError("cancelled");
    const current = getGame();
    const existing = current.actors.get(id);
    if (existing) {
      if (matchingImport(existing, result)) return existing;
      throw new CreatureError("actorCollision");
    }
    const folder = folderId ? current.folders.get(folderId) : null;
    if (folderId && (!folder || folder.type !== "Actor")) throw new CreatureError("invalidFolder");
    const Class = documentClass();
    if (Class.canUserCreate && !Class.canUserCreate(current.user)) throw new CreatureError("notGM");
    const actor = buildActor(selectedSource(result.source, sanitize));
    actor._id = id; actor.name = name.trim(); actor.folder = folder?.id ?? null;
    actor.flags = { [MODULE_ID]: { creatureImport: { resultId: result.resultId, kind: result.generatorKind,
      contractVersion: 1, mapperVersion: MAPPER_VERSION, generatorVersion: result.generatorVersion,
      importedAtUtc: new Date().toISOString() } } };
    client.assertCurrent(state);
    if (signal?.aborted) throw new CreatureError("cancelled");
    try {
      const created = await Class.create(actor, { keepId: true, keepEmbeddedIds: true, renderSheet: false });
      if (!created || created.id !== id || !matchingImport(created, result)) throw new CreatureError("importUncertain");
      return created;
    } catch (error) {
      // A lost socket acknowledgement may follow a completed native creation.
      const recovered = getGame().actors.get(id);
      if (recovered && matchingImport(recovered, result)) return recovered;
      if (error instanceof CreatureError) throw error;
      throw new CreatureError("importUncertain");
    }
  } finally { locks.delete(lock); }
}
