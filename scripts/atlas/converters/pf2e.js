/**
 * pf2e / sf2e converter: projects a live Pathfinder Second Edition (remaster) or Starfinder Second
 * Edition actor to the Atlas PF2e-family schema v1 (`pf2e-compatible` / `sf2e-compatible`
 * API payload). One file for both: sf2e is a fork of the pf2e system with the same actor shape, two
 * more skills (computers, piloting) and another language list, and everything below reads the
 * PREPARED actor (`actor.system` after prepareData, the Statistic getters, `actor.itemTypes`), never
 * `_source`, so the extra skills flow through `actor.skills` without a Starfinder branch. Nothing is
 * localized here: codes and ranks only, the Atlas server re-validates through the slug's module and
 * decides what its skill set accepts. Data paths checked against pf2e 7.5.0+ / sf2e 1.0.0+ (see
 * SUPPORTED_SYSTEMS in constants.js): `system.movement.speeds`, `system.perception`, `system.skills`
 * keyed by full slug. Every read is `?.`-guarded with the schema default: the converter never throws
 * on a missing path.
 */

import { cutText } from "./text.js";

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];
const SIZE_CODES = ["tiny", "sm", "med", "lg", "huge", "grg"];
const SPEED_TYPES = ["burrow", "climb", "fly", "swim"];
const SAVE_KEYS = ["fortitude", "reflex", "will"];
// The four weapon categories (CONFIG.PF2E.weaponCategories) and the four armor categories Atlas
// stores; extra proficiency keys (weapon-group-*, weapon-base-*, custom rule-element slugs such as
// the sf2e Operative's simple-guns, light-barding / heavy-barding) are dropped.
const ATTACK_KEYS = ["simple", "martial", "advanced", "unarmed"];
const DEFENSE_KEYS = ["unarmored", "light", "medium", "heavy"];
// The 17 types of the Sense DataModel (`hearing` and `vision` are basic senses, never stored).
const SENSE_TYPES = new Set([
  "bloodsense", "darkvision", "echolocation", "electromagnetic-sense", "greater-darkvision",
  "infrared-vision", "lifesense", "low-light-vision", "magicsense", "motion-sense", "scent",
  "see-invisibility", "spiritsense", "thoughtsense", "tremorsense", "truesight", "wavesense",
]);

const MAX_NAME = 80;
const MAX_LORES = 6;
const MAX_LORE_NAME = 40;
const MAX_SENSES = 8;
const MAX_LANGUAGES = 24;
const MAX_LANGUAGE_CODE = 32;
const MAX_CUSTOM = 200;

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampRank(value) {
  return clampInt(value, 0, 4, 0);
}

function text(value, max) {
  return typeof value === "string" ? cutText(value, max) : "";
}

function resolveAbilities(actor) {
  const out = {};
  const abilities = actor.system?.abilities ?? {};
  for (const key of ABILITY_KEYS) {
    out[key] = clampInt(abilities[key]?.mod, -5, 9, 0);
  }
  return out;
}

function resolveSpeed(actor) {
  const speeds = actor.system?.movement?.speeds ?? {};
  // `land` is always emitted (Foundry's default of 25 when the trace is missing); the other types
  // only when the prepared trace exists and is positive.
  const out = { land: clampInt(speeds.land?.value ?? 25, 0, 999, 25) };
  for (const type of SPEED_TYPES) {
    const trace = speeds[type];
    const value = Number(trace?.value);
    if (trace && Number.isFinite(value) && value > 0) out[type] = clampInt(value, 0, 999, 0);
  }
  return out;
}

function resolveSaves(actor) {
  const out = {};
  for (const key of SAVE_KEYS) {
    out[key] = clampRank(actor.saves?.[key]?.rank);
  }
  return out;
}

// The skill set of the RUNNING system, read at runtime: CONFIG.PF2E.skills holds 16 slugs under
// pf2e and 18 under sf2e (computers, piloting), so the Starfinder skills flow through with no
// system-specific code and the Atlas validator of the slug decides what it accepts. Without the
// config (a test stub, an unexpected build) the actor's own non-lore statistics are the set.
function skillSlugs(actor) {
  const configured = Object.keys(globalThis.CONFIG?.PF2E?.skills ?? {});
  if (configured.length > 0) return configured;
  return Object.entries(actor.skills ?? {})
    .filter(([, stat]) => stat && !stat.lore)
    .map(([slug]) => slug);
}

// Trained-or-better skills, keyed by slug; lore entries (`stat.lore`) are Items and go to `lores`.
function resolveSkills(actor) {
  const out = {};
  const skills = actor.skills ?? {};
  for (const slug of skillSlugs(actor)) {
    const stat = skills[slug];
    if (!stat || stat.lore) continue;
    const rank = clampRank(stat.rank);
    if (rank >= 1) out[slug] = rank;
  }
  return out;
}

