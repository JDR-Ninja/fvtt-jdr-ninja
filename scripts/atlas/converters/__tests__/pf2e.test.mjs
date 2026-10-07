// Unit tests for the pf2e / sf2e converter. Run from foundry/jdr-ninja-atlas-sync with:
//   node --test scripts/converters/__tests__/pf2e.test.mjs
//
// No Foundry here: a stub PREPARED actor (the getters and `system` shape the converter reads after
// prepareData) plus a stub `globalThis.CONFIG.PF2E` / `game`, so the expected outputs are the two
// briefs' §3 examples (pf2e: the level 5 human fighter; sf2e: Obozaya, the level 4 vesk soldier).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSheet } from "../pf2e.js";
import { converterFor } from "../index.js";
import { SUPPORTED_SYSTEMS } from "../../constants.js";

const PF2E_SKILLS = {
  acrobatics: { attribute: "dex" }, arcana: { attribute: "int" }, athletics: { attribute: "str" },
  crafting: { attribute: "int" }, deception: { attribute: "cha" }, diplomacy: { attribute: "cha" },
  intimidation: { attribute: "cha" }, medicine: { attribute: "wis" }, nature: { attribute: "wis" },
  occultism: { attribute: "int" }, performance: { attribute: "cha" }, religion: { attribute: "wis" },
  society: { attribute: "int" }, stealth: { attribute: "dex" }, survival: { attribute: "wis" },
  thievery: { attribute: "dex" },
};
const SF2E_SKILLS = { ...PF2E_SKILLS, computers: { attribute: "int" }, piloting: { attribute: "dex" } };
const WEAPON_CATEGORIES = { simple: "PF2E.WeaponTypeSimple", martial: "PF2E.WeaponTypeMartial", advanced: "PF2E.WeaponTypeAdvanced", unarmed: "PF2E.WeaponTypeUnarmed" };

function stubConfig(systemId, skills) {
  globalThis.CONFIG = { PF2E: { skills, weaponCategories: WEAPON_CATEGORIES, languages: {} } };
  globalThis.game = { system: { id: systemId, version: systemId === "pf2e" ? "8.5.0" : "1.5.0" } };
}

// `actor.skills[slug]` as the system builds it: a Statistic with rank/attribute/lore, the lore items
// merged in under their slug with `lore: true`.
function statistics(skills, ranks, lores = []) {
  const out = {};
  for (const [slug, { attribute }] of Object.entries(skills)) {
    out[slug] = { slug, rank: ranks[slug] ?? 0, attribute, lore: false };
  }
  for (const lore of lores) {
    out[lore.slug] = { slug: lore.slug, rank: lore.system.proficient.value, attribute: "int", lore: true };
  }
  return out;
}

function trace(value) {
  return value === null ? null : { type: "land", value, base: value };
}

function fighterActor() {
  const lores = [{ slug: "connaissance-de-la-guerre", name: "Connaissance de la guerre", system: { proficient: { value: 1 } } }];
  return {
    type: "character",
    level: 5,
    keyAttribute: "str",
    size: "med",
    class: { name: "Guerrier" },
    ancestry: { name: "Humain" },
    heritage: { name: "Humain polyvalent" },
    background: { name: "Soldat" },
    system: {
      abilities: { str: { mod: 4 }, dex: { mod: 2 }, con: { mod: 3 }, int: { mod: 0 }, wis: { mod: 1 }, cha: { mod: 0 } },
      attributes: { hp: { max: 73, value: 40, temp: 0 }, ac: { value: 23 }, classDC: { value: 21 } },
      movement: { speeds: { land: trace(25), burrow: null, climb: null, fly: null, swim: null, travel: trace(150) } },
      proficiencies: {
        attacks: { simple: { rank: 2 }, martial: { rank: 2 }, advanced: { rank: 1 }, unarmed: { rank: 2 }, "weapon-group-sword": { rank: 3 }, "weapon-base-longsword": { rank: 4 } },
        defenses: { unarmored: { rank: 1 }, light: { rank: 1 }, medium: { rank: 1 }, heavy: { rank: 1 }, "light-barding": { rank: 0 }, "heavy-barding": { rank: 0 } },
      },
      details: { languages: { value: ["common", "taldane", "dwarven"], details: "" }, level: { value: 5 } },
      resources: { heroPoints: { value: 1, max: 3 } },
    },
    perception: {
      rank: 2,
      mod: 10,
      senses: { contents: [{ type: "low-light-vision", acuity: "precise", range: Infinity }] },
    },
    saves: { fortitude: { rank: 2 }, reflex: { rank: 2 }, will: { rank: 1 } },
    skills: statistics(PF2E_SKILLS, { athletics: 2, intimidation: 1, medicine: 1, society: 1, survival: 1 }, lores),
    itemTypes: { lore: lores },
  };
}

