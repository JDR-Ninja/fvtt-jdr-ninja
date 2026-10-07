// Unit tests for the wfrp4e converter. Run from foundry/jdr-ninja-atlas-sync with:
//   node --test scripts/converters/__tests__/wfrp4e.test.mjs
//
// Pure Node: a stub PREPARED actor (the shapes the converter reads, nothing else) and a stub
// `globalThis.game.wfrp4e.config` standing in for the world's runtime config (species and
// subspecies labels; the size and tier tables are there too, but the converter never reads them:
// its code sets are the server's fixed ones). No Foundry, no warhammer-lib.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildSheet, MAX_SKILLS, MAX_TALENTS, MAX_TEXT } from "../wfrp4e.js";

const CODES = ["ws", "bs", "s", "t", "i", "ag", "dex", "int", "wp", "fel"];

function stubConfig() {
  return {
    species: { human: "Humain", dwarf: "Nain" },
    subspecies: { human: { reiklander: { name: "Reiklander" }, nordlander: { name: "Nordlander" } } },
    actorSizes: { tiny: "SPEC.Tiny", ltl: "SPEC.Little", sml: "SPEC.Small", avg: "SPEC.Average", lrg: "SPEC.Large", enor: "SPEC.Enormous", mnst: "SPEC.Monstrous" },
    statusTiers: { g: "TIER.Gold", s: "TIER.Silver", b: "TIER.Brass" },
  };
}

function characteristics(values = {}) {
  const out = {};
  for (const code of CODES) out[code] = { value: values[code] ?? 30 };
  return out;
}

function skill(name, char, adv, { advanced = "bsc", grouped = "noSpec" } = {}) {
  return { name, system: { advances: { value: adv }, characteristic: { value: char }, advanced: { value: advanced }, grouped: { value: grouped } } };
}

function talent(name, adv = 1) {
  return { name, system: { advances: { value: adv } } };
}

function career(name, { current = true, level = 2, cls = "Guerriers", group = "Soldat" } = {}) {
  return { name, system: { current: { value: current }, level: { value: level }, class: { value: cls }, careergroup: { value: group } } };
}

/** A prepared Soldier, species stored as config keys, status computed by the system. */
function stubActor(overrides = {}) {
  return {
    type: "character",
    system: {
      details: {
        species: { value: "human", subspecies: "reiklander" },
        status: { tier: "s", standing: 1 },
        size: { value: "avg" },
        move: { value: 4 },
      },
      characteristics: characteristics({ ws: 45, bs: 33, s: 40, t: 41, i: 35, ag: 32, dex: 30, int: 28, wp: 36, fel: 31 }),
      status: { wounds: { max: 15, value: 9 }, fate: { value: 2 }, resilience: { value: 1 }, fortune: { value: 2 } },
    },
    itemTypes: {
      career: [career("Recrue", { current: false, level: 1 }), career("Soldat")],
      skill: [
        skill("Esquive", "ag", 10),
        skill("Corps à corps (Base)", "ws", 15),
        skill("Athlétisme", "ag", 10),
        skill("Corps à corps (Armes d'hast)", "ws", 8, { grouped: "isSpec" }),
        skill("Langue (Bretonnien)", "int", 3, { advanced: "adv", grouped: "isSpec" }),
        skill("Calme", "wp", 0),
        skill("Perception", "i", 0),
      ],
      talent: [talent("Robuste"), talent("Chanceux"), talent("Robuste")],
    },
    ...overrides,
  };
}

let warnings;
const originalWarn = console.warn;

beforeEach(() => {
  globalThis.game = { wfrp4e: { config: stubConfig() } };
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
});

afterEach(() => {
  delete globalThis.game;
  console.warn = originalWarn;
});

// ── identity, career, status ────────────────────────────────────────────────

test("species keys resolve to their config labels, subspecies through the nested table", () => {
  const sheet = buildSheet(stubActor());
  assert.equal(sheet.species, "Humain");
  assert.equal(sheet.subspecies, "Reiklander");
});

test("free-text species and subspecies (not in the config) pass through verbatim, trimmed and cut to 60", () => {
  const actor = stubActor();
  actor.system.details.species = { value: "  Ogre de Nuln ", subspecies: "x".repeat(80) };
  const sheet = buildSheet(actor);
  assert.equal(sheet.species, "Ogre de Nuln");
  assert.equal(sheet.subspecies, "x".repeat(MAX_TEXT));
});

