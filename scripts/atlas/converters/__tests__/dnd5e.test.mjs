// Unit tests for the dnd5e converter. Run from foundry/jdr-ninja-atlas-sync with:
//   node --test scripts/converters/__tests__/dnd5e.test.mjs
//
// Pure Node, no Foundry: a stub PREPARED actor (the `system` paths and `itemTypes` the converter
// reads) and the sheet it must become. The golden pins the projection that moved verbatim from
// scripts/converter.js into scripts/converters/dnd5e.js when the module went multi-system: any
// drift in a copied-through field shows up here, not in a GM's sync.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSheet } from "../dnd5e.js";
import { converterFor } from "../index.js";

/** A level 5 dwarf fighter (Champion), as dnd5e 5.x prepares it. */
function fighterActor() {
  return {
    name: "Bruenor",
    type: "character",
    img: "art/bruenor.webp",
    system: {
      attributes: {
        ac: { value: 18, flat: null, calc: "default" },
        hp: { value: 30, max: 44, temp: 5, tempmax: 0 },
        // dnd5e 5.3: the numeric senses live under `ranges`; `special` stays on the bag.
        senses: { ranges: { darkvision: 60, blindsight: 0, tremorsense: 0, truesight: 0 }, units: "ft", special: "" },
      },
      abilities: {
        str: { value: 16, proficient: 1, mod: 3 },
        dex: { value: 12, proficient: 0, mod: 1 },
        con: { value: 15, proficient: 1, mod: 2 },
        int: { value: 10, proficient: 0, mod: 0 },
        wis: { value: 13, proficient: 0, mod: 1 },
        cha: { value: 8, proficient: 0, mod: -1 },
      },
      skills: {
        ath: { value: 1, ability: "str" },
        prc: { value: 2, ability: "wis" },
        ins: { value: 0.5, ability: "wis" }, // Jack of All Trades: not a stored code
        arc: { value: 0, ability: "int" },
        itm: { value: 1, ability: "cha" },
      },
      traits: {
        size: "med",
        languages: { value: new Set(["common", "dwarvish"]), custom: "Patois des mines" },
        weaponProf: { value: new Set(["sim", "mar", "longsword"]), custom: "" },
        armorProf: { value: ["lgt", "med", "hvy", "shl"], custom: "" },
      },
      details: { race: "Nain des montagnes", level: 5 },
    },
    itemTypes: {
      class: [{ name: "Guerrier", system: { identifier: "fighter", levels: 5 } }],
      subclass: [{ name: "Champion", system: { classIdentifier: "fighter" } }],
      race: [{ name: "Nain" }],
    },
  };
}

/** The Atlas `dnd5e-compatible` sheet the actor above must convert to. */
const FIGHTER = {
  classes: [{ name: "Guerrier", subClass: "Champion", level: 5 }],
  species: "Nain",
  ca: 18,
  hp: 44,
  size: "med",
  abilities: {
    str: { value: 16, proficient: 1 },
    dex: { value: 12, proficient: 0 },
    con: { value: 15, proficient: 1 },
    int: { value: 10, proficient: 0 },
    wis: { value: 13, proficient: 0 },
    cha: { value: 8, proficient: 0 },
  },
  skills: { ath: 1, prc: 2, itm: 1 },
  senses: { darkvision: 60, blindsight: 0, tremorsense: 0, truesight: 0, special: "" },
  languages: { value: ["common", "dwarvish"], custom: "Patois des mines" },
  weapons: { value: ["sim", "mar"], custom: "" },
  armor: { value: ["lgt", "med", "hvy", "shl"], custom: "" },
};

test("golden: the prepared fighter converts to exactly the expected Atlas sheet, in schema key order", () => {
  const sheet = buildSheet(fighterActor());
  assert.deepEqual(sheet, FIGHTER);
  assert.deepEqual(Object.keys(sheet), Object.keys(FIGHTER));
});

test("dispatch: dnd5e resolves to this converter", () => {
  assert.equal(converterFor("dnd5e"), buildSheet);
});

test("species: the race item wins; without it, details.race as a string, then as an object with a name; else empty", () => {
  const actor = fighterActor();
  assert.equal(buildSheet(actor).species, "Nain");
  actor.itemTypes.race = [];
  assert.equal(buildSheet(actor).species, "Nain des montagnes");
  actor.system.details.race = { name: "Nain des collines" };
  assert.equal(buildSheet(actor).species, "Nain des collines");
  actor.system.details.race = null;
  assert.equal(buildSheet(actor).species, "");
});

test("classes: a class without a matching subclass has an empty subClass; a non-numeric level is 0", () => {
  const actor = fighterActor();
  actor.itemTypes.class.push({ name: "Roublard", system: { identifier: "rogue", levels: "x" } });
  assert.deepEqual(buildSheet(actor).classes, [
    { name: "Guerrier", subClass: "Champion", level: 5 },
    { name: "Roublard", subClass: "", level: 0 },
  ]);
});

test("skills: only full proficiency (1) and expertise (2) are stored; 0 and 0.5 are dropped", () => {
  const { skills } = buildSheet(fighterActor());
  assert.deepEqual(skills, { ath: 1, prc: 2, itm: 1 });
});

test("senses: a system older than 5.3 stores the ranges flat on the bag; both shapes read the same", () => {
  const actor = fighterActor();
  actor.system.attributes.senses = { darkvision: 120, blindsight: 10, tremorsense: 0, truesight: 0, units: "ft", special: "Vision du diable" };
  assert.deepEqual(buildSheet(actor).senses, { darkvision: 120, blindsight: 10, tremorsense: 0, truesight: 0, special: "Vision du diable" });
});

test("code bags: a Set, an array or a { value } wrapper all read; weapons and armor keep the broad categories only", () => {
  const actor = fighterActor();
  actor.system.traits.languages = { value: { value: ["elvish"] }, custom: 7 };
  actor.system.traits.weaponProf = { value: ["mar", "firearms", "sim"], custom: "Arquebuse" };
  actor.system.traits.armorProf = { value: new Set(["shl", "lgt"]) };
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.languages, { value: ["elvish"], custom: "" });
  assert.deepEqual(sheet.weapons, { value: ["mar", "sim"], custom: "Arquebuse" });
  assert.deepEqual(sheet.armor, { value: ["shl", "lgt"], custom: "" });
});

test("an empty actor converts to the schema defaults without throwing", () => {
  const sheet = buildSheet({ system: {}, itemTypes: {} });
  assert.deepEqual(sheet, {
    classes: [],
    species: "",
    ca: 10,
    hp: 0,
    size: "med",
    abilities: {},
    skills: {},
    senses: { darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0, special: "" },
    languages: { value: [], custom: "" },
    weapons: { value: [], custom: "" },
    armor: { value: [], custom: "" },
  });
});
