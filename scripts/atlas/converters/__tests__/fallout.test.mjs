// Unit tests for the fallout converter. Run from the module root with:
//   node --test scripts/atlas/converters/__tests__/fallout.test.mjs
//
// Pure Node: a stub PREPARED actor (the shapes the converter reads, nothing else) and a stub
// `globalThis.game` standing in for the world (`i18n.localize` for the skill labels of the world's
// language, `settings.get` for the derived-stats setting). No Foundry.
//
// An optional drift check compares the alias table with the site's skill labels: set
// FALLOUT_LOCALES_DIR to a directory holding one `<language>.json` per site language (each with a
// `skills` object of code → label) and it runs; without the variable it is skipped, and the
// five-language label table written out below stands in for it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSheet, MAX_PERKS, MAX_TEXT, MAX_TRAITS } from "../fallout.js";

const ATTRIBUTE_CODES = ["str", "per", "end", "cha", "int", "agi", "luc"];
const LOCATION_CODES = ["head", "torso", "armL", "armR", "legL", "legR"];
const SHEET_KEYS = [
  "actorType", "origin", "level", "attributes", "maxHealth", "defense", "initiative", "meleeDamage",
  "skills", "perks", "traits", "resistances", "poisonResistance", "immunities",
];
const SKILL_CODES = [
  "athletics", "barter", "big-guns", "energy-weapons", "explosives", "lockpick", "medicine", "melee-weapons",
  "pilot", "repair", "science", "small-guns", "sneak", "speech", "survival", "throwing", "unarmed",
];

// ── stubs ───────────────────────────────────────────────────────────────────

function skill(name, value = 0, tag = false, flags = undefined) {
  return { name, flags, system: { value, tag, defaultAttribute: "str" } };
}

function perk(name, rank = 1) {
  return { name, system: { rank: { value: rank, max: 1 } } };
}

function trait(name) {
  return { name, system: {} };
}

function attributes(values = {}) {
  return Object.fromEntries(ATTRIBUTE_CODES.map((code) => [code, { value: values[code] ?? 5 }]));
}

function bodyParts(values = {}) {
  return Object.fromEntries(
    LOCATION_CODES.map((code) => {
      const [physical, energy, radiation] = values[code] ?? [0, 0, 0];
      return [code, { resistance: { physical, energy, radiation, poison: 0 } }];
    }),
  );
}

/** The level 7 Vault Dweller of the schema example, English compendium skill names, French perks. */
function stubActor(overrides = {}) {
  return {
    type: "character",
    isWellRested: false,
    isTinkeredWith: false,
    system: {
      origin: "Habitant d'abri",
      level: { value: 7 },
      attributes: attributes({ str: 6, per: 8, end: 6, cha: 5, int: 7, agi: 7, luc: 5 }),
      // END 6 + LUC 5 + level 7 - 1 = 17, no radiation, no bonus.
      health: { max: 17, value: 17 },
      defense: { value: 1 },
      initiative: { value: 15 },
      meleeDamage: { value: 0 },
      radiation: 0,
      resistance: { physical: 0, energy: 0, radiation: 0, poison: 0 },
      immunities: { radiation: false, poison: false },
      body_parts: bodyParts({
        torso: [1, 1, 2], armL: [1, 1, 2], armR: [1, 1, 2], legL: [1, 1, 2], legR: [1, 1, 2],
      }),
    },
    itemTypes: {
      skill: [
        skill("Athletics", 1), skill("Barter", 1), skill("Big Guns", 0), skill("Energy Weapons", 1),
        skill("Explosives", 0), skill("Lockpick", 3, true), skill("Medicine", 2), skill("Melee Weapons", 0),
        skill("Pilot", 0), skill("Repair", 2), skill("Science", 3, true), skill("Small Guns", 4, true),
        skill("Sneak", 2), skill("Speech", 2), skill("Survival", 1), skill("Throwing", 0), skill("Unarmed", 0),
      ],
      perk: [
        perk("Fusilier", 2), perk("Sens affûtés"), perk("Maître-voleur"), perk("Métabolisme rapide"),
        perk("Infiltrateur"), perk("Aptitude scientifique"),
      ],
      trait: [trait("Enfant de l'abri")],
    },
    ...overrides,
  };
}

/** A Mister Handy: a `robot` actor, tinkered with, plating on the body, both immunities. */
function stubRobot() {
  const actor = stubActor({
    type: "robot",
    isTinkeredWith: true,
    itemTypes: {
      skill: [skill("Energy Weapons", 2, true), skill("Repair", 1), skill("Pilot", 3)],
      perk: [perk("Gun Nut", 1), perk("Robotics Expert", 2)],
      trait: [trait("Mister Handy Robot")],
    },
  });
  actor.system.origin = "Mister Handy";
  actor.system.level = { value: 5 };
  // END 6 + LUC 5 + level 5 - 1 = 15, +2 tinkered with.
  actor.system.health = { max: 17, value: 17 };
  actor.system.immunities = { radiation: true, poison: true };
  actor.system.body_parts = bodyParts({ head: [0, 0, 99], torso: [3, 2, 99], armL: [2, 2, 99], armR: [2, 2, 99], legL: [2, 2, 99], legR: [1, 1, 99] });
  actor.system.resistance = { physical: 0, energy: 0, radiation: 99, poison: 99 };
  return actor;
}

