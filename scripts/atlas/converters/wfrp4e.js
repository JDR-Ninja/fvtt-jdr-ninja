/**
 * wfrp4e converter: projects a live Warhammer Fantasy Roleplay 4e actor to the Atlas
 * `wfrp4e-compatible` API schema (flat object, Foundry codes verbatim for the characteristics
 * `ws`…`fel`, the status tier `g/s/b` and the size `tiny`…`mnst`; skills and talents as bounded
 * free-text lists, since the source system has no code for an item). Reads the PREPARED actor
 * (`actor.system` after prepareData, `actor.itemTypes`, `item.system`, `item.name`), never the raw
 * `_source`, and only core APIs: the document → system proxies and `itemTags` that warhammer-lib
 * adds are not used. Data paths checked against wfrp4e 9.6.4 (see SUPPORTED_SYSTEMS.wfrp4e.min in
 * constants.js): characteristics `system.characteristics.<code>.value` (computed
 * `this.value = this.initial + this.modifier + this.advances`), the current career
 * `itemTypes.career.find(c => c.system.current.value)` (only one is current), the status
 * `system.details.status.{tier,standing}` (computed by `computeCareer()` from that career), the
 * size `system.details.size.value`, the move `system.details.move.value`, the wounds
 * `system.status.wounds.max`, the fate/resilience `system.status.{fate,resilience}.value`, skill
 * items (`system.advances.value`, `system.characteristic.value`, `system.advanced.value` bsc/adv,
 * `system.grouped.value` noSpec/isSpec) and talent items (`system.advances.value`, summed across
 * same-name items like the sheet's `get Advances()`). Species and subspecies are stored as KEYS of
 * `game.wfrp4e.config.species` / `.subspecies` when the sheet recognised the label and as free
 * text otherwise, so both are resolved through the runtime config (the free system ships those
 * tables empty; the premium core module fills them), mirroring the actor's own `get Species()`.
 * The size and status-tier code sets are NOT read from that config: the API's sets are fixed,
 * so a module extending `actorSizes` would
 * pass a key the server rejects and an empty table would map every size to `avg`. The Atlas
 * server re-validates the sheet through its registry as a safety net.
 */

import { cutText } from "./text.js";

const CHARACTERISTIC_CODES = ["ws", "bs", "s", "t", "i", "ag", "dex", "int", "wp", "fel"];

// Matches the Atlas API's bounds. The API rejects anything past them, so the converter
// clamps numbers and cuts text, and trims the two lists to their caps (highest advances kept).
export const MAX_TEXT = 60;
export const MAX_SKILLS = 40;
export const MAX_TALENTS = 30;
const MAX_SKILL_ADVANCES = 100;
const MAX_TALENT_ADVANCES = 20;
const MAX_CAREER_LEVEL = 5;
const MAX_STANDING = 9;
const MAX_CHARACTERISTIC = 100;
const MAX_MOVE = 20;
const MAX_WOUNDS = 500;
const MAX_FATE = 20;
const DEFAULT_SIZE = "avg";
// The server's closed sets, verbatim (Foundry's `actorSizes` / `statusTiers` keys as of 9.6.4).
const SIZES = ["tiny", "ltl", "sml", "avg", "lrg", "enor", "mnst"];
const TIERS = ["g", "s", "b"];

