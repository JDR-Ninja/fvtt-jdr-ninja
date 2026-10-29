// Which actors can sync: the per-system `actorTypes` of SUPPORTED_SYSTEMS, the `isSyncableActor`
// helper, and every sync entry point that asks it (the Actors context menu, the Atlas window's rows,
// its per-row actions and Sync all, and the push/create paths). The shipped systems keep syncing
// `character` actors only; Fallout also syncs its `robot` player characters.
//
// Pure Node, the same stubs as atlas.test.mjs: a stubbed world, a stubbed `fetch`, the real modules.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cancelAtlasRequests } from "../scripts/atlas/api.js";
import { pushActor, createActor } from "../scripts/atlas/sync.js";
import { SUPPORTED_SYSTEMS, STATUS, isSyncableActor, syncableActorTypes } from "../scripts/atlas/constants.js";

class App {
  rendered = false;
  async render() { this.rendered = true; return this; }
  async close() { this.rendered = false; return this; }
  bringToFront() {}
}
class ForcedDeletion {}
globalThis.foundry = { applications: { api: { ApplicationV2: App, HandlebarsApplicationMixin: base => base } },
  data: { operators: { ForcedDeletion } } };
const { AtlasSyncApp } = await import("../scripts/atlas/sync-app.js");
const { atlasContextOptions } = await import("../scripts/atlas/integration.js");

const originalFetch = globalThis.fetch;
let settings, actors, requests, notices;

function reply(data, status = 200) { return new Response(JSON.stringify(data), { status }); }

/** A stub actor of the given type, linked to an Atlas character unless `linked` is false. */
function stubActor(id, type = "character", linked = true) {
  const flags = linked ? { "jdr-ninja": { atlasLink: { atlasCharacterId: `atlas-${id}` } } } : {};
  const item = { id, name: `${type} ${id}`, type, system: {}, itemTypes: {}, img: null, flags,
    getFlag: (scope, key) => flags[scope]?.[key],
    setFlag: async (scope, key, value) => { (flags[scope] ??= {})[key] = value; },
    update: async () => {},
  };
  actors.set(id, item);
  return item;
}

/** An Actors-directory entry as V14's ContextMenu passes it (jQuery: false). */
function directoryEntry(id) { return Object.assign(new HTMLElement(), { dataset: { entryId: id } }); }

/** The Atlas entry, collected the way the directory does it: once, at its first render. */
function contextEntry() {
  const options = [];
  atlasContextOptions(null, options);
  assert.equal(options.length, 1);
  return options[0];
}

/** Switches the stubbed world to another game system. */
function useSystem(id, version) {
  game.system = { id, version, title: id };
}

const FALLOUT = "11.17.1";

beforeEach(() => {
  settings = new Map([["atlasEnabled", true], ["atlasToken", "fixture-atlas-token"],
    ["atlasOrigin", "https://www.jdr.ninja"], ["atlasCampaignId", "campaign"], ["atlasMarkClaimable", false]]);
  actors = new Map(); requests = []; notices = [];
  globalThis.game = {
    user: { isGM: true }, modules: new Map(), system: { id: "dnd5e", version: "5.3.0", title: "D&D 5e" },
    settings: { get: (_module, key) => settings.get(key), set: async (_module, key, value) => settings.set(key, value) },
    actors: { get: id => actors.get(id), filter: fn => [...actors.values()].filter(fn) },
    i18n: { localize: key => key, format: key => key },
  };
  foundry.utils = { isNewerVersion: (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0 };
  globalThis.ui = { notifications: {
    info: message => { notices.push(message); return { update() {} }; }, warn: message => notices.push(message),
  }, actors: { rendered: false } };
  globalThis.HTMLElement = class {};
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return reply({ status: "OK", id: "created", syncedAtUtc: "2026-10-26T12:00:00Z", portrait: "unchanged" });
  };
  AtlasSyncApp.instance = null;
});

afterEach(() => { cancelAtlasRequests(); globalThis.fetch = originalFetch; });

// ── the table and the helper ────────────────────────────────────────────────

