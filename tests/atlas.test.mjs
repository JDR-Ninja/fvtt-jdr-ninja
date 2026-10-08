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
const { AtlasSyncApp, rowStatus, connectionStatus, formatSyncedAt } = await import("../scripts/atlas/sync-app.js");
const { refreshAtlasIntegration, atlasContextOptions, renderAtlasButton } = await import("../scripts/atlas/integration.js");
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

/** The few DOM members the directory hook touches: classes, children, attributes and class selectors. */
class FakeNode {
  constructor(tag = "div", className = "") {
    Object.assign(this, { tagName: tag, className, children: [], parentElement: null, textContent: "", attributes: new Map(), listeners: new Map() });
  }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name) }; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes) node.remove(); for (const node of nodes) node.parentElement = this; this.children.unshift(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.classList.contains(selector.slice(1))) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }
}

/** An Actors directory as the render hook receives it: Foundry's header buttons, with or without `.header-actions`. */
function directory({ headerActions = true } = {}) {
  const root = new FakeNode("section", "directory");
  const header = new FakeNode("header", "directory-header");
  const footer = new FakeNode("footer", "directory-footer");
  root.append(header, footer);
  const actions = headerActions ? new FakeNode("div", "header-actions action-buttons flexrow") : null;
  if (actions) { header.append(actions); actions.append(new FakeNode("button", "create-entry"), new FakeNode("button", "create-folder")); }
  return { root, header, footer, actions, html: [root] };
}
const rowIn = host => host.children.filter(child => child.classList.contains("jn-directory-actions"));
const labels = node => node.children.map(child => child.className);

test("the Actors directory offers Atlas only to a GM who can sync now, never as a disabled button", () => {
  globalThis.document = { createElement: tag => new FakeNode(tag) };
  const view = directory();
  const pc = actor("directory");
  renderAtlasButton(null, view.html);
  const [row] = rowIn(view.actions);
  const [button] = row.children;
  assert.equal(button.className, "jdr-ninja-atlas-open jn-directory-button"); assert.notEqual(button.disabled, true);
  assert.equal(contextEntry().visible(directoryEntry(pc.id)), true);
  for (const mode of ["disabled", "player", "legacy", "system", "token"]) {
    settings.set("atlasEnabled", mode !== "disabled"); settings.set("atlasToken", mode === "token" ? "" : "fixture-atlas-token");
    game.user.isGM = mode !== "player";
    game.modules = new Map(mode === "legacy" ? [["jdr-ninja-atlas-sync", { active: true }]] : []);
    game.system = { id: mode === "system" ? "swade" : "dnd5e", version: "5.3.0" };
    // A re-render over the same markup takes the old button away, and the row it was alone in.
    renderAtlasButton(null, view.html);
    assert.deepEqual(labels(view.actions), ["create-entry", "create-folder"], mode);
    const fresh = directory();
    renderAtlasButton(null, fresh.html);
    assert.deepEqual(labels(fresh.actions), ["create-entry", "create-folder"], mode);
    assert.equal(contextEntry().visible(directoryEntry(pc.id)), false, mode);
  }
});

