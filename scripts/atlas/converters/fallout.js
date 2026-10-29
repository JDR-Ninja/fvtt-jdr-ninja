/**
 * fallout converter: projects a live Fallout: The Roleplaying Game player-character actor (a
 * `character`, or a `robot` for a Mister Handy PC, see `actorTypes` in SUPPORTED_SYSTEMS) to the
 * Atlas `fallout-compatible` API schema (v1, flat object). Foundry codes are sent verbatim where the
 * system has one (the attribute keys `str`…`luc`, the body-location keys, the actor types, the
 * immunity keys); a skill has no code in the system (its English item name is the identifier), so it
 * is sent under the slugified English name; perks and traits are bounded free-text names. Reads the
 * PREPARED actor (`actor.system` after prepareData, `actor.itemTypes`, `item.name`), never the raw
 * `_source`, and only core APIs. Data paths checked against fallout 11.17.1 (see
 * SUPPORTED_SYSTEMS.fallout.min in constants.js: 11.17.0 is the first release for Foundry V14, with
 * the same paths): the origin `system.origin` (free text), the level `system.level.value`, the seven
 * attributes `system.attributes.<code>.value`, the four derived values `system.health.max`,
 * `system.defense.value`, `system.initiative.value` and `system.meleeDamage.value`, skill items
 * (`system.value` rank, `system.tag`), perk items (`system.rank.value`), trait items, the damage
 * resistance per location `system.body_parts.<location>.resistance.{physical,energy,radiation}`
 * (equipment included, as the system's own sheet shows it), the poison resistance
 * `system.resistance.poison` and the immunities `system.immunities.{radiation,poison}`.
 *
 * Maximum health folds live state in: when the world computes derived stats itself, the system
 * subtracts the radiation taken and adds 2 while the character is well rested (or the robot is
 * tinkered with). The converter takes those terms back out, so the synced value is the maximum
 * without play state. Bonuses stay in (the four derived values are sent as the system shows them).
 *
 * What is not synced: current health, radiation, luck points, caps, experience, needs, conditions,
 * injuries, addictions, carry weight, every inventory item, biography, custom skills (an item that
 * is not one of the 17 core skills is skipped with a console warning) and the other actor types.
 *
 * Out-of-range values are CLAMPED and lists trimmed to their caps rather than refused: the server
 * rejects the whole payload on one bad value, and a homebrew rank 7 becoming 6 on a summary is the
 * lesser evil. The Atlas server re-validates the sheet as a safety net.
 */

import { cutText } from "./text.js";

const ATTRIBUTES = ["str", "per", "end", "cha", "int", "agi", "luc"];
const LOCATIONS = ["head", "torso", "armL", "armR", "legL", "legR"];
const IMMUNITIES = ["radiation", "poison"];

/**
 * The 17 core skills as [English item name, Atlas code], in the order the converter emits them.
 * Written out, never computed: a code must not move if Foundry's `slugify` ever does.
 */
const SKILLS = [
  ["Athletics", "athletics"],
  ["Barter", "barter"],
  ["Big Guns", "big-guns"],
  ["Energy Weapons", "energy-weapons"],
  ["Explosives", "explosives"],
  ["Lockpick", "lockpick"],
  ["Medicine", "medicine"],
  ["Melee Weapons", "melee-weapons"],
  ["Pilot", "pilot"],
  ["Repair", "repair"],
  ["Science", "science"],
  ["Small Guns", "small-guns"],
  ["Sneak", "sneak"],
  ["Speech", "speech"],
  ["Survival", "survival"],
  ["Throwing", "throwing"],
  ["Unarmed", "unarmed"],
];

/**
 * Skill labels a world may show instead of the English item name, by code: the labels of the five
 * site languages, the system's own French and Spanish short forms and the French community module's
 * names. A skill item renamed to one of these still resolves (layer 3 of `skillResolver`). The English
 * names are matched first and need no entry.
 */
const SKILL_ALIASES = {
  athletics: ["Athlétisme", "Atletismo", "Athletik", "Atletica"],
  barter: ["Troc", "Regateo", "Handel", "Baratto"],
  "big-guns": ["Armes lourdes", "Armas grandes", "Große Waffen", "Armi pesanti"],
  "energy-weapons": ["Armes à énergie", "Armas de energía", "Energiewaffen", "Armi a energia"],
  explosives: ["Explosifs", "Explosivos", "Sprengstoffe", "Esplosivi"],
  lockpick: ["Crochetage", "Cerraduras", "Schlösser knacken", "Scasso"],
  medicine: ["Médecine", "Medicina", "Medizin"],
  "melee-weapons": ["Armes de corps à corps", "Armes de CAC", "Armas cuerpo a cuerpo", "Armas c/c", "Nahkampfwaffen", "Armi da mischia"],
  pilot: ["Pilotage", "Pilotar", "Pilotaggio"],
  repair: ["Réparation", "Reparar", "Reparatur", "Riparazione"],
  science: ["Sciences", "Ciencia", "Wissenschaft", "Scienza"],
  "small-guns": ["Armes légères", "Armas pequeñas", "Kleine Waffen", "Armi leggere"],
  sneak: ["Discrétion", "Sigilo", "Schleichen", "Furtività"],
  speech: ["Discours", "Conversación", "Sprache", "Eloquenza"],
  survival: ["Survie", "Supervivencia", "Überleben", "Sopravvivenza"],
  throwing: ["Projectiles", "Lanzar", "Wurfwaffen", "Lancio"],
  unarmed: ["Mains nues", "Desarmado", "Waffenlos", "Disarmato"],
};

