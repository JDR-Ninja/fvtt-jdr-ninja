import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { requestJson } from "../scripts/auth/http.js";
import { pairDevice } from "../scripts/auth/device-flow.js";
import { CreatureClient } from "../scripts/creatures/api.js";
import { catalog, optionErrors, capabilities, selectedSource, generation } from "../scripts/creatures/contract.js";
import { buildActor } from "../scripts/creatures/generated/dnd-foundry/export.mjs";
import { MAPPER_VERSION } from "../scripts/creatures/generated/dnd-foundry/version.mjs";
import { actorId, importCreature } from "../scripts/creatures/import.js";
import { gameFixture, capabilityFixture, catalogFixture, sourceFixture, resultFixture, requestId, identity } from "./creatures-fixture.mjs";
const websiteOutputs = JSON.parse(await readFile(new URL("./fixtures/creatures-native.json", import.meta.url), "utf8"));

test("all five API routes send the fixed header, generation has no retrieval mode, legacy endpoints remain independent", async () => {
  for (const path of ["/capabilities", "/generators/dnd/monsters/options", "/generators/dnd/npcs/options", "/generators/dnd/monsters/generate", "/generators/dnd/npcs/generate"]) {
    let headers;
    await requestJson({ origin: "https://www.jdr.ninja", path: `/api/foundry/v1${path}`,
      fetchImpl: async (_url, options) => { headers = options.headers; return new Response('{}'); } });
    assert.equal(headers["X-Jdr-Ninja-Client"], "foundry-module");
    assert.equal(headers["Idempotency-Replay-Only"], undefined);
  }
  let headers;
  await requestJson({ origin: "https://www.jdr.ninja", path: "/api/vtt-overlay/device/authorize",
    fetchImpl: async (_url, options) => { headers = options.headers; return new Response('{}'); } });
  assert(!headers["X-Jdr-Ninja-Client"]); assert(!headers["Idempotency-Replay-Only"]);
});
test("decompressed response limit rejects oversized and malformed streamed JSON", async () => {
  for (const body of ['{"text":"' + "a".repeat(200) + '"}', '{"bad":']) {
    const response = await requestJson({ origin: "https://www.jdr.ninja", path: "/api/foundry/v1/capabilities", maxResponseBytes: 100,
      fetchImpl: async () => new Response(body) });
    assert.equal(response.reason, "invalidResponse");
  }
});
test("creature pairing requests the explicit additional permission, regular pairing does not", async () => {
  let body;
  await pairDevice({ origin: "https://www.jdr.ninja", requestedCapabilities: ["dnd-creatures"], request: async options => {
    body = options.body; return { ok: false, reason: "server" };
  } });
  assert.deepEqual(body.requestedCapabilities, ["dnd-creatures"]);
});
test("capability validation distinguishes device approval from subscription, rejects inconsistent access", () => {
  for (const [grant, paid] of [[false, false], [false, true], [true, false], [true, true]]) assert(capabilities(capabilityFixture(grant, paid)));
  const malformed = capabilityFixture(false, true); malformed.features.dndCreatures.allowed = true;
  assert.throws(() => capabilities(malformed));
});
test("authoritative monster matrix preserves fractional CR and rejects unsupported legendary combinations", () => {
  const data = catalog(catalogFixture(), "monster");
  assert.deepEqual(optionErrors(data, data.defaults, "monster"), []);
  assert(optionErrors(data, { ...data.defaults, combatProfile: "legendaryLair" }, "monster").includes("challengeRating"));
  assert.deepEqual(optionErrors(data, { ...data.defaults, challengeRating: "15", combatProfile: "legendaryLair" }, "monster"), []);
  assert.deepEqual(optionErrors(data, { ...data.defaults, challengeRating: "quart" }, "monster"), ["challengeRating"]);
});
test("NPC random/preset/variant/role validation keeps an explicit requested CR", () => {
  const data = catalog(catalogFixture("npc"), "npc"), options = { ...data.defaults, challengeRating: "15" };
  assert.deepEqual(optionErrors(data, options, "npc"), []);
  assert(optionErrors(data, { ...options, variantId: "defender" }, "npc").includes("variantId"));
  assert.deepEqual(optionErrors(data, { ...options, presetId: "guard", variantId: "defender", role: "defense" }, "npc"), []);
  assert(optionErrors(data, { ...options, role: "support" }, "npc").includes("role"));
  assert.equal(options.challengeRating, "15");
});
test("selected-source validation and packaged mapping preserve website native output and shared pools", () => {
  assert.equal(websiteOutputs.mapperVersion, MAPPER_VERSION, "Refresh canonical fixtures when updating the mapper");
  for (const kind of ["monster", "npc"]) {
    const source = selectedSource(sourceFixture(kind), identity);
    assert.deepEqual(buildActor(source), websiteOutputs.actors[kind]);
    const actor = buildActor(source);
    const owner = actor.items.find(item => item.name === "venom1"), consumer = actor.items.find(item => item.name === "venom2");
    assert.equal(Object.values(consumer.system.activities)[0].consumption.targets[0].target, owner._id);
    assert.equal(actor.ownership.default, 0); assert.equal(actor.system.details.biography.public, "");
  }
});
test("selected-source rejects arbitrary native fields, unsafe attribution, dangling and duplicate records", () => {
  const mutations = [s => { s.flags = {}; }, s => { s.sourceUrl = "javascript:alert(1)"; },
    s => { s.records.push({ ...s.records[0] }); }, s => { s.records[0].system = {}; },
    s => { s.records.find(row => row.type === "damage")["owner-id"] = "missing"; },
    s => { s.records.find(row => row.id === "venom2")["resource-id"] = "missing"; },
    s => { delete s.entries.blade; }, s => { s.records[0].hp = "NaN"; },
    s => { s.biography = "a".repeat(262145); }];
  for (const mutate of mutations) { const source = sourceFixture(); mutate(source); assert.throws(() => selectedSource(source, identity)); }
});
test("generation must match the submitted request, selected language and pinned target", () => {
  const data = catalogFixture(), body = { requestId, catalogVersion: data.catalogVersion, options: data.defaults };
  assert(generation(resultFixture(body), body, "monster", identity));
  for (const mutate of [r => { r.requestId = "other"; }, r => { r.target = { ...r.target, systemVersion: "6.0.0" }; },
    r => { r.source.language = "en"; }, r => { r.requestedOptions.units = "metric"; }, r => { r.source.records[0].cr = "1"; }]) {
    const result = resultFixture(body); mutate(result); assert.throws(() => generation(result, body, "monster", identity));
  }
});
test("client never uses overlay entitlement and fails closed for permission/subscription denial", async () => {
  for (const [grant, paid, code] of [[false, true, "devicePermissionRequired"], [true, false, "tierRequired"]]) {
    const current = gameFixture(), calls = [];
    const client = new CreatureClient({ getGame: () => current, request: async options => { calls.push(options.path); return { ok: true, data: capabilityFixture(grant, paid) }; } });
    await assert.rejects(client.check(), error => error.code === code);
    assert.deepEqual(calls, ["/api/foundry/v1/capabilities"]);
    assert.equal(client.access.entitled, paid);
    assert.equal(client.needsSubscription(), !paid);
  }
});
test("local guards reject disabled, player and untested targets before HTTP", async () => {
  for (const mutate of [g => { g.values.creaturesEnabled = false; }, g => { g.user.isGM = false; }, g => { g.system.version = "6.0.0"; },
    g => { g.system.id = "pf2e"; g.system.title = "D&D5e"; }, g => { g.release.generation = 15; }]) {
    const current = gameFixture(); mutate(current);
    const client = new CreatureClient({ getGame: () => current, request: async () => { assert.fail("HTTP must not run"); } });
    await assert.rejects(client.check());
  }
});
test("changing credentials or invalidating lifecycle rejects late API responses", async () => {
  for (const mutate of [(g, c) => { g.values.accountToken = "replacement"; }, (_g, c) => c.invalidate(), g => { g.user.isGM = false; }]) {
    const current = gameFixture(); let release;
    const client = new CreatureClient({ getGame: () => current, request: () => new Promise(resolve => { release = resolve; }) });
    const waiting = client.check(); mutate(current, client); release({ ok: true, data: capabilityFixture() });
    await assert.rejects(waiting); assert.equal(client.access, null);
  }
});
test("429 cooldown is shared by generators; new generation waits for the cooldown", async () => {
  const current = gameFixture(), calls = []; let clock = 1000;
  const data = catalogFixture(), body = { requestId, catalogVersion: data.catalogVersion, options: data.defaults };
  const client = new CreatureClient({ getGame: () => current, now: () => clock, sanitize: identity, request: async options => {
    calls.push(options);
    if (calls.length === 1) return { ok: false, http: 429, retryAfterMs: 42000,
      data: { contractVersion: 1, status: "error", error: { code: "rateLimited", retryAfterSeconds: 42 } } };
    return { ok: true, data: resultFixture(body) };
  } });
  await assert.rejects(client.generate("monster", body), error => error.code === "rateLimited");
  await assert.rejects(client.generate("npc", body), error => error.code === "rateLimited");
  assert.equal(calls.length, 1); assert.equal(client.remainingDelay(), 42000);
  clock += 42000; assert.equal(client.remainingDelay(), 0);
  await client.generate("monster", body);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].body, body);
});
test("a lost response never retries automatically; a new explicit generation gets a fresh ID", async () => {
  const current = gameFixture(), data = catalogFixture(), calls = [];
  const client = new CreatureClient({ getGame: () => current, sanitize: identity, request: async options => {
    calls.push(options);
    if (calls.length === 1) return { ok: false, reason: "network" };
    return { ok: true, data: resultFixture(options.body) };
  } });
  const first = client.makeRequest(data, data.defaults, "monster");
  await assert.rejects(client.generate("monster", first), error => error.code === "network");
  assert.equal(calls.length, 1);
  const second = client.makeRequest(data, data.defaults, "monster");
  assert.notEqual(first.requestId, second.requestId);
  await client.generate("monster", second);
  assert.equal(calls.length, 2);
});
test("server header errors are not reported as disconnected accounts, missing API reports unavailable", async () => {
  for (const [http, data, code] of [[403, { contractVersion: 1, status: "error", error: { code: "invalidClientHeader" } }, "invalidClientHeader"], [404, {}, "apiUnavailable"]]) {
    const client = new CreatureClient({ getGame: gameFixture, request: async () => ({ ok: false, http, reason: "unauthorized", data }) });
    await assert.rejects(client.check(), error => error.code === code);
  }
});
function importFixture(extra = {}) {
  const current = gameFixture(); let creates = 0;
  const client = new CreatureClient({ getGame: () => current, request: async () => ({ ok: true, data: capabilityFixture() }) });
  const data = catalogFixture(), body = { requestId, catalogVersion: data.catalogVersion, options: data.defaults };
  const result = resultFixture(body), state = client.capture();
  const Class = { canUserCreate: () => true, create: async (source, options) => {
    creates++; assert.equal(options.keepId, true); assert.equal(options.keepEmbeddedIds, true);
    const actor = { ...source, id: source._id }; current.actors.set(actor.id, actor); return actor;
  } };
  return { current, result, state, client, options: { state, client, getGame: () => current, documentClass: () => Class, sanitize: identity, ...extra },
    Class, creates: () => creates };
}
test("actor imports recheck access and deduplicate by result/provenance, preserving all embedded references", async () => {
  const f = importFixture();
  const a = await importCreature(f.result, f.options), b = await importCreature(f.result, f.options);
  assert.equal(a, b); assert.equal(f.creates(), 1);
  assert.match(a.id, /^[a-f0-9]{16}$/); assert.equal(a.id, await actorId(f.result.resultId));
  assert.equal(a.ownership.default, 0); assert.equal(a.system.details.biography.public, "");
  assert(!JSON.stringify(a.flags).includes("fixture-token"));
  assert.deepEqual(a.items, buildActor(f.result.source).items);
});
test("imports refuse id collisions and invalid folders without replacement", async () => {
  const f = importFixture(), id = await actorId(f.result.resultId);
  f.current.actors.set(id, { id, type: "npc", flags: {} });
  await assert.rejects(importCreature(f.result, f.options), error => error.code === "actorCollision");
  f.current.actors.clear();
  await assert.rejects(importCreature(f.result, { ...f.options, folderId: "missing" }), error => error.code === "invalidFolder");
  assert.equal(f.creates(), 0);
});
test("permission loss during fresh pre-import verification prevents native mutation", async () => {
  const f = importFixture();
  f.client.request = async () => { f.current.user.isGM = false; return { ok: true, data: capabilityFixture() }; };
  await assert.rejects(importCreature(f.result, f.options)); assert.equal(f.creates(), 0);
});
test("uncertain create acknowledgement recovers the same actor from native state", async () => {
  const f = importFixture(), create = f.Class.create;
  f.Class.create = async (...args) => { await create(...args); throw new Error("Lost acknowledgement"); };
  const actor = await importCreature(f.result, f.options);
  assert(actor); assert.equal(f.creates(), 1);
});
test("concurrent clicks are locked before remote access checking and never double-create", async () => {
  const f = importFixture(); let release;
  f.client.request = () => new Promise(resolve => { release = resolve; });
  const waiting = importCreature(f.result, f.options);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(importCreature(f.result, f.options), error => error.code === "importBusy");
  release({ ok: true, data: capabilityFixture() }); await waiting; assert.equal(f.creates(), 1);
});
