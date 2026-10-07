import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { AtlasApi, cancelAtlasRequests } from "../scripts/atlas/api.js";
import { pushActor, createActor, resultMessage } from "../scripts/atlas/sync.js";
import { getLink, setLink, clearLink } from "../scripts/atlas/flags.js";
import { MAX_WRITE_BODY_BYTES, WRITE_BODY_HEADROOM_BYTES } from "../scripts/atlas/constants.js";

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
const { refreshAtlasIntegration, atlasContextOptions } = await import("../scripts/atlas/integration.js");
const originalFetch = globalThis.fetch;
const copy = JSON.parse(await readFile(new URL("../lang/fr.json", import.meta.url), "utf8"));
let settings, actors, requests, notices;

function reply(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function actor(id, legacy = false) {
  const flags = legacy ? { "jdr-ninja-atlas-sync": { link: { atlasCharacterId: `atlas-${id}`, portraitHash: "previous-hash" } } }
    : { "jdr-ninja": { atlasLink: { atlasCharacterId: `atlas-${id}` } } };
  const item = { id, name: `Character ${id}`, type: "character", system: {}, itemTypes: {}, img: null, flags,
    getFlag: (scope, key) => flags[scope]?.[key],
    setFlag: async (scope, key, value) => { (flags[scope] ??= {})[key] = value; },
    // V14 form only: a nested `flags` object whose deleted keys carry the ForcedDeletion operator.
    update: async changes => {
      assert.deepEqual(Object.keys(changes), ["flags"]);
      for (const [scope, keys] of Object.entries(changes.flags)) {
        for (const [key, value] of Object.entries(keys)) {
          assert(value instanceof ForcedDeletion, `${scope}.${key}`);
          delete flags[scope]?.[key];
        }
      }
    },
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

/** Serves `image` for the actor's portrait and `answer` for every Atlas call; returns the posted bodies. */
function serve(pc, image, answer) {
  const posted = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === pc.img) return new Response(image);
    if (options?.body) posted.push(options.body);
    return answer();
  };
  return posted;
}

const portraitTooLarge = copy["JDRNINJA_ATLAS_SYNC.notify.portraitTooLarge"].replace("{size}", "2");

beforeEach(() => {
  settings = new Map([["atlasEnabled", true], ["atlasToken", "fixture-atlas-token"],
    ["atlasOrigin", "https://www.jdr.ninja"], ["atlasCampaignId", "campaign"], ["atlasMarkClaimable", false]]);
  actors = new Map(); requests = []; notices = [];
  game = globalThis.game = {
    user: { isGM: true }, modules: new Map(), system: { id: "dnd5e", version: "5.3.0", title: "D&D 5e" },
    settings: { get: (_module, key) => settings.get(key), set: async (_module, key, value) => settings.set(key, value) },
    actors: { get: id => actors.get(id), filter: fn => [...actors.values()].filter(fn) },
    i18n: { localize: key => copy[key] ?? key,
      format: (key, values) => (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`) },
  };
  foundry.utils = { isNewerVersion: (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0 };
  globalThis.ui = { notifications: {
    info: message => { notices.push(message); return { update() {} }; }, warn: message => notices.push(message),
  }, actors: { rendered: false } };
  globalThis.HTMLElement = class {};
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return reply({ status: "OK", syncedAtUtc: "2026-10-03T12:00:00Z", portrait: "unchanged" });
  };
  AtlasSyncApp._instance = null;
});

afterEach(() => { cancelAtlasRequests(); globalThis.fetch = originalFetch; });

test("disabled integration, player access, unsupported systems, and the old module block all sync entry points", async () => {
  for (const mode of ["disabled", "player", "legacy", "system", "version"]) {
    settings.set("atlasEnabled", mode !== "disabled");
    game.user.isGM = mode !== "player";
    game.modules = new Map(mode === "legacy" ? [["jdr-ninja-atlas-sync", { active: true }]] : []);
    game.system = { id: mode === "system" ? "swade" : "dnd5e", version: mode === "version" ? "2.0.0" : "5.3.0" };
    const pc = actor(mode);
    assert.equal((await pushActor(pc)).ok, false, mode);
    assert.equal((await createActor(pc, "campaign", false)).ok, false, mode);
    assert.equal((await AtlasApi.campaigns()).ok, false, mode);
    assert.equal(AtlasSyncApp.open(), null, mode);
    assert.equal(contextEntry().visible(directoryEntry(pc.id)), false, mode);
  }
  assert.equal(requests.length, 0);
});

test("the context-menu entry exists from the first render and follows the switch, the GM role and the actor type", async () => {
  settings.set("atlasEnabled", false);
  const pc = actor("menu");
  const npc = actor("npc");
  npc.type = "npc";
  // V14 collects the entries once; enabling Atlas later must not need another collection.
  const entry = contextEntry();
  assert.equal(entry.label, "JDRNINJA_ATLAS_SYNC.context.sync");
  assert.equal(typeof entry.onClick, "function");
  for (const deprecated of ["name", "condition", "callback"]) assert.equal(deprecated in entry, false, deprecated);
  assert.equal(entry.visible(directoryEntry(pc.id)), false);

  settings.set("atlasEnabled", true);
  refreshAtlasIntegration();
  assert.equal(entry.visible(directoryEntry(pc.id)), true);
  assert.equal(entry.visible(directoryEntry(npc.id)), false);
  game.user.isGM = false;
  assert.equal(entry.visible(directoryEntry(pc.id)), false);
  game.user.isGM = true;

  await entry.onClick({}, directoryEntry(pc.id));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://www.jdr.ninja/api/foundry/v1/atlas/characters/atlas-menu");
  assert.deepEqual(notices, [copy["JDRNINJA_ATLAS_SYNC.notify.synced"]]);
});

test("a successful legacy-linked sync preserves the link and promotes its metadata to the unified namespace", async () => {
  const pc = actor("legacy", true);
  const result = await pushActor(pc);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://www.jdr.ninja/api/foundry/v1/atlas/characters/atlas-legacy");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fixture-atlas-token");
  assert.equal(requests[0].options.credentials, "omit");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.contractVersion, 1);
  assert.equal(payload.systemSlug, "dnd5e-compatible");
  assert.equal(payload.sourceSystemId, "dnd5e");
  assert.equal(pc.flags["jdr-ninja"].atlasLink.atlasCharacterId, "atlas-legacy");
  assert.equal(pc.flags["jdr-ninja"].atlasLink.portraitHash, "previous-hash");
  assert.equal(getLink(pc).syncedAtUtc, "2026-10-03T12:00:00Z");
});

test("create sync sends the campaign, name and claimable flag and records the returned link", async () => {
  const pc = actor("new");
  delete pc.flags["jdr-ninja"].atlasLink;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options }); return reply({ status: "OK", id: "new-atlas-character", portrait: "updated" });
  };
  assert.equal((await createActor(pc, "campaign", true)).ok, true);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.name, pc.name);
  assert.equal(payload.markClaimable, true);
  assert.equal(getLink(pc).atlasCharacterId, "new-atlas-character");
});

test("structured API validation errors survive non-success HTTP responses without changing actor flags", async () => {
  const pc = actor("failed");
  const before = structuredClone(pc.flags);
  globalThis.fetch = async () => reply({ status: "VALIDATION_FAILED", errors: [{ code: "TOO_LARGE", path: "rpgData" }] }, 422);
  const result = await pushActor(pc);
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.equal(result.http, 422);
  assert.equal(result.body.errors[0].code, "TOO_LARGE");
  assert.deepEqual(pc.flags, before);
});

test("a response without the Atlas envelope is a network, too-large or server failure; the envelope's code wins", async () => {
  const pc = actor("transport");
  const before = structuredClone(pc.flags);
  const cases = [
    [async () => { throw new TypeError("offline"); }, "NETWORK_ERROR"],
    [async () => new Response("<html>413 Payload Too Large</html>", { status: 413 }), "REQUEST_TOO_LARGE"],
    [async () => new Response(null, { status: 413 }), "REQUEST_TOO_LARGE"],
    [async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }), "SERVER_ERROR"],
    // A generic error body's numeric `status` is not the Atlas envelope's string status code.
    [async () => reply({ title: "An error occurred.", status: 500 }, 500), "SERVER_ERROR"],
    [async () => reply({ title: "Payload Too Large", status: 413 }, 413), "REQUEST_TOO_LARGE"],
    [async () => new Response(null, { status: 401 }), "INVALID_TOKEN"],
    [async () => reply({ status: "TOKEN_REVOKED" }, 401), "TOKEN_REVOKED"],
    [async () => reply({ status: "RATE_LIMITED", retryAfterSeconds: 60 }, 429), "RATE_LIMITED"],
  ];
  for (const [transport, status] of cases) {
    globalThis.fetch = transport;
    const result = await pushActor(pc);
    assert.equal(result.ok, false, status);
    assert.equal(result.status, status);
  }
  assert.deepEqual(pc.flags, before);
  for (const status of ["NETWORK_ERROR", "REQUEST_TOO_LARGE", "SERVER_ERROR"]) {
    assert.equal(resultMessage({ ok: false, status, body: {} }), copy[`JDRNINJA_ATLAS_SYNC.status.${status}`]);
  }
});

test("a portrait too large for the write cap is left out: the sheet syncs, the hash stays, and the GM is told", async () => {
  const pc = actor("big");
  pc.img = "portraits/big.png";
  pc.flags["jdr-ninja"].atlasLink.portraitHash = "previous-hash";
  // 2.5 MiB grows to 3.3 MiB in base64: over the server's 3 MiB cap.
  const posted = serve(pc, new Uint8Array(2.5 * 1024 * 1024).fill(7),
    () => reply({ status: "OK", syncedAtUtc: "2026-10-07T12:00:00Z", portrait: "unchanged" }));
  await contextEntry().onClick({}, directoryEntry(pc.id));
  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0]);
  for (const field of ["portraitHash", "portraitMime", "portraitBase64"]) assert.equal(field in body, false, field);
  assert.equal(body.systemSlug, "dnd5e-compatible");
  assert.equal(getLink(pc).syncedAtUtc, "2026-10-07T12:00:00Z");
  assert.equal(getLink(pc).portraitHash, "previous-hash");
  assert.deepEqual(notices, [copy["JDRNINJA_ATLAS_SYNC.notify.synced"], portraitTooLarge]);
  assert.match(portraitTooLarge, /moins de 2 Mo/);
});

test("a 2 MiB portrait, the size the message promises, still fits under the cap and is sent", async () => {
  const pc = actor("fits");
  pc.img = "portraits/fits.png";
  const posted = serve(pc, new Uint8Array(2 * 1024 * 1024).fill(3),
    () => reply({ status: "OK", syncedAtUtc: "2026-10-07T12:00:00Z", portrait: "updated" }));
  const result = await pushActor(pc);
  assert.equal(result.ok, true);
  assert.equal(result.portraitNotice, undefined);
  assert(new TextEncoder().encode(posted[0]).length <= MAX_WRITE_BODY_BYTES - WRITE_BODY_HEADROOM_BYTES);
  const body = JSON.parse(posted[0]);
  assert.equal(body.portraitMime, "image/png");
  assert.equal(getLink(pc).portraitHash, body.portraitHash);
});

test("creation leaves a too-large portrait out too, and the window row and notifications say so", async () => {
  const pc = actor("create-big");
  delete pc.flags["jdr-ninja"].atlasLink;
  pc.img = "portraits/create-big.webp";
  const posted = serve(pc, new Uint8Array(3 * 1024 * 1024).fill(1),
    () => reply({ status: "OK", id: "created-big", portrait: "unchanged" }));
  const app = new AtlasSyncApp();
  app._data.campaigns = [{ id: "campaign" }];
  await app._onCreate(null, { closest: () => ({ dataset: { actorId: pc.id } }) });
  assert.equal(posted.length, 1);
  assert.equal("portraitBase64" in JSON.parse(posted[0]), false);
  assert.equal(JSON.parse(posted[0]).name, pc.name);
  assert.equal(getLink(pc).atlasCharacterId, "created-big");
  assert.equal(getLink(pc).portraitHash, null);
  assert.equal(app._syncErrors.get(pc.id), portraitTooLarge);
  assert.deepEqual(notices, [copy["JDRNINJA_ATLAS_SYNC.notify.created"], portraitTooLarge]);

  // A later sync with a lighter image sends it and clears the row warning.
  notices.length = 0;
  serve(pc, new Uint8Array(1024).fill(2), () => reply({ status: "OK", portrait: "updated" }));
  await app._onSync(null, { closest: () => ({ dataset: { actorId: pc.id } }) });
  assert.equal(app._syncErrors.has(pc.id), false);
  assert.match(getLink(pc).portraitHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(notices, [copy["JDRNINJA_ATLAS_SYNC.notify.synced"]]);
});

test("a batch names the characters whose portrait was left out, beside the usual summary", async () => {
  const big = actor("batch-big");
  big.img = "portraits/batch-big.png";
  actor("batch-plain");
  const image = new Uint8Array(2.5 * 1024 * 1024).fill(9);
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return url === big.img ? new Response(image) : reply({ status: "OK", portrait: "unchanged" });
  };
  const app = new AtlasSyncApp();
  app.rendered = true;
  await app._onSyncAll();
  assert.equal(app._syncErrors.get(big.id), portraitTooLarge);
  assert.equal(app._syncErrors.has("batch-plain"), false);
  const format = (key, values) => copy[`JDRNINJA_ATLAS_SYNC.notify.${key}`].replace(/\{(\w+)\}/g, (_, name) => values[name]);
  assert(notices.includes(format("batchDone", { ok: 2, failed: 0 })));
  assert(notices.includes(format("batchPortraitTooLarge", { count: 1, names: big.name, size: 2 })));
});

test("after linking to an existing character, an image Atlas already holds is recorded and not sent again", async () => {
  const pc = actor("relinked");
  await setLink(pc, "existing-atlas-character");
  pc.img = "portraits/relinked.jpg";
  const posted = serve(pc, new Uint8Array(4096).fill(5), () => reply({ status: "OK", portrait: "unchanged" }));
  await pushActor(pc);
  const sent = JSON.parse(posted[0]).portraitHash;
  assert.match(sent, /^[0-9a-f]{64}$/);
  assert.equal(getLink(pc).portraitHash, sent);
  await pushActor(pc);
  assert.equal(posted.length, 2);
  assert.equal("portraitBase64" in JSON.parse(posted[1]), false);
});

test("a portrait Atlas skipped or failed keeps the previous hash, so the next sync sends it again", async () => {
  for (const outcome of ["skipped_tier", "skipped_none", "failed"]) {
    const pc = actor(`outcome-${outcome}`);
    pc.img = `portraits/${outcome}.png`;
    pc.flags["jdr-ninja"].atlasLink.portraitHash = "previous-hash";
    const posted = serve(pc, new Uint8Array(4096).fill(6), () => reply({ status: "OK", portrait: outcome }));
    assert.equal((await pushActor(pc)).ok, true, outcome);
    assert.equal(getLink(pc).portraitHash, "previous-hash", outcome);
    await pushActor(pc);
    assert.equal("portraitBase64" in JSON.parse(posted[1]), true, outcome);
  }
});

test("unlink clears both namespaces instead of reviving a legacy link", async () => {
  const pc = actor("unlink", true);
  pc.flags["jdr-ninja"] = { atlasLink: { atlasCharacterId: "newer-link" } };
  await clearLink(pc);
  assert.equal(getLink(pc), null);
});

test("disabling and re-enabling during portrait conversion prevents the original operation from posting", async () => {
  const pc = actor("portrait");
  pc.img = "portraits/fixture.png";
  let release;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Promise(resolve => { release = resolve; });
  };
  const pending = pushActor(pc);
  await new Promise(resolve => setImmediate(resolve));
  settings.set("atlasEnabled", false); refreshAtlasIntegration();
  settings.set("atlasEnabled", true); refreshAtlasIntegration();
  release(new Response(new Uint8Array([1, 2, 3])));
  assert.equal((await pending).status, "OPERATION_CANCELLED");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, pc.img);
});

test("disabling aborts an in-flight sync request and closes the active sync window", async () => {
  const pc = actor("abort");
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const app = AtlasSyncApp._instance = new AtlasSyncApp();
  app.rendered = true;
  const pending = pushActor(pc);
  await new Promise(resolve => setImmediate(resolve));
  settings.set("atlasEnabled", false);
  refreshAtlasIntegration();
  assert.equal(signal.aborted, true);
  assert.equal((await pending).status, "OPERATION_CANCELLED");
  assert.equal(app.rendered, false);
});

test("disabling also aborts portrait loading and releases the actor for a later sync", async () => {
  const pc = actor("image-abort");
  pc.img = "portraits/fixture.png";
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const pending = pushActor(pc);
  await new Promise(resolve => setImmediate(resolve));
  settings.set("atlasEnabled", false);
  refreshAtlasIntegration();
  assert.equal(signal.aborted, true);
  assert.equal((await pending).status, "INTEGRATION_DISABLED");
  settings.set("atlasEnabled", true);
  pc.img = null;
  globalThis.fetch = async () => reply({ status: "OK" });
  assert.equal((await pushActor(pc)).ok, true);
});

test("reopening after a settings change uses a fresh window while the cancelled load finishes", async () => {
  const releases = [];
  globalThis.fetch = async () => new Promise(resolve => { releases.push(resolve); });
  const previous = AtlasSyncApp._instance = new AtlasSyncApp();
  const loading = previous.loadData();
  await new Promise(resolve => setImmediate(resolve));
  settings.set("atlasEnabled", false);
  refreshAtlasIntegration();
  settings.set("atlasEnabled", true);
  const current = AtlasSyncApp.open();
  assert.notEqual(current, previous);
  assert.equal(previous._closed, true);
  await new Promise(resolve => setImmediate(resolve));
  releases[1](reply({ status: "OK", tier: { allowed: false }, world: { name: "Current world" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(current._data.whoami.world.name, "Current world");
  // Native fetch rejects on abort; deliberately finish the old request late instead.
  releases[0](reply({ status: "OK", tier: { allowed: false }, world: { name: "Previous world" } }));
  await loading;
  assert.equal(current._data.whoami.world.name, "Current world");
  assert.equal(previous.rendered, false);
  await current.close();
});

test("repeated clicks cannot post the same actor concurrently", async () => {
  const pc = actor("duplicate");
  let release;
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Promise(resolve => { release = resolve; }); };
  const pending = pushActor(pc);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await pushActor(pc)).status, "SYNC_IN_PROGRESS");
  release(reply({ status: "OK" }));
  assert.equal((await pending).ok, true);
  assert.equal(requests.length, 1);
});

test("batch sync stops before the next actor when integration is disabled", async () => {
  const first = actor("first");
  actor("second");
  const setFlag = first.setFlag;
  first.setFlag = async (...args) => { await setFlag(...args); settings.set("atlasEnabled", false); refreshAtlasIntegration(); };
  const app = new AtlasSyncApp();
  app.rendered = true;
  await app._onSyncAll();
  assert.equal(requests.length, 1);
  assert.equal(getLink(actors.get("second")).syncedAtUtc, undefined);
  assert(notices.includes(copy["JDRNINJA_ATLAS_SYNC.status.OPERATION_CANCELLED"]));
});

test("link picker follows pagination and escapes character names", async () => {
  const pc = actor("picker");
  delete pc.flags["jdr-ninja"].atlasLink;
  const app = new AtlasSyncApp();
  app._data.campaigns = [{ id: "campaign" }];
  globalThis.fetch = async url => {
    requests.push(url);
    return reply({ status: "OK", total: 201, items: url.includes("page=1&")
      ? Array.from({ length: 200 }, (_, i) => ({ id: `pc-${i}`, name: `Character ${i}` }))
      : [{ id: "pc-200", name: "<img src=x onerror=fixture()>" }] });
  };
  foundry.applications.api.DialogV2 = { prompt: async options => {
    assert(!options.content.includes("<img")); assert(options.content.includes("&lt;img")); return "pc-200";
  } };
  await app._onLink(null, { closest: () => ({ dataset: { actorId: pc.id } }) });
  assert.equal(requests.length, 2);
  assert.equal(getLink(pc).atlasCharacterId, "pc-200");
});

test("the Atlas template renders its actions and escapes actor data in all five languages", async () => {
  const source = await readFile(new URL("../templates/atlas-sync.hbs", import.meta.url), "utf8");
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const strings = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    const handlebars = Handlebars.create();
    handlebars.registerHelper("localize", key => strings[key] ?? key);
    const html = handlebars.compile(source)({ connected: true, canWrite: true, hasCampaign: true, tierAllowed: true,
      campaigns: [{ id: "campaign", name: "Campaign", count: 1 }],
      rows: [{ actorId: "linked", name: "<img src=x>", linked: true }, { actorId: "new", name: "New" }] });
    assert(!html.includes("JDRNINJA"), locale);
    assert(!html.includes("<img src=x>"));
    assert(html.includes("&lt;img"));
    for (const action of html.matchAll(/data-action="(\w+)"/g)) assert.equal(typeof AtlasSyncApp.DEFAULT_OPTIONS.actions[action[1]], "function");
  }
});
