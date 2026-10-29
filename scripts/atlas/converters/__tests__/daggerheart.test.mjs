// Unit tests for the daggerheart converter. Run from the repository root with:
//   node --test scripts/atlas/converters/__tests__/daggerheart.test.mjs
//
// Pure Node, no Foundry: `buildSheet` only reads the prepared actor's `system` and `itemTypes`, so a
// stub object shaped like the system's prepared character (the class / multiclass getters returning
// `{ value, subclass }` items, `ancestry` and `community` items or null, `experiences` keyed by id,
// `armorScore` / `damageThresholds` / `resources` as the prepared numbers) is the whole fixture. The
// expected output of the first test is the Atlas schema's level-1 example, the same sheet the Atlas
// API validates. The last tests check the support guard for this system, on the real constants.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildSheet, MAX_CARDS, MAX_DOMAINS, MAX_EXPERIENCES, MAX_NAME } from "../daggerheart.js";
import { SUPPORTED_SYSTEMS } from "../../constants.js";
import { systemGuard } from "../../system-guard.js";

const TRAITS = ["agility", "strength", "finesse", "instinct", "presence", "knowledge"];
const DOMAINS = ["arcana", "blade", "bone", "codex", "dread", "grace", "midnight", "sage", "splendor", "valor"];

const item = (name, system = {}) => ({ name, system });
const card = (name, domain, level = 1, extra = {}) => item(name, { domain, level, inVault: false, ...extra });

function traitBlock(values = {}) {
  const out = {};
  for (const code of TRAITS) out[code] = { value: values[code] ?? 0, tierMarked: false };
  return out;
}

function experiences(...entries) {
  // The system stores them in an object keyed by a random id.
  return Object.fromEntries(entries.map(([name, value], i) => [`exp${i}id`, { name, value, description: "", core: i < 2 }]));
}

/** The level-1 example: a sorcerer as a French world holds her, prepared (class base evasion 10 already in). */
function sorcererActor() {
  return {
    name: "Elyra",
    type: "character",
    system: {
      levelData: { level: { current: 1, changed: 1 }, levelups: {} },
      class: {
        value: item("Ensorceleur", { domains: ["arcana", "midnight"], hitPoints: 6, evasion: 10, isMulticlass: false }),
        subclass: item("Origine primordiale", { spellcastingTrait: "instinct", isMulticlass: false }),
      },
      multiclass: { value: undefined, subclass: undefined },
      ancestry: item("Elfe", { loreReference: null }),
      community: item("Originaire du savoir", { loreReference: null }),
      domains: ["arcana", "midnight"],
      traits: traitBlock({ agility: 0, strength: -1, finesse: 1, instinct: 2, presence: 1, knowledge: 0 }),
      evasion: 10,
      // `.value` is the marked slots (live play state), `.max` the Armor Score.
      armorScore: { value: 1, max: 3 },
      damageThresholds: { major: 7, severe: 14 },
      // Marked slots and current Hope are live; the maximums are the sheet data.
      resources: {
        hitPoints: { value: 2, max: 6 },
        stress: { value: 3, max: 6 },
        hope: { value: 2, max: 6 },
      },
      proficiency: 1,
      experiences: experiences(["Mage royal", 2], ["Moi présent, jamais", 2]),
      biography: { background: "<p>Long récit</p>", connections: "<p>Liens</p>", characteristics: { pronouns: "elle" } },
      scars: 0,
      gold: { coins: 3 },
    },
    itemTypes: {
      // Foundry order differs from the sheet order on purpose: midnight first.
      domainCard: [card("Pluie de lames", "midnight", 1, { inVault: true }), card("Déchaîner le chaos", "arcana", 1)],
      weapon: [item("Bâton long")],
      armor: [item("Robe renforcée")],
    },
  };
}