let warnings;
let settings;
let labels;
const originalWarn = console.warn;

beforeEach(() => {
  warnings = [];
  settings = {};
  labels = {};
  console.warn = (...args) => warnings.push(args.join(" "));
  globalThis.game = {
    // Missing key → the key itself, like Foundry's localize.
    i18n: { localize: (key) => labels[key] ?? key },
    // An unregistered setting throws, like Foundry's.
    settings: {
      get: (module, key) => {
        const id = `${module}.${key}`;
        if (!(id in settings)) throw new Error(`"${id}" is not a registered game setting`);
        return settings[id];
      },
    },
  };
});

afterEach(() => {
  delete globalThis.game;
  console.warn = originalWarn;
});

/** The sheet an actor with the given skill items converts to, skills only. */
function skillsOf(...items) {
  return buildSheet(stubActor({ itemTypes: { skill: items, perk: [], trait: [] } })).skills;
}

// ── the schema example ──────────────────────────────────────────────────────

test("a level 7 Vault Dweller converts to the documented sheet", () => {
  assert.deepEqual(buildSheet(stubActor()), {
    actorType: "character",
    origin: "Habitant d'abri",
    level: 7,
    attributes: { str: 6, per: 8, end: 6, cha: 5, int: 7, agi: 7, luc: 5 },
    maxHealth: 17,
    defense: 1,
    initiative: 15,
    meleeDamage: 0,
    skills: {
      athletics: [1, 0], barter: [1, 0], "energy-weapons": [1, 0], lockpick: [3, 1],
      medicine: [2, 0], repair: [2, 0], science: [3, 1], "small-guns": [4, 1],
      sneak: [2, 0], speech: [2, 0], survival: [1, 0],
    },
    perks: [
      { name: "Fusilier", rank: 2 }, { name: "Sens affûtés", rank: 1 }, { name: "Maître-voleur", rank: 1 },
      { name: "Métabolisme rapide", rank: 1 }, { name: "Infiltrateur", rank: 1 }, { name: "Aptitude scientifique", rank: 1 },
    ],
    traits: ["Enfant de l'abri"],
    resistances: {
      head: [0, 0, 0], torso: [1, 1, 2], armL: [1, 1, 2], armR: [1, 1, 2], legL: [1, 1, 2], legR: [1, 1, 2],
    },
    poisonResistance: 0,
    immunities: [],
  });
});

test("the keys come out in schema order, skills in the fixed order of the 17 codes, and no key is named fields", () => {
  const sheet = buildSheet(stubActor());
  assert.deepEqual(Object.keys(sheet), SHEET_KEYS);
  assert.equal("fields" in sheet, false);
  assert.deepEqual(Object.keys(sheet.attributes), ATTRIBUTE_CODES);
  assert.deepEqual(Object.keys(sheet.resistances), LOCATION_CODES);
  // A sheet whose skill items come in another order still lists the codes alphabetically.
  const shuffled = stubActor();
  shuffled.itemTypes.skill.reverse();
  assert.deepEqual(Object.keys(buildSheet(shuffled).skills), Object.keys(sheet.skills));
  assert.deepEqual(Object.keys(sheet.skills), SKILL_CODES.filter((code) => code in sheet.skills));
  // The result survives a JSON round trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(sheet)), sheet);
});

// ── robots ──────────────────────────────────────────────────────────────────

test("a robot converts with its actor type, its plating values and both immunities", () => {
  const sheet = buildSheet(stubRobot());
  assert.equal(sheet.actorType, "robot");
  assert.equal(sheet.origin, "Mister Handy");
  assert.equal(sheet.level, 5);
  assert.deepEqual(sheet.resistances, {
    head: [0, 0, 99], torso: [3, 2, 99], armL: [2, 2, 99], armR: [2, 2, 99], legL: [2, 2, 99], legR: [1, 1, 99],
  });
  assert.equal(sheet.poisonResistance, 99);
  assert.deepEqual(sheet.immunities, ["radiation", "poison"]);
  assert.deepEqual(sheet.skills, { "energy-weapons": [2, 1], pilot: [3, 0], repair: [1, 0] });
  assert.deepEqual(sheet.perks, [{ name: "Gun Nut", rank: 1 }, { name: "Robotics Expert", rank: 2 }]);
  assert.deepEqual(sheet.traits, ["Mister Handy Robot"]);
});