/** Integer in `min..max`: the server's fields are integers, so a decimal typed in the sheet is truncated first. */
function clamp(value, min, max) {
  const n = Number(value) || 0;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cut(value) {
  return cutText(value, MAX_TEXT);
}

/**
 * The API treats trimmed skill and talent names as unique without case sensitivity.
 * `toUpperCase()` also folds `ı` and `ſ` to `I` and `S`, which `toLowerCase()` would keep
 * apart. Merging equivalent names prevents duplicate-name validation failures.
 */
function dedupeKey(name) {
  return name.toUpperCase();
}

/** `game.wfrp4e.config` when the world has it (the guard already refused any other system). */
function config() {
  return globalThis.game?.wfrp4e?.config ?? {};
}

function resolveSpecies(actor) {
  const cfg = config();
  const details = actor.system?.details?.species ?? {};
  const key = typeof details.value === "string" ? details.value : "";
  const sub = typeof details.subspecies === "string" ? details.subspecies : "";
  const speciesLabel = typeof cfg.species?.[key] === "string" ? cfg.species[key] : key;
  const subEntry = cfg.subspecies?.[key]?.[sub];
  const subLabel = typeof subEntry?.name === "string" ? subEntry.name : sub;
  return { species: cut(speciesLabel), subspecies: cut(subLabel) };
}

function resolveCareer(actor) {
  const careers = actor.itemTypes?.career ?? [];
  const current = careers.find((c) => c.system?.current?.value);
  if (!current) return { class: "", careerGroup: "", career: "", careerLevel: null };
  const level = Number(current.system?.level?.value);
  return {
    class: cut(current.system?.class?.value),
    careerGroup: cut(current.system?.careergroup?.value),
    career: cut(current.name),
    careerLevel: Number.isFinite(level) && level >= 1 ? Math.min(MAX_CAREER_LEVEL, Math.trunc(level)) : null,
  };
}

function resolveStatus(actor) {
  const status = actor.system?.details?.status ?? {};
  // No current career leaves `tier` at its schema default (a number), i.e. not a tier code.
  if (typeof status.tier !== "string" || !TIERS.includes(status.tier)) return null;
  return { tier: status.tier, standing: clamp(status.standing, 0, MAX_STANDING) };
}

function resolveSize(actor) {
  const size = actor.system?.details?.size?.value;
  return typeof size === "string" && SIZES.includes(size) ? size : DEFAULT_SIZE;
}

function resolveCharacteristics(actor) {
  const out = {};
  const chars = actor.system?.characteristics ?? {};
  for (const code of CHARACTERISTIC_CODES) {
    out[code] = { value: clamp(chars[code]?.value, 0, MAX_CHARACTERISTIC) };
  }
  return out;
}

/** True for a basic, ungrouped skill: the first half of the sheet's own split. */
function isBasic(item) {
  return item.system?.advanced?.value === "bsc" && item.system?.grouped?.value === "noSpec";
}

function byName(a, b) {
  return a.name.localeCompare(b.name);
}

/**
 * Keeps the `max` entries with the highest advances (ties broken by name, stable), in their
 * original order, and warns once when something was dropped.
 */
function capList(entries, max, what) {
  if (entries.length <= max) return entries;
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.adv - a.entry.adv || a.entry.name.localeCompare(b.entry.name) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((r) => r.entry);
  console.warn(`jdr-ninja-atlas-sync | wfrp4e: ${entries.length} ${what}, keeping the ${max} with the most advances`);
  return ranked;
}

function resolveSkills(actor) {
  // Same-name items merge by summing their advances (the system does the same on creation,
  // `_handleSkillMerging`); the characteristic is the first item's. Each item's advances are
  // truncated to an integer BEFORE the sum (the system's NumberField is not `integer`, so the
  // sheet input accepts 2.5, and a fractional `adv` fails the server's whole sheet), and the sum
  // is clamped to the server's 1..100 afterwards.
  const merged = new Map();
  for (const item of actor.itemTypes?.skill ?? []) {
    const adv = clamp(item.system?.advances?.value, 0, MAX_SKILL_ADVANCES);
    if (adv <= 0) continue; // untrained: an advanced skill cannot be used, a basic one is just the characteristic
    const name = cut(item.name);
    if (name === "") continue;
    const key = dedupeKey(name);
    const existing = merged.get(key);
    if (existing) {
      existing.adv += adv;
      continue;
    }
    const char = item.system?.characteristic?.value;
    if (!CHARACTERISTIC_CODES.includes(char)) continue; // no characteristic to total against
    merged.set(key, { name, char, adv, basic: isBasic(item) });
  }
  const skills = Array.from(merged.values());
  // The sheet's order: basic skills first, then advanced / grouped, each block by name.
  const basic = skills.filter((s) => s.basic).sort(byName);
  const advanced = skills.filter((s) => !s.basic).sort(byName);
  const ordered = basic.concat(advanced).map((s) => ({ name: s.name, char: s.char, adv: clamp(s.adv, 1, MAX_SKILL_ADVANCES) }));
  return capList(ordered, MAX_SKILLS, "skills");
}

function resolveTalents(actor) {
  // Duplicates are the same talent taken again: their advances add up (the sheet's `get Advances()`).
  // A talent is taken at least once (the system's `min: 1`), so 0, a blank or a fraction below 1
  // counts as 1; each item is truncated before the sum and the sum clamped to the server's 1..20.
  const merged = new Map();
  for (const item of actor.itemTypes?.talent ?? []) {
    const name = cut(item.name);
    if (name === "") continue;
    const adv = clamp(item.system?.advances?.value, 1, MAX_TALENT_ADVANCES);
    const key = dedupeKey(name);
    const existing = merged.get(key);
    if (existing) existing.adv += adv;
    else merged.set(key, { name, adv });
  }
  const talents = Array.from(merged.values()).map((t) => ({ name: t.name, adv: clamp(t.adv, 1, MAX_TALENT_ADVANCES) }));
  return capList(talents, MAX_TALENTS, "talents");
}

/** Builds the flat sheet object (the locked schema keys, codes verbatim). */
export function buildSheet(actor) {
  const sys = actor.system ?? {};
  const { species, subspecies } = resolveSpecies(actor);
  const career = resolveCareer(actor);

  return {
    species,
    subspecies,
    class: career.class,
    careerGroup: career.careerGroup,
    career: career.career,
    careerLevel: career.careerLevel,
    status: resolveStatus(actor),
    size: resolveSize(actor),
    move: clamp(sys.details?.move?.value, 0, MAX_MOVE),
    characteristics: resolveCharacteristics(actor),
    wounds: clamp(sys.status?.wounds?.max, 0, MAX_WOUNDS),
    fate: clamp(sys.status?.fate?.value, 0, MAX_FATE),
    resilience: clamp(sys.status?.resilience?.value, 0, MAX_FATE),
    skills: resolveSkills(actor),
    talents: resolveTalents(actor),
  };
}