function sorcererSheet() {
  return {
    level: 1,
    class: "Ensorceleur",
    subclass: "Origine primordiale",
    multiclass: "",
    multiclassSubclass: "",
    ancestry: "Elfe",
    community: "Originaire du savoir",
    domains: ["arcana", "midnight"],
    spellcastTrait: "instinct",
    traits: { agility: 0, strength: -1, finesse: 1, instinct: 2, presence: 1, knowledge: 0 },
    evasion: 10,
    armor: 3,
    thresholds: { major: 7, severe: 14 },
    hp: 6,
    stress: 6,
    proficiency: 1,
    experiences: [
      { name: "Mage royal", value: 2 },
      { name: "Moi présent, jamais", value: 2 },
    ],
    cards: [
      { name: "Déchaîner le chaos", domain: "arcana", level: 1 },
      { name: "Pluie de lames", domain: "midnight", level: 1 },
    ],
  };
}

/** A level-6 Guardian multiclassed Warrior: three synced domains, four experiences, nine cards. */
function guardianActor() {
  return {
    type: "character",
    system: {
      levelData: { level: { current: 6, changed: 6 } },
      class: {
        value: item("Guardian", { domains: ["valor", "splendor"], isMulticlass: false }),
        subclass: item("Stalwart", { isMulticlass: false }), // no spellcasting trait
      },
      multiclass: {
        value: item("Warrior", { domains: ["blade", "bone"], isMulticlass: true }),
        subclass: item("Call of the Brave", { spellcastingTrait: null, isMulticlass: true }),
      },
      ancestry: item("Dwarf"),
      community: item("Loreborne"),
      domains: ["valor", "splendor", "blade", "bone"], // class domains, then the multiclass ones
      traits: traitBlock({ agility: 1, strength: 3, finesse: 0, instinct: 1, presence: 2, knowledge: -1 }),
      evasion: 9,
      armorScore: { value: 0, max: 6 },
      damageThresholds: { major: 11, severe: 25 },
      resources: { hitPoints: { value: 0, max: 9 }, stress: { value: 0, max: 7 } },
      proficiency: 3,
      experiences: experiences(["Garde du roi", 3], ["Tavernier", 2], ["Chasseur", 2], ["Veilleur", 2]),
    },
    itemTypes: {
      domainCard: [
        card("Aegis", "valor", 1),
        card("Rampart", "valor", 2),
        card("Bastion", "valor", 5),
        card("Mercy", "splendor", 1),
        card("Dawn", "splendor", 3),
        card("Vow", "splendor", 6, { inVault: true }),
        card("Cut", "blade", 2),
        card("Parry", "blade", 4),
        card("Shatter", "bone", 1),
      ],
    },
  };
}

let warnings;
const originalWarn = console.warn;

beforeEach(() => {
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
});

afterEach(() => {
  console.warn = originalWarn;
  delete globalThis.game;
  delete globalThis.CONFIG;
  delete globalThis.foundry;
});

// ── the schema examples ─────────────────────────────────────────────────────

test("the level-1 example: a prepared sorcerer converts to exactly the expected Atlas sheet", () => {
  const sheet = buildSheet(sorcererActor());
  assert.deepEqual(sheet, sorcererSheet());
  // The stored key set is the schema's allowlist, nothing more (and no `fields` key, see below).
  assert.deepEqual(Object.keys(sheet), Object.keys(sorcererSheet()));
  assert.equal("fields" in sheet, false);
  assert.deepEqual(warnings, []);
});