test("any actor type other than robot reads as a character", () => {
  assert.equal(buildSheet(stubActor({ type: "character" })).actorType, "character");
  assert.equal(buildSheet(stubActor({ type: "npc" })).actorType, "character");
  assert.equal(buildSheet(stubActor({ type: undefined })).actorType, "character");
  assert.equal(buildSheet(stubActor({ type: "robot" })).actorType, "robot");
});

test("immunities list only the flags that are exactly true, in the order radiation, poison", () => {
  const actor = stubActor();
  actor.system.immunities = { poison: true, radiation: false };
  assert.deepEqual(buildSheet(actor).immunities, ["poison"]);
  actor.system.immunities = { poison: true, radiation: true };
  assert.deepEqual(buildSheet(actor).immunities, ["radiation", "poison"]);
  actor.system.immunities = { poison: "yes", radiation: 1 };
  assert.deepEqual(buildSheet(actor).immunities, []);
});

// ── maximum health ──────────────────────────────────────────────────────────

test("max health takes the radiation back out: the system subtracts it from the maximum", () => {
  settings["fallout.disableAutoDerivedStats"] = false;
  const actor = stubActor();
  actor.system.radiation = 3;
  actor.system.health.max = 14; // 17 - 3
  assert.equal(buildSheet(actor).maxHealth, 17);
});

test("max health takes the well-rested bonus out for a character and the tinkered-with bonus out for a robot", () => {
  settings["fallout.disableAutoDerivedStats"] = false;
  const rested = stubActor({ isWellRested: true });
  rested.system.radiation = 3;
  rested.system.health.max = 16; // 17 - 3 + 2
  assert.equal(buildSheet(rested).maxHealth, 17);

  const tinkered = stubRobot();
  tinkered.system.radiation = 0;
  tinkered.system.health.max = 17; // 15 + 2
  assert.equal(buildSheet(tinkered).maxHealth, 15);
});

test("max health keeps a permanent health bonus: only radiation and the two conditions are undone", () => {
  settings["fallout.disableAutoDerivedStats"] = false;
  const actor = stubActor({ isWellRested: true });
  actor.system.radiation = 2;
  actor.system.health.max = 17 + 4 - 2 + 2; // base + bonus 4 - radiation + well rested
  assert.equal(buildSheet(actor).maxHealth, 21);
});

test("with the derived-stats setting on, the typed maximum goes through untouched", () => {
  settings["fallout.disableAutoDerivedStats"] = true;
  const actor = stubActor({ isWellRested: true });
  actor.system.radiation = 5;
  actor.system.health.max = 22;
  assert.equal(buildSheet(actor).maxHealth, 22);
});

test("an unreadable derived-stats setting counts as off: the live terms are still undone", () => {
  // The stub throws for an unregistered setting, exactly like Foundry.
  const actor = stubActor({ isWellRested: true });
  actor.system.radiation = 3;
  actor.system.health.max = 16;
  assert.equal(buildSheet(actor).maxHealth, 17);
  delete globalThis.game;
  assert.equal(buildSheet(actor).maxHealth, 17);
});

test("max health is clamped to 0..999 after the live terms are undone", () => {
  settings["fallout.disableAutoDerivedStats"] = false;
  const huge = stubActor();
  huge.system.health.max = 5000;
  assert.equal(buildSheet(huge).maxHealth, 999);
  const negative = stubActor({ isWellRested: true });
  negative.system.health.max = -20;
  negative.system.radiation = 4;
  assert.equal(buildSheet(negative).maxHealth, 0);
});

test("the other derived values are sent as the system shows them, bonuses included", () => {
  const actor = stubActor();
  actor.system.defense = { value: 3, bonus: 1 };
  actor.system.initiative = { value: 17, bonus: 2 };
  actor.system.meleeDamage = { value: 4, bonus: 1 };
  const sheet = buildSheet(actor);
  assert.equal(sheet.defense, 3);
  assert.equal(sheet.initiative, 17);
  assert.equal(sheet.meleeDamage, 4);
});

// ── skills ──────────────────────────────────────────────────────────────────

test("every one of the 17 English names resolves to its code", () => {
  const names = [
    "Athletics", "Barter", "Big Guns", "Energy Weapons", "Explosives", "Lockpick", "Medicine", "Melee Weapons",
    "Pilot", "Repair", "Science", "Small Guns", "Sneak", "Speech", "Survival", "Throwing", "Unarmed",
  ];
  const sheet = skillsOf(...names.map((name) => skill(name, 1)));
  assert.deepEqual(Object.keys(sheet), SKILL_CODES);
  for (const code of SKILL_CODES) assert.deepEqual(sheet[code], [1, 0], code);
});

