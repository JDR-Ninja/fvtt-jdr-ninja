import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { emptyStore, validateStore, readStore, validateValue, uuid7, copy, preview, validateProjectionCapacity } from "../scripts/variables/schema.js";
import { parseExpression, inspectExpression } from "../scripts/variables/expressions.js";
import { VariableService } from "../scripts/variables/service.js";
import { VariableActions, validateMacroDeclaration, usesVariables, usesUpdates } from "../scripts/variables/dispatcher.js";
import { FoundryActions } from "../scripts/stream-deck/actions.js";

const ref = (id, scope = "world") => ({ source: "variable", scope, id });
const variable = (id, type = "number", value = 1, extra = {}) => ({ id, name: id, type, kind: "stored", current: value, default: value, constraints: {}, ...extra });
const expression = (text, refs = {}) => parseExpression(text, label => refs[label]);
const computed = (id, text, type = "number", refs = {}) => ({ id, name: id, kind: "computed", type, constraints: {}, expression: expression(text, refs) });
function fixture() {
  const gm = { id: "gm", role: 4, isGM: true, active: true, can: () => true }, other = { ...gm, id: "other" }, player = { id: "player", role: 1, active: true, isGM: false };
  const users = [gm, other, player], stored = { world: { ...emptyStore(), controller: gm.id }, personal: emptyStore() }, documents = new Map();
  let service, writes = 0, save;
  const game = { world: { id: "world" }, ready: true, user: gm, users: { contents: users, get: id => users.find(u => u.id === id), getDesignatedUser: fn => users.find(fn) },
    settings: { settings: new Map([["jdr-ninja.variablesWorld", {}]]), get: (_m, key) => copy(stored[key === "variablesWorld" ? "world" : "personal"]),
      set: async (_m, key, value) => { if (save) await save(); const scope = key === "variablesWorld" ? "world" : "personal";
        stored[scope] = copy(value); writes++; service.invalidate(scope); return copy(value); } } };
  const canvas = { tokens: { controlled: [] } };
  service = new VariableService({ game: () => game, canvas: () => canvas, resolveUuid: async uuid => documents.get(uuid), resolveSync: uuid => documents.get(uuid), crypto: webcrypto });
  return { service, stored, game, users, gm, other, player, canvas, documents, writes: () => writes, save: fn => { save = fn; },
    add: (v, scope = "world") => { stored[scope].variables.push(v); }, mutate: (operation, id, operand = {}, scope = "world") => service.mutate({ operation, variable: ref(id, scope), ...operand }) };
}