test("a level-6 Guardian multiclassed Warrior: three domains, no spellcasting, nine cards in domain order", () => {
  const sheet = buildSheet(guardianActor());
  assert.equal(sheet.level, 6);
  assert.deepEqual([sheet.class, sheet.subclass, sheet.multiclass, sheet.multiclassSubclass], ["Guardian", "Stalwart", "Warrior", "Call of the Brave"]);
  assert.deepEqual([sheet.ancestry, sheet.community], ["Dwarf", "Loreborne"]);
  assert.deepEqual(sheet.domains, ["valor", "splendor", "blade"]); // the fourth (bone) is over the cap of three
  assert.equal(sheet.spellcastTrait, "");
  assert.deepEqual(sheet.traits, { agility: 1, strength: 3, finesse: 0, instinct: 1, presence: 2, knowledge: -1 });
  assert.deepEqual([sheet.evasion, sheet.armor, sheet.hp, sheet.stress, sheet.proficiency], [9, 6, 9, 7, 3]);
  assert.deepEqual(sheet.thresholds, { major: 11, severe: 25 });
  assert.equal(sheet.experiences.length, 4);
  // valor, splendor, blade (synced order), then bone (a core domain the character did not sync); level then name inside.
  assert.deepEqual(
    sheet.cards.map((c) => [c.domain, c.level, c.name]),
    [
      ["valor", 1, "Aegis"], ["valor", 2, "Rampart"], ["valor", 5, "Bastion"],
      ["splendor", 1, "Mercy"], ["splendor", 3, "Dawn"], ["splendor", 6, "Vow"],
      ["blade", 2, "Cut"], ["blade", 4, "Parry"],
      ["bone", 1, "Shatter"],
    ],
  );
});

// ── paths: what is read and what is not ─────────────────────────────────────

test("the maximums are read, never the marked or live values (armor, hit points, stress)", () => {
  const actor = sorcererActor();
  actor.system.armorScore = { value: 9, max: 4 };
  actor.system.resources.hitPoints = { value: 12, max: 7 };
  actor.system.resources.stress = { value: 11, max: 5 };
  const sheet = buildSheet(actor);
  assert.equal(sheet.armor, 4);
  assert.equal(sheet.hp, 7);
  assert.equal(sheet.stress, 5);
  // And with no maximum at all the live value is not a fallback: it reads as 0.
  actor.system.armorScore = { value: 9 };
  actor.system.resources.hitPoints = { value: 12 };
  actor.system.resources.stress = { value: 11, max: null };
  const bare = buildSheet(actor);
  assert.deepEqual([bare.armor, bare.hp, bare.stress], [0, 0, 0]);
});

test("the level is levelData.level.current; the pending level-up target (changed) is ignored", () => {
  const actor = sorcererActor();
  actor.system.levelData.level = { current: 3, changed: 4 };
  assert.equal(buildSheet(actor).level, 3);
});

test("play state, narrative, equipment and the Hope maximum never reach the sheet", () => {
  const actor = sorcererActor();
  actor.system.activeBeastform = { name: "Wolf" };
  actor.system.scars = 2;
  actor.system.resources.hope.max = 4;
  const json = JSON.stringify(buildSheet(actor));
  for (const leaked of ["hope", "scars", "gold", "Long récit", "Bâton long", "Robe renforcée", "biography", "Wolf", "tier"]) {
    assert.equal(json.includes(leaked), false, leaked);
  }
});

test("a sync during beastform is not guarded: the prepared (transformed) numbers pass through", () => {
  const actor = sorcererActor();
  actor.system.activeBeastform = { name: "Wolf" };
  actor.system.traits.agility.value = 3; // the beastform effect, already applied by the system
  actor.system.evasion = 12;
  const sheet = buildSheet(actor);
  assert.equal(sheet.traits.agility, 3);
  assert.equal(sheet.evasion, 12);
});

test("the converter reads no world setting and no global config", () => {
  const trap = () => { throw new Error("the converter must not read the world"); };
  globalThis.game = { get settings() { return trap(); }, get system() { return trap(); } };
  globalThis.CONFIG = new Proxy({}, { get: trap });
  assert.deepEqual(buildSheet(sorcererActor()), sorcererSheet());
});

// ── domains, spellcast trait ────────────────────────────────────────────────

test("domains keep the ten core codes only, deduplicated, in the actor's order, at most three", () => {
  const actor = sorcererActor();
  actor.system.domains = ["arcana", "homebrew-void", "arcana", "Midnight", 7, null, "dread", "codex", "valor"];
  assert.deepEqual(buildSheet(actor).domains, ["arcana", "dread", "codex"]);
  assert.equal(MAX_DOMAINS, 3);

  actor.system.domains = DOMAINS; // all ten known: the first three
  assert.deepEqual(buildSheet(actor).domains, ["arcana", "blade", "bone"]);

  actor.system.domains = ["homebrew"]; // a world with only a homebrew domain
  assert.deepEqual(buildSheet(actor).domains, []);
});