// The four Atlas weapon categories are Foundry's CONFIG.PF2E.weaponCategories; a build that renamed
// one would silently sync rank 0 for it, so say so in the console (never throw: the sync goes on).
function warnOnMissingWeaponCategories() {
  const categories = globalThis.CONFIG?.PF2E?.weaponCategories;
  if (!categories || typeof categories !== "object") return;
  const missing = ATTACK_KEYS.filter((key) => !(key in categories));
  if (missing.length > 0) {
    console.warn(`jdr-ninja-atlas-sync | CONFIG.PF2E.weaponCategories lacks ${missing.join(", ")}; those proficiencies sync as untrained`);
  }
}

function resolveLores(actor) {
  const items = actor.itemTypes?.lore ?? [];
  const out = [];
  for (const item of items) {
    const rank = clampRank(item?.system?.proficient?.value);
    const name = text(item?.name, MAX_LORE_NAME);
    if (rank < 1 || name === "") continue;
    out.push({ name, rank });
    if (out.length >= MAX_LORES) break;
  }
  return out;
}

function resolveRankBag(source, keys) {
  const out = {};
  for (const key of keys) {
    out[key] = clampRank(source?.[key]?.rank);
  }
  return out;
}

function resolveSenses(actor) {
  const collection = actor.perception?.senses;
  const senses = Array.isArray(collection) ? collection : (collection?.contents ?? []);
  const out = [];
  const seen = new Set();
  for (const sense of senses) {
    const type = sense?.type;
    if (typeof type !== "string" || !SENSE_TYPES.has(type) || seen.has(type)) continue;
    seen.add(type);
    const entry = { type };
    // `precise` is Foundry's default and is omitted like the stored code; `Infinity` / null = unlimited.
    if (sense.acuity === "imprecise" || sense.acuity === "vague") entry.acuity = sense.acuity;
    const range = Number(sense.range);
    if (Number.isFinite(range) && range > 0) entry.range = clampInt(range, 1, 999, 1);
    out.push(entry);
    if (out.length >= MAX_SENSES) break;
  }
  return out;
}

// Verbatim slugs: `common` and the campaign's common language (taldane, pact-common) both pass
// through as Foundry keeps both; homebrew slugs (no hb_ prefix since Migration893) are plain codes.
function resolveLanguages(actor) {
  const languages = actor.system?.details?.languages ?? {};
  const raw = languages.value;
  const list = raw instanceof Set ? Array.from(raw) : Array.isArray(raw) ? raw : [];
  const value = list
    .filter((code) => typeof code === "string")
    .map((code) => code.trim())
    .filter((code) => code !== "" && code.length <= MAX_LANGUAGE_CODE)
    .slice(0, MAX_LANGUAGES);
  return {
    value,
    custom: text(languages.details, MAX_CUSTOM),
  };
}

/** Builds the flat sheet object (the family schema keys in canonical order, codes verbatim). */
export function buildSheet(actor) {
  const sys = actor.system ?? {};
  const attributes = sys.attributes ?? {};
  const keyAttribute = actor.keyAttribute;
  const size = actor.size;
  const classDc = attributes.classDC?.value;
  warnOnMissingWeaponCategories();

  return {
    // Level 0 pregens show as 1; Foundry clamps to 0..30, Atlas to 1..20.
    level: clampInt(actor.level, 1, 20, 1),
    keyAbility: ABILITY_KEYS.includes(keyAttribute) ? keyAttribute : "str",
    class: text(actor.class?.name, MAX_NAME),
    ancestry: text(actor.ancestry?.name, MAX_NAME),
    heritage: text(actor.heritage?.name, MAX_NAME),
    background: text(actor.background?.name, MAX_NAME),
    size: SIZE_CODES.includes(size) ? size : "med",
    abilities: resolveAbilities(actor),
    hp: clampInt(attributes.hp?.max, 0, 999, 0),
    ac: clampInt(attributes.ac?.value, 0, 99, 0),
    speed: resolveSpeed(actor),
    classDc: classDc === null || classDc === undefined ? null : clampInt(classDc, 0, 99, 0),
    perception: clampRank(actor.perception?.rank),
    saves: resolveSaves(actor),
    skills: resolveSkills(actor),
    lores: resolveLores(actor),
    attacks: resolveRankBag(sys.proficiencies?.attacks, ATTACK_KEYS),
    defenses: resolveRankBag(sys.proficiencies?.defenses, DEFENSE_KEYS),
    senses: resolveSenses(actor),
    languages: resolveLanguages(actor),
  };
}