test("UUID v7 preserves timestamp, RFC variant and independent random IDs", () => {
  const a = uuid7(webcrypto, 1700000000000), b = uuid7(webcrypto, 1700000000000);
  assert.match(a, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); assert.notEqual(a, b);
  assert.equal(parseInt(a.replaceAll("-", "").slice(0, 12), 16), 1700000000000);
});
test("typed values reject coercion, nonfinite numbers and document recipe/type mismatches", () => {
  for (const value of [Infinity, NaN, "2", null]) assert.throws(() => validateValue(value, "number"));
  assert.throws(() => validateValue("false", "boolean")); assert.throws(() => validateValue({ source: "selectedToken" }, "Actor"));
  assert.throws(() => validateValue({ source: "userCharacter" }, "Token")); assert.throws(() => validateValue({ uuid: "Actor.a", arbitrary: true }, "Actor"));
  assert.equal(validateValue(0, "number"), 0); validateValue({ source: "userCharacter" }, "Actor");
});
test("schema rejects duplicate IDs, conflicting kind fields and unknown versions without wiping data", () => {
  const store = emptyStore(); store.variables.push(variable("a"), variable("a")); assert.throws(() => validateStore(store));
  store.variables = [variable("a", "number", 1, { expression: {} })]; assert.throws(() => validateStore(store));
  const raw = { ...emptyStore(), version: 7 }; assert.throws(() => readStore(raw), { code: "futureSchema" }); assert.equal(raw.version, 7);
  assert.throws(() => readStore('{"__proto__":{},"version":1}'), { code: "invalidStore" });
});
test("numbers are bounded, clamp is explicit, no-ops do not advance revision and defaults remain independent", async () => {
  const f = fixture(); f.add(variable("n", "number", 5, { default: 2, constraints: { min: 0, max: 5 } }));
  await assert.rejects(f.mutate("increment", "n", { amount: 1 }), { code: "outOfBounds" }); assert.equal(f.writes(), 0);
  f.stored.world.variables[0].constraints.clamp = true;
  assert.equal((await f.mutate("increment", "n", { amount: 1 })).changed, false); assert.equal(f.writes(), 0);
  await f.mutate("decrement", "n", { amount: 3 }); assert.equal(f.stored.world.variables[0].current, 2);
  await f.mutate("set", "n", { value: 3 }); assert.equal(f.stored.world.variables[0].default, 2);
  await f.mutate("reset", "n"); assert.equal(f.stored.world.variables[0].current, 2);
  await assert.rejects(f.mutate("increment", "n", { amount: -1 })); await assert.rejects(f.mutate("set", "n", { value: 1, amount: 2 }));
});
test("list selections derive current entry values, preserve IDs on reorder and never repair deletion implicitly", async () => {
  const f = fixture(); f.stored.world.lists.push({ id: "list", name: "List", type: "number", entries: [{ id: "a", label: "A", value: 10 }, { id: "b", label: "B", value: 20 }] });
  f.add({ id: "choice", name: "Choice", type: "number", kind: "list", list: { scope: "world", id: "list" }, current: "a", default: "a", wrap: false, constraints: {} });
  await f.mutate("next", "choice"); assert.equal(await f.service.read(ref("choice")), 20);
  assert.equal((await f.mutate("next", "choice")).changed, false);
  const list = copy(f.stored.world.lists[0]); list.entries.reverse(); list.entries[0].value = 25;
  await f.service.saveList("world", list, f.stored.world.revision); assert.equal(await f.service.read(ref("choice")), 25);
  list.entries.splice(0, 1); await f.service.saveList("world", list, f.stored.world.revision);
  await assert.rejects(f.service.read(ref("choice")), { code: "missingEntry" }); await assert.rejects(f.mutate("next", "choice"), { code: "missingEntry" });
  await f.mutate("reset", "choice"); assert.equal(await f.service.read(ref("choice")), 10);
  await assert.rejects(f.mutate("set", "choice", { value: 10 }), { code: "readOnly" });
});
test("list wrap and invalid defaults are explicit", async () => {
  const f = fixture(); f.stored.world.lists.push({ id: "l", name: "l", type: "text", entries: [{ id: "a", label: "a", value: "A" }, { id: "b", label: "b", value: "B" }] });
  f.add({ id: "c", name: "c", type: "text", kind: "list", list: { scope: "world", id: "l" }, current: "a", default: "missing", wrap: true, constraints: {} });
  await f.mutate("previous", "c"); assert.equal(await f.service.read(ref("c")), "B");
  await f.mutate("next", "c"); assert.equal(await f.service.read(ref("c")), "A");
  await assert.rejects(f.mutate("reset", "c"), { code: "missingEntry" });
});
test("world controller stays assigned and requires independent full-GM and native permissions", async () => {
  const f = fixture(); f.add(variable("n")); f.game.user = f.other;
  await f.service.initialize(); assert.equal(f.stored.world.controller, "gm");
  await assert.rejects(f.mutate("set", "n", { value: 2 }), { code: "notController" });
  f.game.user = f.gm; f.gm.can = () => false; await assert.rejects(f.mutate("set", "n", { value: 2 }), { code: "notController" });
  f.gm.can = () => true; await f.service.assignController("other", 0); assert.equal(f.stored.world.controller, "other");
  await assert.rejects(f.mutate("set", "n", { value: 2 }), { code: "notController" });
  f.game.user = f.other; await f.mutate("set", "n", { value: 2 });
});
test("offline recovery has one designated initiator and active controllers cannot be stolen", async () => {
  const f = fixture(); f.game.user = f.other;
  await assert.rejects(f.service.assignController("other", 0), { code: "notController" });
  f.gm.active = false; await f.service.assignController("other", 0); assert.equal(f.stored.world.controller, "other");
});
test("players can write only their own personal store, never another owner supplied in a reference", async () => {
  const f = fixture(); f.game.user = f.player; f.add(variable("n"), "personal");
  await f.mutate("set", "n", { value: 9 }, "personal"); assert.equal(f.stored.personal.variables[0].current, 9);
  await assert.rejects(f.service.mutate({ operation: "set", variable: { ...ref("n", "personal"), userId: "gm" }, value: 3 }));
  assert.equal(f.stored.world.revision, 0);
});
test("an editor save preserves current state, conflicts retain the caller draft, conversion is explicit", async () => {
  const f = fixture(); f.add(variable("n", "number", 2)); const draft = variable("n", "number", 1, { name: "Renamed", default: 4 });
  await f.service.saveVariable("world", draft, 0); assert.equal(f.stored.world.variables[0].current, 2); assert.equal(f.stored.world.variables[0].default, 4);
  await assert.rejects(f.service.saveVariable("world", draft, 0), { code: "conflict" }); assert.equal(draft.name, "Renamed");
  const derived = computed("n", "3"); await assert.rejects(f.service.saveVariable("world", derived, 1), { code: "incompatibleChange" });
  await f.service.saveVariable("world", derived, 1, { convert: true }); assert.equal(await f.service.read(ref("n")), 3);
  await assert.rejects(f.mutate("reset", "n"), { code: "readOnly" });
});
test("configuration and runtime writes share a fail-fast lock, including macro reentrancy", async () => {
  const f = fixture(); f.add(variable("n")); let release; f.save(() => new Promise(resolve => { release = resolve; }));
  const running = f.mutate("set", "n", { value: 2 }); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.saveVariable("world", variable("other"), 0), { code: "busy" });
  await assert.rejects(f.mutate("increment", "n", { amount: 1 }), { code: "busy" }); release(); await running;
});
test("foreign edits and replaced users invalidate prepared operations", async () => {
  const f = fixture(); f.add(variable("n"));
  await assert.rejects(f.service.run(async op => { f.stored.world.revision++; f.service.invalidate("world"); op.guard(); }), { code: "staleState" });
  await assert.rejects(f.service.run(async op => { f.game.user = f.player; op.guard(); }), { code: "wrongSession" });
});
test("a confirmed check ignores later table changes and unrelated edits, never a changed binding, document or seat", async () => {
  const f = fixture(); const doc = { uuid: "Combat.c", documentName: "Combat", testUserPermission: () => true };
  f.documents.set(doc.uuid, doc); f.add(variable("fight", "Combat", { uuid: doc.uuid })); f.add(variable("n"));
  const ctx = f.service.context(); await ctx.resolve("world", "fight");
  f.service.invalidate(); f.stored.world.variables[1].current = 7;
  assert.throws(() => ctx.check(), { code: "staleState" }); ctx.check({ confirmed: true });
  f.documents.delete(doc.uuid); assert.throws(() => ctx.check({ confirmed: true }), { code: "missingDocument" });
  f.documents.set(doc.uuid, doc); f.stored.world.variables[0].current = { uuid: "Combat.other" };
  assert.throws(() => ctx.check({ confirmed: true }), { code: "staleState" });
  await f.service.run(async op => { f.service.invalidate(); assert.throws(() => op.guard(), { code: "staleState" });
    op.guard({ confirmed: true }); f.game.user = f.player; assert.throws(() => op.guard({ confirmed: true }), { code: "wrongSession" }); });
});
test("a disconnected native seat cannot write or execute even while its user remains active elsewhere", async () => {
  const f = fixture(); f.add(variable("n")); f.game.socket = { connected: false };
  assert.equal(f.service.canWrite("world"), false); await assert.rejects(f.mutate("set", "n", { value: 2 }), { code: "wrongSession" });
  f.game.socket.connected = true; const ctx = f.service.context(); f.game.socket.connected = false;
  assert.throws(() => ctx.check(), { code: "staleState" }); assert.equal(f.writes(), 0);
});
test("uncertain persistence blocks dependent writes instead of replaying or rolling back", async () => {
  const f = fixture(); f.add(variable("n")); f.save(async () => { throw new Error("transport closed"); });
  await assert.rejects(f.mutate("set", "n", { value: 2 }), { code: "uncertain" }); assert(f.service.uncertain.has("world"));
  f.save(null); await assert.rejects(f.mutate("set", "n", { value: 3 }), { code: "uncertain" }); assert.equal(f.writes(), 0);
});
test("reconciliation confirms native absence, refuses stale cache and never reads another personal owner", async () => {
  const f = fixture(), original = globalThis.foundry; let query;
  globalThis.foundry = { documents: { Setting: { database: { get: async (_class, operation) => { query = operation.query; return []; } } } } };
  try {
    f.service.uncertain.add("personal"); await f.service.reconcile("personal"); assert.equal(f.service.uncertain.has("personal"), false);
    assert.deepEqual(query, { key: "jdr-ninja.variablesPersonal", user: "gm" });
    f.service.uncertain.add("world"); await assert.rejects(f.service.reconcile("world"), { code: "reloadRequired" }); assert(f.service.uncertain.has("world"));
  } finally { globalThis.foundry = original; }
});
test("computed expressions are typed, lazy and bounded without evaluating arbitrary script", async () => {
  const f = fixture(); f.add(variable("n", "number", 5)); f.add(computed("c", 'if(@{n} > 3, round(@{n} * 2.4), 1 / 0)', "number", { n: { scope: "world", id: "n" } }));
  assert.equal(await f.service.read(ref("c")), 12);
  for (const source of ['globalThis.fetch("x")', 'constructor("x")', '1; game.pause=true', '[1,2]', 'this.x']) assert.throws(() => expression(source));
  f.add(computed("zero", "1 / 0")); await assert.rejects(f.service.read(ref("zero")), { code: "divisionByZero" });
  f.add(computed("text", 'concat("Total: ", @{n}, true)', "text", { n: { scope: "world", id: "n" } })); assert.equal(await f.service.read(ref("text")), "Total: 5true");
});
test("cycles and world-to-personal dependencies are rejected through the whole graph", () => {
  const f = fixture(); const a = computed("a", "@{b}", "number", { b: { scope: "world", id: "b" } }), b = computed("b", "@{a}", "number", { a: { scope: "world", id: "a" } });
  f.add(a); f.add(b); assert.throws(() => f.service.validateDefinitions(f.stored, "world", "a"), { code: "expressionCycle" });
  const personal = expression("@{n}", { n: { scope: "personal", id: "n" } }); assert.throws(() => inspectExpression(personal, () => variable("n"), "world"), { code: "scopeMismatch" });
});
test("permission loss invalidates derived text and hidden document entries never enter the projection", async () => {
  const f = fixture(); let observe = true; const doc = { uuid: "Actor.a", name: "Private actor", documentName: "Actor", testUserPermission: () => observe };
  f.documents.set(doc.uuid, doc); f.add(variable("actor", "Actor", { uuid: doc.uuid })); f.add(computed("label", "documentName(@{actor})", "text", { actor: { scope: "world", id: "actor" } }));
  f.stored.world.lists.push({ id: "actors", name: "Actors", type: "Actor", entries: [{ id: "hidden", label: "Private actor", value: { uuid: doc.uuid } }] });
  const ctx = f.service.context(); assert.equal(await ctx.resolve("world", "label"), "Private actor"); observe = false;
  assert.throws(() => ctx.check(), { code: "denied" }); const projected = await f.service.projection();
  assert.equal(projected.state.find(v => v.id === "label").status, "denied"); assert.deepEqual(projected.lists[0].entries, []);
  assert(!JSON.stringify(projected).includes("Private actor")); assert(!JSON.stringify(projected).includes(doc.uuid));
});
test("hidden token recipes and derived labels follow native catalog visibility for players", async () => {
  const f = fixture(); f.game.user = f.player; const doc = { uuid: "Scene.s.Token.hidden", documentName: "Token", name: "Private token", hidden: true, testUserPermission: () => true };
  f.documents.set(doc.uuid, doc); f.add(variable("token", "Token", { uuid: doc.uuid }));
  f.add(computed("name", "documentName(@{token})", "text", { token: { scope: "world", id: "token" } }));
  const projection = await f.service.projection(); assert.equal(projection.state.find(s => s.id === "name").status, "denied"); assert(!JSON.stringify(projection).includes("Private token"));
});
test("contextual recipes pin selected tokens and assigned characters across asynchronous preparation", async () => {
  const f = fixture(); const token = { uuid: "Scene.s.Token.t", documentName: "Token", testUserPermission: () => true };
  f.canvas.tokens.controlled = [{ document: token }]; f.add(variable("t", "Token", { source: "selectedToken" }));
  const ctx = f.service.context(); await ctx.resolve("world", "t"); f.canvas.tokens.controlled = []; assert.throws(() => ctx.check(), { code: "staleSelection" });
  const actor = { uuid: "Actor.a", documentName: "Actor", testUserPermission: () => true }; f.gm.character = actor; f.add(variable("a", "Actor", { source: "userCharacter" }));
  const ctx2 = f.service.context(); await ctx2.resolve("world", "a"); f.gm.character = null; assert.throws(() => ctx2.check(), { code: "staleState" });
});
test("typed templates allow numeric dice fragments and document labels but never string formula injection", async () => {
  const f = fixture(); f.add(variable("n", "number", 3)); f.add(variable("s", "text", "999d999"));
  const template = { source: "template", segments: [{ text: "1d20 + " }, { variable: ref("n") }] };
  assert.equal(await f.service.resolveInput(template, f.service.context(), { formula: true }), "1d20 + 3");
  template.segments[1].variable = ref("s"); await assert.rejects(f.service.resolveInput(template, f.service.context(), { formula: true }), { code: "wrongValueType" });
  assert.deepEqual(await f.service.resolveInput(["gm", ref("s")], f.service.context()), ["gm", "999d999"]);
  await assert.rejects(f.service.resolveInput([["gm"]], f.service.context()));
});
test("projection previews remain bounded in UTF-8 after future labels grow and capacity rejects whole configurations", () => {
  assert.equal(new TextEncoder().encode(preview("🙂".repeat(1000)).text).length, 96); assert.equal(preview("🙂".repeat(1000)).shortened, true);
  const store = emptyStore(); for (let n = 0; n < 32; n++) store.lists.push({ id: `l${n}`, name: "n", type: "number", entries: Array.from({ length: 128 }, (_, e) => ({ id: `l${n}e${e}`, label: "x".repeat(80), value: 1 })) });
  assert.throws(() => validateProjectionCapacity(store, "world"), { code: "capacity" });
});
function command(action, parameters) { return { id: uuid7(webcrypto), action, parameters, selectionRevision: 0 }; }
test("combined command preflights all child fields, commits once and uses the candidate value", async () => {
  const f = fixture(); f.add(variable("n", "number", 1)); let called = 0, input;
  const native = { prepare: async c => { assert.equal(c.parameters.paused, true); return c; }, dispatch: async c => { called++; input = c.parameters; return { code: "executed" }; } };
  f.add(variable("b", "boolean", false)); const actions = new VariableActions({ native, variables: f.service });
  const result = await actions.execute(command("variable.applyAndExecute", { mutations: [{ operation: "toggle", variable: ref("b") }], action: { action: "game.pause", parameters: { paused: ref("b") } } }));
  assert.equal(called, 1); assert.equal(input.paused, true); assert.equal(f.writes(), 1); assert.equal(result.details.variableCommit, "committed");
  assert.equal(result.details.execution, "completed");
});
test("combined preflight failures and mixed-scope batches never persist or call native effects", async () => {
  const f = fixture(); f.add(variable("n")); f.add(variable("p"), "personal"); let calls = 0;
  const actions = new VariableActions({ variables: f.service, native: { prepare: async () => { throw new Error("invalid child"); }, dispatch: async () => { calls++; } } });
  await assert.rejects(actions.execute(command("variable.applyAndExecute", { mutations: [{ operation: "set", variable: ref("n"), value: 2 }], action: { action: "chat.send", parameters: { content: "x" } } })));
  await assert.rejects(actions.execute(command("variable.applyAndExecute", { mutations: [{ operation: "set", variable: ref("n"), value: 2 }, { operation: "set", variable: ref("p", "personal"), value: 3 }], action: { action: "game.pause", parameters: { paused: true } } })), { code: "scopeMismatch" });
  assert.equal(calls, 0); assert.equal(f.writes(), 0);
});
test("combined uncertain writes do not execute, while child failures retain committed state and structured partial results", async () => {
  const f = fixture(); f.add(variable("n")); let calls = 0;
  const actions = new VariableActions({ variables: f.service, native: { prepare: async c => c, dispatch: async () => { calls++; throw new Error("native failed"); } } });
  const make = value => command("variable.applyAndExecute", { mutations: [{ operation: "set", variable: ref("n"), value }], action: { action: "game.pause", parameters: { paused: true } } });
  const result = await actions.execute(make(2)); assert.equal(result.code, "partial"); assert.equal(result.details.variableCommit, "committed"); assert.equal(f.stored.world.variables[0].current, 2);
  f.save(async () => { throw new Error("socket closed"); }); const uncertain = await actions.execute(make(3));
  assert.equal(uncertain.code, "uncertain"); assert.equal(uncertain.details.execution, "notStarted"); assert.equal(calls, 1);
});
test("compatible script macros receive detached typed arguments, cannot reenter writes and must acknowledge", async () => {
  const f = fixture(); f.add(variable("n", "number", 4)); const flag = { version: 1, arguments: [{ name: "amount", type: "number", required: true }] }; let got;
  const macro = { uuid: "Macro.m", type: "script", canExecute: true, documentName: "Macro", testUserPermission: () => true, getFlag: () => flag,
    execute: async ({ jdrNinja }) => { got = jdrNinja; await assert.rejects(f.mutate("set", "n", { value: 8 }), { code: "busy" }); return { jdrNinja: { version: 1, status: "executed" } }; } };
  f.documents.set(macro.uuid, macro);
  const native = new FoundryActions({ game: () => f.game, canvas: () => f.canvas, ui: () => ({}), foundry: () => ({}), resolveUuid: async uuid => f.documents.get(uuid) });
  const actions = new VariableActions({ native, variables: f.service });
  await actions.execute(command("macro.execute", { document: { uuid: macro.uuid }, arguments: { amount: ref("n") } })); assert.deepEqual(got.arguments, { amount: 4 });
  macro.execute = async () => undefined; await assert.rejects(actions.execute(command("macro.execute", { document: { uuid: macro.uuid }, arguments: { amount: 2 } })), { code: "uncertain" });
  assert.throws(() => validateMacroDeclaration({ version: 1, arguments: [{ name: "constructor", type: "number", required: false }] }));
});