test("every one of the ten core domain codes is accepted", () => {
  for (const code of DOMAINS) {
    const actor = sorcererActor();
    actor.system.domains = [code];
    assert.deepEqual(buildSheet(actor).domains, [code], code);
  }
});

test("a multiclass domain that repeats a class domain does not take a second slot", () => {
  const actor = guardianActor();
  actor.system.domains = ["valor", "splendor", "valor", "bone"];
  assert.deepEqual(buildSheet(actor).domains, ["valor", "splendor", "bone"]);
});

test("the spellcast trait is the main subclass's, kept only if it is one of the six trait codes", () => {
  const actor = sorcererActor();
  assert.equal(buildSheet(actor).spellcastTrait, "instinct");
  for (const code of TRAITS) {
    actor.system.class.subclass.system.spellcastingTrait = code;
    assert.equal(buildSheet(actor).spellcastTrait, code);
  }
  for (const bad of [null, undefined, "", "Instinct", "luck", 3, {}]) {
    actor.system.class.subclass.system.spellcastingTrait = bad;
    assert.equal(buildSheet(actor).spellcastTrait, "", String(bad));
  }
  actor.system.class.subclass = undefined; // no subclass item yet
  assert.equal(buildSheet(actor).spellcastTrait, "");
  // The multiclass subclass's trait is not the sheet's spellcast trait.
  const guardian = guardianActor();
  guardian.system.multiclass.subclass.system.spellcastingTrait = "knowledge";
  assert.equal(buildSheet(guardian).spellcastTrait, "");
});

// ── cards ───────────────────────────────────────────────────────────────────

test("a card in a homebrew domain gets an empty domain, and sorts after every known domain", () => {
  const actor = sorcererActor();
  actor.itemTypes.domainCard = [
    card("Souffle noir", "homebrew-umbra", 2),
    card("Eclat", "dread", 1),
    card("Sans domaine", undefined, 1),
    card("Pluie de lames", "midnight", 1),
    card("Déchaîner le chaos", "arcana", 1),
  ];
  assert.deepEqual(
    buildSheet(actor).cards.map((c) => [c.name, c.domain]),
    [["Déchaîner le chaos", "arcana"], ["Pluie de lames", "midnight"], ["Eclat", "dread"], ["Sans domaine", ""], ["Souffle noir", ""]],
  );
});

test("the loadout and the vault are one list: inVault changes nothing", () => {
  const actor = sorcererActor();
  const a = buildSheet(actor);
  for (const c of actor.itemTypes.domainCard) c.system.inVault = !c.system.inVault;
  assert.deepEqual(buildSheet(actor), a);
});

test("cards: empty names dropped, names deduplicated (first kept), cut to 40, level clamped to 1..10", () => {
  const actor = sorcererActor();
  actor.itemTypes.domainCard = [
    card("  ", "arcana", 1),
    card(null, "arcana", 1),
    card("Doublon", "arcana", 2),
    card("Doublon", "arcana", 9),
    card("y".repeat(60), "arcana", 0),
    card("Haute", "arcana", 12),
    card("Fraction", "arcana", 2.9),
    card("Texte", "arcana", "4"),
    card("Absent", "arcana", undefined),
  ];
  const cards = buildSheet(actor).cards;
  const byName = Object.fromEntries(cards.map((c) => [c.name, c]));
  assert.equal(cards.length, 6);
  assert.equal(byName.Doublon.level, 2);
  assert.equal(byName["y".repeat(MAX_NAME)].level, 1); // cut to 40, level 0 -> 1
  assert.equal(byName.Haute.level, 10);
  assert.equal(byName.Fraction.level, 2);
  assert.equal(byName.Texte.level, 4);
  assert.equal(byName.Absent.level, 1);
});

