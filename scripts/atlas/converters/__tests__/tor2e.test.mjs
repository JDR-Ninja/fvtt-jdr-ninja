// Unit tests for the tor2e converter. Run with:
//   node --test scripts/converters/__tests__/tor2e.test.mjs
//
// Pure Node, no Foundry: `buildSheet` only reads the prepared actor's `system` and `itemTypes`, so a
// stub object shaped like `Tor2eCharacterModel` (modules/models/actors/character.model.mjs, tor2e
// 6.0.0+) is the whole fixture. The expected output is the Atlas brief's §3 example, the same sheet
// the Atlas API validates.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSheet } from "../tor2e.js";

const v = (value) => ({ value, type: typeof value === "number" ? "Number" : typeof value === "boolean" ? "Boolean" : "String" });
const skill = (value, favoured = false) => ({ value, type: "Number", favoured: v(favoured), magical: v(false), roll: {} });
const combat = (value) => ({ value, type: "Number", roll: {} });
const item = (name, system = {}) => ({ name, system });
const armour = (name, group, protection, equipped = true) =>
  item(name, { group: v(group), protection: v(protection), equipped: v(equipped) });

/** A Hobbit of the Shire, Treasure Hunter: the brief's §3 example as a prepared actor. */
function hobbitActor() {
  return {
    name: "Meriadoc",
    type: "character",
    system: {
      biography: {
        age: v(33),
        title: v("Maître de Bouc"),
        culture: v("Hobbits de la Comté"),
        calling: v("treasure-hunter"),
        standardOfLiving: v("prosperous"),
        culturalBlessing: v("Bon sens hobbit"),
        shadowPath: v("Mal du Dragon"),
        fellowshipFocus: v("Meriadoc Brandebouc"),
      },
      attributes: { strength: v(3), heart: v(7), wits: v(4) },
      stature: { valour: { value: 1, type: "Number", favoured: v(false) }, wisdom: { value: 2, type: "Number", favoured: v(false) } },
      // `.value` is live state (wounded hero), `.max` the sheet datum.
      resources: { endurance: { value: 12, max: 23 }, hope: { value: 5, max: 19 } },
      combatAttributes: { parry: v(14), armour: { favoured: v(false) } },
      commonSkills: {
        awe: skill(0), athletics: skill(1), awareness: skill(1), hunting: skill(0), song: skill(1), craft: skill(1),
        enhearten: skill(2), travel: skill(0), insight: skill(2), healing: skill(1), courtesy: skill(3, true), battle: skill(0),
        persuade: skill(1), stealth: skill(2, true), scan: skill(1), explore: skill(0), riddle: skill(3), lore: skill(1),
      },
      combatProficiencies: { axes: combat(0), swords: combat(1), spears: combat(0), bows: combat(2) },
      bonuses: { tn: { strength: 2 }, defense: { shieldParry: 1 } },
      skillGroups: { personality: v(3) },
    },
    itemTypes: {
      trait: [
        item("Curieux", { group: v("distinctiveFeature") }),
        item("Rusé", { group: v("distinctiveFeature") }),
        item("Cupide", { group: v("flaw") }),
      ],
      virtues: [item("Art de disparaître"), item("Confiance")],
      reward: [item("Affûté")],
      armour: [
        armour("Bouclier", "shield", 3),
        armour("Corselet de cuir", "leather", 2),
        armour("Heaume", "head", 1, false),
      ],
      weapon: [item("Épée courte")],
    },
  };
}

/** The Atlas sheet the actor above must convert to (brief §3). */
function expectedSheet() {
  return {
    culture: "Hobbits de la Comté",
    calling: "treasure-hunter",
    standardOfLiving: "prosperous",
    culturalBlessing: "Bon sens hobbit",
    shadowPath: "Mal du Dragon",
    fellowshipFocus: "Meriadoc Brandebouc",
    age: 33,
    attributes: { strength: 3, heart: 7, wits: 4 },
    valour: 1,
    wisdom: 2,
    endurance: 23,
    hope: 19,
    parry: 17,
    protection: 2,
    skills: {
      enhearten: [2, 0], persuade: [1, 0], athletics: [1, 0], stealth: [2, 1],
      awareness: [1, 0], insight: [2, 0], scan: [1, 0], healing: [1, 0], song: [1, 0],
      courtesy: [3, 1], riddle: [3, 0], craft: [1, 0], lore: [1, 0],
    },
    combat: { axes: 0, swords: 1, spears: 0, bows: 2 },
    traits: ["Curieux", "Rusé"],
    virtues: ["Art de disparaître", "Confiance"],
    rewards: ["Affûté"],
  };
}