class ForcedDeletion {}
const mirror = { getProperty: (object, key) => key.split(".").reduce((target, part) => target?.[part], object),
  setProperty: (object, key, value) => { const parts = key.split("."), last = parts.pop(); parts.reduce((target, part) => target[part] ??= {}, object)[last] = value; } };
const change = (path, operation, value) => ({ path, operation, ...(value === undefined ? {} : { value }) });
const template = (...segments) => ({ source: "template", segments });
/** Real native handlers over the variable fixture, with documents whose source data differs from what a sheet shows. */
function updateFixture(f) {
  const updates = [], foundry = { utils: mirror, data: { operators: { ForcedDeletion } } };
  const target = (uuid, type, source) => { const doc = { uuid, documentName: type, testUserPermission: () => true, _source: source,
    canUserModify: () => true, update: async data => { updates.push([uuid, data]); } }; f.documents.set(uuid, doc); return doc; };
  const native = new FoundryActions({ game: () => f.game, canvas: () => f.canvas, ui: () => ({}), foundry: () => foundry, resolveUuid: async uuid => f.documents.get(uuid) });
  return { actions: new VariableActions({ native, variables: f.service }), updates, target };
}
test("document.update rows resolve variables and templates with their types, and keep every other value as a literal", async () => {
  const f = fixture(), u = updateFixture(f);
  u.target("Item.sword", "Item", { system: { qty: 3, bonus: 10, equipped: false } });
  f.add(variable("n", "number", 7)); f.add(variable("b", "boolean", true)); f.add(variable("s", "text", "Hello")); f.add(variable("where", "text", "Item.sword"));
  const literal = { keep: [1, "two", { three: null }], text: "x" };
  const result = await u.actions.execute(command("document.update", { document: ref("where"), changes: [
    change("system.qty", "set", ref("n")), change("system.flag", "set", ref("b")), change("system.label", "set", ref("s")),
    change("system.title", "set", template({ text: "Sword #" }, { variable: ref("n") })), change("system.bonus", "increment", ref("n")),
    change("system.equipped", "set", literal), change("system.list", "set", [ref("n")]), change("system.nothing", "unset")] }));
  assert.equal(result.code, "executed"); assert.equal(u.updates.length, 1); assert.equal(u.updates[0][0], "Item.sword");
  const update = u.updates[0][1];
  assert.deepEqual(update.system.qty, 7); assert.equal(update.system.flag, true); assert.equal(update.system.label, "Hello");
  assert.equal(update.system.title, "Sword #7"); assert.equal(update.system.bonus, 17);
  assert.deepEqual(update.system.equipped, literal); assert.notEqual(update.system.equipped, literal);
  assert.deepEqual(update.system.list, [ref("n")]); assert(update.system.nothing instanceof ForcedDeletion);
  assert.equal(f.writes(), 0);
});
test("document.update targets resolve from a text variable, a template or a document variable", async () => {
  const f = fixture(), u = updateFixture(f), changes = [change("name", "set", "Renamed")];
  u.target("Item.sword", "Item", { name: "Sword" }); u.target("Actor.hero", "Actor", { name: "Hero" });
  f.add(variable("sword", "text", "Item.sword")); f.add(variable("part", "text", "sword")); f.add(variable("hero", "Actor", { uuid: "Actor.hero" }));
  for (const [document, uuid] of [[ref("sword"), "Item.sword"], [template({ text: "Item." }, { variable: ref("part") }), "Item.sword"],
    [ref("hero"), "Actor.hero"], [{ uuid: "Item.sword" }, "Item.sword"], ["Actor.hero", "Actor.hero"]]) {
    u.updates.length = 0; await u.actions.execute(command("document.update", { document, changes })); assert.deepEqual(u.updates, [[uuid, { name: "Renamed" }]]);
  }
  await assert.rejects(u.actions.execute(command("document.update", { document: ref("absent"), changes })), { code: "missingVariable" });
  f.add(variable("gone", "text", "Item.gone")); await assert.rejects(u.actions.execute(command("document.update", { document: ref("gone"), changes })), { code: "missingDocument" });
  f.add(variable("amount", "number", 3)); await assert.rejects(u.actions.execute(command("document.update", { document: ref("amount"), changes })), { code: "invalidParameters" });
  assert.equal(u.updates.length, 1);
});
test("document.update never coerces a resolved row value and reports the row that does not fit its operation", async () => {
  const f = fixture(), u = updateFixture(f), at = (...rows) => command("document.update", { document: "Item.sword", changes: rows });
  u.target("Item.sword", "Item", { system: { qty: 1, on: true } });
  f.add(variable("s", "text", "5")); f.add(variable("b", "boolean", true)); f.add(variable("n", "number", 2));
  for (const [row, code] of [[change("system.qty", "increment", ref("s")), "invalidParameters"], [change("system.qty", "decrement", ref("b")), "invalidParameters"],
    [change("system.on", "toggle", ref("b")), "invalidParameters"], [change("system.on", "increment", ref("n")), "wrongValueType"],
    [change("system.qty", "set", ref("absent")), "missingVariable"], [change("system.qty", "set", { source: "variable", scope: "world", id: "n", extra: 1 }), "invalidParameters"],
    [change("system.qty", "set", template({ variable: ref("absent") })), "missingVariable"]])
    await assert.rejects(u.actions.execute(at(row)), { code }, JSON.stringify(row));
  assert.equal(u.updates.length, 0);
  await assert.rejects(u.actions.execute(command("document.update", { document: "Item.sword", changes: "system.qty" })), { code: "invalidParameters" });
  await assert.rejects(u.actions.execute(command("document.update", { document: "Item.sword", changes: Array.from({ length: 17 }, (_, index) => change(`f${index}`, "set", ref("n"))) })),
    { code: "invalidParameters" });
  assert.equal((await u.actions.execute(at(change("system.qty", "increment", 1)))).code, "executed");
});
test("variable detection sees reference and template values inside document.update rows, and nowhere else", () => {
  const rows = value => ({ action: "document.update", parameters: { document: "Item.a", changes: [change("a", "set", 1), change("b", "set", value)] } });
  assert.equal(usesVariables(rows(1)), false); assert.equal(usesVariables(rows({ nested: [1] })), false);
  assert.equal(usesVariables(rows(ref("n"))), true); assert.equal(usesVariables(rows(template({ text: "x" }))), true);
  // A reference inside a literal array or object is data to write, not something to resolve.
  assert.equal(usesVariables(rows([ref("n")])), false); assert.equal(usesVariables(rows({ inner: ref("n") })), false);
  assert.equal(usesVariables({ action: "document.update", parameters: { document: ref("d"), changes: [] } }), true);
  assert.equal(usesVariables({ action: "document.update", parameters: { document: "Item.a", changes: [null, "text", { value: ref("n") }] } }), true);
  assert.equal(usesVariables({ action: "document.update", parameters: { document: "Item.a", changes: { value: ref("n") } } }), false);
  assert.equal(usesVariables({ action: "chat.send", parameters: { changes: [change("a", "set", ref("n"))] } }), false);
  assert.equal(usesVariables({ action: "document.update", parameters: { document: "Item.a" } }), false);
  assert.equal(usesUpdates({ action: "document.update", parameters: {} }), true);
  assert.equal(usesUpdates({ action: "variable.applyAndExecute", parameters: { action: { action: "document.update", parameters: {} } } }), true);
  for (const candidate of [{ action: "variable.applyAndExecute", parameters: { action: { action: "game.pause" } } },
    { action: "variable.applyAndExecute", parameters: {} }, { action: "game.pause", parameters: { action: { action: "document.update" } } }, { action: "variable.set", parameters: {} }])
    assert.equal(usesUpdates(candidate), false);
});
test("document.update inside applyAndExecute commits the variable once and updates with the candidate value", async () => {
  const f = fixture(), u = updateFixture(f);
  u.target("Item.sword", "Item", { system: { on: false, qty: 4 } });
  f.add(variable("b", "boolean", false)); f.add(variable("n", "number", 5));
  const result = await u.actions.execute(command("variable.applyAndExecute", { mutations: [{ operation: "toggle", variable: ref("b") }, { operation: "increment", variable: ref("n"), amount: 2 }],
    action: { action: "document.update", parameters: { document: "Item.sword", changes: [change("system.on", "set", ref("b")), change("system.qty", "increment", ref("n"))] } } }));
  assert.equal(result.code, "executed"); assert.equal(result.details.variableCommit, "committed"); assert.equal(result.details.execution, "completed");
  assert.equal(f.writes(), 1); assert.deepEqual(u.updates, [["Item.sword", { system: { on: true, qty: 11 } }]]);
  // An update Foundry refuses only after the variable was committed leaves it committed and reports the child as not started.
  let asked = 0; u.target("Item.sword", "Item", { system: { on: false, qty: 4 } }).canUserModify = () => ++asked === 1;
  const refused = await u.actions.execute(command("variable.applyAndExecute", { mutations: [{ operation: "toggle", variable: ref("b") }],
    action: { action: "document.update", parameters: { document: "Item.sword", changes: [change("system.on", "set", ref("b"))] } } }));
  assert.deepEqual([refused.code, refused.details.variableCommit, refused.details.execution], ["partial", "committed", "notStarted"]);
  assert.equal(u.updates.length, 1); assert.equal(f.writes(), 2);
  // One refused during preparation stops the whole command before the variable is touched.
  await assert.rejects(u.actions.execute(command("variable.applyAndExecute", { mutations: [{ operation: "toggle", variable: ref("b") }],
    action: { action: "document.update", parameters: { document: "Item.sword", changes: [change("system.on", "set", ref("b"))] } } })), { code: "denied" });
  assert.equal(f.writes(), 2);
});