test("English names match whatever the case, the accents or the spacing", () => {
  const sheet = skillsOf(skill("  big   GUNS ", 2), skill("lockpick", 1), skill("SMALL guns", 3, true));
  assert.deepEqual(sheet, { "big-guns": [2, 0], lockpick: [1, 0], "small-guns": [3, 1] });
});

test("a Babele-translated item resolves through its original name, a French world's item name notwithstanding", () => {
  const translated = skill("Armes lourdes", 3, false, { babele: { hasTranslation: true, originalName: "Big Guns" } });
  const odd = skill("Une compétence rebaptisée", 2, true, { babele: { hasTranslation: true, originalName: "Sneak" } });
  assert.deepEqual(skillsOf(translated, odd), { "big-guns": [3, 0], sneak: [2, 1] });
});

test("a Babele flag that does not say the item is translated is ignored; one without an original name falls back to the item name", () => {
  const notTranslated = skill("Pilot", 1, false, { babele: { hasTranslation: false, originalName: "Sneak" } });
  const noOriginal = skill("Repair", 2, false, { babele: { hasTranslation: true } });
  assert.deepEqual(skillsOf(notTranslated, noOriginal), { pilot: [1, 0], repair: [2, 0] });
});

test("a skill renamed to the label of the world's language resolves through that label", () => {
  // A Polish world: the system shows its own Polish labels, none of them in the alias table.
  labels["FALLOUT.SKILL.Big Guns"] = "Broń ciężka";
  labels["FALLOUT.SKILL.Sneak"] = "Skradanie się";
  assert.deepEqual(skillsOf(skill("Broń ciężka", 2), skill("skradanie się", 1, true)), { "big-guns": [2, 0], sneak: [1, 1] });
  // Without those labels in the world, the same names are unknown.
  labels = {};
  assert.deepEqual(skillsOf(skill("Broń ciężka", 2)), {});
});

test("the system's French and Spanish short forms and the community names resolve through the alias table", () => {
  const sheet = skillsOf(
    skill("Armes de CAC", 2), skill("Sciences", 1), skill("Armas c/c", 3, true),
    skill("Armes de corps à corps", 1), skill("Armes légères", 4),
  );
  // Both melee spellings land on one code: the best rank and the tag win.
  assert.deepEqual(sheet, { "melee-weapons": [3, 1], science: [1, 0], "small-guns": [4, 0] });
});

test("an unknown skill item is skipped and warned once, and the sheet still syncs the others", () => {
  const sheet = skillsOf(skill("Sneak", 2), skill("Basket-weaving", 3), skill("Basket-weaving", 1), skill("Hacking", 2, true));
  assert.deepEqual(sheet, { sneak: [2, 0] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"Basket-weaving"/);
  assert.match(warnings[0], /"Hacking"/);
  assert.match(warnings[0], /^jdr-ninja-atlas-sync \| fallout:/);
  assert.equal(warnings[0].split("Basket-weaving").length, 2, "an unknown name is listed once");
});

test("no warning when every skill is known", () => {
  skillsOf(skill("Sneak", 2), skill("Speech", 1));
  assert.deepEqual(warnings, []);
});

test("two items that resolve to the same code merge: highest rank, tagged if either is", () => {
  const sheet = skillsOf(skill("Science", 2, true), skill("Scienza", 4, false), skill("Wissenschaft", 1, false));
  assert.deepEqual(sheet, { science: [4, 1] });
});

test("an untrained, untagged skill is left out; a tagged one at rank 0 is kept as [0, 1]", () => {
  const sheet = skillsOf(skill("Sneak", 0), skill("Speech", 0, true), skill("Survival", 1));
  assert.deepEqual(sheet, { speech: [0, 1], survival: [1, 0] });
});

test("rank is clamped to 0..6, decimals are truncated, junk reads as 0, and only a boolean true tags", () => {
  const sheet = skillsOf(
    skill("Athletics", 9), skill("Barter", -2, true), skill("Explosives", 2.9), skill("Lockpick", "4"),
    skill("Medicine", "abc", true), skill("Pilot", 1, 1), skill("Repair", 1, "true"),
  );
  assert.deepEqual(sheet, {
    athletics: [6, 0], barter: [0, 1], explosives: [2, 0], lockpick: [4, 0], medicine: [0, 1], pilot: [1, 0], repair: [1, 0],
  });
});

test("a fresh actor with all 17 skills at rank 0 converts to an empty skills object", () => {
  const items = SKILL_CODES.map((code) => skill(code.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), 0));
  assert.deepEqual(skillsOf(...items), {});
  assert.deepEqual(warnings, []);
});

// ── the alias table ─────────────────────────────────────────────────────────