test("the Atlas shortcut is an icon, a short label and the full title as tooltip, in the shared row of the header", () => {
  globalThis.document = { createElement: tag => new FakeNode(tag) };
  const view = directory();
  renderAtlasButton(null, view.html);
  // The row follows Foundry's own buttons, inside `.header-actions`.
  assert.deepEqual(labels(view.actions), ["create-entry", "create-folder", "jn-directory-actions"]);
  const [button] = view.actions.children[2].children;
  assert.equal(button.tagName, "button");
  assert.equal(button.type, "button");
  assert.equal(button.attributes.get("data-tooltip"), copy["JDRNINJA_ATLAS_SYNC.app.title"]);
  assert.equal(button.attributes.get("aria-label"), copy["JDRNINJA_ATLAS_SYNC.app.title"]);
  const [icon, label] = button.children;
  assert.equal(icon.className, "fa-solid fa-globe");
  assert.equal(icon.attributes.get("aria-hidden"), "true");
  assert.equal(label.textContent, copy["JDRNINJA_ATLAS_SYNC.app.openButton"]);
  assert(label.textContent.length < copy["JDRNINJA_ATLAS_SYNC.app.title"].length, "the visible label is the short one");
  // Rendering again, as every directory refresh does, never doubles the button or the row.
  renderAtlasButton(null, view.html); renderAtlasButton(null, view.html);
  assert.equal(rowIn(view.actions).length, 1);
  assert.equal(view.actions.children[2].children.length, 1);
  // The click opens the window.
  const open = AtlasSyncApp.open;
  let opened = 0;
  AtlasSyncApp.open = () => { opened++; };
  try { button.listeners.get("click")(); } finally { AtlasSyncApp.open = open; }
  assert.equal(opened, 1);
});

test("the Atlas shortcut joins a row the creature shortcuts made first, and stays ahead of them", () => {
  globalThis.document = { createElement: tag => new FakeNode(tag) };
  const view = directory();
  const row = new FakeNode("div", "jn-directory-actions");
  row.append(new FakeNode("button", "jdr-ninja-creature-open jn-directory-button"), new FakeNode("button", "jdr-ninja-creature-open jn-directory-button"));
  view.actions.append(row);
  renderAtlasButton(null, view.html);
  assert.equal(rowIn(view.actions).length, 1);
  assert.equal(rowIn(view.actions)[0], row);
  assert.deepEqual(labels(row), ["jdr-ninja-atlas-open jn-directory-button", "jdr-ninja-creature-open jn-directory-button",
    "jdr-ninja-creature-open jn-directory-button"]);
  // Taking Atlas away leaves the other integration's buttons in their row.
  settings.set("atlasEnabled", false);
  renderAtlasButton(null, view.html);
  assert.deepEqual(labels(row), ["jdr-ninja-creature-open jn-directory-button", "jdr-ninja-creature-open jn-directory-button"]);
  assert.equal(rowIn(view.actions).length, 1);
});

test("without `.header-actions` the shortcut falls back to the directory header, then its footer, then the root", () => {
  globalThis.document = { createElement: tag => new FakeNode(tag) };
  const withHeader = directory({ headerActions: false });
  renderAtlasButton(null, withHeader.html);
  assert.equal(rowIn(withHeader.header).length, 1);
  assert.equal(rowIn(withHeader.header)[0].children[0].className, "jdr-ninja-atlas-open jn-directory-button");

  const footerOnly = directory({ headerActions: false });
  footerOnly.header.remove();
  renderAtlasButton(null, footerOnly.html);
  assert.equal(rowIn(footerOnly.footer).length, 1);

  const bare = new FakeNode("section", "directory");
  renderAtlasButton(null, [bare]);
  assert.equal(rowIn(bare).length, 1);
  assert.equal(bare.children[0].children[0].className, "jdr-ninja-atlas-open jn-directory-button");
});

test("a sync date follows Foundry's language, short and without seconds, and an unreadable one shows nothing", () => {
  const moment = "2026-10-08T19:30:45.000Z";
  const plain = text => text.replace(/\s/g, " ");
  assert.equal(plain(formatSyncedAt(moment, "en", { timeZone: "UTC" })), "Oct 8, 2026, 7:30 PM");
  const french = formatSyncedAt(moment, "fr", { timeZone: "UTC" });
  assert.match(french, /19:30/); assert.match(french, /2026/); assert.match(french, /oct/);
  assert.notEqual(french, formatSyncedAt(moment, "en", { timeZone: "UTC" }));
  for (const locale of ["en", "fr", "es", "de", "it"]) assert.doesNotMatch(formatSyncedAt(moment, locale, { timeZone: "UTC" }), /:45/, locale);
  // Same moment, another zone: the formatter shows the viewer's clock, not UTC.
  assert.notEqual(formatSyncedAt(moment, "en", { timeZone: "Asia/Tokyo" }), formatSyncedAt(moment, "en", { timeZone: "UTC" }));
  for (const value of [null, undefined, "", "not a date"]) assert.equal(formatSyncedAt(value, "en"), null, String(value));
  // A language tag the browser does not know falls back to its own, instead of breaking the window.
  assert.match(formatSyncedAt(moment, "not_a_locale", { timeZone: "UTC" }), /2026/);
});

