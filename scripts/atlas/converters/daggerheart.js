/**
 * daggerheart converter: projects a live Daggerheart `character` actor to the Atlas
 * `daggerheart-compatible` API schema (v1: a flat object, the system's codes verbatim for the six
 * traits and the ten core domains, bounded free text for everything the system has no code for:
 * class, subclass, ancestry, community, experiences and domain cards). Reads the PREPARED actor
 * (`actor.system` after prepareData, `actor.itemTypes`, `item.system`, `item.name`), never the raw
 * `_source`. Data paths checked against daggerheart 2.0.0 (the first release on Foundry V14, see
 * SUPPORTED_SYSTEMS.daggerheart.min in constants.js) and 2.10.7: traits `system.traits.<code>.value`,
 * the level `system.levelData.level.current`, the class and multiclass getters
 * (`system.class` / `system.multiclass` -> `{ value, subclass }`, items), `system.ancestry` and
 * `system.community` (items or null), `system.domains` (class domains, then the multiclass ones),
 * the prepared numbers (`system.evasion`, `system.armorScore.max`, `system.damageThresholds`,
 * `system.resources.{hitPoints,stress}.max`, `system.proficiency`), `system.experiences` (an object
 * keyed by id) and `actor.itemTypes.domainCard`.
 *
 * What is synced: level, class, subclass, multiclass and its subclass, ancestry, community, the
 * domains, the spellcast trait, the six traits, evasion, Armor Score, the two damage thresholds, the
 * Hit Point and Stress MAXIMUMS, proficiency, the experiences and the domain cards (loadout and
 * vault together, as one list).
 *
 * What is not: live play state (marked Hit Points, Stress and Armor Slots, current Hope, Scars, gold,
 * conditions, the active beastform), the Hope maximum (a table setting, not a character datum),
 * equipment, feature and card texts, the narrative fields and the level-up ledger. The tier is not
 * read either: the Atlas side derives it from the level with the SRD table, and `game.settings` and
 * `CONFIG` are never consulted, so nothing world-specific leaks into a character.
 *
 * The prepared actor includes every active effect, so a sync made while a Druid is in beastform (or
 * under a temporary spell or condition effect) captures the transformed traits and evasion. This is
 * documented rather than guarded: synchronise outside beastform (README, Atlas section).
 *
 * Out-of-range values are CLAMPED and over-long lists TRIMMED rather than refused: the server rejects
 * the whole payload on one bad number, and a homebrew trait of +12 becoming +10 on a summary is the
 * lesser evil. The Atlas server re-validates the sheet through its registry as a safety net.
 */

import { cutText } from "./text.js";

// The ten core domains, in the system's code-table order (the closed set the API accepts). A homebrew
// domain id is not in it: its label lives in a world setting the server cannot resolve.
const DOMAINS = ["arcana", "blade", "bone", "codex", "dread", "grace", "midnight", "sage", "splendor", "valor"];
// The six traits, in the system's order.
const TRAITS = ["agility", "strength", "finesse", "instinct", "presence", "knowledge"];

// Matches the Atlas API's bounds. The API rejects anything past them, so the converter clamps
// numbers, cuts text and trims the lists to their caps.
export const MAX_NAME = 40;
export const MAX_DOMAINS = 3;
export const MAX_EXPERIENCES = 8;
export const MAX_CARDS = 20;
const MIN_LEVEL = 1;
const MAX_LEVEL = 10;
const TRAIT_BOUND = 10;
const MAX_EVASION = 40;
const MAX_ARMOR = 20;
const MAX_THRESHOLD = 199;
const MAX_SLOTS = 30;
const MAX_PROFICIENCY = 10;
const EXPERIENCE_BOUND = 10;

const WARN_PREFIX = "jdr-ninja-atlas-sync | daggerheart:";

/** A finite number from a number or a numeric string; anything else (null, boolean, object) is NaN. */
function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/**
 * Integer in `min..max`: the server's fields are integers, so a decimal typed in the sheet is
 * truncated first. A missing or non-numeric value reads as `fallback`.
 */
function clampInt(value, min, max, fallback = 0) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function name(value) {
  return cutText(value, MAX_NAME);
}

function knownDomain(code) {
  return typeof code === "string" && DOMAINS.includes(code) ? code : "";
}