/** The skill labels of the five site languages, one table per code, mirrored from the site's locales. */
const SITE_LABELS = {
  athletics: ["Athletics", "Athlétisme", "Atletismo", "Athletik", "Atletica"],
  barter: ["Barter", "Troc", "Regateo", "Handel", "Baratto"],
  "big-guns": ["Big Guns", "Armes lourdes", "Armas grandes", "Große Waffen", "Armi pesanti"],
  "energy-weapons": ["Energy Weapons", "Armes à énergie", "Armas de energía", "Energiewaffen", "Armi a energia"],
  explosives: ["Explosives", "Explosifs", "Explosivos", "Sprengstoffe", "Esplosivi"],
  lockpick: ["Lockpick", "Crochetage", "Cerraduras", "Schlösser knacken", "Scasso"],
  medicine: ["Medicine", "Médecine", "Medicina", "Medizin", "Medicina"],
  "melee-weapons": ["Melee Weapons", "Armes de corps à corps", "Armas cuerpo a cuerpo", "Nahkampfwaffen", "Armi da mischia"],
  pilot: ["Pilot", "Pilotage", "Pilotar", "Pilot", "Pilotaggio"],
  repair: ["Repair", "Réparation", "Reparar", "Reparatur", "Riparazione"],
  science: ["Science", "Science", "Ciencia", "Wissenschaft", "Scienza"],
  "small-guns": ["Small Guns", "Armes légères", "Armas pequeñas", "Kleine Waffen", "Armi leggere"],
  sneak: ["Sneak", "Discrétion", "Sigilo", "Schleichen", "Furtività"],
  speech: ["Speech", "Discours", "Conversación", "Sprache", "Eloquenza"],
  survival: ["Survival", "Survie", "Supervivencia", "Überleben", "Sopravvivenza"],
  throwing: ["Throwing", "Projectiles", "Lanzar", "Wurfwaffen", "Lancio"],
  unarmed: ["Unarmed", "Mains nues", "Desarmado", "Waffenlos", "Disarmato"],
};

/** The table's labels, grouped by the loose comparison the converter uses. */
function looseKey(label) {
  return label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

test("the label table covers the 17 codes, and no label means two different skills", () => {
  assert.deepEqual(Object.keys(SITE_LABELS), SKILL_CODES);
  const owner = new Map();
  for (const [code, list] of Object.entries(SITE_LABELS)) {
    for (const label of list) {
      const key = looseKey(label);
      assert.equal(owner.get(key) ?? code, code, `"${label}" is claimed by two skills`);
      owner.set(key, code);
    }
  }
});

test("every site-language label of every skill resolves to its code", () => {
  for (const [code, list] of Object.entries(SITE_LABELS)) {
    for (const label of list) {
      assert.deepEqual(skillsOf(skill(label, 2)), { [code]: [2, 0] }, `${label} → ${code}`);
    }
  }
  assert.deepEqual(warnings, []);
});

test("a case, accent or spacing variant of a site label still resolves", () => {
  assert.deepEqual(skillsOf(skill("ARMES LEGERES", 1), skill("GROßE   waffen", 2), skill("schlosser   knacken", 3)), {
    "small-guns": [1, 0], "big-guns": [2, 0], lockpick: [3, 0],
  });
});

test("the alias table follows the site's skill labels when a locale directory is given", { skip: !process.env.FALLOUT_LOCALES_DIR && "FALLOUT_LOCALES_DIR is not set" }, () => {
  const dir = process.env.FALLOUT_LOCALES_DIR;
  const seen = [];
  for (const language of ["fr", "en", "es", "de", "it"]) {
    const file = join(dir, `${language}.json`);
    assert.ok(existsSync(file), `${file} is missing`);
    const dictionary = JSON.parse(readFileSync(file, "utf8")).skills;
    assert.deepEqual(Object.keys(dictionary).sort(), [...SKILL_CODES].sort(), `${language}: the 17 codes`);
    for (const [code, label] of Object.entries(dictionary)) {
      assert.deepEqual(skillsOf(skill(label, 1)), { [code]: [1, 0] }, `${language}: "${label}" → ${code}`);
      seen.push(label);
    }
  }
  assert.ok(seen.length >= 85);
  assert.deepEqual(warnings, []);
});

// ── perks ───────────────────────────────────────────────────────────────────

function perksOf(...items) {
  return buildSheet(stubActor({ itemTypes: { skill: [], perk: items, trait: [] } })).perks;
}

test("a perk at rank 0 (the compendium default) reads 1, and a rank is capped at 10", () => {
  assert.deepEqual(perksOf(perk("Toughness", 0), perk("Intense Training", 11), perk("Gunslinger", 3)), [
    { name: "Toughness", rank: 1 }, { name: "Intense Training", rank: 10 }, { name: "Gunslinger", rank: 3 },
  ]);
  assert.deepEqual(perksOf(perk("A", -3), perk("B", "x"), perk("C", 2.8), perk("D", null)), [
    { name: "A", rank: 1 }, { name: "B", rank: 1 }, { name: "C", rank: 2 }, { name: "D", rank: 1 },
  ]);
});

test("perks with the same name merge whatever the case, keeping the highest rank", () => {
  assert.deepEqual(perksOf(perk("Fusilier", 1), perk("  fusilier ", 3), perk("FUSILIER", 2), perk("Ninja", 1)), [
    { name: "Fusilier", rank: 3 }, { name: "Ninja", rank: 1 },
  ]);
});

test("nameless perks are dropped, long names cut to 60 and trimmed", () => {
  const long = `${"x".repeat(59)} tail that goes past the limit`;
  const sheet = perksOf(perk("", 2), perk("   ", 2), perk(undefined, 2), perk(long, 2), perk("  Padded  ", 1));
  assert.deepEqual(sheet, [{ name: "x".repeat(59), rank: 2 }, { name: "Padded", rank: 1 }]);
  for (const entry of sheet) assert.ok(entry.name.length <= MAX_TEXT);
});

test("names that only differ after the cut collapse into one perk", () => {
  const base = "y".repeat(MAX_TEXT);
  assert.deepEqual(perksOf(perk(`${base}A`, 1), perk(`${base}B`, 4)), [{ name: base, rank: 4 }]);
});

test("a perk name with a trailing next-line character (U+0085) merges with the plain one", () => {
  // The server trims U+0085 and JavaScript's trim() does not: both names must leave as one perk.
  assert.deepEqual(perksOf(perk("Fusilier", 2), perk("Fusilier\u0085", 3), perk("\u0085fusilier\u0085", 1)), [
    { name: "Fusilier", rank: 3 },
  ]);
  assert.deepEqual(perksOf(perk("\u0085", 2), perk(" \u0085 ", 2), perk("Ninja\u0085", 1)), [{ name: "Ninja", rank: 1 }]);
});

test("over 30 perks, the 30 highest ranks stay (ties by name), in their original order, with a warning", () => {
  const items = [];
  for (let i = 0; i < 31; i++) items.push(perk(`Perk ${String(i).padStart(2, "0")}`, 1));
  items[7] = perk("Perk 07", 5);
  const sheet = perksOf(...items);
  assert.equal(sheet.length, MAX_PERKS);
  // All ranks tie at 1 except Perk 07, so the cut falls on the last name alphabetically: Perk 30.
  assert.equal(sheet.some((entry) => entry.name === "Perk 30"), false);
  assert.equal(sheet.some((entry) => entry.name === "Perk 07"), true);
  assert.deepEqual(sheet.map((entry) => entry.name), items.filter((i) => i.name !== "Perk 30").map((i) => i.name));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /31 perks, keeping the 30/);
});

