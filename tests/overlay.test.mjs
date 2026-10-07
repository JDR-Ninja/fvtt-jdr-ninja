import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { OverlayRelay, overlayRelay, CARD_HOLD_CLASS } from "../scripts/overlay/relay.js";
import { buildOverlayPayload, extractAppearance, tableFormulaIsMeshBacked } from "../scripts/overlay/payload.js";
import { registerSettings } from "../scripts/settings.js";

class App {
  rendered = false;
  renders = 0;
  async render() { this.rendered = true; this.renders++; return this; }
  async close() { this.rendered = false; return this; }
  bringToFront() {}
}
globalThis.foundry = { applications: { api: { ApplicationV2: App, HandlebarsApplicationMixin: base => base } },
  utils: { randomID: () => "fixture-test-id" } };
const { OverlayPanel } = await import("../scripts/overlay/panel.js");
const { ConnectionPanel } = await import("../scripts/connection-panel.js");
const copy = JSON.parse(await readFile(new URL("../lang/fr.json", import.meta.url), "utf8"));

test("refreshing account connections preserves the native timer receiver", () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const seen = [];
  globalThis.setTimeout = function () { assert.equal(this, globalThis); seen.push("set"); return 1; };
  globalThis.clearTimeout = function () { assert.equal(this, globalThis); seen.push("clear"); };
  try {
    const relay = new OverlayRelay();
    relay.schedulePoll = () => relay.setTimer(() => {}, 1000);
    relay.refresh();
    assert.deepEqual(seen, ["clear", "set"]);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
let settings, requests, relay, timers, clock, notices, writes;
const flush = () => new Promise(resolve => setImmediate(resolve));
function message(id = "roll-1", values = {}) {
  return { id, blind: false, whisper: [], isContentVisible: true, author: { name: "Player", isGM: false },
    speaker: { alias: "Character" }, flavor: "<b>Attack</b>", rolls: [{ formula: "2d20kh + 4", total: 22,
      dice: [{ faces: 20, results: [{ result: 18, active: true }, { result: 7, discarded: true }] }] }], ...values };
}
async function advance(ms) {
  clock += ms;
  for (const [id, task] of [...timers]) if (task.at <= clock) { timers.delete(id); await task.action(); }
  await flush();
}
beforeEach(() => {
  settings = new Map([['accountOrigin', 'https://www.jdr.ninja'], ['accountToken', 'fixture-account-token'],
    ['atlasToken', 'fixture-atlas-token'], ['atlasEnabled', false], ['overlayEnabled', true],
    ['overlayForwardFilter', 'allPublic'], ['overlayCardHoldSeconds', '0'], ['overlayTableCommandsEnabled', false]]);
  requests = []; notices = []; writes = []; timers = new Map(); clock = 100000;
  globalThis.game = { user: { isGM: true }, modules: new Map(),
    settings: { get: (_module, key) => settings.get(key), set: async (_module, key, value) => {
      writes.push(key); settings.set(key, value);
    } }, actors: new Map(), i18n: { localize: key => copy[key] ?? key,
      format: (key, values) => (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`) } };
  globalThis.ui = { notifications: { info: value => notices.push(value), warn: value => notices.push(value), error: value => notices.push(value) } };
  globalThis.CSS = { escape: value => value };
  globalThis.document = { querySelectorAll: () => [] };
  relay = new OverlayRelay({ request: async options => { requests.push(options); return { ok: true, data: { state: "rolled" } }; },
    now: () => clock, setTimer: (action, ms) => { const id = Symbol(); timers.set(id, { action, at: clock + ms }); return id; },
    clearTimer: id => timers.delete(id), resolveUuid: async () => null });
});
afterEach(() => {
  settings.set("overlayEnabled", false);
  relay.refresh(); overlayRelay.refresh(); OverlayPanel.instances.clear();
  OverlayPanel.instance = null;
});

test("public relay works for players and uses only the browser account credential", async () => {
  game.user.isGM = false;
  relay.onMessage(message());
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].token, "fixture-account-token");
  assert.equal(requests[0].path, "/api/foundry/v1/overlay/rolls");
  assert.deepEqual(requests[0].body.dice, [{ faces: 20, results: [18, 7] }]);
  assert.equal(requests[0].body.total, 22);
  assert.equal(requests[0].body.formula, "2d20kh + 4");
  assert.equal(requests[0].body.roller, "Character");
  assert.equal(requests[0].body.label, "Attack");
});

test("private, blind, whispered and self rolls stay private even when a GM can see them", async () => {
  for (const values of [{ blind: true }, { whisper: ["gm"] }, { whisper: ["self"] }, { blind: true, whisper: ["gm"] }]) {
    relay.onMessage(message(`hidden-${requests.length}`, values));
  }
  await flush();
  assert.equal(requests.length, 0);
  assert.equal(relay.holds.size, 0);
});

test("off, missing account credential and active standalone module block every overlay write", async () => {
  for (const mode of ["off", "token", "legacy"]) {
    settings.set("overlayEnabled", mode !== "off");
    settings.set("accountToken", mode === "token" ? "" : "fixture-account-token");
    game.modules = new Map(mode === "legacy" ? [["jdr-ninja-vtt-overlay", { active: true }]] : []);
    relay.onMessage(message(mode));
    assert.equal((await relay.sendTestRoll()).ok, false);
    await relay.pollOnce();
  }
  assert.equal(requests.length, 0);
});

test("players-only filter skips GM authors and deterministic chat without dice", async () => {
  settings.set("overlayForwardFilter", "playersOnly");
  relay.onMessage(message("gm", { author: { isGM: true } }));
  relay.onMessage(message("empty", { rolls: [{ formula: "4", total: 4, dice: [] }] }));
  relay.onMessage(message("player"));
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.rollId, "player");
});

test("exact multi-roll results and actor attribution survive without re-evaluation", () => {
  game.actors.set("actor", { name: "Actor Name" });
  const payload = buildOverlayPayload(message("multi", { speaker: { actor: "actor", alias: "Fallback" },
    rolls: [{ formula: "1d6", total: 5, dice: [{ faces: 6, results: [{ result: 5 }] }] },
      { formula: "1d8 + 2", total: 10, dice: [{ faces: 8, results: [{ result: 8 }] }] }] }));
  assert.equal(payload.total, 15);
  assert.equal(payload.formula, "1d6 + 1d8 + 2");
  assert.equal(payload.roller, "Actor Name");
  assert.deepEqual(payload.dice, [{ faces: 6, results: [5] }, { faces: 8, results: [8] }]);
});

/**
 * A stand-in for Dice So Nice 6.2.9 with the same shapes: the user flag stores `diceColor`/`labelColor`
 * under `global` or a die type, DSN's default is the user's colour, `getAppearanceForDice` renames them
 * to `background`/`foreground` and substitutes a preset's colours when `colorset` is not `custom`.
 */
function fakeDsn({ presets = {} } = {}) {
  class Dice3D {
    static ALL_CUSTOMIZATION(user, _factory, actor) {
      const appearance = { global: { labelColor: "#ffffff", diceColor: user.color, outlineColor: user.color,
        edgeColor: user.color, texture: "none", material: "auto", font: "auto", colorset: "custom", system: "standard" } };
      for (const flag of [user.flags?.["dice-so-nice"]?.appearance, actor?.flags?.["dice-so-nice"]?.appearance]) {
        for (const [scope, values] of Object.entries(flag ?? {})) appearance[scope] = { ...appearance[scope], ...values };
      }
      return { appearance, specialEffects: [] };
    }
  }
  const dsn = new Dice3D();
  dsn.types = [];
  dsn.DiceFactory = { getAppearanceForDice(appearances, type) {
    dsn.types.push(type);
    const settings = appearances[type] ?? appearances.global, global = appearances.global;
    const resolved = { colorset: settings.colorset ?? global.colorset, foreground: settings.labelColor ?? global.labelColor,
      background: settings.diceColor ?? global.diceColor, outline: settings.outlineColor ?? "", edge: settings.edgeColor ?? "",
      texture: settings.texture ?? global.texture, material: settings.material ?? global.material,
      font: settings.font ?? global.font, system: settings.system ?? global.system };
    if (resolved.colorset !== "custom") Object.assign(resolved, presets[resolved.colorset]);
    return resolved;
  } };
  return dsn;
}
const dsnUser = (id, values = {}) => ({ id, name: id, isGM: false, color: "#3366cc", flags: {}, ...values });
const dsnFlag = appearance => ({ "dice-so-nice": { appearance } });

test("Dice So Nice: a user who never opened its settings still sends the user colour DSN draws", () => {
  game.dice3d = fakeDsn();
  const appearance = extractAppearance(message("default", { author: dsnUser("player") }));
  assert.deepEqual(appearance, { diceColor: "#3366cc", labelColor: "#ffffff", outlineColor: "#3366cc", edgeColor: "#3366cc" });
});

test("Dice So Nice: custom colours come from the resolved appearance, never textures or systems", () => {
  game.dice3d = fakeDsn();
  const author = dsnUser("player", { flags: dsnFlag({ global: { diceColor: " #ABC ", labelColor: "#aabbcc",
    outlineColor: "bad", edgeColor: "#000", material: "metal", font: "Arial", texture: "private-texture",
    system: "mesh-data", colorset: "custom" } }) });
  assert.deepEqual(extractAppearance(message("custom", { author })),
    { diceColor: "#aabbcc", labelColor: "#aabbcc", edgeColor: "#000000", material: "metal", font: "Arial" });
});

test("Dice So Nice: a preset's colours, the first of a variant list, and its own material", () => {
  game.dice3d = fakeDsn({ presets: { fire: { foreground: "#f8d84f", background: ["not-a-colour", "#f43c04", "#910200"],
    outline: "#b70000", edge: "#ff5d0d", material: "chrome", texture: "fire" } } });
  const author = dsnUser("player", { flags: dsnFlag({ global: { colorset: "fire", diceColor: "#123456" } }) });
  assert.deepEqual(extractAppearance(message("preset", { author })),
    { diceColor: "#f43c04", labelColor: "#f8d84f", outlineColor: "#b70000", edgeColor: "#ff5d0d", material: "chrome" });
});

test("Dice So Nice: per-die settings and actor overrides resolve like DSN for the rolled die", () => {
  const dsn = game.dice3d = fakeDsn();
  const author = dsnUser("player", { flags: dsnFlag({ d20: { diceColor: "#00ff00" }, d6: { diceColor: "#ff0000" } }) });
  assert.equal(extractAppearance(message("d20", { author })).diceColor, "#00ff00");
  const coin = message("coin", { author, rolls: [{ formula: "1d2", total: 1, dice: [{ faces: 2, results: [{ result: 1 }] }] }] });
  assert.equal(extractAppearance(coin).diceColor, "#3366cc");
  assert.deepEqual(dsn.types, ["d20", "dc"]);
  const hero = { id: "hero", flags: dsnFlag({ global: { diceColor: "#654321" } }) };
  const spoken = message("actor", { author, speaker: { actor: "hero" }, rolls: [{ formula: "1d8", total: 3,
    dice: [{ faces: 8, results: [{ result: 3 }] }] }], constructor: { getSpeakerActor: speaker => speaker.actor === "hero" ? hero : null } });
  assert.equal(extractAppearance(spoken).diceColor, "#654321");
});

test("Dice So Nice: its character-owner setting colours a GM roll with the owning player's dice", () => {
  game.dice3d = fakeDsn();
  const gm = dsnUser("gm", { isGM: true, color: "#111111" });
  const owner = dsnUser("owner", { color: "#222222", character: { id: "hero" } });
  game.users = new Map([["gm", gm], ["owner", owner]]);
  const hero = { id: "hero", hasPlayerOwner: true, ownership: { default: 0, owner: 3 } };
  game.actors.set("hero", hero);
  const roll = message("owned", { author: gm, speaker: { actor: "hero" } });
  assert.equal(extractAppearance(roll).diceColor, "#111111");
  settings.set("forceCharacterOwnerAppearance", "2");
  assert.equal(extractAppearance(roll).diceColor, "#222222");
});

test("Dice So Nice: absent, inactive or failing DSN sends no appearance and the roll still goes out", () => {
  game.dice3d = undefined;
  assert.equal(extractAppearance(message("none", { author: dsnUser("player", { flags: dsnFlag({ global: { diceColor: "#123456" } }) }) })), undefined);
  game.dice3d = {};
  assert.equal(extractAppearance(message("plain")), undefined);
  game.dice3d = fakeDsn();
  game.dice3d.DiceFactory.getAppearanceForDice = () => { throw new Error("DSN failure"); };
  const payload = buildOverlayPayload(message("failing", { author: dsnUser("player") }));
  assert.equal(payload.appearance, undefined);
  assert.equal(payload.total, 22);
  game.dice3d = fakeDsn();
  assert.equal(buildOverlayPayload(message("relayed", { author: dsnUser("player") })).appearance.diceColor, "#3366cc");
});

for (const order of ["before", "after", "fallback", "declined"]) {
  test(`DSN timing sends once with a ${order} signal`, async () => {
    game.dice3d = {};
    if (order === "before" || order === "declined") relay.settleDsn("dsn");
    relay.onMessage(message("dsn"));
    if (order === "after") { assert.equal(requests.length, 0); relay.settleDsn("dsn"); }
    if (order === "fallback") { await advance(1999); assert.equal(requests.length, 0); await advance(1); }
    await flush();
    assert.equal(requests.length, 1);
    relay.onMessage(message("dsn"));
    relay.settleDsn("dsn");
    await advance(2000);
    assert.equal(requests.length, 1);
  });
}

test("disable or credential change cancels DSN waits, releases cards and never redirects old rolls", async () => {
  game.dice3d = {};
  settings.set("overlayCardHoldSeconds", "5");
  let reveals = 0;
  document.querySelectorAll = () => [{ classList: { remove: name => { assert.equal(name, CARD_HOLD_CLASS); reveals++; } }, closest: () => null }];
  relay.onMessage(message("cancel"));
  let hidden = false;
  relay.renderCard(message("cancel"), { classList: { add: name => { assert.equal(name, CARD_HOLD_CLASS); hidden = true; } } });
  assert.equal(hidden, true);
  settings.set("accountOrigin", "https://other.example"); relay.refresh();
  await advance(6000);
  assert.equal(requests.length, 0);
  assert.equal(reveals, 1);
  assert.equal(relay.holds.size, 0);
  settings.set("overlayEnabled", true); relay.onMessage(message("switch"));
  settings.set("overlayEnabled", false); relay.restart();
  await advance(6000);
  assert.equal(requests.length, 0);
  assert.equal(reveals, 2);
  relay.onMessage(message("off"));
  assert.equal(relay.pendingDsn.size, 0);
});

test("registered DSN hooks honor a declined animation and a system that drives DSN manually", async () => {
  const hooks = new Map();
  globalThis.Hooks = { on: (name, callback) => hooks.set(name, callback) };
  relay.registerHooks();
  game.dice3d = {};
  hooks.get("diceSoNiceMessageProcessed")("declined", { willTrigger3DRoll: false });
  hooks.get("createChatMessage")(message("declined"));
  await flush();
  assert.equal(requests.length, 1);
  game.dice3d.messageHookDisabled = true;
  hooks.get("diceSoNiceMessageProcessed")("manual", { willTrigger3DRoll: false });
  hooks.get("createChatMessage")(message("manual"));
  assert.equal(requests.length, 1);
  hooks.get("diceSoNiceRollStart")("manual");
  await flush();
  assert.equal(requests.length, 2);
  await advance(2000);
  assert.equal(requests.length, 2);
});

test("holds are bounded deadlines and removing our class preserves DSN's independent gate", async () => {
  settings.set("overlayCardHoldSeconds", "100");
  const classes = new Set(["dsn-hide"]);
  document.querySelectorAll = () => [{ classList: { remove: name => classes.delete(name) }, closest: () => null }];
  relay.onMessage(message());
  relay.renderCard(message(), { classList: { add: name => classes.add(name) } });
  await advance(9999);
  assert(classes.has(CARD_HOLD_CLASS));
  await advance(1);
  assert(!classes.has(CARD_HOLD_CLASS));
  assert(classes.has("dsn-hide"));
});

for (const state of ["notEntitled", "overlayDisabled", "invalidCommand", "ignored", "unexpected"]) {
  test(`HTTP success with ${state} is not recorded as an accepted roll`, async () => {
    relay.request = async () => ({ ok: true, data: { state } });
    const result = await relay.postRoll(buildOverlayPayload(message()));
    assert.equal(result.ok, false);
    assert.equal(result.reason, state === "unexpected" ? "invalidResponse" : state);
    assert.equal(settings.has("overlayLastSuccessAt"), false);
    assert.equal(settings.get("overlayLastErrorAt"), clock);
  });
}

test("accepted and duplicate states succeed; live success stamps are throttled and manual tests are immediate", async () => {
  await relay.postRoll(buildOverlayPayload(message()));
  relay.request = async () => ({ ok: true, data: { state: "duplicate" } });
  await relay.postRoll(buildOverlayPayload(message("duplicate")));
  assert.equal(writes.filter(key => key === "overlayLastSuccessAt").length, 1);
  clock += 1;
  assert.equal((await relay.sendTestRoll()).ok, true);
  assert.equal(writes.filter(key => key === "overlayLastSuccessAt").length, 2);
});

test("disabling aborts an in-flight roll and late transport completion cannot stamp success", async () => {
  let options, release;
  relay.request = current => { options = current; return new Promise(resolve => { release = resolve; }); };
  const pending = relay.postRoll(buildOverlayPayload(message()));
  settings.set("overlayEnabled", false); relay.restart();
  assert(options.signal.aborted);
  settings.set("overlayEnabled", true); relay.restart();
  release({ ok: true, data: { state: "rolled" } });
  assert.equal((await pending).reason, "cancelled");
  assert.equal(writes.length, 0);
});

test("diagnostics remain available when the relay is off", async () => {
  settings.set("overlayEnabled", false);
  assert.equal((await relay.diagnostics()).ok, true);
  assert.equal(requests[0].path, "/api/foundry/v1/overlay/diagnostics");
});

test("transport exceptions become local network errors without leaking the exception", async () => {
  relay.request = async () => { throw new Error("fixture-sensitive-error"); };
  const result = await relay.postRoll(buildOverlayPayload(message()));
  assert.equal(result.reason, "network");
  assert(!settings.get("overlayLastError").includes("fixture-sensitive-error"));
});

test("Twitch polling requires a GM and both independent local switches", async () => {
  for (const [gm, enabled, tables] of [[false, true, true], [true, false, true], [true, true, false]]) {
    game.user.isGM = gm; settings.set("overlayEnabled", enabled); settings.set("overlayTableCommandsEnabled", tables);
    relay.schedulePoll(); await relay.pollOnce();
    assert.equal(timers.size, 0);
  }
  assert.equal(requests.length, 0);
  game.user.isGM = true; settings.set("overlayEnabled", true); settings.set("overlayTableCommandsEnabled", true);
  relay.request = async options => { requests.push(options); return { ok: true, data: { commands: [] } }; };
  relay.schedulePoll(); relay.schedulePoll();
  assert.equal(timers.size, 1);
  await advance(2500);
  assert.equal(requests.length, 1);
  assert.equal(timers.size, 1);
});

test("poll failures back off to a minute and disabled polling clears timers", async () => {
  settings.set("overlayTableCommandsEnabled", true);
  relay.request = async () => ({ ok: false, reason: "network" });
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    await relay.pollOnce();
    assert.equal(relay.backoff, delay);
    relay.clearTimer(relay.pollTimer); relay.pollTimer = null;
  }
  settings.set("overlayTableCommandsEnabled", false); relay.restart();
  assert.equal(timers.size, 0);
});

test("the poll loop draws eligible world and compendium tables once in V14 public mode", async () => {
  settings.set("overlayTableCommandsEnabled", true);
  const draws = [];
  relay.request = async () => ({ ok: true, data: { commands: [
    { kind: "drawTable", uuid: "RollTable.world" }, { kind: "unknown", uuid: "RollTable.skip" },
    { kind: "drawTable", uuid: "Compendium.scope.pack.RollTable.entry" },
  ] } });
  relay.resolveUuid = async uuid => ({ documentName: "RollTable", formula: "1d20", draw: async options => draws.push({ uuid, options }) });
  await relay.pollOnce();
  assert.equal(draws.length, 2);
  assert.deepEqual(draws[0].options, { messageMode: "public" });
  assert.equal(requests.length, 0); // Draws post through chat; there is no separate roll-ingest call here.
});

test("table formulas refuse percentile, Fate, explicit faces, missing dice and mixed unsupported terms", () => {
  for (const formula of ["1d100", "1d7", "1d6 + 1dF", "1d%", "1d{1,3,5}", "1d20 + d(@level)", "12", "@abilities.dex.mod"]) {
    assert.equal(tableFormulaIsMeshBacked(formula), false, formula);
  }
  for (const formula of ["1d20", "4d6d1", "1d6 + 2d8", "1d12 + @abilities.dex.mod"]) {
    assert.equal(tableFormulaIsMeshBacked(formula), true, formula);
  }
});

test("a non-table or ineligible formula cannot draw; disabling during UUID resolution cancels the draw", async () => {
  settings.set("overlayTableCommandsEnabled", true);
  let draws = 0;
  for (const table of [null, { documentName: "Actor", formula: "1d20" }, { documentName: "RollTable", formula: "1d100" }]) {
    relay.resolveUuid = async () => table ? { ...table, draw: async () => draws++ } : null;
    await relay.handleDrawCommand("RollTable.invalid");
  }
  let release;
  relay.resolveUuid = () => new Promise(resolve => { release = resolve; });
  const pending = relay.handleDrawCommand("RollTable.slow");
  settings.set("overlayEnabled", false); relay.restart();
  settings.set("overlayEnabled", true); relay.restart();
  release({ documentName: "RollTable", formula: "1d20", draw: async () => draws++ });
  await pending;
  assert.equal(draws, 0);
});

test("a batch of table commands stops before the next draw when its switch is disabled", async () => {
  settings.set("overlayTableCommandsEnabled", true);
  relay.request = async () => ({ ok: true, data: { commands: [1, 2].map(id => ({ kind: "drawTable", uuid: `RollTable.${id}` })) } });
  let draws = 0;
  relay.resolveUuid = async () => ({ documentName: "RollTable", formula: "1d20", draw: async () => {
    draws++; settings.set("overlayTableCommandsEnabled", false); relay.restart();
  } });
  await relay.pollOnce();
  assert.equal(draws, 1);
  assert.equal(timers.size, 0);
});

test("settings changes cancel the appropriate integration and keep account, switch, preference and world callbacks separate", () => {
  const registered = new Map();
  game.settings.register = (_module, key, value) => registered.set(key, value);
  game.settings.registerMenu = () => {};
  const calls = [];
  registerSettings({ menus: { connections: ConnectionPanel }, onAtlasChange: () => calls.push("atlas"),
    onAccountChange: () => calls.push("account"), onOverlaySwitch: () => calls.push("switch"),
    onOverlayPreference: () => calls.push("preference") });
  for (const key of ["accountOrigin", "accountToken", "overlayEnabled", "overlayForwardFilter", "overlayCardHoldSeconds",
    "overlayTableCommandsEnabled", "atlasOrigin", "atlasToken", "atlasEnabled"]) registered.get(key).onChange();
  assert.deepEqual(calls, ["account", "account", "switch", "preference", "preference", "switch", "atlas", "atlas", "atlas"]);
});

test("a relay switch restarts roll and command work but leaves a diagnostics read running; a credential change ends both", async () => {
  const pending = [];
  relay.request = options => new Promise(resolve => pending.push({ options, resolve }));
  const diagnostics = relay.diagnostics();
  const roll = relay.postRoll(buildOverlayPayload(message()));
  settings.set("overlayTableCommandsEnabled", true); relay.restart();
  assert.equal(pending[0].options.signal.aborted, false);
  assert.equal(pending[1].options.signal.aborted, true);
  pending[0].resolve({ ok: true, data: { ok: true } }); pending[1].resolve({ ok: true, data: { state: "rolled" } });
  assert.deepEqual(await diagnostics, { ok: true, data: { ok: true } });
  assert.equal((await roll).reason, "cancelled");
  assert.deepEqual(writes, []);
  const stale = relay.diagnostics();
  settings.set("accountToken", "fixture-other-token"); relay.refresh();
  assert.equal(pending[2].options.signal.aborted, true);
  pending[2].resolve({ ok: true, data: { ok: true } });
  assert.equal((await stale).reason, "cancelled");
});

test("overlay switches and preferences keep the generated creature, the diagnostics and the account; a credential change resets them", async () => {
  const init = new Map();
  globalThis.Hooks = { once: (name, callback) => init.set(name, callback), on: () => {} };
  const registered = new Map();
  game.settings.register = (_module, key, options) => registered.set(key, options);
  game.settings.registerMenu = () => {};
  await import("../scripts/main.js");
  const { CreaturePanel, MonsterGeneratorPanel } = await import("../scripts/creatures/panel.js");
  const { streamDeckBridge } = await import("../scripts/stream-deck/bridge.js");
  init.get("init")();
  const calls = [];
  overlayRelay.restart = () => calls.push("restart"); overlayRelay.refresh = () => calls.push("refresh");
  streamDeckBridge.changed = () => calls.push("snapshot"); streamDeckBridge.refreshCapabilities = () => calls.push("capabilities");
  const creature = new MonsterGeneratorPanel(), preview = { source: { name: "Fixture" } };
  Object.assign(creature, { _preview: preview, _catalog: { kind: "monster" } });
  CreaturePanel.instances.add(creature);
  const overlay = await new OverlayPanel().render();
  overlay._diagnostics = { account: "Fixture account" }; OverlayPanel.instances.add(overlay);
  try {
    for (const key of ["overlayEnabled", "overlayTableCommandsEnabled"]) registered.get(key).onChange(true);
    assert.deepEqual(calls, ["restart", "snapshot", "restart", "snapshot"]);
    for (const key of ["overlayForwardFilter", "overlayCardHoldSeconds"]) registered.get(key).onChange("1");
    assert.equal(calls.length, 4);
    assert.equal(creature._preview, preview); assert(creature._catalog);
    assert.equal(overlay._diagnostics.account, "Fixture account");
    assert.equal(overlay.renders, 5);
    registered.get("accountToken").onChange("");
    assert.deepEqual(calls.slice(4), ["refresh", "capabilities"]);
    assert.equal(creature._preview, null);
    assert.equal(overlay._diagnostics, null);
  } finally {
    // The spies are own properties over the prototype methods.
    delete overlayRelay.restart; delete overlayRelay.refresh;
    delete streamDeckBridge.changed; delete streamDeckBridge.refreshCapabilities;
    CreaturePanel.instances.delete(creature); delete globalThis.Hooks;
  }
});

test("players can enable the browser relay in the connection panel without changing Atlas", async () => {
  game.user.isGM = false;
  const panel = new ConnectionPanel();
  await panel._toggleOverlay({ currentTarget: { checked: true } });
  assert.equal(settings.get("overlayEnabled"), true);
  assert.equal(settings.get("atlasEnabled"), false);
  assert.deepEqual(writes, ["overlayEnabled"]);
});

test("the overlay template is localized, escapes server labels and hides table controls from players", async () => {
  const template = await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8");
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const strings = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    game.i18n.localize = key => strings[key] ?? key;
    const hbs = Handlebars.create(); hbs.registerHelper("localize", key => strings[key] ?? key);
    const context = await new OverlayPanel()._prepareContext();
    context.hasDiagnostics = true;
    context.rows = [{ label: strings["JDRNINJA.overlay.diag.account"], message: "<img src=x onerror=fixture()>" }];
    const html = hbs.compile(template)(context);
    assert(!html.includes("JDRNINJA."), locale);
    assert(html.includes("&lt;img")); assert(!html.includes("<img src=x"));
    assert(html.includes('name="overlayTableCommandsEnabled"'));
    const player = hbs.compile(template)({ ...context, isGM: false });
    assert(!player.includes('name="overlayTableCommandsEnabled"'));
    assert(player.includes('name="overlayEnabled"'));
    for (const action of html.matchAll(/data-action="(\w+)"/g)) assert.equal(typeof OverlayPanel.DEFAULT_OPTIONS.actions[action[1]], "function");
  }
});

test("the overlay window is reused while open and gets a fresh instance after closing", async () => {
  const first = OverlayPanel.open();
  assert.equal(OverlayPanel.open(), first);
  await first.close();
  assert.notEqual(OverlayPanel.open(), first);
});

test("closing the overlay panel aborts diagnostics and refuses a late authenticated result", async () => {
  const original = overlayRelay.request;
  let options, release;
  overlayRelay.request = current => { options = current; return new Promise(resolve => { release = resolve; }); };
  try {
    const panel = new OverlayPanel();
    const pending = panel._check(); await flush();
    await panel.close();
    const renders = panel.renders;
    assert(options.signal.aborted);
    release({ ok: true, data: { ok: true, tokenKind: "foundry", account: "Late", entitled: true } });
    await pending;
    assert.equal(panel._diagnostics, null);
    assert.equal(panel.renders, renders);
  } finally { overlayRelay.request = original; }
});
