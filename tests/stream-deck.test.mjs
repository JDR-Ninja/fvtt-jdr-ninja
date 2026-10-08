import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { StreamDeckBridge } from "../scripts/stream-deck/bridge.js";
import { FoundryActions, ACTIONS } from "../scripts/stream-deck/actions.js";
import { buildSnapshot, CATALOG_LIMIT } from "../scripts/stream-deck/snapshot.js";
import { normalizeBridgeUrl, normalizeBridgeKey, proof, parseMessage, MAX_MESSAGE_BYTES } from "../scripts/stream-deck/protocol.js";
import { VariableService } from "../scripts/variables/service.js";
import { VariableActions } from "../scripts/variables/dispatcher.js";
import { emptyStore } from "../scripts/variables/schema.js";

function collection(documents = []) {
  return { contents: documents, get: id => documents.find(document => document.id === id) };
}
function document(type, id, overrides = {}) {
  return { id, uuid: `${type}.${id}`, documentName: type, name: id, testUserPermission: () => true, ...overrides };
}
function environment() {
  const user = { id: "gm", name: "GM", isGM: true, active: true };
  const game = { user, world: { id: "world-a", title: "World A" }, version: "14.365", system: { id: "test", version: "1.0" },
    i18n: { localize: key => key }, actors: collection(), macros: collection(), scenes: collection(), tables: collection(),
    playlists: collection(), journal: collection(), users: collection([user]), combats: collection(), paused: false };
  const canvas = { tokens: { controlled: [] } };
  const ui = { sidebar: { constructor: { TABS: { chat: {}, scenes: { gmOnly: true } } } }, controls: { controls: {} } };
  const config = { statusEffects: [{ id: "prone", name: "Prone" }] };
  const overlay = { enabled: () => false, access: () => ({ ok: false }) };
  return { game, canvas, ui, config, overlay };
}
function transportFixture(options = {}) {
  const env = environment(), settings = { streamDeckEnabled: true, streamDeckUrl: "ws://127.0.0.1:19114/jdr-ninja",
    streamDeckKey: "a".repeat(64) };
  env.game.settings = { get: (_module, key) => settings[key] };
  let clock = 100000;
  const timers = new Map(), sent = [], sockets = [], calls = [];
  const wired = options.wire?.(env, settings) ?? {};
  const bridge = new StreamDeckBridge({ game: () => env.game, canvas: () => env.canvas, ui: () => env.ui,
    config: () => env.config, overlay: env.overlay, crypto: webcrypto, now: () => clock,
    ...(wired.variables ? { variables: wired.variables } : {}),
    actions: wired.actions ?? options.actions ?? { execute: async (command, { guard }) => { guard(); calls.push(command); return { code: "executed" }; } },
    setTimer: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id),
    socket: () => {
      const socket = { readyState: 1, bufferedAmount: 0, close: () => { socket.closed = true; },
        send: data => sent.push(JSON.parse(data)) };
      sockets.push(socket); return socket;
    },
  });
  const send = async body => bridge.receive({ protocol: 1, sessionId: bridge.session?.id, ...body }, bridge.generation);
  const command = (overrides = {}) => ({ type: "command", protocol: 1, id: "command01", sessionId: bridge.session.id,
    revision: bridge.revision, expiresAt: clock + 10000, action: "game.pause", parameters: { paused: true }, ...overrides });
  const handshake = async extensions => {
    bridge.refresh(); bridge.ws.onopen();
    const nonce = "b".repeat(64);
    await send({ type: "challenge", nonce,
      proof: await proof(settings.streamDeckKey, "bridge", bridge.session.id, bridge.clientNonce, nonce, webcrypto) });
    assert.equal(sent.at(-1).proof, await proof(settings.streamDeckKey, "foundry", bridge.session.id, bridge.clientNonce, nonce, webcrypto));
    await send({ type: "authenticated", ...(extensions ? { extensions } : {}) });
    flushChanges();
  };
  const ready = async extensions => { await handshake(extensions); await send({ type: "syncAck", revision: bridge.revision }); };
  const flushChanges = () => { for (const [id, timer] of timers) if (timer.delay === 150) { timers.delete(id); timer.fn(); } };
  return { ...env, bridge, settings, timers, sent, sockets, calls, command, send, handshake, ready, flushChanges,
    advance: amount => { clock += amount; } };
}

test("bridge endpoints stay on loopback and credentials never enter URLs", () => {
  for (const url of ["ws://127.0.0.1:19114/jdr-ninja", "wss://localhost:19114/jdr-ninja", "ws://[::1]:19114/jdr-ninja"])
    assert.equal(normalizeBridgeUrl(url), url);
  for (const url of ["https://localhost/jdr-ninja", "ws://example.com/jdr-ninja", "ws://localhost/other",
    "ws://user:pass@localhost/jdr-ninja", "ws://localhost/jdr-ninja?token=value", "ws://localhost.evil/jdr-ninja"])
    assert.throws(() => normalizeBridgeUrl(url));
  assert.throws(() => normalizeBridgeKey("short"));
  assert.throws(() => normalizeBridgeKey("a".repeat(32) + "\nvalue"));
});

test("legacy companion keeps literal schemas and clearly refuses advanced commands", async () => {
  const f = transportFixture(); await f.ready();
  const projection = f.sent.find(message => message.type === "snapshot");
  assert(!projection.capabilities.variables); assert(!projection.actions.some(action => action.id.startsWith("variable.")));
  await f.send(f.command({ action: "variable.toggle", parameters: { variable: { source: "variable", scope: "world", id: "a" } } }));
  assert.equal(f.sent.at(-1).code, "unsupportedExtension"); assert.equal(f.calls.length, 0);
});

test("duplicate structured results are retained after own commit dirties synchronization", async () => {
  const details = { version: 1, variableCommit: "committed", execution: "completed", revision: 2 };
  const f = transportFixture({ actions: { execute: async () => ({ code: "executed", details }) } });
  await f.ready(); f.bridge.extensions = { variables: 1 };
  const request = f.command({ extensions: { variables: 1 } }); await f.send(request); await f.bridge.tail;
  assert.equal(f.bridge.state, "synchronizing"); assert.deepEqual(f.sent.at(-1).details, details);
  await f.send(request); assert.deepEqual(f.sent.at(-1).details, details); assert.equal(f.sent.at(-1).code, "executed");
  await f.send({ ...request, parameters: { paused: false } }); assert.equal(f.sent.at(-1).code, "duplicateConflict");
});

test("negotiated snapshot publishes advanced descriptors without changing base literal definitions", () => {
  const env = environment(), variables = { variables: [{ id: "a", scope: "world", writable: true }], lists: [], state: [], revisions: { world: 2, personal: 0 }, controller: "gm" };
  const snap = buildSnapshot({ ...env, selectionRevision: 0, variables });
  assert.equal(snap.capabilities.variables.version, 1); assert.equal(snap.actions.find(a => a.id === "game.pause").inputs.paused.variable, true);
  assert.equal(ACTIONS["game.pause"].inputs.paused.variable, undefined); assert(snap.actions.some(a => a.id === "variable.applyAndExecute"));
  assert.deepEqual(snap.state.variableStores.revisions, variables.revisions);
});

test("disabled or unconfigured integration never creates a socket", () => {
  const f = transportFixture(); f.settings.streamDeckEnabled = false; f.bridge.refresh();
  assert.equal(f.sockets.length, 0); assert.equal(f.bridge.state, "disabled");
  f.settings.streamDeckEnabled = true; f.settings.streamDeckKey = ""; f.bridge.refresh();
  assert.equal(f.sockets.length, 0); assert.equal(f.bridge.state, "unconfigured");
});