test("a world without game.wfrp4e.config still converts (free system: empty tables)", () => {
  delete globalThis.game;
  const sheet = buildSheet(stubActor());
  assert.equal(sheet.species, "human"); // the key, since nothing can resolve it
  assert.equal(sheet.subspecies, "reiklander");
  assert.deepEqual(sheet.status, { tier: "s", standing: 1 }); // fallback tier set
  assert.equal(sheet.size, "avg");
});

test("the current career gives class, career group, the level title as career, and the level", () => {
  const sheet = buildSheet(stubActor());
  assert.equal(sheet.class, "Guerriers");
  assert.equal(sheet.careerGroup, "Soldat");
  assert.equal(sheet.career, "Soldat");
  assert.equal(sheet.careerLevel, 2);
});

test("no current career → empty career strings, null level, and a non-tier status becomes null", () => {
  const actor = stubActor();
  actor.itemTypes.career = [career("Recrue", { current: false })];
  actor.system.details.status = { tier: 0, standing: "" }; // the schema defaults of a never-careered actor
  const sheet = buildSheet(actor);
  assert.equal(sheet.class, "");
  assert.equal(sheet.careerGroup, "");
  assert.equal(sheet.career, "");
  assert.equal(sheet.careerLevel, null);
  assert.equal(sheet.status, null);
});

test("career level is clamped to 1..5, status standing to 0..9, unknown tier → null", () => {
  const actor = stubActor();
  actor.itemTypes.career = [career("Chef de guerre", { level: 9 })];
  actor.system.details.status = { tier: "g", standing: 14 };
  let sheet = buildSheet(actor);
  assert.equal(sheet.careerLevel, 5);
  assert.deepEqual(sheet.status, { tier: "g", standing: 9 });

  actor.system.details.status = { tier: "platinum", standing: 2 };
  sheet = buildSheet(actor);
  assert.equal(sheet.status, null);
});

test("size must be one of the seven server codes, else avg; move / wounds / fate / resilience are clamped", () => {
  const actor = stubActor();
  actor.system.details.size = { value: "lrg" };
  actor.system.details.move = { value: 30 };
  actor.system.status = { wounds: { max: 900 }, fate: { value: -2 }, resilience: { value: "3" } };
  let sheet = buildSheet(actor);
  assert.equal(sheet.size, "lrg");
  assert.equal(sheet.move, 20);
  assert.equal(sheet.wounds, 500);
  assert.equal(sheet.fate, 0);
  assert.equal(sheet.resilience, 3);

  actor.system.details.size = { value: "huge" };
  sheet = buildSheet(actor);
  assert.equal(sheet.size, "avg");
});

test("the size and tier code sets are the server's fixed ones, whatever the world's config tables say", () => {
  // A module extending the tables: the extra keys are not codes the server accepts.
  globalThis.game.wfrp4e.config.actorSizes.colossal = "SPEC.Colossal";
  globalThis.game.wfrp4e.config.statusTiers.p = "TIER.Platinum";
  const actor = stubActor();
  actor.system.details.size = { value: "colossal" };
  actor.system.details.status = { tier: "p", standing: 2 };
  let sheet = buildSheet(actor);
  assert.equal(sheet.size, "avg");
  assert.equal(sheet.status, null);

  // Empty tables (the free system without the core module): the real codes still pass through.
  globalThis.game.wfrp4e.config.actorSizes = {};
  globalThis.game.wfrp4e.config.statusTiers = {};
  actor.system.details.size = { value: "mnst" };
  actor.system.details.status = { tier: "b", standing: 0 };
  sheet = buildSheet(actor);
  assert.equal(sheet.size, "mnst");
  assert.deepEqual(sheet.status, { tier: "b", standing: 0 });
});

// ── characteristics ─────────────────────────────────────────────────────────

test("the ten characteristics are emitted as { value }, clamped 0..100, missing ones as 0", () => {
  const actor = stubActor();
  actor.system.characteristics = { ws: { value: 145 }, bs: { value: "33" }, s: { value: -5 } };
  const sheet = buildSheet(actor);
  assert.deepEqual(Object.keys(sheet.characteristics), CODES);
  assert.deepEqual(sheet.characteristics.ws, { value: 100 });
  assert.deepEqual(sheet.characteristics.bs, { value: 33 });
  assert.deepEqual(sheet.characteristics.s, { value: 0 });
  assert.deepEqual(sheet.characteristics.fel, { value: 0 });
});

