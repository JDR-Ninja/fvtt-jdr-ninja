import { I18N } from "../constants.js";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHex = value => typeof value === "string" && HEX_RE.test(value.trim());
const MESH_BACKED_FACES = [4, 6, 8, 10, 12, 20];
const DIE_TERM_START_RE = /(?:^|[^a-z0-9.@_])\d*d/gi;
const FACE_SPEC_RE = /^(\d+|f|%|\{[^}]*\})/i;

/** Preserve the standalone module's table-formula guard, including mixed unsupported dice. */
export function tableFormulaIsMeshBacked(formula) {
  if (typeof formula !== "string") return false;
  let terms = 0;
  let meshBacked = 0;
  for (const start of formula.matchAll(DIE_TERM_START_RE)) {
    terms++;
    const spec = FACE_SPEC_RE.exec(formula.slice(start.index + start[0].length));
    if (spec && /^\d+$/.test(spec[1]) && MESH_BACKED_FACES.includes(Number(spec[1]))) meshBacked++;
  }
  return terms > 0 && meshBacked === terms;
}

/** Parse flavor in an inert document; never attach untrusted HTML to the active document. */
function stripHtml(html) {
  if (!html) return "";
  try {
    return new DOMParser().parseFromString(String(html), "text/html").body.textContent.trim();
  } catch { return String(html).replace(/<[^>]*>/g, "").trim(); }
}