test("mutual HMAC authentication binds both nonces and the selected session without transmitting the key", async () => {
  const f = transportFixture(); await f.handshake();
  assert.equal(f.bridge.state, "synchronizing");
  assert(!JSON.stringify(f.sent).includes(f.settings.streamDeckKey));
  // The hello carries only the session ID; the identity travels with the module's proof, after the companion's.
  assert.deepEqual(f.sent[0].session, { id: f.bridge.session.id });
  const authentication = f.sent.find(message => message.type === "authenticate");
  assert.deepEqual(authentication.session, { worldId: "world-a", worldName: "World A", userId: "gm", userName: "GM", isGM: true,
    foundryVersion: "14.365", systemId: "test", systemVersion: "1.0" });
  assert(f.sent.some(message => message.type === "snapshot"));
  await f.send({ type: "syncAck", revision: f.bridge.revision }); assert.equal(f.bridge.state, "ready");
});

test("an incorrect bridge proof or premature authentication cannot sync or execute", async () => {
  const f = transportFixture(); f.bridge.refresh(); f.bridge.ws.onopen();
  await assert.rejects(f.send({ type: "challenge", nonce: "b".repeat(64), proof: "c".repeat(64) }), { code: "authenticationFailed" });
  await assert.rejects(f.send({ type: "authenticated" }), { code: "authenticationFailed" });
  assert(!f.sent.some(message => message.type === "snapshot"));
  // A listener that cannot prove the key never learns the world or the user.
  for (const value of ["world-a", "World A", '"gm"', "14.365"]) assert(!JSON.stringify(f.sent).includes(value));
});

test("sync acknowledgement is required, and an old acknowledgement cannot restore readiness during a pending update", async () => {
  const f = transportFixture(); await f.handshake();
  await f.send(f.command()); assert.equal(f.sent.at(-1).code, "notSynchronized");
  await f.send({ type: "syncAck", revision: f.bridge.revision });
  const previousRevision = f.bridge.revision;
  f.bridge.changed(); await f.send({ type: "syncAck", revision: f.bridge.revision });
  assert.equal(f.bridge.state, "synchronizing");
  f.flushChanges(); assert.equal(f.sent.at(-1).type, "update");
  assert.equal(f.sent.at(-1).baseRevision, previousRevision); assert.equal(f.sent.at(-1).revision, previousRevision + 1);
  await f.send({ type: "syncAck", revision: previousRevision }); assert.equal(f.bridge.state, "synchronizing");
  await f.send({ type: "syncAck", revision: previousRevision + 1 }); assert.equal(f.bridge.state, "ready");
});

test("command acceptance and completion are separate, and duplicate presses never repeat a mutation", async () => {
  const f = transportFixture(); await f.ready(); const command = f.command();
  await f.send(command); await f.bridge.tail;
  assert.deepEqual(f.sent.filter(message => message.id === command.id).map(message => message.type), ["accepted", "result"]);
  assert.equal(f.calls.length, 1);
  f.flushChanges(); await f.send({ type: "syncAck", revision: f.bridge.revision });
  await f.send({ ...command, revision: f.bridge.revision }); assert.equal(f.sent.at(-1).code, "executed");
  assert.equal(f.calls.length, 1);
  await f.send({ ...command, revision: f.bridge.revision, parameters: { paused: false } });
  assert.equal(f.sent.at(-1).code, "duplicateConflict");
});

test("wrong-session, stale and expired commands are rejected before handlers", async () => {
  const f = transportFixture(); await f.ready();
  await assert.rejects(f.send(f.command({ sessionId: "another" })), { code: "wrongSession" });
  for (const [overrides, code] of [[{ revision: 0 }, "staleState"], [{ expiresAt: 1 }, "expired"],
    [{ expiresAt: 999999999 }, "expired"], [{ id: "!" }, "invalidCommand"]]) {
    await f.send(f.command(overrides)); assert.equal(f.sent.at(-1).code, code);
  }
  assert.equal(f.calls.length, 0);
});

test("disable cancels admitted commands that have not begun executing", async () => {
  const f = transportFixture(); await f.ready();
  const command = f.command(); f.bridge.admit(command, f.bridge.generation);
  f.settings.streamDeckEnabled = false; f.bridge.refresh(); await f.bridge.tail;
  assert.equal(f.calls.length, 0); assert.equal(f.bridge.session, null);
  assert.equal(f.sockets[0].closed, true); assert.equal(f.timers.size, 0);
});

test("reconnect changes the session and a changed world invalidates the old execution guard", async () => {
  const f = transportFixture(); await f.ready(); const first = f.bridge.session.id;
  f.game.world = { id: "world-b", title: "World B" }; f.bridge.changed();
  assert.notEqual(f.bridge.session.id, first); assert.equal(f.bridge.session.worldId, "world-b");
  assert.equal(f.bridge.state, "connecting");
});

test("malformed, binary and oversized messages are bounded; socket errors do not leak raw data", async () => {
  assert.throws(() => parseMessage("not json"));
  assert.throws(() => parseMessage(new Uint8Array(2)));
  assert.throws(() => parseMessage("x".repeat(MAX_MESSAGE_BYTES + 1)));
  assert.throws(() => parseMessage('{"protocol":2,"type":"command"}'));
  const f = transportFixture(); await f.ready(); f.bridge.ws.onmessage({ data: "private error content" });
  await f.bridge.incoming;
  assert.equal(f.bridge.state, "disconnected"); assert.equal(f.bridge.error, "invalidMessage");
});

test("loss of heartbeat disconnects and only schedules a bounded reconnect", async () => {
  const f = transportFixture(); await f.ready(); f.advance(46000);
  const heartbeat = [...f.timers.values()].find(timer => timer.delay === 15000); heartbeat.fn();
  assert.equal(f.bridge.state, "disconnected"); assert.equal(f.bridge.error, "heartbeatTimeout");
  assert([...f.timers.values()].some(timer => timer.delay === 1000));
});

function actionFixture() {
  const env = environment(), documents = new Map(), calls = [];
  const foundry = { documents: { collections: { Journal: { show: async (doc, options) => calls.push([doc.uuid, options]) } } } };
  const actions = new FoundryActions({ game: () => env.game, canvas: () => env.canvas, ui: () => env.ui,
    config: () => env.config, foundry: () => foundry, resolveUuid: async uuid => documents.get(uuid), overlay: env.overlay });
  let revision = 5;
  const execute = (action, parameters, extras = {}) => actions.execute({ action, parameters, selectionRevision: revision, ...extras },
    { guard: extras.guard ?? (() => {}), selectionRevision: () => revision });
  const add = doc => { documents.set(doc.uuid, doc); return doc; };
  return { ...env, actions, documents, calls, foundry, execute, add, setRevision: value => { revision = value; } };
}

test("one actor command resolves two fixed UUIDs and uses the selected user's assigned character", async () => {
  const f = actionFixture(); const calls = [];
  const alice = f.add(document("Actor", "alice", { sheet: { render: async () => calls.push("alice") } }));
  const bob = f.add(document("Actor", "bob", { sheet: { render: async () => calls.push("bob") } }));
  f.game.users = collection([{ id: "player", character: bob }]);
  await f.execute("actor.open", { actor: { uuid: alice.uuid } });
  await f.execute("actor.open", { actor: { uuid: bob.uuid } });
  await f.execute("actor.open", { actor: { source: "userCharacter", userId: "player" } });
  assert.deepEqual(calls, ["alice", "bob", "bob"]);
});

test("unknown, wrong-type, deleted, denied and unassigned references never fall back to another actor", async () => {
  const f = actionFixture();
  const scene = f.add(document("Scene", "wrong"));
  const denied = f.add(document("Actor", "denied", { testUserPermission: () => false }));
  for (const [actor, code] of [[{ uuid: "Actor.deleted" }, "missingDocument"], [{ uuid: scene.uuid }, "wrongDocumentType"],
    [{ uuid: denied.uuid }, "denied"], [{ source: "userCharacter", userId: "absent" }, "missingDocument"]])
    await assert.rejects(f.execute("actor.open", { actor }), { code });
  await assert.rejects(f.execute("toString", {}), { code: "unknownAction" });
  await assert.rejects(f.execute("actor.open", { actor: { uuid: "Actor.deleted" }, arbitraryPath: "system.hp" }), { code: "invalidParameters" });
});