test("the §3 example: a prepared hobbit converts to exactly the expected Atlas sheet", () => {
  const sheet = buildSheet(hobbitActor());
  assert.deepEqual(sheet, expectedSheet());
  // The stored key set is the schema's allowlist, nothing more.
  assert.deepEqual(Object.keys(sheet).sort(), Object.keys(expectedSheet()).sort());
});

test("parry is base + the equipped shield's protection (14 + 3), Active-Effect bonuses ignored", () => {
  const actor = hobbitActor();
  assert.equal(buildSheet(actor).parry, 17);
  actor.itemTypes.armour[0].system.equipped = v(false); // shield carried, not equipped
  assert.equal(buildSheet(actor).parry, 14);
});

test("protection is the first equipped body armour plus the first equipped headgear", () => {
  const actor = hobbitActor();
  assert.equal(buildSheet(actor).protection, 2); // leather 2, helm not equipped
  actor.itemTypes.armour[2].system.equipped = v(true);
  assert.equal(buildSheet(actor).protection, 3);
  actor.itemTypes.armour.push(armour("Haubert", "mail", 4)); // a second body armour: the first wins, like the sheet
  assert.equal(buildSheet(actor).protection, 3);
});

test("endurance and hope read the maximums, never the live values", () => {
  const sheet = buildSheet(hobbitActor());
  assert.equal(sheet.endurance, 23);
  assert.equal(sheet.hope, 19);
});

test("[0, 0] skills are omitted, favoured accepts true or the legacy 1", () => {
  const actor = hobbitActor();
  actor.system.commonSkills.awe = skill(0, true);
  actor.system.commonSkills.hunting.favoured = v(1);
  actor.system.commonSkills.hunting.value = 2;
  const { skills } = buildSheet(actor);
  assert.deepEqual(skills.awe, [0, 1]);
  assert.deepEqual(skills.hunting, [2, 1]);
  assert.equal("travel" in skills, false);
  assert.equal("explore" in skills, false);
  for (const tuple of Object.values(skills)) assert.notDeepEqual(tuple, [0, 0]);
});

test("brawling is never read: the four stored proficiencies only, rank 0 included", () => {
  const actor = hobbitActor();
  actor.system.combatProficiencies.brawling = combat(5);
  assert.deepEqual(buildSheet(actor).combat, { axes: 0, swords: 1, spears: 0, bows: 2 });
});

test("out-of-range numbers are clamped rather than refused", () => {
  const actor = hobbitActor();
  actor.system.attributes.heart = v(14);
  actor.system.stature.valour.value = 9;
  actor.system.resources.hope.max = 250;
  actor.system.combatAttributes.parry = v(60);
  actor.system.commonSkills.riddle.value = 7;
  actor.system.combatProficiencies.bows = combat(-2);
  actor.system.biography.age = v(123456);
  actor.itemTypes.armour = [armour("Grand pavois", "shield", 99), armour("Mithril", "mail", 40)];
  const sheet = buildSheet(actor);
  assert.equal(sheet.attributes.heart, 10);
  assert.equal(sheet.valour, 6);
  assert.equal(sheet.hope, 99);
  assert.equal(sheet.parry, 40);
  assert.deepEqual(sheet.skills.riddle, [6, 0]);
  assert.equal(sheet.combat.bows, 0);
  assert.equal(sheet.age, 99999);
  assert.equal(sheet.protection, 15);
});

test("age 0 is a valid value (the server renders it as unset); a negative or non-numeric age is null", () => {
  const actor = hobbitActor();
  actor.system.biography.age = v(0);
  assert.equal(buildSheet(actor).age, 0);
  actor.system.biography.age = v(0.7); // truncates to 0, still valid
  assert.equal(buildSheet(actor).age, 0);
  actor.system.biography.age = v(-1);
  assert.equal(buildSheet(actor).age, null);
  actor.system.biography.age = v("vieux");
  assert.equal(buildSheet(actor).age, null);
});

