/**
 * tor2e converter: projects a live The One Ring 2e `character` actor to the Atlas `tor2e-compatible`
 * API schema (v1). Reads the PREPARED actor (`actor.system` after prepareData, `actor.itemTypes`),
 * never the raw `_source`. Data paths checked against tor2e 6.0.0+ (`modules/models/actors/character.model.mjs`,
 * see SUPPORTED_SYSTEMS.tor2e.min in constants.js): the first release built on Foundry data models.
 *
 * What is synced: culture, calling, standard of living, cultural blessing, shadow path, fellowship focus,
 * age, the three attributes, valour and wisdom, the Endurance and Hope MAXIMUMS, the effective Parry
 * (base + equipped shield), the Protection dice (equipped armour + headgear), the eighteen common skills
 * (rank + favoured), the four combat proficiencies, distinctive features, virtues and rewards.
 *
 * What is not: live play state (current Endurance/Hope, Shadow, Fatigue, conditions, points), equipment,
 * narrative history, custom skills, standings, flaws, and Active-Effect bonuses (`system.bonuses.*`).
 * The target number is derived on the Atlas side (20 − rating); the world's `tnBaseValue` setting is not
 * read, because a table setting is not a character datum.
 *
 * Out-of-range values are CLAMPED rather than refused: the server rejects the whole payload on one bad
 * number, and a homebrew rank 7 becoming 6 on a summary is the lesser evil (README « The One Ring 2e »).
 */

import { cutText } from "./text.js";

const ATTRIBUTES = ["strength", "heart", "wits"];
const SKILLS = [
  "awe", "athletics", "awareness", "hunting", "song", "craft",
  "enhearten", "travel", "insight", "healing", "courtesy", "battle",
  "persuade", "stealth", "scan", "explore", "riddle", "lore",
];
// Foundry synthesises `brawling` at runtime from the other four; it is never read.
const COMBAT = ["axes", "swords", "spears", "bows"];
const CALLINGS = ["scholar", "messenger", "champion", "warden", "treasure-hunter", "captain"];
const STANDARDS_OF_LIVING = ["poor", "frugal", "common", "prosperous", "rich", "veryRich"];

// Storage values of the item `group` fields (CONFIG.tor2e.constants mirrors them); literals on purpose,
// so nothing is read from CONFIG or game.settings at conversion time.
const GROUP_DISTINCTIVE_FEATURE = "distinctiveFeature";
const GROUP_SHIELD = "shield";
const GROUP_HEAD = "head";
const BODY_ARMOUR_GROUPS = ["mail", "leather"];

const MAX_TEXT = 60;
const MAX_NAME = 40;
const MAX_TRAITS = 6;
const MAX_VIRTUES = 8;
const MAX_REWARDS = 8;

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function text(value) {
  return cutText(value, MAX_TEXT);
}

function closedCode(value, allowed) {
  return allowed.includes(value) ? value : "";
}

/** The `.value` of a `{ value, type, label }` block, or the block itself when it is already a scalar. */
function valueOf(field) {
  if (field && typeof field === "object" && "value" in field) return field.value;
  return field;
}

function isEquipped(item) {
  return item?.system?.equipped?.value === true;
}

function itemGroup(item) {
  return item?.system?.group?.value;
}

function protectionOf(item) {
  return clampInt(item?.system?.protection?.value, 0, 99);
}

/** Item names as a deduplicated, trimmed, capped list in `actor.itemTypes` order. */
function names(items, max) {
  const out = [];
  for (const item of items ?? []) {
    const name = cutText(item?.name, MAX_NAME);
    if (name === "" || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function resolveAttributes(sys) {
  const out = {};
  for (const key of ATTRIBUTES) out[key] = clampInt(valueOf(sys.attributes?.[key]), 0, 10);
  return out;
}

function resolveSkills(sys) {
  const out = {};
  const skills = sys.commonSkills ?? {};
  for (const code of SKILLS) {
    const skill = skills[code];
    if (!skill) continue;
    const rank = clampInt(valueOf(skill.value), 0, 6);
    const f = valueOf(skill.favoured);
    // Legacy worlds stored 0/1 (cf. Tor2eSkillModel.migrateData); booleans since the data model.
    const favoured = f === true || f === 1 ? 1 : 0;
    if (rank === 0 && favoured === 0) continue; // the server refuses [0, 0]; absent means the same
    out[code] = [rank, favoured];
  }
  return out;
}

function resolveCombat(sys) {
  const out = {};
  for (const code of COMBAT) out[code] = clampInt(valueOf(sys.combatProficiencies?.[code]), 0, 6);
  return out;
}

/** Effective Parry: the entered base plus the equipped shield's protection (the sheet card's number). */
function resolveParry(sys, armours) {
  const base = clampInt(valueOf(sys.combatAttributes?.parry), 0, 40);
  const shield = armours.find((item) => isEquipped(item) && itemGroup(item) === GROUP_SHIELD);
  return clampInt(base + (shield ? protectionOf(shield) : 0), 0, 40);
}

/** Protection dice: the first equipped body armour (mail or leather) plus the first equipped headgear. */
function resolveProtection(armours) {
  const body = armours.find((item) => isEquipped(item) && BODY_ARMOUR_GROUPS.includes(itemGroup(item)));
  const head = armours.find((item) => isEquipped(item) && itemGroup(item) === GROUP_HEAD);
  return clampInt((body ? protectionOf(body) : 0) + (head ? protectionOf(head) : 0), 0, 15);
}

/** Age 0 is a valid server value (it renders as unset, the way Elves leave it); only a negative or missing age is null. */
function resolveAge(sys) {
  const n = Number(valueOf(sys.biography?.age));
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), 99999) : null;
}

/** Builds the flat sheet object (the locked schema keys, codes verbatim). */
export function buildSheet(actor) {
  const sys = actor.system ?? {};
  const bio = sys.biography ?? {};
  const armours = actor.itemTypes?.armour ?? [];
  const traits = (actor.itemTypes?.trait ?? []).filter((item) => itemGroup(item) === GROUP_DISTINCTIVE_FEATURE);

  return {
    culture: text(valueOf(bio.culture)),
    calling: closedCode(valueOf(bio.calling), CALLINGS),
    standardOfLiving: closedCode(valueOf(bio.standardOfLiving), STANDARDS_OF_LIVING),
    culturalBlessing: text(valueOf(bio.culturalBlessing)),
    shadowPath: text(valueOf(bio.shadowPath)),
    fellowshipFocus: text(valueOf(bio.fellowshipFocus)),
    age: resolveAge(sys),
    attributes: resolveAttributes(sys),
    valour: clampInt(valueOf(sys.stature?.valour), 0, 6, 1),
    wisdom: clampInt(valueOf(sys.stature?.wisdom), 0, 6, 1),
    // `.max` is the sheet datum; `.value` is live play state and never synced.
    endurance: clampInt(sys.resources?.endurance?.max, 0, 99),
    hope: clampInt(sys.resources?.hope?.max, 0, 99),
    parry: resolveParry(sys, armours),
    protection: resolveProtection(armours),
    skills: resolveSkills(sys),
    combat: resolveCombat(sys),
    traits: names(traits, MAX_TRAITS),
    virtues: names(actor.itemTypes?.virtues, MAX_VIRTUES),
    rewards: names(actor.itemTypes?.reward, MAX_REWARDS),
  };
}