function obozayaActor() {
  const lores = [{ slug: "warfare-lore", name: "Warfare Lore", system: { proficient: { value: 1 } } }];
  return {
    type: "character",
    level: 4,
    keyAttribute: "con",
    size: "med",
    class: { name: "Soldier" },
    ancestry: { name: "Vesk" },
    heritage: { name: "Briskwander Vesk" },
    background: { name: "Trooper" },
    system: {
      abilities: { str: { mod: 3 }, dex: { mod: 1 }, con: { mod: 4 }, int: { mod: 0 }, wis: { mod: 0 }, cha: { mod: 1 } },
      attributes: { hp: { max: 66, value: 66 }, ac: { value: 21 }, classDC: { value: 20 } },
      movement: { speeds: { land: trace(20), burrow: null, climb: null, fly: null, swim: null } },
      proficiencies: {
        attacks: { simple: { rank: 1 }, martial: { rank: 1 }, advanced: { rank: 0 }, unarmed: { rank: 1 }, "simple-guns": { rank: 2 } },
        defenses: { unarmored: { rank: 1 }, light: { rank: 1 }, medium: { rank: 1 }, heavy: { rank: 1 } },
      },
      details: { languages: { value: ["common", "vesk", "akitonian"], details: "" } },
    },
    perception: { rank: 1, senses: { contents: [{ type: "low-light-vision", acuity: "precise", range: Infinity }] } },
    saves: { fortitude: { rank: 2 }, reflex: { rank: 1 }, will: { rank: 2 } },
    skills: statistics(SF2E_SKILLS, { athletics: 1, intimidation: 2, computers: 1, piloting: 1 }, lores),
    itemTypes: { lore: lores },
  };
}

const FIGHTER = {
  level: 5,
  keyAbility: "str",
  class: "Guerrier",
  ancestry: "Humain",
  heritage: "Humain polyvalent",
  background: "Soldat",
  size: "med",
  abilities: { str: 4, dex: 2, con: 3, int: 0, wis: 1, cha: 0 },
  hp: 73,
  ac: 23,
  speed: { land: 25 },
  classDc: 21,
  perception: 2,
  saves: { fortitude: 2, reflex: 2, will: 1 },
  skills: { athletics: 2, intimidation: 1, medicine: 1, society: 1, survival: 1 },
  lores: [{ name: "Connaissance de la guerre", rank: 1 }],
  attacks: { simple: 2, martial: 2, advanced: 1, unarmed: 2 },
  defenses: { unarmored: 1, light: 1, medium: 1, heavy: 1 },
  senses: [{ type: "low-light-vision" }],
  languages: { value: ["common", "taldane", "dwarven"], custom: "" },
};