test("cards sort by the character's domains, then level, then name", () => {
  const actor = sorcererActor();
  actor.itemTypes.domainCard = [
    card("Zèbre", "arcana", 2), card("Abeille", "arcana", 2), card("Cygne", "arcana", 1),
    card("Mer", "midnight", 3), card("Lune", "midnight", 1),
    card("Grâce", "grace", 1), card("Blason", "blade", 1),
  ];
  assert.deepEqual(
    buildSheet(actor).cards.map((c) => c.name),
    ["Cygne", "Abeille", "Zèbre", "Lune", "Mer", "Blason", "Grâce"], // blade before grace: the code table's order
  );
});

test("more than 20 cards keep the 20 highest levels, in the sorted order, and warn with the count", () => {
  const actor = sorcererActor();
  // 24 cards: levels 1..4 repeated six times each, spread over the two synced domains.
  actor.itemTypes.domainCard = Array.from({ length: 24 }, (_, i) =>
    card(`C${String(i).padStart(2, "0")}`, i % 2 ? "midnight" : "arcana", (i % 4) + 1));
  const cards = buildSheet(actor).cards;
  assert.equal(cards.length, MAX_CARDS);
  // The four cut cards are among the lowest level (1): level-1 cards number 6, so two of them stay.
  assert.equal(cards.filter((c) => c.level === 1).length, 2);
  assert.equal(cards.filter((c) => c.level >= 2).length, 18);
  // The survivors are still in the sorted order: arcana before midnight, level ascending inside.
  const sorted = [...cards].sort((a, b) =>
    (a.domain === "arcana" ? 0 : 1) - (b.domain === "arcana" ? 0 : 1) || a.level - b.level || a.name.localeCompare(b.name));
  assert.deepEqual(cards, sorted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /24 domain cards/);
});

test("exactly 20 cards are kept whole, without a warning", () => {
  const actor = sorcererActor();
  actor.itemTypes.domainCard = Array.from({ length: 20 }, (_, i) => card(`C${i}`, "arcana", 1));
  assert.equal(buildSheet(actor).cards.length, 20);
  assert.deepEqual(warnings, []);
});

// ── experiences ─────────────────────────────────────────────────────────────

test("experiences: stored order, empty names dropped, names deduplicated, value clamped to -10..10", () => {
  const actor = sorcererActor();
  actor.system.experiences = experiences(
    ["Mage royal", 2], ["  ", 3], ["Mage royal", 5], ["Trop fort", 14], ["Trop faible", -20], ["Décimal", 2.8], ["Texte", "3"], ["Vide", null],
  );
  assert.deepEqual(buildSheet(actor).experiences, [
    { name: "Mage royal", value: 2 },
    { name: "Trop fort", value: 10 },
    { name: "Trop faible", value: -10 },
    { name: "Décimal", value: 2 },
    { name: "Texte", value: 3 },
    { name: "Vide", value: 0 },
  ]);
});

test("more than 8 experiences keep the first 8 (the two core ones first) and warn with the count", () => {
  const actor = sorcererActor();
  actor.system.experiences = experiences(...Array.from({ length: 11 }, (_, i) => [`E${i}`, 1]));
  const list = buildSheet(actor).experiences;
  assert.equal(list.length, MAX_EXPERIENCES);
  assert.deepEqual(list.map((e) => e.name), ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /11 experiences/);
});

test("exactly 8 experiences are kept whole, without a warning; an array form is read too", () => {
  const actor = sorcererActor();
  actor.system.experiences = Array.from({ length: 8 }, (_, i) => ({ name: `E${i}`, value: 1 }));
  assert.equal(buildSheet(actor).experiences.length, 8);
  assert.deepEqual(warnings, []);
});

// ── clamps and text ─────────────────────────────────────────────────────────