test("UUID resolution is followed by a fresh consent/permission/selection check", async () => {
  const f = actionFixture(); let calls = 0, allowed = true;
  const actor = document("Actor", "late", { testUserPermission: () => allowed, sheet: { render: () => calls++ } });
  f.actions.resolveUuid = async () => actor;
  let guards = 0;
  await assert.rejects(f.execute("actor.open", { actor: { uuid: actor.uuid } },
    { guard: () => { if (++guards === 2) allowed = false; } }), { code: "denied" });
  assert.equal(calls, 0);
  f.canvas.tokens.controlled = [{ document: document("Token", "one", { actor }) }];
  await assert.rejects(f.execute("actor.open", { actor: { source: "selectedToken" } }, { selectionRevision: 4 }), { code: "staleSelection" });
  f.canvas.tokens.controlled.push({ document: document("Token", "two", { actor }) });
  await assert.rejects(f.execute("actor.open", { actor: { source: "selectedToken" } }), { code: "ambiguousTarget" });
});

test("a journal page opens through its parent sheet with exact pageId", async () => {
  const f = actionFixture(); const renders = [];
  const parent = document("JournalEntry", "journal", { sheet: { render: async options => renders.push(options) } });
  const page = f.add(document("JournalEntryPage", "page", { parent }));
  await f.execute("journal.open", { document: { uuid: page.uuid } });
  assert.deepEqual(renders, [{ force: true, pageId: "page" }]); assert.equal(f.calls.length, 0);
});

test("journal sharing names exact players or GMs and explicitly supports authorized reveal", async () => {
  const f = actionFixture(); const page = f.add(document("JournalEntryPage", "page"));
  f.game.users = collection([f.game.user, { id: "alice", isGM: false, active: true }, { id: "offline", isGM: false, active: false }]);
  await f.execute("journal.show", { document: { uuid: page.uuid }, audience: "users", users: ["alice"] });
  assert.deepEqual(f.calls.at(-1), [page.uuid, { users: ["alice"], force: false }]);
  await f.execute("journal.show", { document: { uuid: page.uuid }, audience: "gms" });
  assert.deepEqual(f.calls.at(-1)[1].users, ["gm"]);
  await f.execute("journal.show", { document: { uuid: page.uuid }, audience: "players", reveal: true });
  assert.deepEqual(f.calls.at(-1)[1], { users: ["alice"], force: true });
});

test("empty, offline, nonexistent or unauthorized journal recipients never become a broadcast", async () => {
  const f = actionFixture(); const page = f.add(document("JournalEntryPage", "page"));
  f.game.users = collection([{ id: "offline", active: false }, { id: "denied", active: true }]);
  page.testUserPermission = user => user.id === "gm";
  for (const users of [undefined, ["offline"], ["nonexistent"]])
    await assert.rejects(f.execute("journal.show", { document: { uuid: page.uuid }, audience: "users", ...(users ? { users } : {}) }), { code: "noRecipients" });
  await assert.rejects(f.execute("journal.show", { document: { uuid: page.uuid }, audience: "users", users: ["denied"] }), { code: "denied" });
  assert.equal(f.calls.length, 0);
});

test("macro context passes resolved actor/token objects without impersonation or source substitution", async () => {
  const f = actionFixture(); const actor = f.add(document("Actor", "alice"));
  const object = { id: "placeable" }; const token = f.add(document("Token", "token", { actor, object }));
  const contexts = [];
  const macro = f.add(document("Macro", "macro", { canExecute: true, execute: async context => contexts.push(context) }));
  await f.execute("macro.execute", { document: { uuid: macro.uuid }, actor: { uuid: actor.uuid }, token: { uuid: token.uuid } });
  assert.deepEqual(contexts, [{ actor, token: object }]); assert.equal(f.game.user.id, "gm");
  macro.canExecute = false;
  await assert.rejects(f.execute("macro.execute", { document: { uuid: macro.uuid } }), { code: "denied" });
});

test("native token bars adjust resources without accepting an arbitrary update path", async () => {
  const f = actionFixture(); const updates = [];
  const actor = document("Actor", "actor", { modifyTokenAttribute: async (...args) => updates.push(args) });
  const token = f.add(document("Token", "token", { actor, getBarAttribute: () =>
    ({ attribute: "attributes.hp", value: 10, max: 20, editable: true, type: "bar" }) }));
  await f.execute("token.resource", { token: { uuid: token.uuid }, bar: "bar1", amount: -5 });
  assert.deepEqual(updates, [["attributes.hp", -5, true, true]]);
  token.getBarAttribute = () => ({ editable: false, value: 10 });
  await assert.rejects(f.execute("token.resource", { token: { uuid: token.uuid }, bar: "bar1", amount: 5 }), { code: "unavailable" });
});

test("GM controls, action input bounds and configured status IDs are checked at execution", async () => {
  const f = actionFixture(); f.game.user.isGM = false;
  await assert.rejects(f.execute("game.pause", { paused: true }), { code: "denied" });
  f.game.user.isGM = true;
  const scene = f.add(document("Scene", "scene", { update: async () => {} }));
  await assert.rejects(f.execute("scene.darkness", { document: { uuid: scene.uuid }, value: 2 }), { code: "invalidParameters" });
  const actor = f.add(document("Actor", "actor", { toggleStatusEffect: async () => {} }));
  await assert.rejects(f.execute("actor.status", { actor: { uuid: actor.uuid }, status: "unknown", active: true }), { code: "unavailable" });
});

test("snapshot exposes only permitted UUID metadata, live bars and filtered initiative, with bounded catalogs", () => {
  const env = environment();
  const secret = document("Actor", "secret", { testUserPermission: () => false, system: { secret: "private actor data" } });
  const actor = document("Actor", "visible", { system: { secret: "private actor data" }, statuses: new Set(["prone"]) });
  env.game.actors = collection([actor, secret]);
  env.game.journal = collection([document("JournalEntry", "journal", { pages: collection([
    document("JournalEntryPage", "page", { text: { content: "private journal body" } })]) })]);
  const token = document("Token", "token", { actor, getBarAttribute: () => ({ value: 10, max: 20, editable: true }) });
  env.canvas.tokens.controlled = [{ document: token }]; env.canvas.scene = document("Scene", "scene", { tokens: collection([token]) });
  env.game.combat = document("Combat", "combat", { round: 1, turn: 0,
    combatant: { id: "a" }, turns: [document("Combatant", "a", { initiative: 10, token }),
      document("Combatant", "hidden", { hidden: true })] });
  env.game.user.isGM = false;
  env.game.macros = collection(Array.from({ length: CATALOG_LIMIT + 3 }, (_, index) => document("Macro", `macro-${index}`, { canExecute: true })));
  const snapshot = buildSnapshot({ ...env, selectionRevision: 4 });
  const json = JSON.stringify(snapshot);
  for (const value of ["private actor data", "private journal body", "Actor.secret", "Combatant.hidden"]) assert(!json.includes(value));
  assert.equal(snapshot.catalogs.macros.length, CATALOG_LIMIT); assert(snapshot.truncated.includes("macros"));
  assert.equal(snapshot.state.encounter.combatants.length, 1); assert.equal(snapshot.state.encounter.combatants[0].current, true);
  assert.deepEqual(snapshot.state.selected[0].bars[0], { id: "bar1", value: 10, max: 20, editable: true });
  assert.equal(snapshot.actions.find(action => action.id === "game.pause").available, false);
  assert.equal(snapshot.actions.find(action => action.id === "overlay.test").available, false);
});