const OBOZAYA = {
  level: 4,
  keyAbility: "con",
  class: "Soldier",
  ancestry: "Vesk",
  heritage: "Briskwander Vesk",
  background: "Trooper",
  size: "med",
  abilities: { str: 3, dex: 1, con: 4, int: 0, wis: 0, cha: 1 },
  hp: 66,
  ac: 21,
  speed: { land: 20 },
  classDc: 20,
  perception: 1,
  saves: { fortitude: 2, reflex: 1, will: 2 },
  skills: { athletics: 1, intimidation: 2, computers: 1, piloting: 1 },
  lores: [{ name: "Warfare Lore", rank: 1 }],
  attacks: { simple: 1, martial: 1, advanced: 0, unarmed: 1 },
  defenses: { unarmored: 1, light: 1, medium: 1, heavy: 1 },
  senses: [{ type: "low-light-vision" }],
  languages: { value: ["common", "vesk", "akitonian"], custom: "" },
};

test("pf2e: the §3 fighter comes out as the brief's example, in canonical key order", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const sheet = buildSheet(fighterActor());
  assert.deepEqual(sheet, FIGHTER);
  assert.deepEqual(Object.keys(sheet), Object.keys(FIGHTER));
});

test("sf2e: Obozaya comes out as the sf2e brief's example; computers and piloting flow through CONFIG.PF2E.skills", () => {
  stubConfig("sf2e", SF2E_SKILLS);
  const sheet = buildSheet(obozayaActor());
  assert.deepEqual(sheet, OBOZAYA);
});

test("untrained skills are dropped; lores at rank 0 too; extra proficiency keys never leak", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.skills.arcana.rank = 0;
  actor.itemTypes.lore.push({ slug: "x", name: "Untrained lore", system: { proficient: { value: 0 } } });
  const sheet = buildSheet(actor);
  assert.equal("arcana" in sheet.skills, false);
  assert.deepEqual(sheet.lores, [{ name: "Connaissance de la guerre", rank: 1 }]);
  assert.deepEqual(Object.keys(sheet.attacks), ["simple", "martial", "advanced", "unarmed"]);
  assert.deepEqual(Object.keys(sheet.defenses), ["unarmored", "light", "medium", "heavy"]);
});

test("senses: precise acuity and an unlimited range are omitted, others kept, unknown types dropped, first 8", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.perception.senses = {
    contents: [
      { type: "darkvision", acuity: "precise", range: Infinity },
      { type: "scent", acuity: "imprecise", range: 30 },
      { type: "tremorsense", acuity: "vague", range: null },
      { type: "hearing", acuity: "precise", range: Infinity },
      { type: "scent", acuity: "vague", range: 10 },
    ],
  };
  assert.deepEqual(buildSheet(actor).senses, [
    { type: "darkvision" },
    { type: "scent", acuity: "imprecise", range: 30 },
    { type: "tremorsense", acuity: "vague" },
  ]);

  actor.perception.senses = {
    contents: ["bloodsense", "darkvision", "echolocation", "electromagnetic-sense", "greater-darkvision", "infrared-vision", "lifesense", "low-light-vision", "magicsense"]
      .map((type) => ({ type, acuity: "precise", range: Infinity })),
  };
  assert.equal(buildSheet(actor).senses.length, 8);
});

test("speeds: land always emitted (25 when the trace is missing), other types only when positive, travel ignored", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.system.movement.speeds = { land: trace(30), fly: trace(40), swim: trace(0), climb: null, travel: trace(200) };
  assert.deepEqual(buildSheet(actor).speed, { land: 30, fly: 40 });
  actor.system.movement = undefined;
  assert.deepEqual(buildSheet(actor).speed, { land: 25 });
});

test("level 0 pregens become 1, level 30 is capped at 20, an unknown key attribute falls back to str, size to med", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.level = 0;
  actor.keyAttribute = "luck";
  actor.size = "colossal";
  let sheet = buildSheet(actor);
  assert.equal(sheet.level, 1);
  assert.equal(sheet.keyAbility, "str");
  assert.equal(sheet.size, "med");
  actor.level = 30;
  sheet = buildSheet(actor);
  assert.equal(sheet.level, 20);
});