test("a system without actorTypes syncs character actors only, and so do the five shipped systems", () => {
  for (const id of ["dnd5e", "tor2e", "pf2e", "sf2e", "wfrp4e"]) {
    assert.equal("actorTypes" in SUPPORTED_SYSTEMS[id], false, id);
    assert.deepEqual(syncableActorTypes(id), ["character"], id);
  }
  for (const [id, entry] of Object.entries(SUPPORTED_SYSTEMS)) {
    if (!("actorTypes" in entry)) assert.deepEqual(syncableActorTypes(id), ["character"], id);
  }
});

test("an entry that declares actorTypes lists non-empty type names, and Fallout adds robot to character", () => {
  for (const [id, entry] of Object.entries(SUPPORTED_SYSTEMS)) {
    if (!("actorTypes" in entry)) continue;
    assert.ok(Array.isArray(entry.actorTypes) && entry.actorTypes.length > 0, id);
    assert.ok(entry.actorTypes.every(type => typeof type === "string" && type !== ""), id);
  }
  assert.deepEqual(syncableActorTypes("fallout"), ["character", "robot"]);
});

test("an unsupported or missing system id falls back to character actors, never throwing", () => {
  assert.deepEqual(syncableActorTypes("swade"), ["character"]);
  assert.deepEqual(syncableActorTypes("constructor"), ["character"]);
  assert.deepEqual(syncableActorTypes("toString"), ["character"]);
  assert.deepEqual(syncableActorTypes(undefined), ["character"]);
  game.system = undefined;
  assert.deepEqual(syncableActorTypes(), ["character"]);
  delete globalThis.game;
  assert.deepEqual(syncableActorTypes(), ["character"]);
  assert.equal(isSyncableActor({ type: "character" }), true);
});

test("isSyncableActor reads the active system: a robot passes under Fallout and is refused under dnd5e", () => {
  const character = { type: "character" }, robot = { type: "robot" }, npc = { type: "npc" };
  for (const other of [npc, { type: "vehicle" }, { type: "creature" }, { type: undefined }, {}, null, undefined]) {
    assert.equal(isSyncableActor(other), false, JSON.stringify(other));
  }
  assert.equal(isSyncableActor(character), true);
  assert.equal(isSyncableActor(robot), false, "a dnd5e world refuses a robot-typed actor");

  useSystem("fallout", FALLOUT);
  assert.equal(isSyncableActor(character), true);
  assert.equal(isSyncableActor(robot), true);
  for (const other of [npc, { type: "creature" }, { type: "vehicle" }, { type: "settlement" }, { type: "scavenging_location" }, null]) {
    assert.equal(isSyncableActor(other), false, JSON.stringify(other));
  }

  // The system can also be named by the caller, whatever the world runs.
  assert.equal(isSyncableActor(robot, "dnd5e"), false);
  assert.equal(isSyncableActor(robot, "fallout"), true);
  useSystem("wfrp4e", "9.6.4");
  assert.equal(isSyncableActor(robot), false);
});

// ── the context menu ────────────────────────────────────────────────────────

test("the context-menu entry shows for a robot under Fallout and not under another system", async () => {
  const character = stubActor("pc"), robot = stubActor("handy", "robot"), npc = stubActor("npc", "npc");
  const entry = contextEntry();
  assert.equal(entry.visible(directoryEntry(character.id)), true);
  assert.equal(entry.visible(directoryEntry(robot.id)), false);

  useSystem("fallout", FALLOUT);
  assert.equal(entry.visible(directoryEntry(character.id)), true);
  assert.equal(entry.visible(directoryEntry(robot.id)), true);
  assert.equal(entry.visible(directoryEntry(npc.id)), false);
});

test("the context-menu action syncs a linked robot under Fallout, with the robot sheet; under dnd5e it does nothing", async () => {
  const robot = stubActor("handy", "robot");
  const entry = contextEntry();

  await entry.onClick({}, directoryEntry(robot.id));
  assert.equal(requests.length, 0, "a dnd5e world ignores the robot");
  assert.deepEqual(notices, []);

  useSystem("fallout", FALLOUT);
  await entry.onClick({}, directoryEntry(robot.id));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://www.jdr.ninja/api/foundry/v1/atlas/characters/atlas-handy");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.systemSlug, "fallout-compatible");
  assert.equal(body.sourceSystemId, "fallout");
  assert.equal(body.rpgData.actorType, "robot");
  assert.deepEqual(notices, ["JDRNINJA.atlas.notify.synced"]);
});