/** `#rgb` or `#rrggbb` as `#rrggbb`; a preset's array of variants yields its first valid colour. */
function hexOf(value) {
  const candidate = Array.isArray(value) ? value.find(isHex) : value;
  if (!isHex(candidate)) return undefined;
  const hex = candidate.trim().toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/** The die type Dice So Nice resolves per-die settings with (its coin is `dc`). */
function dieTypeOf(message) {
  const faces = message.rolls?.flatMap(roll => roll.dice ?? [])[0]?.faces;
  return faces === 2 ? "dc" : Number.isInteger(faces) && faces > 0 ? `d${faces}` : "d20";
}

/** DSN's own rule for "character owner appearance": the PC's assigned player, else its single player owner. */
function playerOwner(actor, current) {
  if (!actor?.hasPlayerOwner) return null;
  const users = Array.from(current.users?.values?.() ?? []);
  let owner = users.find(user => !user.isGM && user.character?.id === actor.id);
  if (!owner) {
    const ownership = { ...actor.ownership };
    if (ownership.default !== 3) {
      delete ownership.default;
      const players = Object.keys(ownership).filter(id => current.users.get(id) && !current.users.get(id).isGM);
      if (players.length === 1) owner = current.users.get(players[0]);
    }
  }
  return owner ?? null;
}

/**
 * The user and actor whose dice Dice So Nice draws for this message (mirrors its chat-message
 * handler): the author and the speaker's actor, or the actor's player owner when DSN's
 * `forceCharacterOwnerAppearance` setting applies to the message.
 */
function dsnRoller(message, current) {
  const speakerActor = speaker => {
    if (!speaker) return null;
    try { return message.constructor?.getSpeakerActor?.(speaker) ?? current.actors?.get(speaker.actor) ?? null; }
    catch { return current.actors?.get(speaker.actor) ?? null; }
  };
  let author = message.author, speaker = message.speaker;
  let mode;
  try { mode = current.settings?.get("dice-so-nice", "forceCharacterOwnerAppearance"); } catch { mode = undefined; }
  if (mode === "2" || (mode === "1" && message.getFlag?.("core", "initiativeRoll"))) {
    const roll = message.rolls?.[0];
    const actorId = roll?.data?.actorId || roll?.dice?.[0]?.options?.dsnActorId;
    const actor = (actorId ? current.actors?.get(actorId) : null) ?? speakerActor(message.speaker);
    const owner = playerOwner(actor, current);
    if (owner) { author = owner; if (actorId) speaker = { actor: actorId }; }
  }
  return { author, actor: speakerActor(speaker) };
}

/**
 * A user's Dice So Nice appearance scopes (`global` plus per-die-type entries), merged as DSN merges them
 * before it draws: the user-colour default, the package defaults for a player who never saved a look, the
 * user flag, then the speaking actor's flag. Up to 6.3, DSN exposes this as the static
 * `Dice3D.ALL_CUSTOMIZATION`. 6.4 moved it into a settings class it does not export, so the same steps are
 * replayed with the helpers it does export (`dice3d.exports.Utils`). Undefined when neither exists: a
 * future DSN that moves them again must show up as unreadable (`dsnAppearanceStatus`), never as a guess.
 */
function dsnAppearanceScopes(dsn, user, actor) {
  const Dice3D = dsn?.constructor;
  if (typeof Dice3D?.ALL_CUSTOMIZATION === "function") {
    return Dice3D.ALL_CUSTOMIZATION(user, dsn.DiceFactory, actor)?.appearance;
  }
  const Utils = dsn?.exports?.Utils, utils = globalThis.foundry?.utils;
  if (typeof Utils?.contrastOf !== "function" || typeof Utils?.sanitizeAppearance !== "function"
    || typeof utils?.mergeObject !== "function" || typeof utils?.deepClone !== "function") return undefined;
  const merge = (target, source) => utils.mergeObject(target, utils.deepClone(source), { applyOperators: true });
  const flag = (document, key) => document?.getFlag?.("dice-so-nice", key);
  const color = user.color?.toString?.() ?? "#000000";
  let appearance = { global: { labelColor: Utils.contrastOf(color), diceColor: color, outlineColor: color,
    edgeColor: color, texture: "none", material: "auto", font: "auto", colorset: "custom", system: "standard" } };
  const packageDefaults = dsn.DiceFactory?.getRole?.("basic")?.defaults;
  if (!flag(user, "saved")?.appearance && packageDefaults && Object.keys(packageDefaults).length) {
    appearance = merge(appearance, Utils.sanitizeAppearance(utils.deepClone(packageDefaults), user));
  }
  appearance = merge(appearance, flag(user, "appearance") ?? {});
  delete appearance.dimensions;
  const actorAppearance = flag(actor, "appearance");
  if (actorAppearance) appearance = merge(appearance, actorAppearance);
  return Utils.sanitizeAppearance(appearance, user);
}

/**
 * Whether this client can read the dice look Dice So Nice draws: `absent` without DSN, `ok` when the current
 * user's appearance resolves, `unreadable` when DSN is there but neither known way to read it works (a DSN
 * update moved its internals again, as 6.4 did). Shown in the overlay panel's diagnostics, since an unreadable
 * appearance changes nothing else: rolls still reach the stream, in the overlay's default dice.
 */
export function dsnAppearanceStatus(current = globalThis.game) {
  const dsn = current?.dice3d;
  if (!dsn) return "absent";
  try {
    if (typeof dsn.DiceFactory?.getAppearanceForDice !== "function" || !current.user) return "unreadable";
    const scopes = dsnAppearanceScopes(dsn, current.user, null);
    const resolved = scopes?.global ? dsn.DiceFactory.getAppearanceForDice(scopes, "d20") : null;
    return resolved && typeof resolved === "object" ? "ok" : "unreadable";
  } catch { return "unreadable"; }
}

/**
 * The colours and material/font names the roller's dice show at the table, resolved by the installed
 * Dice So Nice itself: its user-colour default, the user's settings (flag `global`, or a per-die-type
 * entry), a chosen preset, an actor override and a system's preferred colorset. Never textures, meshes
 * or preset tables. The raw user flag is not enough: it stores `diceColor`/`labelColor` only for the
 * custom colorset and holds nothing at all for a user who never opened DSN's settings.
 */
export function extractAppearance(message, current = globalThis.game) {
  try {
    const dsn = current?.dice3d, factory = dsn?.DiceFactory;
    if (typeof factory?.getAppearanceForDice !== "function") return undefined;
    const { author, actor } = dsnRoller(message, current);
    if (!author) return undefined;
    const appearances = dsnAppearanceScopes(dsn, author, actor);
    if (!appearances?.global) return undefined;
    let resolved;
    try { resolved = factory.getAppearanceForDice(appearances, dieTypeOf(message)); }
    catch { resolved = factory.getAppearanceForDice(appearances, "d20"); }
    if (!resolved || typeof resolved !== "object") return undefined;
    const result = {};
    for (const [source, target] of [["background", "diceColor"], ["foreground", "labelColor"],
      ["outline", "outlineColor"], ["edge", "edgeColor"]]) {
      const hex = hexOf(resolved[source]);
      if (hex) result[target] = hex;
    }
    for (const name of ["material", "font"]) {
      const value = typeof resolved[name] === "string" ? resolved[name].trim() : "";
      if (value && !["auto", "none"].includes(value)) result[name] = value.slice(0, 64);
    }
    return Object.keys(result).length ? result : undefined;
  } catch { return undefined; }
}

/** Exact core roll results. Never evaluate or re-roll a message. */
export function buildOverlayPayload(message) {
  const rolls = message.rolls ?? [];
  const dice = rolls.flatMap(roll => (roll.dice ?? []).map(term => ({
    faces: term.faces, results: (term.results ?? []).map(result => result.result),
  })));
  if (!dice.length) return null;
  const speaker = message.speaker;
  const roller = (speaker?.actor ? game.actors?.get(speaker.actor)?.name : null) || speaker?.alias
    || message.author?.name || game.i18n.localize(`${I18N}.overlay.unknownRoller`);
  const payload = { rollId: message.id, formula: rolls.map(roll => roll.formula).filter(Boolean).join(" + "),
    total: rolls.reduce((sum, roll) => sum + (roll.total ?? 0), 0), dice,
    label: stripHtml(message.flavor), roller };
  const appearance = extractAppearance(message);
  if (appearance) payload.appearance = appearance;
  return payload;
}