test("no class item: empty class and a null class DC; a missing ancestry keeps Foundry's prepared defaults", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.class = null;
  actor.ancestry = undefined;
  actor.system.attributes.classDC = null;
  const sheet = buildSheet(actor);
  assert.equal(sheet.class, "");
  assert.equal(sheet.classDc, null);
  assert.equal(sheet.ancestry, "");
  assert.equal(sheet.size, "med");
});

test("languages: strings only, trimmed, overlong codes dropped, first 24, details → custom (200), a Set is accepted", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  const many = Array.from({ length: 30 }, (_, i) => `lang${i}`);
  actor.system.details.languages = {
    value: new Set(["common", " thassilonian ", 42, "", "x".repeat(33), ...many]),
    details: " Patois des collines ".padEnd(260, "x"),
  };
  const sheet = buildSheet(actor);
  assert.equal(sheet.languages.value.length, 24);
  assert.deepEqual(sheet.languages.value.slice(0, 2), ["common", "thassilonian"]);
  assert.equal(sheet.languages.custom.length, 200);
});

test("free text: a cut after a space is trimmed again, a cut inside a surrogate pair drops the lone half, non-strings are empty", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.class = { name: `${"c".repeat(79)} suite` }; // the 80th unit is a space
  actor.ancestry = { name: `${"a".repeat(79)}\u{1D11E}` }; // 79 + 2 units
  actor.background = { name: 42 };
  actor.itemTypes.lore = [{ slug: "l", name: `${"l".repeat(39)}\u{1D11E}`, system: { proficient: { value: 2 } } }];
  const sheet = buildSheet(actor);
  assert.equal(sheet.class, "c".repeat(79));
  assert.equal(sheet.ancestry, "a".repeat(79));
  assert.equal(sheet.background, "");
  assert.deepEqual(sheet.lores, [{ name: "l".repeat(39), rank: 2 }]);
  assert.ok(JSON.stringify(sheet).isWellFormed());
});

test("abilities are clamped to -5..9 and truncated; hp/ac/classDc clamped to their bounds", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const actor = fighterActor();
  actor.system.abilities.str.mod = 12;
  actor.system.abilities.dex.mod = -9;
  actor.system.abilities.con.mod = 2.7;
  actor.system.attributes.hp.max = 1500;
  actor.system.attributes.ac.value = 120;
  actor.system.attributes.classDC.value = -3;
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.abilities, { str: 9, dex: -5, con: 2, int: 0, wis: 1, cha: 0 });
  assert.equal(sheet.hp, 999);
  assert.equal(sheet.ac, 99);
  assert.equal(sheet.classDc, 0);
});

test("never throws on an empty actor: every field takes its schema default", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  const sheet = buildSheet({});
  assert.equal(sheet.level, 1);
  assert.equal(sheet.keyAbility, "str");
  assert.deepEqual(sheet.abilities, { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 });
  assert.deepEqual(sheet.speed, { land: 25 });
  assert.equal(sheet.classDc, null);
  assert.deepEqual(sheet.skills, {});
  assert.deepEqual(sheet.senses, []);
  assert.deepEqual(sheet.languages, { value: [], custom: "" });
});

test("without CONFIG.PF2E, the actor's own non-lore statistics are the skill set", () => {
  delete globalThis.CONFIG;
  const sheet = buildSheet(obozayaActor());
  assert.deepEqual(sheet.skills, OBOZAYA.skills);
});

test("dispatch: pf2e and sf2e both resolve to this converter and carry their Atlas slugs and floors", () => {
  stubConfig("pf2e", PF2E_SKILLS);
  assert.equal(converterFor("pf2e"), buildSheet);
  assert.equal(converterFor("sf2e"), buildSheet);
  assert.deepEqual(SUPPORTED_SYSTEMS.pf2e, { min: "7.5.0", atlasSlug: "pf2e-compatible" });
  assert.deepEqual(SUPPORTED_SYSTEMS.sf2e, { min: "1.0.0", atlasSlug: "sf2e-compatible" });
});