// ── the push and create paths ───────────────────────────────────────────────

test("pushActor and createActor refuse a robot under dnd5e without any request, and accept it under Fallout", async () => {
  const linked = stubActor("linked", "robot"), fresh = stubActor("fresh", "robot", false);
  for (const result of [await pushActor(linked), await createActor(fresh, "campaign", false)]) {
    assert.deepEqual([result.ok, result.status], [false, STATUS.CHARACTER_NOT_FOUND]);
  }
  assert.equal(requests.length, 0);

  useSystem("fallout", FALLOUT);
  const pushed = await pushActor(linked);
  assert.equal(pushed.ok, true);
  const created = await createActor(fresh, "campaign", false);
  assert.equal(created.ok, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const body = JSON.parse(request.options.body);
    assert.equal(body.systemSlug, "fallout-compatible");
    assert.equal(body.rpgData.actorType, "robot");
  }
});

test("a non-player Fallout actor is refused by the push and create paths", async () => {
  useSystem("fallout", FALLOUT);
  const creature = stubActor("beast", "creature"), npc = stubActor("raider", "npc", false);
  assert.equal((await pushActor(creature)).status, STATUS.CHARACTER_NOT_FOUND);
  assert.equal((await createActor(npc, "campaign", false)).status, STATUS.CHARACTER_NOT_FOUND);
  assert.equal(requests.length, 0);
});

// ── the Atlas window ────────────────────────────────────────────────────────

test("the window lists a Fallout robot beside the characters, and only the characters elsewhere", async () => {
  stubActor("pc"); stubActor("handy", "robot"); stubActor("raider", "npc"); stubActor("beast", "creature");
  const app = new AtlasSyncApp();
  app._data = { loading: false, error: null, campaigns: [], whoami: { world: { name: "World" }, tier: { allowed: true } } };

  assert.deepEqual((await app._prepareContext()).rows.map(row => row.actorId), ["pc"]);
  useSystem("fallout", FALLOUT);
  assert.deepEqual((await app._prepareContext()).rows.map(row => row.actorId), ["pc", "handy"]);
});

test("the window's row actions find a robot only under Fallout", () => {
  const robot = stubActor("handy", "robot");
  const app = new AtlasSyncApp();
  const target = { closest: () => ({ dataset: { actorId: robot.id } }) };
  assert.equal(app._actorFromTarget(target), null);
  useSystem("fallout", FALLOUT);
  assert.equal(app._actorFromTarget(target), robot);
  assert.equal(app._actorFromTarget({ closest: () => ({ dataset: { actorId: stubActor("beast", "creature").id } }) }), null);
});

test("Sync all pushes the linked robots of a Fallout world and skips them elsewhere", async () => {
  stubActor("pc"); stubActor("handy", "robot"); stubActor("free", "robot", false); stubActor("raider", "npc");

  let app = new AtlasSyncApp();
  app.rendered = true;
  await app._onSyncAll();
  assert.deepEqual(requests.map(request => request.url), ["https://www.jdr.ninja/api/foundry/v1/atlas/characters/atlas-pc"]);

  requests = []; notices = [];
  useSystem("fallout", FALLOUT);
  app = new AtlasSyncApp();
  app.rendered = true;
  await app._onSyncAll();
  assert.deepEqual(requests.map(request => request.url).sort(), [
    "https://www.jdr.ninja/api/foundry/v1/atlas/characters/atlas-handy",
    "https://www.jdr.ninja/api/foundry/v1/atlas/characters/atlas-pc",
  ]);
  const types = requests.map(request => JSON.parse(request.options.body).rpgData.actorType).sort();
  assert.deepEqual(types, ["character", "robot"]);
});