test("a higher rank beats an earlier position when the list is cut", () => {
  const items = [];
  for (let i = 0; i < 30; i++) items.push(perk(`Low ${String(i).padStart(2, "0")}`, 1));
  items.push(perk("Late but strong", 6));
  const names = perksOf(...items).map((entry) => entry.name);
  assert.equal(names.length, MAX_PERKS);
  assert.ok(names.includes("Late but strong"));
  assert.ok(!names.includes("Low 29"));
});

test("exactly 30 perks pass without a warning", () => {
  const items = Array.from({ length: 30 }, (_, i) => perk(`Perk ${i}`, 1));
  assert.equal(perksOf(...items).length, 30);
  assert.deepEqual(warnings, []);
});

// ── traits ──────────────────────────────────────────────────────────────────

function traitsOf(...items) {
  return buildSheet(stubActor({ itemTypes: { skill: [], perk: [], trait: items } })).traits;
}

test("traits keep their names in order, deduplicated, trimmed and cut", () => {
  const long = "z".repeat(80);
  assert.deepEqual(traitsOf(trait("Gifted"), trait(" gifted "), trait(""), trait("Small Frame"), trait(long)), [
    "Gifted", "Small Frame", "z".repeat(MAX_TEXT),
  ]);
  assert.deepEqual(warnings, []);
});

test("a trait name with a trailing next-line character (U+0085) is the same trait", () => {
  assert.deepEqual(traitsOf(trait("Gifted"), trait("Gifted\u0085"), trait("\u0085"), trait("Small Frame\u0085")), [
    "Gifted", "Small Frame",
  ]);
});

test("over 6 traits the first 6 stay, with a warning", () => {
  const sheet = traitsOf(...Array.from({ length: 8 }, (_, i) => trait(`Trait ${i}`)));
  assert.deepEqual(sheet, Array.from({ length: MAX_TRAITS }, (_, i) => `Trait ${i}`));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /8 traits, keeping the first 6/);
});

// ── clamping ────────────────────────────────────────────────────────────────