test("pill levels: a row follows its link, the header follows the connection", () => {
  assert.deepEqual(rowStatus({ linked: false, synced: false }), { state: "unlinked", level: "neutral", icon: "fa-link-slash" });
  assert.deepEqual(rowStatus({ linked: false, synced: true }), { state: "unlinked", level: "neutral", icon: "fa-link-slash" });
  assert.deepEqual(rowStatus({ linked: true, synced: false }), { state: "linked", level: "info", icon: "fa-link" });
  assert.deepEqual(rowStatus({ linked: true, synced: true }), { state: "synced", level: "success", icon: "fa-circle-check" });
  assert.deepEqual(connectionStatus({ connected: true, loading: false, failed: false }), { state: "connected", level: "success", icon: "fa-circle-check" });
  assert.equal(connectionStatus({ connected: true, loading: true, failed: true }).state, "connected");
  assert.deepEqual(connectionStatus({ connected: false, loading: true, failed: false }), { state: "loading", level: "info", icon: "fa-spinner fa-spin" });
  assert.deepEqual(connectionStatus({ connected: false, loading: false, failed: true }), { state: "disconnected", level: "error", icon: "fa-circle-xmark" });
  assert.equal(connectionStatus({ connected: false, loading: false, failed: false }).level, "neutral");
});

/** The window's context for a world with one synced, one linked-but-never-synced and one unlinked character. */
async function windowContext({ data, messages = () => {} } = {}) {
  const synced = actor("synced");
  synced.flags["jdr-ninja"].atlasLink.syncedAtUtc = "2026-10-08T19:30:00Z";
  const waiting = actor("waiting");
  const free = actor("free");
  delete free.flags["jdr-ninja"].atlasLink;
  const app = new AtlasSyncApp();
  app._data = data ?? { loading: false, error: null, campaigns: [{ id: "campaign", name: "Campaign", characterCount: 3 }],
    whoami: { world: { name: "The Sunken Crown" }, tier: { allowed: true } } };
  messages(app, { synced, waiting, free });
  return { app, context: await app._prepareContext(), synced, waiting, free };
}

test("each row's pill, date and message come from its link and its last sync result", async () => {
  const { app, context, synced, waiting, free } = await windowContext({ messages: (app, { synced, waiting }) => {
    app._recordRowResult(waiting, { ok: false, status: "NETWORK_ERROR", body: {} });
    app._recordRowResult(synced, { ok: true, portraitNotice: "TOO_LARGE" });
  } });
  const row = actor => context.rows.find(candidate => candidate.actorId === actor.id);
  assert.deepEqual([row(synced).status.state, row(synced).status.level], ["synced", "success"]);
  assert.equal(row(synced).status.label, copy["JDRNINJA_ATLAS_SYNC.row.synced"]);
  assert.equal(row(synced).syncedLabel, formatSyncedAt("2026-10-08T19:30:00Z", undefined));
  assert.equal(row(synced).error, portraitTooLarge);
  assert.equal(row(synced).errorLevel, "warning");
  assert.deepEqual([row(waiting).status.state, row(waiting).status.level], ["linked", "info"]);
  assert.equal(row(waiting).status.label, copy["JDRNINJA_ATLAS_SYNC.row.linked"]);
  assert.equal(row(waiting).syncedLabel, null);
  assert.equal(row(waiting).error, copy["JDRNINJA_ATLAS_SYNC.status.NETWORK_ERROR"]);
  assert.equal(row(waiting).errorLevel, "error");
  assert.deepEqual([row(free).status.state, row(free).status.level], ["unlinked", "neutral"]);
  assert.equal(row(free).status.label, copy["JDRNINJA_ATLAS_SYNC.row.unlinked"]);
  assert.equal(row(free).error, null);
  // A clean result, a successful unlink or a reload drops the message and its level together.
  app._recordRowResult(waiting, { ok: true });
  app._forgetRowMessages(synced.id);
  assert.equal(app._syncErrors.size, 0); assert.equal(app._syncLevels.size, 0);
  app._recordRowResult(free, { ok: false, status: "NETWORK_ERROR", body: {} });
  app._forgetRowMessages();
  assert.equal(app._syncErrors.size, 0); assert.equal(app._syncLevels.size, 0);
});