test("deletion, changed assignments and connection state replace previously synchronized choices", () => {
  const env = environment(); const actor = document("Actor", "actor");
  env.game.actors = collection([actor]); env.game.user.character = actor;
  const first = buildSnapshot({ ...env, selectionRevision: 0 });
  assert.equal(first.catalogs.users[0].characterUuid, actor.uuid);
  env.game.actors = collection(); env.game.user.character = null;
  const second = buildSnapshot({ ...env, selectionRevision: 1 });
  assert.equal(second.catalogs.actors.length, 0); assert.equal(second.catalogs.users[0].characterUuid, null);
});

test("the combined UTF-8 snapshot stays bounded with long multibyte names across several catalogs", () => {
  const env = environment(); const name = "龍".repeat(128);
  for (const [key, type] of [["actors", "Actor"], ["scenes", "Scene"], ["macros", "Macro"], ["tables", "RollTable"],
    ["playlists", "Playlist"], ["journal", "JournalEntry"], ["combats", "Combat"]])
    env.game[key] = collection(Array.from({ length: CATALOG_LIMIT }, (_, index) =>
      document(type, `${key}-${index}`, { name, canExecute: true })));
  for (const playlist of env.game.playlists.contents) playlist.sounds = collection(Array.from({ length: 2 }, (_, index) =>
    document("PlaylistSound", `${playlist.id}-${index}`, { name })));
  for (const journal of env.game.journal.contents) journal.pages = collection(Array.from({ length: 2 }, (_, index) =>
    document("JournalEntryPage", `${journal.id}-${index}`, { name })));
  const snapshot = buildSnapshot({ ...env, selectionRevision: 0 });
  assert(new TextEncoder().encode(JSON.stringify(snapshot)).length < MAX_MESSAGE_BYTES - 2048);
  assert(snapshot.truncated.length > 0);
});

test("all action schemas are serializable, and none accepts raw script or arbitrary update paths", () => {
  assert(Object.keys(ACTIONS).length >= 25);
  assert(!JSON.stringify(ACTIONS).includes("script"));
  for (const action of Object.values(ACTIONS)) assert(!Object.hasOwn(action.inputs, "path"));
});

test("overlay availability requires a verified Foundry-device entitlement, not merely a stored credential", async () => {
  const f = transportFixture();
  f.overlay.access = () => ({ ok: true });
  f.overlay.diagnostics = async () => ({ ok: true, data: { ok: true, tokenKind: "foundry", entitled: false } });
  await f.ready();
  assert.equal(f.bridge.capabilities.overlay.entitled, false);
  assert.equal(f.sent.at(-1).actions.find(action => action.id === "overlay.test").available, false);
  f.overlay.diagnostics = async () => ({ ok: true, data: { ok: true, tokenKind: "stream-deck", entitled: true } });
  await f.bridge.verifyCapabilities(); f.flushChanges();
  assert.equal(f.bridge.capabilities.overlay.verification, "unavailable");
  assert.equal(f.bridge.capabilities.overlay.entitled, null);
  f.overlay.diagnostics = async () => ({ ok: true, data: { ok: true, tokenKind: "foundry", entitled: true } });
  await f.bridge.verifyCapabilities(); f.flushChanges();
  assert.equal(f.sent.at(-1).actions.find(action => action.id === "overlay.test").available, true);
});

