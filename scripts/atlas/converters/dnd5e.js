/**
 * dnd5e converter: projects a live dnd5e actor to the locked Atlas `dnd5e-compatible` API
 * schema. Because that schema is a Foundry subset, most fields copy straight through; the Atlas
 * server re-validates through its registry as a safety net. Reads the PREPARED actor (`actor.system`
 * after prepareData, `actor.itemTypes`), never the raw `_source`. Data paths checked against dnd5e
 * 3.0.0+ (see SUPPORTED_SYSTEMS.dnd5e.min in constants.js).
 */

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

// Broad proficiency categories the Atlas schema accepts; specific item codes are dropped.
const WEAPON_CODES = ["sim", "mar"];
const ARMOR_CODES = ["lgt", "med", "hvy", "shl"];

function toArray(value) {
  if (!value) return [];
  if (value instanceof Set) return Array.from(value);
  if (Array.isArray(value)) return value;
  // dnd5e sometimes stores trait values as { value: Set, custom: string }
  if (typeof value === "object" && "value" in value) return toArray(value.value);
  return [];
}

function codeBag(trait, allowed) {
  let value = toArray(trait?.value);
  // Some traits (weapon proficiencies) mix broad categories with specific item
  // codes; Atlas only accepts the broad categories, so filter when an allowlist
  // is given and drop everything else.
  if (allowed) value = value.filter((code) => allowed.includes(code));
  return {
    value,
    custom: typeof trait?.custom === "string" ? trait.custom : "",
  };
}

function resolveClasses(actor) {
  const classes = actor.itemTypes?.class ?? [];
  const subclasses = actor.itemTypes?.subclass ?? [];
  return classes.map((cls) => {
    const identifier = cls.system?.identifier;
    const sub = subclasses.find((s) => s.system?.classIdentifier === identifier);
    return {
      name: cls.name,
      subClass: sub?.name ?? "",
      level: Number(cls.system?.levels ?? 0) || 0,
    };
  });
}

function resolveSpecies(actor) {
  const race = actor.itemTypes?.race?.[0];
  if (race?.name) return race.name;
  const detail = actor.system?.details?.race;
  if (typeof detail === "string") return detail;
  if (detail?.name) return detail.name;
  return "";
}

function resolveAbilities(actor) {
  const out = {};
  const abilities = actor.system?.abilities ?? {};
  for (const key of ABILITY_KEYS) {
    const ab = abilities[key];
    if (!ab) continue;
    out[key] = {
      value: Number(ab.value ?? 10) || 10,
      proficient: ab.proficient ? 1 : 0,
    };
  }
  return out;
}

function resolveSkills(actor) {
  const out = {};
  const skills = actor.system?.skills ?? {};
  for (const [code, skill] of Object.entries(skills)) {
    const value = Number(skill?.value ?? 0) || 0;
    // Atlas only accepts full proficiency (1) or expertise (2); drop untrained (0)
    // and half-proficiency (0.5, e.g. Bard Jack of All Trades) which it rejects.
    if (value === 1 || value === 2) out[code] = value;
  }
  return out;
}

function resolveSenses(actor) {
  const s = actor.system?.attributes?.senses ?? {};
  // dnd5e 5.3 moved the numeric senses under `senses.ranges.*`; reading the
  // legacy flat keys (`s.blindsight`, ...) now fires a deprecation warning.
  // Prefer `ranges` when present, fall back to the flat keys for older systems.
  const r = s.ranges ?? s;
  return {
    darkvision: Number(r.darkvision ?? 0) || 0,
    blindsight: Number(r.blindsight ?? 0) || 0,
    tremorsense: Number(r.tremorsense ?? 0) || 0,
    truesight: Number(r.truesight ?? 0) || 0,
    special: typeof s.special === "string" ? s.special : "",
  };
}

/** Builds the flat sheet object (the locked schema keys, codes verbatim). */
export function buildSheet(actor) {
  const sys = actor.system ?? {};
  const ac = sys.attributes?.ac ?? {};
  const hp = sys.attributes?.hp ?? {};
  const traits = sys.traits ?? {};

  return {
    classes: resolveClasses(actor),
    species: resolveSpecies(actor),
    ca: Number(ac.value ?? 10) || 10,
    hp: Number(hp.max ?? hp.value ?? 0) || 0,
    size: typeof traits.size === "string" ? traits.size : "med",
    abilities: resolveAbilities(actor),
    skills: resolveSkills(actor),
    senses: resolveSenses(actor),
    languages: codeBag(traits.languages),
    weapons: codeBag(traits.weaponProf, WEAPON_CODES),
    armor: codeBag(traits.armorProf, ARMOR_CODES),
  };
}