test("the header pill reads connected, loading or not connected, with the world only once connected", async () => {
  const label = key => copy[key];
  const connected = (await windowContext()).context;
  assert.deepEqual([connected.connection.level, connected.connection.label, connected.worldName],
    ["success", label("JDRNINJA.status.connected"), "The Sunken Crown"]);
  const loading = (await windowContext({ data: { loading: true, whoami: null, campaigns: [], error: null } })).context;
  assert.deepEqual([loading.connection.level, loading.connection.label], ["info", label("JDRNINJA_ATLAS_SYNC.app.loading")]);
  const failed = (await windowContext({ data: { loading: false, whoami: null, campaigns: [], error: "INVALID_TOKEN" } })).context;
  assert.deepEqual([failed.connection.level, failed.connection.label], ["error", label("JDRNINJA_ATLAS_SYNC.app.disconnected")]);
  assert.equal(failed.worldName, "");
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

/** The tags of one kind that carry a class, e.g. `button` with `bright`. */
const tagsWithClass = (html, tag, name) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))]
  .map(match => match[0]).filter(opening => new RegExp(`class="[^"]*\\b${name}\\b`).test(opening));

test("the Atlas window is a layout of header, controls, a card per character and one primary action in the footer", async () => {
  const source = await readFile(new URL("../templates/atlas-sync.hbs", import.meta.url), "utf8");
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const strings = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    game.i18n.localize = key => strings[key] ?? key; game.i18n.lang = locale;
    const handlebars = Handlebars.create();
    handlebars.registerHelper("localize", key => strings[key] ?? key);
    const { context, synced, waiting, free } = await windowContext({ messages: (app, { waiting }) => {
      app._recordRowResult(waiting, { ok: false, status: "NETWORK_ERROR", body: {} });
    } });
    const html = handlebars.compile(source)(context);
    assert(!html.includes("JDRNINJA"), locale);
    // Structure: one root layout, a scrolling list, a footer; no fieldset and no loose button bars.
    assert.match(html, /^<div class="standard-form jn-layout atlas-sync">/);
    assert.equal(tagsWithClass(html, "div", "jn-scroll").length, 1, locale);
    assert.equal(tagsWithClass(html, "footer", "jn-footer").length, 1, locale);
    assert(!html.includes("<fieldset"), locale);
    assert(html.indexOf('class="atlas-sync__header"') < html.indexOf('data-control="campaign"'));
    // Header: the connection pill, then the world and the system as plain text.
    assert.match(html, /<header class="atlas-sync__header">\s*<span class="jn-pill jn-pill--success">/);
    assert(html.includes('<span class="atlas-sync__world">The Sunken Crown</span>'));
    assert(html.includes('<span class="jn-muted atlas-sync__system">'));
    assert(!/class="badge/.test(html), locale);
    // The single primary action is "Sync all", in the footer.
    const bright = tagsWithClass(html, "button", "bright");
    assert.equal(bright.length, 1, locale);
    assert(bright[0].includes('data-action="syncAll"'));
    assert(html.indexOf('data-action="syncAll"') > html.indexOf("<footer"), "Sync all is in the footer");
    // Every other hook the code and the screenshot tool rely on is still there, with labels.
    for (const hook of ['data-control="campaign"', 'data-control="claimable"', 'data-action="refresh"', 'data-action="sync"',
      'data-action="unlink"', 'data-action="create"', 'data-action="link"']) assert(html.includes(hook), `${locale}: ${hook}`);
    assert(html.includes('<label for="jdr-ninja-atlas-campaign">') && html.includes('id="jdr-ninja-atlas-campaign"'));
    assert(html.includes('<label for="jdr-ninja-atlas-claimable">') && html.includes('id="jdr-ninja-atlas-claimable"'));
    // One card per character; its pill matches its state; the date reads after "Synced".
    const cards = tagsWithClass(html, "li", "jn-card");
    assert.deepEqual(cards.map(card => card.match(/data-actor-id="([\w-]+)"/)[1]).sort(), [free.id, synced.id, waiting.id].sort());
    const flat = html.replace(/\s+/g, " ");
    assert(flat.includes(`jn-pill--success"> <i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${strings["JDRNINJA_ATLAS_SYNC.row.synced"]} </span>`));
    assert(flat.includes(`jn-pill--info"> <i class="fa-solid fa-link" aria-hidden="true"></i> ${strings["JDRNINJA_ATLAS_SYNC.row.linked"]} </span>`));
    assert(flat.includes(`jn-pill--neutral"> <i class="fa-solid fa-link-slash" aria-hidden="true"></i> ${strings["JDRNINJA_ATLAS_SYNC.row.unlinked"]} </span>`));
    assert(html.includes(`<span class="jn-muted">${formatSyncedAt("2026-10-08T19:30:00Z", locale)}</span>`), locale);
    assert(html.includes('class="notice notice-error"'), "a failed sync shows its message at error level");
    // "Sync" is an icon button with its name and tooltip; "Unlink" is the destructive style; the rest stay plain.
    const sync = tagsWithClass(html, "button", "jn-icon-button").filter(button => button.includes('data-action="sync"'));
    assert.equal(sync.length, 2, "a linked character has it, whether synced or not");
    for (const button of sync) {
      assert(button.includes(`aria-label="${strings["JDRNINJA_ATLAS_SYNC.row.sync"]}"`), locale);
      assert(button.includes(`data-tooltip="${strings["JDRNINJA_ATLAS_SYNC.row.sync"]}"`), locale);
    }
    const unlink = tagsWithClass(html, "button", "jn-danger");
    assert.equal(unlink.length, 2); assert(unlink.every(button => button.includes('data-action="unlink"')));
    const refresh = tagsWithClass(html, "button", "jn-icon-button").find(button => button.includes('data-action="refresh"'));
    assert(refresh.includes("aria-label=") && refresh.includes("data-tooltip="));
    for (const action of ["create", "link"]) {
      const [button] = [...html.matchAll(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`, "g"))].map(match => match[0]);
      assert(!/class=/.test(button), `${action} stays a secondary button`);
    }
  }
});

test("while connecting the window shows the loading pill and no character, and without access only its warning", async () => {
  const source = await readFile(new URL("../templates/atlas-sync.hbs", import.meta.url), "utf8");
  const handlebars = Handlebars.create();
  handlebars.registerHelper("localize", key => copy[key] ?? key);
  const { context } = await windowContext({ data: { loading: true, whoami: null, campaigns: [], error: null } });
  const loading = handlebars.compile(source)(context);
  assert(loading.includes("jn-pill--info"));
  assert(loading.includes(copy["JDRNINJA_ATLAS_SYNC.app.loading"]));
  assert(!loading.includes("atlas-sync__rows"));
  assert(loading.includes('aria-busy="true"'));
  assert(!loading.includes('class="atlas-sync__world"'), "no world before the connection");
  settings.set("atlasEnabled", false);
  const blocked = handlebars.compile(source)(await new AtlasSyncApp()._prepareContext());
  assert(blocked.includes("notice-warning"));
  assert(!blocked.includes("data-action="), "nothing to click without access");
  assert(!blocked.includes("<footer"));
});