test("disconnect aborts a capability verification and ignores a late entitlement result", async () => {
  const f = transportFixture(); let finish;
  f.overlay.access = () => ({ ok: true });
  f.overlay.diagnostics = () => new Promise(resolve => { finish = resolve; });
  await f.ready(); const controller = f.bridge.capabilityController;
  f.settings.streamDeckEnabled = false; f.bridge.refresh();
  assert.equal(controller.signal.aborted, true);
  finish({ ok: true, data: { ok: true, tokenKind: "foundry", entitled: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.bridge.capabilities.overlay.entitled, null); assert.equal(f.bridge.state, "disabled");
});

test("a missing sync acknowledgement times out without accepting a command", async () => {
  const f = transportFixture(); await f.handshake();
  const timeout = f.timers.get(f.bridge.ackTimer); timeout.fn();
  assert.equal(f.bridge.state, "disconnected"); assert.equal(f.bridge.error, "syncTimeout");
  assert.equal(f.calls.length, 0);
});

test("V14 scene, playlist, sidebar and tool handlers invoke the native operations with validated parameters", async () => {
  const f = actionFixture(); const calls = [];
  const scene = f.add(document("Scene", "scene", { view: async () => calls.push("view"), activate: async () => calls.push("activate"),
    update: async update => calls.push(update) }));
  f.game.scenes.preload = async (id, options) => calls.push([id, options]);
  await f.execute("scene.view", { document: { uuid: scene.uuid } });
  await f.execute("scene.activate", { document: { uuid: scene.uuid } });
  await f.execute("scene.darkness", { document: { uuid: scene.uuid }, value: 0.8 });
  await f.execute("scene.preload", { document: { uuid: scene.uuid } });
  assert.deepEqual(calls, ["view", "activate", { "environment.darknessLevel": 0.8 }, ["scene", { broadcast: true }]]);
  const playlist = f.add(document("Playlist", "music", { playSound: async sound => calls.push(sound.uuid),
    stopSound: async sound => calls.push(sound.uuid), stopAll: async () => calls.push("stop"),
    playNext: async (_, options) => calls.push(options) }));
  const sound = f.add(document("PlaylistSound", "sound", { parent: playlist, update: async update => calls.push(update) }));
  await f.execute("playlist.play", { document: { uuid: sound.uuid }, playing: true });
  await f.execute("playlist.volume", { document: { uuid: sound.uuid }, value: 0.4 });
  await f.execute("playlist.next", { document: { uuid: playlist.uuid }, direction: "previous" });
  await f.execute("playlist.stop", { document: { uuid: playlist.uuid } });
  assert.deepEqual(calls.slice(-4), [sound.uuid, { volume: 0.4 }, { direction: -1 }, "stop"]);
  f.ui.sidebar.changeTab = (...args) => calls.push(args);
  await f.execute("sidebar.tab", { tab: "chat" }); assert.deepEqual(calls.at(-1), ["chat", "primary"]);
  f.ui.controls.controls = { token: { name: "token", tools: { select: { name: "select", visible: true } } } };
  f.ui.controls.activate = async options => calls.push(options);
  await f.execute("canvas.tool", { control: "token", tool: "select" });
  assert.deepEqual(calls.at(-1), { control: "token", tool: "select" });
  await assert.rejects(f.execute("canvas.tool", { control: "token", tool: "unknown" }), { code: "unavailable" });
});

test("native dice and table commands preserve private modes and bound nested dice work", async () => {
  const f = actionFixture(); const messages = [];
  f.foundry.documents.ChatMessage = { getSpeaker: () => ({ alias: "GM" }) };
  f.foundry.dice = { Roll: class {
    static validate() { return true; }
    constructor(formula) { this.formula = formula; this.dice = []; }
    async evaluate() { this.total = 10; }
    async toMessage(data, options) { messages.push(options); }
  } };
  await f.execute("dice.roll", { formula: "(2d6)+4", mode: "blind" });
  assert.deepEqual(messages, [{ messageMode: "blind" }]);
  for (const formula of ["(100000d6)", "1d100000", "1d6x", "1d6**10", "51d6+51d6"])
    await assert.rejects(f.execute("dice.roll", { formula, mode: "public" }), { code: "invalidParameters" });
  const table = f.add(document("RollTable", "table", { draw: async options => messages.push(options) }));
  await f.execute("table.draw", { document: { uuid: table.uuid }, mode: "gm" });
  assert.deepEqual(messages.at(-1), { messageMode: "gm" });
});

// Mirrors V14 DialogV2.confirm/wait/_onSubmit: Yes and No keep their callbacks (true/false by default), closing
// resolves null. A callback that throws leaves the real dialog open, every button disabled and wait() pending;
// the fake records that as `stuck` and resolves undefined so a test can still finish and assert it never happens.
function confirmDialog() {
  const dialogs = [];
  const confirm = ({ yes = {}, no = {}, ...config } = {}) => new Promise(resolve => {
    const dialog = { config, open: true, stuck: false };
    dialogs.push(dialog);
    const buttons = { yes: { callback: () => true, ...yes }, no: { callback: () => false, ...no } };
    dialog.answer = async choice => {
      if (choice === "close") { dialog.open = false; resolve(null); return; }
      try { const result = await buttons[choice].callback(); dialog.open = false; resolve(result); }
      catch { dialog.stuck = true; resolve(undefined); }
    };
  });
  return { confirm, dialogs };
}
async function settle(condition) {
  for (let turn = 0; turn < 100 && !condition(); turn++) await new Promise(resolve => setImmediate(resolve));
  assert(condition());
}
const deletableCombat = (id, deleted, documents) => {
  const combat = document("Combat", id, { canUserModify: (user, action) => user.isGM === true && action === "delete",
    delete: async () => { deleted.push(id); documents.delete(combat.uuid); return combat; } });
  documents.set(combat.uuid, combat); return combat;
};

test("combat end keeps the pre-dialog guard strict, and No or closing the dialog cancels without deleting", async () => {
  const f = actionFixture(), deleted = [], dialog = confirmDialog();
  const combat = deletableCombat("combat", deleted, f.documents);
  f.foundry.utils = { escapeHTML: value => value };
  f.foundry.applications = { api: { DialogV2: dialog } };
  const stale = ({ confirmed } = {}) => { if (!confirmed) throw Object.assign(new Error(), { code: "staleState" }); };
  await assert.rejects(f.execute("combat.end", { document: { uuid: combat.uuid } }, { guard: stale }), { code: "staleState" });
  assert.equal(dialog.dialogs.length, 0);
  for (const choice of ["no", "close"]) {
    const ending = f.execute("combat.end", { document: { uuid: combat.uuid } });
    await settle(() => dialog.dialogs.at(-1)?.open === true); await dialog.dialogs.at(-1).answer(choice);
    await assert.rejects(ending, { code: "cancelled" });
  }
  combat.canUserModify = () => false;
  await assert.rejects(f.execute("combat.end", { document: { uuid: combat.uuid } }), { code: "denied" });
  assert.deepEqual(deleted, []); assert.equal(dialog.dialogs.length, 2);
  assert(dialog.dialogs.every(entry => !entry.open && !entry.stuck));
});

/** Real bridge, variable operation and native handlers, as the module wires them, with a scripted end-combat dialog. */
function combatBridge({ variables = true, store } = {}) {
  const documents = new Map(), deleted = [], pauses = [], outcomes = [], dialog = confirmDialog(), hooks = {};
  let service;
  const f = transportFixture({ wire: (env, settings) => {
    if (variables) { env.game.settings.settings = new Map([["jdr-ninja.variablesWorld", {}]]); settings.variablesWorld = store; }
    env.game.user.role = 4;
    // Foundry's Setting write, then its onChange invalidation as scripts/variables/settings.js registers it.
    env.game.settings.set = async (_module, key, value) => { settings[key] = JSON.parse(JSON.stringify(value));
      service.invalidate(key === "variablesWorld" ? "world" : "personal"); return value; };
    service = new VariableService({ game: () => env.game, canvas: () => env.canvas, resolveUuid: async uuid => documents.get(uuid),
      resolveSync: uuid => documents.get(uuid), crypto: webcrypto });
    const foundry = { applications: { api: { DialogV2: dialog } }, utils: { escapeHTML: value => value } };
    const native = new FoundryActions({ game: () => env.game, canvas: () => env.canvas, ui: () => env.ui, config: () => env.config,
      foundry: () => foundry, resolveUuid: async uuid => documents.get(uuid), overlay: env.overlay });
    const actions = new VariableActions({ native, variables: service });
    return { variables: service, actions: { execute: async (...args) => {
      try { const result = await actions.execute(...args); outcomes.push(result.code); return result; }
      catch (error) { outcomes.push(error.code); throw error; }
    } } };
  } });
  f.bridge.registerHooks({ on: (event, handler) => { hooks[event] = handler; } });
  f.game.togglePause = paused => pauses.push(paused);
  const combat = id => deletableCombat(id, deleted, documents);
  const result = id => f.sent.find(message => message.type === "result" && message.id === id)?.code;
  const open = async () => { await settle(() => dialog.dialogs.at(-1)?.open === true); return dialog.dialogs.at(-1); };
  return { ...f, documents, deleted, pauses, outcomes, dialog, hooks, combat, result, open, service: () => service };
}

test("an explicit Yes ends combat after the table changed during the dialog, and the queue moves on", async () => {
  for (const variables of [true, false]) {
    const f = combatBridge({ variables }); await f.ready();
    const combat = f.combat("combat");
    const end = f.command({ id: "endcombat01", action: "combat.end", parameters: { document: { uuid: combat.uuid } } });
    const queued = f.command({ id: "pausegame01" });
    await f.send(end); await f.send(queued);
    const dialog = await f.open();
    // Table activity while the GM reads the dialog: every hook moves both epochs, and the deck's command expires.
    f.hooks.updateToken(); f.hooks.updateCombat(); f.hooks.controlToken(); f.advance(31000);
    await dialog.answer("yes"); await f.bridge.tail;
    assert.deepEqual(f.deleted, ["combat"]); assert.equal(f.result(end.id), "executed");
    assert.equal(dialog.open, false); assert.equal(dialog.stuck, false);
    // The press queued behind the dialog still runs, with its own guard as strict as before.
    assert.equal(f.result(queued.id), "staleState"); assert.deepEqual(f.pauses, []);
    f.flushChanges(); await f.send({ type: "syncAck", revision: f.bridge.revision });
    const fresh = f.command({ id: "pausegame02" }); await f.send(fresh); await f.bridge.tail;
    assert.equal(f.result(fresh.id), "executed"); assert.deepEqual(f.pauses, [true]);
  }
});

test("disabling Stream Deck or replacing its session during the dialog never ends combat", async () => {
  for (const [variables, replace] of [[true, false], [true, true], [false, false], [false, true]]) {
    const f = combatBridge({ variables }); await f.ready();
    const combat = f.combat("combat");
    await f.send(f.command({ id: "endcombat01", action: "combat.end", parameters: { document: { uuid: combat.uuid } } }));
    const tail = f.bridge.tail, dialog = await f.open();
    if (!replace) f.settings.streamDeckEnabled = false;
    f.bridge.refresh();
    await dialog.answer("yes"); await tail;
    assert.deepEqual(f.deleted, []); assert.deepEqual(f.outcomes, ["cancelled"]);
    assert.equal(dialog.open, false); assert.equal(dialog.stuck, false);
    assert(!f.sent.some(message => message.type === "result"));
  }
});

test("a combat deleted elsewhere during the dialog fails without throwing from the dialog", async () => {
  for (const variables of [true, false]) {
    const f = combatBridge({ variables }); await f.ready();
    const combat = f.combat("combat");
    const end = f.command({ id: "endcombat01", action: "combat.end", parameters: { document: { uuid: combat.uuid } } });
    await f.send(end); const dialog = await f.open();
    f.documents.delete(combat.uuid); f.hooks.deleteCombat();
    await dialog.answer("yes"); await f.bridge.tail;
    assert.deepEqual(f.deleted, []); assert.equal(f.result(end.id), "missingDocument");
    assert.equal(dialog.open, false); assert.equal(dialog.stuck, false);
  }
});

test("a variable-bound combat ends after unrelated variable edits, but not once its variable points elsewhere", async () => {
  const ref = id => ({ source: "variable", scope: "world", id });
  const fight = { id: "fight", name: "Fight", type: "Combat", kind: "stored", current: { uuid: "Combat.combat" }, default: null, constraints: {} };
  const count = { id: "count", name: "Count", type: "number", kind: "stored", current: 1, default: 1, constraints: {} };
  for (const combined of [false, true]) for (const rebind of [false, true]) {
    const store = { ...emptyStore(), controller: "gm", variables: [fight, count] };
    const f = combatBridge({ store }); await f.ready(); f.bridge.extensions = { variables: 1 };
    const combat = f.combat("combat"); f.combat("other");
    const target = { document: ref("fight") };
    const end = f.command({ id: "endcombat01", extensions: { variables: 1 }, ...(combined
      ? { action: "variable.applyAndExecute", parameters: { mutations: [{ operation: "set", variable: ref("count"), value: 5 }],
        action: { action: "combat.end", parameters: target } } }
      : { action: "combat.end", parameters: target }) });
    await f.send(end); const dialog = await f.open();
    // Someone edits the variables while the dialog is open: another variable, or the one bound to the combat.
    const current = f.settings.variablesWorld;
    f.settings.variablesWorld = { ...current, revision: current.revision + 1, variables: current.variables.map(v => rebind
      ? (v.id === "fight" ? { ...v, current: { uuid: "Combat.other" } } : v) : (v.id === "count" ? { ...v, current: 9 } : v)) };
    f.service().invalidate("world");
    await dialog.answer("yes"); await f.bridge.tail;
    const result = f.sent.find(message => message.type === "result" && message.id === end.id);
    assert.deepEqual(f.deleted, rebind ? [] : ["combat"]); assert.equal(f.documents.has(combat.uuid), rebind);
    assert.equal(result.code, rebind ? (combined ? "partial" : "staleState") : "executed");
    if (combined) assert.deepEqual([result.details.variableCommit, result.details.execution], ["committed", rebind ? "failed" : "completed"]);
    assert.equal(dialog.open, false); assert.equal(dialog.stuck, false);
  }
});

test("the real Stream Deck panel template is localized and escapes generated keys and statuses", async () => {
  const source = await readFile(new URL("../templates/stream-deck.hbs", import.meta.url), "utf8");
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const copy = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    const handlebars = Handlebars.create(); handlebars.registerHelper("localize", key => copy[key] ?? key);
    const html = handlebars.compile(source)({ enabled: false, url: "ws://localhost:19114/jdr-ninja", status: "<script>", generated: '"<script>' });
    assert(!html.includes("JDRNINJA.")); assert(!html.includes("<script>"));
    assert(html.includes('name="streamDeckEnabled" type="checkbox"'));
    assert(!html.includes('type="checkbox" checked'));
    assert(html.includes('name="streamDeckKey" type="password"'));
  }
});

class ForcedDeletion {}
// Same behavior as the V14 helpers the update builder relies on.
const v14Utils = {
  getProperty(object, key) {
    if (!key || !object) return undefined;
    if (key in object) return object[key];
    let target = object;
    for (const part of key.split(".")) {
      if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
      if (part in target) target = target[part]; else return undefined;
    }
    return target;
  },
  setProperty(object, key, value) {
    const parts = key.split("."), last = parts.pop();
    parts.reduce((target, part) => target[part] ??= {}, object)[last] = value;
  },
};
const UPDATE_CAPABILITY = { version: 1, operations: ["set", "increment", "decrement", "toggle", "unset"], maxChanges: 16 };
const change = (path, operation, value) => ({ path, operation, ...(value === undefined ? {} : { value }) });
const updateByteLength = rows => new TextEncoder().encode(JSON.stringify(rows)).length;

function updateFixture() {
  const f = actionFixture();
  f.foundry.utils = v14Utils; f.foundry.data = { operators: { ForcedDeletion } };
  // The prepared `system` of these documents differs from their `_source`, as an Active Effect would make it.
  const edit = (type, id, source, overrides = {}) => f.add(document(type, id, { _source: source, updates: [], checks: [],
    canUserModify(user, action, data) { this.checks.push([user, action, data]); return true; },
    async update(data) { this.updates.push(data); }, ...overrides }));
  const run = (target, changes, extras) => f.execute("document.update", { document: target, changes }, extras);
  return { ...f, edit, run };
}

test("snapshot lists document.update only for a companion that negotiated updates, and nothing else changes", () => {
  const env = environment(), variables = { variables: [], lists: [], state: [], revisions: { world: 0, personal: 0 }, controller: "gm" };
  const ids = snapshot => snapshot.actions.map(action => action.id);
  const legacy = buildSnapshot({ ...env, selectionRevision: 0 });
  assert.deepEqual(ids(legacy), Object.keys(ACTIONS).filter(id => id !== "document.update"));
  assert.equal(legacy.capabilities.updates, undefined);
  for (const extensions of [{}, { variables: 1 }, { updates: 2 }]) {
    const other = buildSnapshot({ ...env, selectionRevision: 0, extensions, ...(extensions.variables ? { variables } : {}) });
    assert(!ids(other).includes("document.update")); assert.equal(other.capabilities.updates, undefined);
  }
  const capabilities = { overlay: { verification: "unchecked", entitled: null } };
  const updates = buildSnapshot({ ...env, selectionRevision: 0, capabilities, extensions: { updates: 1 } });
  assert.deepEqual(updates.actions.find(action => action.id === "document.update"), { id: "document.update", advanced: true,
    inputs: { document: { type: "anyDocument" }, changes: { type: "changes", max: 16 } }, available: true, authority: "foundryPermissions" });
  assert.deepEqual(updates.capabilities.updates, UPDATE_CAPABILITY); assert.equal(capabilities.updates, undefined);
  // Apart from the action and its capability, a peer that negotiated updates sees today's snapshot.
  updates.actions = updates.actions.filter(action => action.id !== "document.update"); delete updates.capabilities.updates;
  assert.deepEqual(updates, legacy);
  assert.deepEqual(ACTIONS["document.update"].inputs, { document: { type: "anyDocument" }, changes: { type: "changes", max: 16 } });
});

test("with variables also negotiated, document.update accepts variables and templates for its target and changes", () => {
  const env = environment(), variables = { variables: [], lists: [], state: [], revisions: { world: 0, personal: 0 }, controller: "gm" };
  const snapshot = buildSnapshot({ ...env, selectionRevision: 0, variables, extensions: { variables: 1, updates: 1 } });
  const action = snapshot.actions.find(entry => entry.id === "document.update");
  assert.deepEqual(action, { id: "document.update", advanced: true, available: true, authority: "foundryPermissions",
    inputs: { document: { type: "anyDocument", variable: true, template: true },
      changes: { type: "changes", max: 16, variable: true, template: true } } });
  assert.deepEqual(snapshot.capabilities.updates, UPDATE_CAPABILITY); assert.equal(snapshot.capabilities.variables.version, 1);
  assert.equal(ACTIONS["document.update"].inputs.document.variable, undefined);
});

test("hello offers both extensions and authentication keeps each one independently", async () => {
  const projection = { variables: [], lists: [], state: [], revisions: { world: 0, personal: 0 }, controller: null };
  for (const [offered, expected] of [[undefined, {}], [{}, {}], [{ variables: 1 }, { variables: 1 }], [{ updates: 1 }, { updates: 1 }],
    [{ variables: 1, updates: 1 }, { variables: 1, updates: 1 }], [{ variables: true, updates: 2 }, {}]]) {
    const f = transportFixture({ wire: () => ({ variables: { projection: async () => projection, operation: null } }) });
    await f.handshake(offered); await settle(() => f.sent.some(message => message.actions));
    assert.deepEqual(f.sent[0].extensions, { variables: 1, updates: 1 }); assert.deepEqual(f.bridge.extensions, expected);
    const snapshot = f.sent.findLast(message => message.actions);
    assert.equal(snapshot.actions.some(action => action.id === "document.update"), expected.updates === 1);
    assert.deepEqual(snapshot.capabilities.updates, expected.updates === 1 ? UPDATE_CAPABILITY : undefined);
    assert.equal(snapshot.capabilities.variables !== undefined, expected.variables === 1);
  }
});

test("document.update commands, direct or inside applyAndExecute, need the negotiated updates extension", async () => {
  const parameters = { document: { uuid: "Actor.a" }, changes: [change("system.x", "set", 1)] };
  const wrapped = { mutations: [{ operation: "toggle", variable: { source: "variable", scope: "world", id: "a" } }],
    action: { action: "document.update", parameters } };
  const direct = ["document.update", parameters], combined = ["variable.applyAndExecute", wrapped];
  for (const [[action, body], negotiated, offered, code] of [
    [direct, {}, undefined, "unsupportedExtension"], [direct, {}, { updates: 1 }, "unsupportedExtension"],
    [direct, { updates: 1 }, undefined, "unsupportedExtension"], [direct, { updates: 1 }, { variables: 1 }, "unsupportedExtension"],
    [direct, { variables: 1 }, { variables: 1, updates: 1 }, "unsupportedExtension"], [direct, { updates: 1 }, { updates: 1 }, "executed"],
    [combined, { variables: 1 }, { variables: 1 }, "unsupportedExtension"], [combined, { updates: 1 }, { updates: 1 }, "unsupportedExtension"],
    [combined, { variables: 1 }, { variables: 1, updates: 1 }, "unsupportedExtension"],
    [combined, { variables: 1, updates: 1 }, { variables: 1 }, "unsupportedExtension"],
    [combined, { variables: 1, updates: 1 }, { variables: 1, updates: 1 }, "executed"],
  ]) {
    const f = transportFixture(); await f.ready(); f.bridge.extensions = negotiated;
    await f.send(f.command({ id: "update0001", action, parameters: body, ...(offered ? { extensions: offered } : {}) })); await f.bridge.tail;
    assert.equal(f.sent.at(-1).code, code, JSON.stringify([action, negotiated, offered])); assert.equal(f.calls.length, code === "executed" ? 1 : 0);
    if (code !== "executed") assert(!f.sent.some(message => message.type === "accepted"));
  }
});

test("document.update builds each operation as a nested update from source data and sends it once", async () => {
  const f = updateFixture(), deep = { list: [1, { nested: null }], text: "é" };
  const hero = f.edit("Actor", "hero", { system: { hp: { value: 10, max: 20 }, shield: false, note: "old", temp: 3 }, flags: {} },
    { system: { hp: { value: 999, max: 999 }, shield: true, note: "derived" } });
  const result = await f.run({ uuid: hero.uuid }, [change("system.hp.value", "increment", 5), change("system.hp.max", "decrement", 0.5),
    change("system.shield", "toggle"), change("system.note", "set", "new"), change("system.temp", "unset"), change("flags.world.deep", "set", deep)]);
  assert.equal(result.code, "executed"); assert.equal(hero.updates.length, 1);
  const [update] = hero.updates;
  assert.deepEqual(Object.keys(update).sort(), ["flags", "system"]);
  assert.deepEqual(Object.keys(update.system).sort(), ["hp", "note", "shield", "temp"]);
  assert.deepEqual(update.system.hp, { value: 15, max: 19.5 }); assert.equal(update.system.shield, true); assert.equal(update.system.note, "new");
  assert(update.system.temp instanceof ForcedDeletion);
  assert.deepEqual(update.flags, { world: { deep } }); assert.notEqual(update.flags.world.deep, deep);
  // Foundry decides on exactly the data it is then given.
  assert(hero.checks.length > 0 && hero.checks.every(([user, action]) => user === f.game.user && action === "update"));
  assert.deepEqual(hero.checks.at(-1)[2], update);
  // Paths missing from the source stay missing: set creates them, unset leaves a deletion, increment refuses.
  await f.run({ uuid: hero.uuid }, [change("system.absent.deep", "set", 1), change("system.absent2", "unset")]);
  assert.deepEqual(Object.keys(hero.updates.at(-1).system.absent), ["deep"]);
  await assert.rejects(f.run({ uuid: hero.uuid }, [change("system.absent.deep", "increment", 1)]), { code: "wrongValueType" });
  assert.equal(hero.updates.length, 2);
});

test("document.update stops at Foundry's own update permission and does not ask for observer access", async () => {
  const f = updateFixture(), seen = []; let allowed = false;
  const sword = f.edit("Item", "sword", { system: { qty: 1 } }, { testUserPermission: () => false,
    canUserModify: (user, action, data) => { seen.push([user, action, data]); return allowed; } });
  const changes = [change("system.qty", "increment", 1)];
  await assert.rejects(f.run({ uuid: sword.uuid }, changes), { code: "denied" });
  assert.equal(sword.updates.length, 0); assert.deepEqual(seen, [[f.game.user, "update", { system: { qty: 2 } }]]);
  allowed = true; assert.equal((await f.run(sword.uuid, changes)).code, "executed");
  assert.deepEqual(sword.updates, [{ system: { qty: 2 } }]);
  // A document that cannot answer, or cannot be updated, is refused rather than trusted.
  sword.canUserModify = undefined; await assert.rejects(f.run(sword.uuid, changes), { code: "denied" });
  sword.canUserModify = () => true; sword.update = undefined; await assert.rejects(f.run(sword.uuid, changes), { code: "unavailable" });
  sword.update = async () => {}; sword._source = undefined; await assert.rejects(f.run(sword.uuid, changes), { code: "unavailable" });
  f.game.user.isGM = false; sword._source = { system: { qty: 1 } }; assert.equal((await f.run(sword.uuid, changes)).code, "executed");
});

test("document.update reads source numbers and booleans strictly and refuses a non-finite result", async () => {
  const f = updateFixture();
  const item = f.edit("Item", "gear", { system: { text: "5", yes: true, zero: 0, big: Number.MAX_VALUE, nothing: null, nested: { n: 1 } } });
  for (const [row, code] of [[change("system.text", "increment", 1), "wrongValueType"], [change("system.nothing", "decrement", 1), "wrongValueType"],
    [change("system.missing", "increment", 1), "wrongValueType"], [change("system.yes", "increment", 1), "wrongValueType"],
    [change("system.nested", "decrement", 1), "wrongValueType"], [change("system.zero", "toggle"), "wrongValueType"],
    [change("system.text", "toggle"), "wrongValueType"], [change("system.missing", "toggle"), "wrongValueType"],
    [change("system.big", "increment", Number.MAX_VALUE), "outOfBounds"], [change("system.big", "decrement", -Number.MAX_VALUE), "outOfBounds"]])
    await assert.rejects(f.run({ uuid: item.uuid }, [row]), { code }, JSON.stringify(row));
  assert.equal(item.updates.length, 0);
  await f.run({ uuid: item.uuid }, [change("system.zero", "decrement", 1.5), change("system.yes", "toggle")]);
  assert.deepEqual(item.updates, [{ system: { zero: -1.5, yes: false } }]);
});

test("document.update refuses malformed changes before any permission check or update", async () => {
  const f = updateFixture(), item = f.edit("Item", "gear", { system: {} }), target = { uuid: item.uuid };
  const set = (value, path = "a") => [{ path, operation: "set", value }];
  const cases = [undefined, null, "system.a", {}, [], [null], ["system.a"], [[]], Array.from({ length: 17 }, (_, index) => change(`f${index}`, "unset")),
    [{ operation: "unset" }], [{ path: "a" }], [{ path: 5, operation: "unset" }], [change("", "unset")], [change("a".repeat(257), "unset")],
    [change("a..b", "unset")], [change(".a", "unset")], [change("a.", "unset")], [change("a.__proto__.b", "unset")],
    [change("constructor", "unset")], [change("a.prototype", "unset")], [change("a.b", "unset"), change("a.b", "set", 1)],
    [change("a", "unset"), change("a.b", "unset")], [change("a.b", "unset"), change("a", "unset")],
    [change("a", "replace")], [{ path: "a", operation: "unset", extra: 1 }], [{ path: "a", operation: "set" }], set(undefined),
    set(NaN), set(Infinity), set(() => 1), set(new Date()), set({ nested: [undefined] }), set([1, , 2]), set({ map: new Map() }),
    set(Symbol("a")), set(1n), set(JSON.parse('{"inner":{"__proto__":{"polluted":true}}}')), set(Object.create({ inherited: 1 })),
    [{ path: "a", operation: "increment" }], [change("a", "increment", "1")], [change("a", "increment", NaN)],
    [change("a", "decrement", Infinity)], [change("a", "increment", null)], [change("a", "decrement", true)],
    [{ path: "a", operation: "toggle", value: true }], [{ path: "a", operation: "unset", value: null }]];
  for (const [index, changes] of cases.entries()) await assert.rejects(f.run(target, changes), error => {
    assert.equal(error.code, "invalidParameters", `case ${index}`); return true; });
  assert.equal(item.checks.length, 0); assert.equal(item.updates.length, 0);
  // Exactly the allowed shapes pass, including every JSON value kind.
  await f.run(target, [...["string", 0, -1.5, true, false, null, [], {}, [1, [2, { a: null }]], { a: { b: [true] } }].map((value, index) => set(value, `v${index}`)[0]),
    change("x.y", "unset")]);
  assert.equal(item.updates.length, 1);
});

test("document.update bounds the serialized changes, including hostile depth and cycles", async () => {
  const f = updateFixture(), item = f.edit("Item", "gear", { system: {} }), target = { uuid: item.uuid };
  const room = 65536 - updateByteLength([change("a", "set", "")]);
  await f.run(target, [change("a", "set", "x".repeat(room))]); assert.equal(item.updates.length, 1);
  const cycle = {}; cycle.self = cycle; const nest = levels => { let value = []; for (let level = 0; level < levels; level++) value = [value]; return value; };
  for (const value of ["x".repeat(room + 1), "é".repeat(room / 2 + 1), Array.from({ length: 70000 }, () => 1), cycle, nest(60000), nest(100000)])
    await assert.rejects(f.run(target, [change("a", "set", value)]), { code: "capacity" });
  assert.equal(item.updates.length, 1);
});

test("document.update targets any document type through a UUID string, a UUID object or an assigned character", async () => {
  const f = updateFixture(), changes = [change("name", "set", "Renamed")];
  const hero = f.edit("Actor", "hero", { name: "Hero" }), sword = f.edit("Item", "sword", { name: "Sword" });
  const folder = f.edit("Folder", "folder", { name: "Folder" }), scene = f.edit("Scene", "scene", { name: "Scene" });
  f.game.users = collection([{ id: "player", character: hero }]);
  for (const [target, doc] of [[hero.uuid, hero], [{ uuid: sword.uuid }, sword], [folder.uuid, folder], [{ uuid: scene.uuid }, scene],
    [{ source: "userCharacter", userId: "player" }, hero]]) {
    const before = doc.updates.length; await f.run(target, changes);
    assert.equal(doc.updates.length, before + 1, JSON.stringify(target));
  }
  for (const [target, code] of [["Item.absent", "missingDocument"], [{ uuid: "Item.absent" }, "missingDocument"], ["x".repeat(512), "missingDocument"],
    [{ source: "userCharacter", userId: "absent" }, "missingDocument"], ["x".repeat(513), "invalidParameters"], ["", "invalidParameters"],
    [5, "invalidParameters"], [null, "invalidParameters"], [undefined, "invalidParameters"], [[], "invalidParameters"], [{}, "invalidParameters"],
    [{ uuid: "" }, "invalidParameters"], [{ uuid: sword.uuid, extra: true }, "invalidParameters"], [{ uuid: 5 }, "invalidParameters"],
    [{ source: "selectedToken", uuid: sword.uuid }, "invalidParameters"], [{ source: "selectedTokenActor", extra: 1 }, "invalidParameters"],
    [{ source: "userCharacter" }, "invalidParameters"], [{ source: "userCharacter", userId: "player", uuid: "x" }, "invalidParameters"],
    [{ source: "unknown" }, "invalidParameters"], [{ source: "variable", scope: "world", id: "x" }, "invalidParameters"]])
    await assert.rejects(f.run(target, changes), { code }, JSON.stringify(target));
  assert.equal(hero.updates.length + sword.updates.length, 3);
});

test("document.update resolves the selected token or its actor under the same single-selection rules", async () => {
  const f = updateFixture(), changes = [change("name", "set", "Renamed")];
  const actor = f.edit("Actor", "synthetic", { name: "Actor" }), token = f.edit("Token", "one", { name: "Token" }, { actor });
  const other = f.edit("Token", "two", { name: "Other" }, { actor: f.edit("Actor", "second", { name: "Second" }) });
  f.canvas.tokens.controlled = [{ document: token }];
  await f.run({ source: "selectedToken" }, changes); await f.run({ source: "selectedTokenActor" }, changes);
  assert.equal(token.updates.length, 1); assert.equal(actor.updates.length, 1);
  await assert.rejects(f.run({ source: "selectedTokenActor" }, changes, { selectionRevision: 4 }), { code: "staleSelection" });
  await assert.rejects(f.run({ source: "selectedToken" }, changes, { selectionRevision: 4 }), { code: "staleSelection" });
  token.actor = null; await assert.rejects(f.run({ source: "selectedTokenActor" }, changes), { code: "missingDocument" }); token.actor = actor;
  f.canvas.tokens.controlled = [{ document: token }, { document: other }];
  for (const source of ["selectedToken", "selectedTokenActor"]) await assert.rejects(f.run({ source }, changes), { code: "ambiguousTarget" });
  f.canvas.tokens.controlled = [];
  for (const source of ["selectedToken", "selectedTokenActor"]) await assert.rejects(f.run({ source }, changes), { code: "ambiguousTarget" });
  // The selection or the token's actor changing between preparation and dispatch never retargets the update.
  for (const [source, retarget] of [["selectedToken", () => { f.canvas.tokens.controlled = [{ document: other }]; }],
    ["selectedTokenActor", () => { f.canvas.tokens.controlled = [{ document: other }]; }], ["selectedTokenActor", () => { token.actor = other.actor; }]]) {
    f.canvas.tokens.controlled = [{ document: token }]; token.actor = actor; let guards = 0;
    await assert.rejects(f.run({ source }, changes, { guard: () => { if (++guards === 3) retarget(); } }), { code: "staleSelection" });
  }
  assert.equal(token.updates.length + other.updates.length + actor.updates.length + other.actor.updates.length, 2);
});

test("document.update rebuilds its update from the current source and permission right before sending", async () => {
  const f = updateFixture(), changes = [change("system.hp", "increment", 1)];
  const hero = f.edit("Actor", "hero", { system: { hp: 1 } });
  const prepared = await f.actions.prepare({ action: "document.update", parameters: { document: hero.uuid, changes }, selectionRevision: 5 },
    { selectionRevision: () => 5 });
  assert.equal(hero.updates.length, 0); hero._source.system.hp = 40;
  await f.actions.dispatch(prepared, { selectionRevision: () => 5 });
  assert.deepEqual(hero.updates, [{ system: { hp: 41 } }]); assert.notEqual(hero.updates[0], hero.checks[0][2]);
  hero._source.system.hp = "broken"; await assert.rejects(f.actions.dispatch(prepared, { selectionRevision: () => 5 }), { code: "wrongValueType" });
  hero._source.system.hp = 2; hero.canUserModify = () => false;
  await assert.rejects(f.actions.dispatch(prepared, { selectionRevision: () => 5 }), { code: "denied" });
  assert.equal(hero.updates.length, 1);
  // A confirmation binds a UUID string to the very same document.
  hero.canUserModify = () => true; await f.actions.confirmed(prepared, () => {});
  f.documents.set(hero.uuid, document("Actor", "other"));
  await assert.rejects(f.actions.confirmed(prepared, () => {}), { code: "missingDocument" });
});