test("a cut that lands after a space is trimmed again, and one that splits a surrogate pair drops the lone half", () => {
  const actor = hobbitActor();
  const base = "x".repeat(39);
  actor.system.biography.culture = v(`${"y".repeat(59)} et plus`); // the 60th unit is a space
  actor.itemTypes.virtues = [item(`${base} suite`), item(base), item(`${base}\u{1D11E}`)];
  const sheet = buildSheet(actor);
  assert.equal(sheet.culture, "y".repeat(59));
  assert.deepEqual(sheet.virtues, [base]); // the three cut to the same name: one entry
  assert.ok(JSON.stringify(sheet).isWellFormed());
});

test("a calling or standard of living outside the six codes (an old free-text world) becomes empty", () => {
  const actor = hobbitActor();
  actor.system.biography.calling = v("Tueur");
  actor.system.biography.standardOfLiving = v("Modeste");
  const sheet = buildSheet(actor);
  assert.equal(sheet.calling, "");
  assert.equal(sheet.standardOfLiving, "");
});

test("free text is trimmed and capped at 60, item names at 40, lists deduplicated and capped", () => {
  const actor = hobbitActor();
  actor.system.biography.culture = v("  " + "x".repeat(80));
  actor.itemTypes.trait = [
    item(" Curieux "), item("Curieux"), item("  "), item("y".repeat(50)),
    ...Array.from({ length: 10 }, (_, i) => item(`T${i}`)),
  ].map((t) => ({ ...t, system: { group: v("distinctiveFeature") } }));
  actor.itemTypes.virtues = Array.from({ length: 12 }, (_, i) => item(`V${i}`));
  const sheet = buildSheet(actor);
  assert.equal(sheet.culture.length, 60);
  assert.equal(sheet.traits.length, 6);
  assert.equal(sheet.traits[0], "Curieux");
  assert.equal(sheet.traits[1].length, 40);
  assert.equal(sheet.virtues.length, 8);
});

test("a fresh actor (all zeros, valour and wisdom 1, no items) converts to a valid, nearly empty sheet", () => {
  const sheet = buildSheet({
    system: {
      biography: { age: v(18), culture: v(""), calling: v(""), standardOfLiving: v(""), culturalBlessing: v(""), shadowPath: v(""), fellowshipFocus: v("") },
      attributes: { strength: v(0), heart: v(0), wits: v(0) },
      stature: { valour: { value: 1 }, wisdom: { value: 1 } },
      resources: { endurance: { value: 1, max: 1 }, hope: { value: 1, max: 1 } },
      combatAttributes: { parry: v(0) },
      commonSkills: Object.fromEntries(["awe", "athletics", "awareness", "hunting", "song", "craft", "enhearten", "travel", "insight", "healing", "courtesy", "battle", "persuade", "stealth", "scan", "explore", "riddle", "lore"].map((c) => [c, skill(0)])),
      combatProficiencies: { axes: combat(0), swords: combat(0), spears: combat(0), bows: combat(0) },
    },
    itemTypes: {},
  });
  assert.deepEqual(sheet, {
    culture: "", calling: "", standardOfLiving: "", culturalBlessing: "", shadowPath: "", fellowshipFocus: "",
    age: 18,
    attributes: { strength: 0, heart: 0, wits: 0 },
    valour: 1, wisdom: 1, endurance: 1, hope: 1, parry: 0, protection: 0,
    skills: {},
    combat: { axes: 0, swords: 0, spears: 0, bows: 0 },
    traits: [], virtues: [], rewards: [],
  });
});

test("an actor with no system data at all converts without throwing", () => {
  const sheet = buildSheet({});
  assert.deepEqual(sheet.attributes, { strength: 0, heart: 0, wits: 0 });
  assert.equal(sheet.age, null);
  assert.equal(sheet.valour, 1);
  assert.deepEqual(sheet.skills, {});
  assert.deepEqual(sheet.traits, []);
});