/** Known, deduplicated domain codes in the actor's order (class domains, then the multiclass ones), at most three. */
function resolveDomains(sys) {
  const out = [];
  const domains = Array.isArray(sys.domains) ? sys.domains : [];
  for (const code of domains) {
    const known = knownDomain(code);
    if (known === "" || out.includes(known)) continue;
    out.push(known);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

/** The main subclass's spellcast trait when it is one of the six trait codes, else empty (non-casters). */
function resolveSpellcastTrait(sys) {
  const trait = sys.class?.subclass?.system?.spellcastingTrait;
  return typeof trait === "string" && TRAITS.includes(trait) ? trait : "";
}

function resolveTraits(sys) {
  const out = {};
  const traits = sys.traits ?? {};
  for (const code of TRAITS) out[code] = clampInt(traits[code]?.value, -TRAIT_BOUND, TRAIT_BOUND);
  return out;
}

function resolveThresholds(sys) {
  const thresholds = sys.damageThresholds ?? {};
  return {
    major: clampInt(thresholds.major, 0, MAX_THRESHOLD),
    severe: clampInt(thresholds.severe, 0, MAX_THRESHOLD),
  };
}

/** The stored order is the creation order (the two core experiences first); the first eight are kept. */
function resolveExperiences(sys) {
  const seen = new Set();
  const out = [];
  for (const experience of Object.values(sys.experiences ?? {})) {
    const experienceName = name(experience?.name);
    if (experienceName === "" || seen.has(experienceName)) continue;
    seen.add(experienceName);
    out.push({ name: experienceName, value: clampInt(experience?.value, -EXPERIENCE_BOUND, EXPERIENCE_BOUND) });
  }
  if (out.length <= MAX_EXPERIENCES) return out;
  console.warn(`${WARN_PREFIX} ${out.length} experiences, keeping the first ${MAX_EXPERIENCES}`);
  return out.slice(0, MAX_EXPERIENCES);
}

/**
 * Every domain card the character owns, loadout and vault together (the play-state split is not
 * synced), as `{ name, domain, level }` with `domain` a core code or `""` (a homebrew domain).
 * Sorted by the character's own domains first (in their synced order), then the other core domains
 * in code-table order, then the `""` cards; inside a group by level, then name. Over twenty cards,
 * the twenty highest levels are kept (ties go to the earlier card of that order).
 */
function resolveCards(actor, syncedDomains) {
  const groupRank = (domain) => {
    if (domain === "") return syncedDomains.length + DOMAINS.length;
    const own = syncedDomains.indexOf(domain);
    return own >= 0 ? own : syncedDomains.length + DOMAINS.indexOf(domain);
  };

  const seen = new Set();
  const cards = [];
  for (const item of actor.itemTypes?.domainCard ?? []) {
    const cardName = name(item?.name);
    if (cardName === "" || seen.has(cardName)) continue;
    seen.add(cardName);
    cards.push({
      name: cardName,
      domain: knownDomain(item?.system?.domain),
      level: clampInt(item?.system?.level, MIN_LEVEL, MAX_LEVEL, MIN_LEVEL),
    });
  }

  cards.sort(
    (a, b) =>
      groupRank(a.domain) - groupRank(b.domain) || a.level - b.level || a.name.localeCompare(b.name),
  );
  if (cards.length <= MAX_CARDS) return cards;

  console.warn(`${WARN_PREFIX} ${cards.length} domain cards, keeping the ${MAX_CARDS} with the highest levels`);
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => b.card.level - a.card.level || a.index - b.index)
    .slice(0, MAX_CARDS)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.card);
}

/** Builds the flat sheet object (the locked schema keys, codes verbatim). */
export function buildSheet(actor) {
  const sys = actor?.system ?? {};
  const domains = resolveDomains(sys);

  return {
    // `levelData.level.changed` is the pending target of a level-up, not the level.
    level: clampInt(sys.levelData?.level?.current, MIN_LEVEL, MAX_LEVEL, MIN_LEVEL),
    class: name(sys.class?.value?.name),
    subclass: name(sys.class?.subclass?.name),
    multiclass: name(sys.multiclass?.value?.name),
    multiclassSubclass: name(sys.multiclass?.subclass?.name),
    ancestry: name(sys.ancestry?.name),
    community: name(sys.community?.name),
    domains,
    spellcastTrait: resolveSpellcastTrait(sys),
    traits: resolveTraits(sys),
    evasion: clampInt(sys.evasion, 0, MAX_EVASION),
    // `.max` is the Armor Score; `.value` is the marked slots (live play state) and never synced.
    armor: clampInt(sys.armorScore?.max, 0, MAX_ARMOR),
    thresholds: resolveThresholds(sys),
    // `.max` of both resources (a null stress maximum reads as 0); the marked `.value` is never synced.
    hp: clampInt(sys.resources?.hitPoints?.max, 0, MAX_SLOTS),
    stress: clampInt(sys.resources?.stress?.max, 0, MAX_SLOTS),
    proficiency: clampInt(sys.proficiency, 0, MAX_PROFICIENCY, 1),
    experiences: resolveExperiences(sys),
    cards: resolveCards(actor ?? {}, domains),
  };
}