// Matches the Atlas API's bounds. The API rejects anything past them, so the converter clamps
// numbers and cuts text, and trims the two lists to their caps.
export const MAX_TEXT = 60;
export const MAX_PERKS = 30;
export const MAX_TRAITS = 6;
const MAX_PERK_RANK = 10;
const MAX_SKILL_RANK = 6;
const MAX_ATTRIBUTE = 15;
const DEFAULT_ATTRIBUTE = 5;
const MAX_LEVEL = 99;
const MAX_HEALTH = 999;
const MAX_DEFENSE = 20;
const MAX_INITIATIVE = 99;
const MAX_MELEE_DAMAGE = 20;
const MAX_RESISTANCE = 99;
const WARN_PREFIX = "jdr-ninja-atlas-sync | fallout:";

/** Integer in `min..max`; a missing, blank or non-numeric value reads as `fallback` (default `min`), a decimal is truncated. */
function clampInt(value, min, max, fallback = min) {
  const blank = value === null || (typeof value === "string" && value.trim() === "");
  const n = blank ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cut(value) {
  return cutText(value, MAX_TEXT);
}

/**
 * The API treats trimmed perk and trait names as unique without case sensitivity.
 * `toUpperCase()` also folds `ı` and `ſ` to `I` and `S`, which `toLowerCase()` would keep
 * apart. Merging equivalent names prevents duplicate-name validation failures.
 */
function dedupeKey(name) {
  return name.toUpperCase();
}

/** A skill name compared loosely: accents, case and runs of spaces ignored. */
function normalizeName(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The world setting that stops the system computing the derived values (read defensively, default off). */
function derivedStatsDisabled() {
  try {
    return globalThis.game?.settings?.get("fallout", "disableAutoDerivedStats") === true;
  } catch {
    return false;
  }
}

/** A skill label the world's language shows for `englishName` (`FALLOUT.SKILL.<name>`), or "" when it has none. */
function localizedSkillLabel(englishName) {
  const key = `FALLOUT.SKILL.${englishName}`;
  try {
    const label = globalThis.game?.i18n?.localize?.(key);
    return typeof label === "string" && label !== key ? label : "";
  } catch {
    return "";
  }
}

/**
 * Builds the skill item → code resolver once per conversion. The system identifies a skill by its
 * English item name, so the layers are, in order:
 *  1. the name the system itself compares: `flags.babele.originalName` of a translated item, else
 *     the item name, matched against the 17 English names;
 *  2. the label of the world's language for each skill (an item renamed to what the system shows);
 *  3. the alias table (the site languages, the community module, the system's short forms).
 * Returns the code, or null for a skill that is not one of the 17.
 */
function skillResolver() {
  const byEnglish = new Map(SKILLS.map(([name, code]) => [normalizeName(name), code]));
  const byLabel = new Map();
  for (const [name, code] of SKILLS) {
    const label = normalizeName(localizedSkillLabel(name));
    if (label !== "") byLabel.set(label, code);
  }
  const byAlias = new Map();
  for (const [code, labels] of Object.entries(SKILL_ALIASES)) {
    for (const label of labels) byAlias.set(normalizeName(label), code);
  }

  const lookup = (name) => {
    const key = normalizeName(name);
    if (key === "") return null;
    return byEnglish.get(key) ?? byLabel.get(key) ?? byAlias.get(key) ?? null;
  };

  return (item) => {
    const babele = item?.flags?.babele;
    const original = babele?.hasTranslation === true && typeof babele.originalName === "string" ? babele.originalName : null;
    return (original !== null ? lookup(original) : null) ?? lookup(item?.name);
  };
}

function resolveSkills(actor) {
  const resolve = skillResolver();
  const merged = new Map();
  const skipped = new Set();
  for (const item of actor.itemTypes?.skill ?? []) {
    const code = resolve(item);
    if (code === null) {
      const label = cut(item?.name);
      if (label !== "") skipped.add(label);
      continue;
    }
    const rank = clampInt(item.system?.value, 0, MAX_SKILL_RANK);
    const tag = item.system?.tag === true ? 1 : 0;
    // The system refuses a second item with the same name, but a renamed one can resolve to the
    // same code: keep the best of both.
    const existing = merged.get(code);
    if (existing) {
      existing.rank = Math.max(existing.rank, rank);
      existing.tag = Math.max(existing.tag, tag);
    } else {
      merged.set(code, { rank, tag });
    }
  }
  if (skipped.size > 0) {
    console.warn(`${WARN_PREFIX} skipped ${skipped.size} skill item(s) that are not one of the 17 core skills: ${[...skipped].map((n) => `"${n}"`).join(", ")}`);
  }
  const out = {};
  for (const [, code] of SKILLS) {
    const entry = merged.get(code);
    if (!entry || (entry.rank === 0 && entry.tag === 0)) continue; // the server refuses [0, 0]; absent means the same
    out[code] = [entry.rank, entry.tag];
  }
  return out;
}

/**
 * Keeps the `max` perks with the highest ranks (ties broken by name, stable), in their original
 * order, and warns once when something was dropped.
 */
function capPerks(perks) {
  if (perks.length <= MAX_PERKS) return perks;
  const kept = perks
    .map((perk, index) => ({ perk, index }))
    .sort((a, b) => b.perk.rank - a.perk.rank || a.perk.name.localeCompare(b.perk.name) || a.index - b.index)
    .slice(0, MAX_PERKS)
    .sort((a, b) => a.index - b.index)
    .map((r) => r.perk);
  console.warn(`${WARN_PREFIX} ${perks.length} perks, keeping the ${MAX_PERKS} with the highest ranks`);
  return kept;
}

function resolvePerks(actor) {
  // Same-name perks are the same perk: keep the highest rank. An owned perk can read rank 0 (the
  // compendium default), which is a perk taken once, so a rank below 1 counts as 1.
  const merged = new Map();
  for (const item of actor.itemTypes?.perk ?? []) {
    const name = cut(item?.name);
    if (name === "") continue;
    const rank = clampInt(item.system?.rank?.value, 1, MAX_PERK_RANK);
    const key = dedupeKey(name);
    const existing = merged.get(key);
    if (existing) existing.rank = Math.max(existing.rank, rank);
    else merged.set(key, { name, rank });
  }
  return capPerks(Array.from(merged.values()));
}

function resolveTraits(actor) {
  const seen = new Set();
  const names = [];
  for (const item of actor.itemTypes?.trait ?? []) {
    const name = cut(item?.name);
    if (name === "") continue;
    const key = dedupeKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length <= MAX_TRAITS) return names;
  console.warn(`${WARN_PREFIX} ${names.length} traits, keeping the first ${MAX_TRAITS}`);
  return names.slice(0, MAX_TRAITS);
}

function resolveAttributes(sys) {
  const out = {};
  for (const code of ATTRIBUTES) {
    out[code] = clampInt(sys.attributes?.[code]?.value, 1, MAX_ATTRIBUTE, DEFAULT_ATTRIBUTE);
  }
  return out;
}

/**
 * The maximum health as the sheet states it without play state. With the world computing derived
 * stats, the system's own value is `END + LUC + level - 1 - radiation + bonus (+ 2 well rested or
 * tinkered with)`, so the radiation is added back and the 2 taken out. With the setting on, the
 * value is whatever was typed and goes through as is.
 */
function resolveMaxHealth(actor) {
  const sys = actor.system ?? {};
  let max = Number(sys.health?.max);
  if (!Number.isFinite(max)) max = 0;
  if (!derivedStatsDisabled()) {
    max += Number(sys.radiation) || 0;
    if (actor.isWellRested || actor.isTinkeredWith) max -= 2;
  }
  return clampInt(max, 0, MAX_HEALTH);
}

/** Per location `[physical, energy, radiation]`; a blank armour value is NaN upstream and reads 0. */
function resolveResistances(sys) {
  const out = {};
  for (const location of LOCATIONS) {
    const resistance = sys.body_parts?.[location]?.resistance ?? {};
    out[location] = [
      clampInt(resistance.physical, 0, MAX_RESISTANCE),
      clampInt(resistance.energy, 0, MAX_RESISTANCE),
      clampInt(resistance.radiation, 0, MAX_RESISTANCE),
    ];
  }
  return out;
}

/** Builds the flat sheet object (the locked schema keys, codes verbatim). */
export function buildSheet(actor) {
  const sys = actor.system ?? {};

  return {
    actorType: actor.type === "robot" ? "robot" : "character",
    origin: cut(sys.origin),
    level: clampInt(sys.level?.value, 1, MAX_LEVEL),
    attributes: resolveAttributes(sys),
    maxHealth: resolveMaxHealth(actor),
    defense: clampInt(sys.defense?.value, 0, MAX_DEFENSE),
    initiative: clampInt(sys.initiative?.value, 0, MAX_INITIATIVE),
    meleeDamage: clampInt(sys.meleeDamage?.value, 0, MAX_MELEE_DAMAGE),
    skills: resolveSkills(actor),
    perks: resolvePerks(actor),
    traits: resolveTraits(actor),
    resistances: resolveResistances(sys),
    poisonResistance: clampInt(sys.resistance?.poison, 0, MAX_RESISTANCE),
    immunities: IMMUNITIES.filter((code) => sys.immunities?.[code] === true),
  };
}