// ── skills ──────────────────────────────────────────────────────────────────

test("skills: untrained items are dropped, basic (bsc + noSpec) come first by name, then advanced/grouped by name", () => {
  const sheet = buildSheet(stubActor());
  assert.deepEqual(sheet.skills.map((s) => s.name), [
    "Athlétisme",
    "Corps à corps (Base)",
    "Esquive",
    "Corps à corps (Armes d'hast)",
    "Langue (Bretonnien)",
  ]);
  assert.deepEqual(sheet.skills[1], { name: "Corps à corps (Base)", char: "ws", adv: 15 });
});

test("skills: same-name items merge by summing advances; an unknown characteristic drops the entry", () => {
  const actor = stubActor();
  actor.itemTypes.skill = [
    skill("Esquive", "ag", 5),
    skill("esquive ", "ag", 7),
    skill("Bizarre", "con", 4),
    skill("", "ws", 4),
  ];
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.skills, [{ name: "Esquive", char: "ag", adv: 12 }]);
});

test("skills: 45 trained skills → the 40 with the most advances are kept, in order, with a warning", () => {
  const actor = stubActor();
  actor.itemTypes.skill = [];
  for (let i = 0; i < 45; i++) {
    // advances 1..45; the five lowest (1..5) must go
    actor.itemTypes.skill.push(skill(`Savoir (Région ${String(i).padStart(2, "0")})`, "int", i + 1, { advanced: "adv", grouped: "isSpec" }));
  }
  const sheet = buildSheet(actor);
  assert.equal(sheet.skills.length, MAX_SKILLS);
  assert.ok(sheet.skills.every((s) => s.adv >= 6));
  // Original (by-name) order preserved among the survivors.
  const names = sheet.skills.map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /45 skills, keeping the 40/);
});

test("skills: advances are clamped to 100 and names cut to 60", () => {
  const actor = stubActor();
  actor.itemTypes.skill = [skill("A".repeat(70), "ws", 150)];
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.skills, [{ name: "A".repeat(MAX_TEXT), char: "ws", adv: 100 }]);
});

test("fractional advances (the sheet input accepts decimals) are truncated per item before the merge: skill 2.5 → 2, talent 1.5 → 1", () => {
  const actor = stubActor();
  actor.itemTypes.skill = [
    skill("Esquive", "ag", 2.5),
    skill("Esquive", "ag", 1.9), // 2 + 1, never 2.5 + 1.9 = 4.4 → 4
    skill("Calme", "wp", 0.9), // truncates to 0: untrained, dropped like a 0
    skill("Perception", "i", "7.75"),
  ];
  actor.itemTypes.talent = [talent("Robuste", 1.5), talent("Robuste", 1.5), talent("Chanceux", 0.4)];
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.skills, [
    { name: "Esquive", char: "ag", adv: 3 },
    { name: "Perception", char: "i", adv: 7 },
  ]);
  // A talent is taken at least once: 0.4 truncates to 0 and counts as 1, like a blank.
  assert.deepEqual(sheet.talents, [{ name: "Robuste", adv: 2 }, { name: "Chanceux", adv: 1 }]);
  for (const entry of [...sheet.skills, ...sheet.talents]) assert.ok(Number.isInteger(entry.adv), `${entry.name}: ${entry.adv}`);
});

test("a cut that lands after a space is trimmed again, so two names the server would trim to the same string merge instead of colliding", () => {
  const actor = stubActor();
  const base = "A".repeat(59);
  actor.itemTypes.skill = [
    skill(`${base} B`, "ws", 4), // 61 units: the cut keeps "A…A " and the server trims it to "A…A"
    skill(base, "ws", 6),
  ];
  actor.itemTypes.talent = [talent(`${base} C`), talent(base)];
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.skills, [{ name: base, char: "ws", adv: 10 }]);
  assert.deepEqual(sheet.talents, [{ name: base, adv: 2 }]);
});