test("level, attributes and the four derived values are clamped to the schema's bounds", () => {
  const actor = stubActor();
  actor.system.level = { value: 150 };
  actor.system.attributes = attributes({ str: 0, per: 16, end: 12, cha: -3, int: 99, agi: 4.7, luc: 15 });
  actor.system.defense = { value: 25 };
  actor.system.initiative = { value: 500 };
  actor.system.meleeDamage = { value: 31 };
  const sheet = buildSheet(actor);
  assert.equal(sheet.level, 99);
  assert.deepEqual(sheet.attributes, { str: 1, per: 15, end: 12, cha: 1, int: 15, agi: 4, luc: 15 });
  assert.equal(sheet.defense, 20);
  assert.equal(sheet.initiative, 99);
  assert.equal(sheet.meleeDamage, 20);

  actor.system.level = { value: 0 };
  actor.system.defense = { value: -1 };
  actor.system.initiative = { value: -9 };
  actor.system.meleeDamage = { value: -9 };
  const low = buildSheet(actor);
  assert.equal(low.level, 1);
  assert.equal(low.defense, 0);
  assert.equal(low.initiative, 0);
  assert.equal(low.meleeDamage, 0);
});

test("resistances are clamped to 0..99; the NaN of a blank armour value reads 0", () => {
  const actor = stubActor();
  actor.system.body_parts = bodyParts({
    head: [100, 250, -4], torso: [Number.NaN, "", null], armL: ["7", 3.9, undefined], armR: [0, 0, 0],
  });
  actor.system.body_parts.legL = undefined; // a missing location
  delete actor.system.body_parts.legR;
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.resistances, {
    head: [99, 99, 0], torso: [0, 0, 0], armL: [7, 3, 0], armR: [0, 0, 0], legL: [0, 0, 0], legR: [0, 0, 0],
  });
  actor.system.resistance = { poison: 140 };
  assert.equal(buildSheet(actor).poisonResistance, 99);
  actor.system.resistance = { poison: Number.NaN };
  assert.equal(buildSheet(actor).poisonResistance, 0);
});

test("the origin is trimmed and cut to 60 characters, without a lone surrogate at the cut", () => {
  const actor = stubActor();
  actor.system.origin = `   ${"o".repeat(80)}`;
  assert.equal(buildSheet(actor).origin, "o".repeat(MAX_TEXT));
  actor.system.origin = `${"o".repeat(MAX_TEXT - 1)}\u{1F680}`; // the emoji straddles the cut
  assert.equal(buildSheet(actor).origin, "o".repeat(MAX_TEXT - 1));
  actor.system.origin = 12;
  assert.equal(buildSheet(actor).origin, "12");
  actor.system.origin = null;
  assert.equal(buildSheet(actor).origin, "");
});

// ── empty and hostile data ──────────────────────────────────────────────────

test("an actor with no data at all converts to the neutral sheet without throwing", () => {
  for (const actor of [{ type: "character" }, { type: "robot", system: {}, itemTypes: {} }, { type: "character", system: null, itemTypes: null }]) {
    const sheet = buildSheet(actor);
    assert.deepEqual(sheet, {
      actorType: actor.type,
      origin: "",
      level: 1,
      attributes: { str: 5, per: 5, end: 5, cha: 5, int: 5, agi: 5, luc: 5 },
      maxHealth: 0,
      defense: 0,
      initiative: 0,
      meleeDamage: 0,
      skills: {},
      perks: [],
      traits: [],
      resistances: Object.fromEntries(LOCATION_CODES.map((code) => [code, [0, 0, 0]])),
      poisonResistance: 0,
      immunities: [],
    });
  }
  assert.deepEqual(warnings, []);
});

test("items without a system block, a name or flags do not break the conversion", () => {
  const actor = stubActor({ itemTypes: { skill: [{ name: "Sneak" }, {}, null], perk: [{ name: "Solid" }, {}, null], trait: [{ name: "Wiry" }, {}, null] } });
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.skills, {});
  assert.deepEqual(sheet.perks, [{ name: "Solid", rank: 1 }]);
  assert.deepEqual(sheet.traits, ["Wiry"]);
});

// ── bounds, whatever the input ──────────────────────────────────────────────

function assertInt(value, min, max, what) {
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `${what}: ${value} is not an integer in ${min}..${max}`);
}