test("every number is clamped rather than refused", () => {
  const actor = sorcererActor();
  Object.assign(actor.system, {
    levelData: { level: { current: 14 } },
    traits: traitBlock({ agility: 15, strength: -15, finesse: 10, instinct: -10, presence: 11, knowledge: -11 }),
    evasion: 99,
    armorScore: { max: 55 },
    damageThresholds: { major: 500, severe: -4 },
    resources: { hitPoints: { max: 80 }, stress: { max: 31 } },
    proficiency: 25,
  });
  const sheet = buildSheet(actor);
  assert.equal(sheet.level, 10);
  assert.deepEqual(sheet.traits, { agility: 10, strength: -10, finesse: 10, instinct: -10, presence: 10, knowledge: -10 });
  assert.equal(sheet.evasion, 40);
  assert.equal(sheet.armor, 20);
  assert.deepEqual(sheet.thresholds, { major: 199, severe: 0 });
  assert.equal(sheet.hp, 30);
  assert.equal(sheet.stress, 30);
  assert.equal(sheet.proficiency, 10);

  actor.system.levelData.level.current = 0;
  actor.system.evasion = -3;
  actor.system.proficiency = -2;
  const low = buildSheet(actor);
  assert.equal(low.level, 1);
  assert.equal(low.evasion, 0);
  assert.equal(low.proficiency, 0);
});

test("decimals are truncated, numeric strings read, and junk falls back (level 1, proficiency 1, the rest 0)", () => {
  const actor = sorcererActor();
  Object.assign(actor.system, {
    levelData: { level: { current: "4" } },
    evasion: 10.9,
    armorScore: { max: "3" },
    damageThresholds: { major: 7.5, severe: NaN },
    resources: { hitPoints: { max: Infinity }, stress: { max: "six" } },
    proficiency: "x",
  });
  actor.system.traits = traitBlock({ agility: 1.9, strength: -1.9, finesse: "2", instinct: null, presence: true, knowledge: {} });
  const sheet = buildSheet(actor);
  assert.equal(sheet.level, 4);
  assert.equal(sheet.evasion, 10);
  assert.equal(sheet.armor, 3);
  assert.deepEqual(sheet.thresholds, { major: 7, severe: 0 });
  assert.equal(sheet.hp, 0); // Infinity is not a number the sheet can hold
  assert.equal(sheet.stress, 0);
  assert.equal(sheet.proficiency, 1);
  assert.deepEqual(sheet.traits, { agility: 1, strength: -1, finesse: 2, instinct: 0, presence: 0, knowledge: 0 });
});

test("names are trimmed and cut to 40; a cut after a space is trimmed again; a lone surrogate half is dropped", () => {
  const actor = sorcererActor();
  actor.system.class.value.name = `  ${"x".repeat(60)}`;
  actor.system.class.subclass.name = `${"y".repeat(39)} suite`; // the 40th unit is a space
  actor.system.ancestry.name = `${"z".repeat(39)}\u{1D11E}`; // the cut lands inside the surrogate pair
  actor.system.community.name = "  Communauté  ";
  const sheet = buildSheet(actor);
  assert.equal(sheet.class, "x".repeat(MAX_NAME));
  assert.equal(sheet.subclass, "y".repeat(39));
  assert.equal(sheet.ancestry, "z".repeat(39));
  assert.equal(sheet.community, "Communauté");
  assert.ok(JSON.stringify(sheet).isWellFormed());
});

test("two names that differ only past the cut collapse to one entry", () => {
  const actor = sorcererActor();
  const base = "x".repeat(40);
  actor.itemTypes.domainCard = [card(`${base}A`, "arcana", 2), card(`${base}B`, "arcana", 5)];
  actor.system.experiences = experiences([`${base}A`, 1], [`${base}B`, 2]);
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.cards, [{ name: base, domain: "arcana", level: 2 }]);
  assert.deepEqual(sheet.experiences, [{ name: base, value: 1 }]);
});

// ── empty and missing data ──────────────────────────────────────────────────