test("API name uniqueness ignores case: the dotless ı and the long ſ fold to I and S", () => {
  const actor = stubActor();
  actor.itemTypes.skill = [skill("Esquıve", "ag", 5), skill("ESQUIVE", "ag", 7), skill("ſavoir", "int", 2), skill("Savoir", "int", 3)];
  actor.itemTypes.talent = [talent("Robuſte"), talent("ROBUSTE")];
  const sheet = buildSheet(actor);
  assert.deepEqual(sheet.skills, [{ name: "Esquıve", char: "ag", adv: 12 }, { name: "ſavoir", char: "int", adv: 5 }]);
  assert.deepEqual(sheet.talents, [{ name: "Robuſte", adv: 2 }]);
});

test("a cut that splits a surrogate pair drops the lone high surrogate, so the JSON stays well-formed", () => {
  const actor = stubActor();
  const base = "A".repeat(59);
  actor.itemTypes.skill = [skill(`${base}\u{1D11E}`, "ws", 4)]; // 59 + 2 units: the cut would keep only the high half
  actor.itemTypes.talent = [talent(`${base}\u{1D11E}`)];
  actor.system.details.species = { value: `${base}\u{1D11E}`, subspecies: "" };
  const sheet = buildSheet(actor);
  assert.equal(sheet.skills[0].name, base);
  assert.equal(sheet.talents[0].name, base);
  assert.equal(sheet.species, base);
  assert.ok(JSON.stringify(sheet).isWellFormed());
});

// ── talents ─────────────────────────────────────────────────────────────────

test("talents: duplicates are summed (the sheet's Advances getter), order of first appearance", () => {
  const sheet = buildSheet(stubActor());
  assert.deepEqual(sheet.talents, [{ name: "Robuste", adv: 2 }, { name: "Chanceux", adv: 1 }]);
});

test("talents: 35 talents → the 30 with the most advances are kept, with a warning; advances clamped to 20", () => {
  const actor = stubActor();
  actor.itemTypes.talent = [];
  for (let i = 0; i < 35; i++) actor.itemTypes.talent.push(talent(`Talent ${String(i).padStart(2, "0")}`, i === 0 ? 40 : i));
  const sheet = buildSheet(actor);
  assert.equal(sheet.talents.length, MAX_TALENTS);
  assert.equal(sheet.talents[0].name, "Talent 00");
  assert.equal(sheet.talents[0].adv, 20);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /35 talents, keeping the 30/);
});

// ── shape ───────────────────────────────────────────────────────────────────

test("the sheet has exactly the schema keys, in the schema order, and no live state", () => {
  const sheet = buildSheet(stubActor());
  assert.deepEqual(Object.keys(sheet), [
    "species", "subspecies", "class", "careerGroup", "career", "careerLevel", "status", "size", "move",
    "characteristics", "wounds", "fate", "resilience", "skills", "talents",
  ]);
  assert.equal(sheet.wounds, 15); // max, never the current value
  assert.equal("fortune" in sheet, false);
});

test("an empty actor converts to a valid-shaped default sheet", () => {
  const sheet = buildSheet({ system: {}, itemTypes: {} });
  assert.equal(sheet.species, "");
  assert.equal(sheet.careerLevel, null);
  assert.equal(sheet.status, null);
  assert.equal(sheet.size, "avg");
  assert.deepEqual(sheet.characteristics.ws, { value: 0 });
  assert.deepEqual(sheet.skills, []);
  assert.deepEqual(sheet.talents, []);
});

// ── the brief's §3 sheet ────────────────────────────────────────────────────
// The realistic French Soldier of the WFRP4e implementation brief (§3; the same sheet the server
// tests keep as `RpgSystemWfrp4eModuleTests.RealisticSheet`), as a prepared actor. Skill items
// are listed here in a scrambled order on purpose: the converter, like the Foundry sheet, emits
// the basic block then the advanced / grouped block, each by name.

const SOLDIER_BASIC_SKILLS = [
  ["Art", "dex", 3], ["Athlétisme", "ag", 10], ["Calme", "wp", 8], ["Charme", "fel", 5],
  ["Charme animal", "wp", 3], ["Commandement", "fel", 5], ["Conduite", "ag", 3], ["Corps à corps (Base)", "ws", 15],
  ["Corruption", "fel", 3], ["Discrétion (Rurale)", "ag", 3], ["Divertissement", "fel", 3], ["Endurance", "t", 10],
  ["Équitation", "ag", 3], ["Escalade", "s", 5], ["Esquive", "ag", 10], ["Intimidation", "s", 8],
  ["Intuition", "i", 5], ["Jeu", "int", 3], ["Marchandage", "fel", 3], ["Navigation", "i", 3],
  ["Perception", "i", 8], ["Projectiles (Arc)", "bs", 5], ["Ragot", "fel", 5], ["Ramer", "s", 3],
  ["Résistance à l'alcool", "t", 5], ["Survie en extérieur", "int", 5],
];