/** The server's bounds for the sheet, written out: whatever the converter returns must pass them. */
function assertWithinBounds(sheet) {
  assert.deepEqual(Object.keys(sheet), SHEET_KEYS);
  assert.ok(["character", "robot"].includes(sheet.actorType));
  assert.ok(typeof sheet.origin === "string" && sheet.origin.length <= 60);
  assertInt(sheet.level, 1, 99, "level");
  assert.deepEqual(Object.keys(sheet.attributes), ATTRIBUTE_CODES);
  for (const code of ATTRIBUTE_CODES) assertInt(sheet.attributes[code], 1, 15, code);
  assertInt(sheet.maxHealth, 0, 999, "maxHealth");
  assertInt(sheet.defense, 0, 20, "defense");
  assertInt(sheet.initiative, 0, 99, "initiative");
  assertInt(sheet.meleeDamage, 0, 20, "meleeDamage");
  for (const [code, tuple] of Object.entries(sheet.skills)) {
    assert.ok(SKILL_CODES.includes(code), `skill code ${code}`);
    assert.equal(tuple.length, 2);
    assertInt(tuple[0], 0, 6, `${code} rank`);
    assertInt(tuple[1], 0, 1, `${code} tag`);
    assert.ok(tuple[0] > 0 || tuple[1] > 0, `${code} is [0, 0]`);
  }
  assert.ok(sheet.perks.length <= 30);
  const names = new Set();
  for (const entry of sheet.perks) {
    assert.deepEqual(Object.keys(entry), ["name", "rank"]);
    assert.ok(entry.name.length >= 1 && entry.name.length <= 60 && entry.name === entry.name.trim());
    assertInt(entry.rank, 1, 10, "perk rank");
    assert.ok(!names.has(entry.name.toUpperCase()), `duplicate perk ${entry.name}`);
    names.add(entry.name.toUpperCase());
  }
  assert.ok(sheet.traits.length <= 6);
  assert.equal(new Set(sheet.traits.map((name) => name.toUpperCase())).size, sheet.traits.length);
  for (const name of sheet.traits) assert.ok(name.length >= 1 && name.length <= 60);
  assert.deepEqual(Object.keys(sheet.resistances), LOCATION_CODES);
  for (const code of LOCATION_CODES) {
    assert.equal(sheet.resistances[code].length, 3);
    for (const value of sheet.resistances[code]) assertInt(value, 0, 99, `${code} resistance`);
  }
  assertInt(sheet.poisonResistance, 0, 99, "poisonResistance");
  assert.ok(sheet.immunities.every((code) => ["radiation", "poison"].includes(code)));
  assert.equal(new Set(sheet.immunities).size, sheet.immunities.length);
}

test("whatever junk a number holds, the sheet stays inside the server's bounds", () => {
  const junk = [undefined, null, "", "  ", "abc", Number.NaN, Infinity, -Infinity, -5, 0, 1e9, "7", 3.9, true, {}, [], [3]];
  for (const value of junk) {
    const actor = stubActor({ isWellRested: true });
    actor.system.level = { value };
    actor.system.attributes = attributes(Object.fromEntries(ATTRIBUTE_CODES.map((code) => [code, value])));
    actor.system.health = { max: value };
    actor.system.radiation = value;
    actor.system.defense = { value };
    actor.system.initiative = { value };
    actor.system.meleeDamage = { value };
    actor.system.resistance = { poison: value };
    actor.system.body_parts = bodyParts(Object.fromEntries(LOCATION_CODES.map((code) => [code, [value, value, value]])));
    actor.itemTypes = {
      skill: SKILL_CODES.map((code) => skill(code.replace("-", " "), value, value)),
      perk: [perk("Junk perk", value)],
      trait: [trait("Junk trait")],
    };
    assertWithinBounds(buildSheet(actor));
  }
});

test("a maximal sheet sits on every bound, passes them, and fits the 8 KiB sheet cap", () => {
  const actor = stubActor({ isWellRested: true });
  actor.system.origin = "o".repeat(80);
  actor.system.level = { value: 99 };
  actor.system.attributes = attributes(Object.fromEntries(ATTRIBUTE_CODES.map((code) => [code, 15])));
  actor.system.health = { max: 999 };
  actor.system.defense = { value: 20 };
  actor.system.initiative = { value: 99 };
  actor.system.meleeDamage = { value: 20 };
  actor.system.radiation = 0;
  actor.system.immunities = { radiation: true, poison: true };
  actor.system.resistance = { poison: 99 };
  actor.system.body_parts = bodyParts(Object.fromEntries(LOCATION_CODES.map((code) => [code, [99, 99, 99]])));
  actor.itemTypes = {
    skill: SKILL_CODES.map((code) => skill(code.replace("-", " "), 6, true)),
    perk: Array.from({ length: 40 }, (_, i) => perk(`${String(i).padStart(2, "0")}${"p".repeat(70)}`, 10)),
    trait: Array.from({ length: 9 }, (_, i) => trait(`${i}${"t".repeat(70)}`)),
  };
  const sheet = buildSheet(actor);
  assertWithinBounds(sheet);
  assert.equal(Object.keys(sheet.skills).length, 17);
  assert.equal(sheet.perks.length, MAX_PERKS);
  assert.equal(sheet.traits.length, MAX_TRAITS);
  assert.ok(new TextEncoder().encode(JSON.stringify(sheet)).length < 8 * 1024);
});

test("a robot and a character with the same data differ by the actor type alone", () => {
  const character = buildSheet(stubActor());
  const robot = buildSheet(stubActor({ type: "robot" }));
  assert.deepEqual({ ...robot, actorType: "character" }, character);
});