test("a fresh actor (no class, no items, the system's no-armor thresholds) converts to a valid, thin sheet", () => {
  const sheet = buildSheet({
    type: "character",
    system: {
      levelData: { level: { current: 1, changed: 1 } },
      class: { value: undefined, subclass: undefined },
      multiclass: { value: undefined, subclass: undefined },
      ancestry: null,
      community: null,
      domains: [],
      traits: traitBlock(),
      evasion: 0,
      armorScore: { value: 0, max: 0 },
      damageThresholds: { major: 1, severe: 2 },
      resources: { hitPoints: { value: 0, max: 0 }, stress: { value: 0, max: 6 }, hope: { value: 2, max: 6 } },
      proficiency: 1,
      experiences: {},
    },
    itemTypes: { domainCard: [] },
  });
  assert.deepEqual(sheet, {
    level: 1,
    class: "", subclass: "", multiclass: "", multiclassSubclass: "", ancestry: "", community: "",
    domains: [],
    spellcastTrait: "",
    traits: { agility: 0, strength: 0, finesse: 0, instinct: 0, presence: 0, knowledge: 0 },
    evasion: 0,
    armor: 0,
    thresholds: { major: 1, severe: 2 },
    hp: 0,
    stress: 6,
    proficiency: 1,
    experiences: [],
    cards: [],
  });
});

test("an actor with no system data at all converts without throwing, to the schema's defaults", () => {
  for (const actor of [{}, { system: {} }, { system: null, itemTypes: null }, undefined]) {
    const sheet = buildSheet(actor);
    assert.equal(sheet.level, 1);
    assert.equal(sheet.proficiency, 1);
    assert.deepEqual(sheet.traits, { agility: 0, strength: 0, finesse: 0, instinct: 0, presence: 0, knowledge: 0 });
    assert.deepEqual(sheet.thresholds, { major: 0, severe: 0 });
    assert.deepEqual([sheet.domains, sheet.experiences, sheet.cards], [[], [], []]);
    assert.equal(sheet.class, "");
    assert.equal(sheet.spellcastTrait, "");
    assert.deepEqual([sheet.evasion, sheet.armor, sheet.hp, sheet.stress], [0, 0, 0, 0]);
  }
});

test("the six trait keys are always present, in the system's order, even when the actor lacks some", () => {
  const actor = sorcererActor();
  actor.system.traits = { finesse: { value: 2 }, unknown: { value: 9 } };
  const { traits } = buildSheet(actor);
  assert.deepEqual(Object.keys(traits), TRAITS);
  assert.deepEqual(traits, { agility: 0, strength: 0, finesse: 2, instinct: 0, presence: 0, knowledge: 0 });
});

// ── the support guard for this system ───────────────────────────────────────

/**
 * A faithful reduction of foundry.utils.isNewerVersion(v1, v0): true when v1 is newer than v0,
 * dotted parts compared numerically, a part v0 lacks making v1 newer.
 */
function isNewerVersion(v1, v0) {
  const a = String(v1).split(".");
  const b = String(v0).split(".");
  for (let i = 0; i < a.length; i++) {
    if (b[i] === undefined) return true;
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

function stubWorld(version) {
  globalThis.game = { system: { id: "daggerheart", version } };
  globalThis.foundry = { utils: { isNewerVersion } };
}

test("the support table pins daggerheart at 2.0.0 and the Atlas slug", () => {
  assert.deepEqual(SUPPORTED_SYSTEMS.daggerheart, { min: "2.0.0", atlasSlug: "daggerheart-compatible" });
});

test("the guard accepts daggerheart 2.0.0 and 2.10.7 with the Atlas slug", () => {
  for (const version of ["2.0.0", "2.10.7"]) {
    stubWorld(version);
    assert.deepEqual(systemGuard(), { ok: true, id: "daggerheart", version, min: "2.0.0", atlasSlug: "daggerheart-compatible" }, version);
  }
});

test("the guard reports daggerheart 1.9.14 (the Foundry V13 maintenance line) as too old", () => {
  stubWorld("1.9.14");
  assert.deepEqual(systemGuard(), { ok: false, reason: "version", id: "daggerheart", version: "1.9.14", min: "2.0.0" });
});