// §3 lists these six in the order they were taken; by name they come out as below.
const SOLDIER_ADVANCED_SKILLS = [
  ["Corps à corps (Armes d'hast)", "ws", 8], ["Langue (Bretonnien)", "int", 3], ["Lire/Écrire", "int", 3],
  ["Métier (Armurier)", "dex", 5], ["Savoir (Reikland)", "int", 3], ["Soins", "int", 5],
];

const SOLDIER_TALENTS = [
  ["Chanceux", 1], ["Destinée", 1], ["Guerrier né", 1], ["Frappe puissante", 1], ["Costaud", 1], ["Robuste", 2],
  ["Lecture/Écriture", 1], ["Sens aiguisé (Vue)", 1], ["Combat de rue", 1], ["Coriace", 1], ["Vaillant", 1], ["Sang-froid", 1],
];

function soldierActor() {
  const basic = SOLDIER_BASIC_SKILLS.map(([name, char, adv]) => skill(name, char, adv));
  const advanced = SOLDIER_ADVANCED_SKILLS.map(([name, char, adv]) => skill(name, char, adv, { advanced: "adv", grouped: "isSpec" }));
  const items = [...basic, ...advanced];
  // Deterministic scramble (reverse, then interleave halves): the output order must not depend on it.
  const scrambled = [];
  const reversed = items.slice().reverse();
  const half = Math.ceil(reversed.length / 2);
  for (let i = 0; i < half; i++) {
    scrambled.push(reversed[i]);
    if (reversed[half + i]) scrambled.push(reversed[half + i]);
  }
  // « Robuste » ×2 arrives as two items, as when the talent is taken again at a career step.
  const talents = SOLDIER_TALENTS.flatMap(([name, adv]) => Array.from({ length: adv }, () => talent(name, 1)));
  return {
    type: "character",
    system: {
      details: {
        species: { value: "human", subspecies: "reiklander" },
        status: { tier: "s", standing: 1 },
        size: { value: "avg" },
        move: { value: 4 },
      },
      characteristics: characteristics({ ws: 45, bs: 33, s: 40, t: 41, i: 35, ag: 32, dex: 30, int: 28, wp: 36, fel: 31 }),
      status: { wounds: { max: 15, value: 11 }, fate: { value: 2 }, resilience: { value: 1 }, fortune: { value: 1 }, resolve: { value: 1 } },
    },
    itemTypes: {
      career: [career("Recrue", { current: false, level: 1 }), career("Soldat", { level: 2, cls: "Guerriers", group: "Soldat" })],
      skill: scrambled,
      talent: talents,
    },
  };
}

function soldierSheet() {
  const characteristicsOut = {};
  for (const [code, value] of Object.entries({ ws: 45, bs: 33, s: 40, t: 41, i: 35, ag: 32, dex: 30, int: 28, wp: 36, fel: 31 })) {
    characteristicsOut[code] = { value };
  }
  return {
    species: "Humain",
    subspecies: "Reiklander",
    class: "Guerriers",
    careerGroup: "Soldat",
    career: "Soldat",
    careerLevel: 2,
    status: { tier: "s", standing: 1 },
    size: "avg",
    move: 4,
    characteristics: characteristicsOut,
    wounds: 15,
    fate: 2,
    resilience: 1,
    skills: [...SOLDIER_BASIC_SKILLS, ...SOLDIER_ADVANCED_SKILLS].map(([name, char, adv]) => ({ name, char, adv })),
    talents: SOLDIER_TALENTS.map(([name, adv]) => ({ name, adv })),
  };
}

test("the brief's §3 Soldier: the prepared actor converts to exactly the expected Atlas sheet (32 skills, 12 talents)", () => {
  const sheet = buildSheet(soldierActor());
  assert.deepEqual(sheet, soldierSheet());
  assert.equal(sheet.skills.length, 32);
  assert.equal(sheet.talents.length, 12);
  assert.deepEqual(warnings, []); // under both caps: nothing dropped
});
