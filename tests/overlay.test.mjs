import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { OverlayRelay, overlayRelay, CARD_HOLD_CLASS } from "../scripts/overlay/relay.js";
import { buildOverlayPayload, dsnAppearanceStatus, extractAppearance, tableFormulaIsMeshBacked } from "../scripts/overlay/payload.js";
import { registerSettings } from "../scripts/settings.js";
import { overlayState, creatureState, atlasState, windowState, control } from "../scripts/ui/states.js";

class App {
  rendered = false;
  renders = 0;
  async render() { this.rendered = true; this.renders++; return this; }
  async close() { this.rendered = false; return this; }
  bringToFront() {}
}
/** Foundry's deep merge, in place and source-wins, for the plain objects Dice So Nice stores. */
function mergeObject(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const nested = value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object";
    target[key] = nested ? mergeObject(target[key], value) : value;
  }
  return target;
}
globalThis.foundry = { applications: { api: { ApplicationV2: App, HandlebarsApplicationMixin: base => base } },
  utils: { randomID: () => "fixture-test-id", deepClone: value => structuredClone(value), mergeObject } };
const { OverlayPanel, diagnosticStatus, formatMoment } = await import("../scripts/overlay/panel.js");
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

/**
 * A stand-in for Dice So Nice 6.4.4, which no longer has `Dice3D.ALL_CUSTOMIZATION`: it keeps that step in a
 * settings class it does not export. What it still exports is `exports.Utils` (`contrastOf`,
 * `sanitizeAppearance`), the package defaults of its `basic` role, and the user, `saved` and actor flags.
 */
function fakeDsn64({ packageDefaults = {} } = {}) {
  const { DiceFactory } = fakeDsn();
  DiceFactory.getRole = id => id === "basic" ? { id, defaults: packageDefaults } : undefined;
  const sanitized = [];
  return { DiceFactory, sanitized, exports: { Utils: {
    contrastOf: () => "#FFFFFF",
    sanitizeAppearance(appearance, user) {
      sanitized.push(user?.id);
      for (const scope of Object.values(appearance)) if (scope.material === "unknown-material") scope.material = "auto";
      return appearance;
    },
  } } };
}
const dsnFlags = flags => (scope, key) => scope === "dice-so-nice" ? flags[key] : undefined;
const dsn64User = (id, flags = {}, values = {}) => ({ ...dsnUser(id), getFlag: dsnFlags(flags), ...values });

test("Dice So Nice 6.4: the look is rebuilt from what DSN still exports, in DSN's own order", () => {
  const dsn = game.dice3d = fakeDsn64({ packageDefaults: { global: { diceColor: "#445566" } } });
  // A player who never saved a look: the user colour default, then the package's basic defaults.
  assert.deepEqual(extractAppearance(message("fresh", { author: dsn64User("fresh") })),
    { diceColor: "#445566", labelColor: "#ffffff", outlineColor: "#3366cc", edgeColor: "#3366cc" });
  // A saved look replaces the package defaults, and DSN's sanitizer still runs over it.
  const look = { global: { diceColor: "#aa0000", labelColor: "#00aa00", material: "unknown-material", font: "Signika" } };
  const saved = dsn64User("saved", { saved: { appearance: true }, appearance: look });
  assert.deepEqual(extractAppearance(message("saved", { author: saved })),
    { diceColor: "#aa0000", labelColor: "#00aa00", outlineColor: "#3366cc", edgeColor: "#3366cc", font: "Signika" });
  assert.equal(look.global.material, "unknown-material");
  assert(dsn.sanitized.includes("fresh") && dsn.sanitized.includes("saved"));
  // The speaking actor's look wins over the user's.
  const hero = { id: "hero", getFlag: dsnFlags({ appearance: { global: { diceColor: "#654321" } } }) };
  const spoken = message("actor", { author: saved, speaker: { actor: "hero" },
    constructor: { getSpeakerActor: speaker => speaker.actor === "hero" ? hero : null } });
  assert.equal(extractAppearance(spoken).diceColor, "#654321");
});

test("Dice So Nice: a version whose look the module cannot read is reported, not guessed", () => {
  game.user = dsn64User("me", {}, { isGM: true });
  game.dice3d = undefined;
  assert.equal(dsnAppearanceStatus(), "absent");
  for (const dsn of [fakeDsn(), fakeDsn64()]) { game.dice3d = dsn; assert.equal(dsnAppearanceStatus(), "ok"); }
  // DSN is there, but neither ALL_CUSTOMIZATION nor the exported helpers are: a later update moved them again.
  game.dice3d = { DiceFactory: fakeDsn().DiceFactory };
  assert.equal(dsnAppearanceStatus(), "unreadable");
  assert.equal(extractAppearance(message("moved", { author: dsn64User("player") })), undefined);
  game.dice3d = fakeDsn64();
  game.dice3d.DiceFactory.getAppearanceForDice = () => { throw new Error("DSN failure"); };
  assert.equal(dsnAppearanceStatus(), "unreadable");
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

test("the overlay window offers its subscription page only when diagnostics report sending as not included", async () => {
  const renderer = Handlebars.create(); renderer.registerHelper("localize", key => copy[key] ?? key);
  const render = renderer.compile(await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8"));
  const diagnostics = entitled => ({ ok: true, tokenKind: "foundry", account: "Fixture GM", entitled });
  for (const [data, expected] of [[null, false], [diagnostics(true), false], [diagnostics(false), true]]) {
    const panel = new OverlayPanel(); panel._diagnostics = data;
    const context = await panel._prepareContext();
    const html = render(context);
    assert.equal(context.status.step?.link?.kind === "overlay", expected);
    assert.equal(html.includes('data-jdr-subscriptions="overlay"'), expected);
    // The offers page of the overlay on the saved site address; the sentence is the one « Consult the subscriptions ».
    if (expected) {
      assert(html.includes('href="https://www.jdr.ninja/vtt-overlay/abonnement"'));
      assert(html.includes(`>${copy["JDRNINJA.creatures.subscription"]}</a>`));
    }
    // No window button opens it: the link lives in the status line only.
    assert(!html.includes('data-action="subscription"'));
  }
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

test("the overlay settings are not listed in the settings tab: their key, scope, default and choices survive", () => {
  const registered = new Map();
  game.settings.register = (_module, key, value) => registered.set(key, value);
  game.settings.registerMenu = () => {};
  registerSettings({ menus: { connections: ConnectionPanel } });
  const expected = { overlayEnabled: [false], overlayForwardFilter: ["allPublic", ["allPublic", "playersOnly"]],
    overlayCardHoldSeconds: ["0", ["0", "1", "2", "3", "5"]], overlayTableCommandsEnabled: [false] };
  for (const [key, [value, choices]] of Object.entries(expected)) {
    const options = registered.get(key);
    assert.equal(options.config, false, key);
    assert.equal(options.scope, "client", key);
    assert.equal(options.default, value, key);
    assert(!("name" in options) && !("hint" in options), `${key}: its window owns the label and the hint`);
    assert.deepEqual(choices ? Object.keys(options.choices) : undefined, choices, key);
    assert.equal(typeof options.onChange, "function", key);
  }
  // The table-commands switch is no longer a GM-only line of the tab: its configuration does not depend on the user.
  game.user.isGM = false;
  assert.equal(registered.get("overlayTableCommandsEnabled").config, false);
  game.user.isGM = true;
  assert.equal(registered.get("overlayTableCommandsEnabled").config, false);
  for (const key of ["overlayLastSuccessAt", "overlayLastErrorAt", "overlayLastError"]) assert.equal(registered.get(key).config, false, key);
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
    context.hasDiagnostics = context.showDiagnostics = true;
    context.rows = [{ label: strings["JDRNINJA.overlay.diag.subscription"], message: "<img src=x onerror=fixture()>" },
      { label: strings["JDRNINJA.overlay.diag.obs"], message: "<img src=y onerror=fixture()>", level: "warning", icon: "fa-triangle-exclamation" }];
    // A failure text and the account's own error are escaped too.
    context.status = windowState(overlayState({ enabled: true, account: "retry" }), { retry: control("diagnostics", "Retry", "fa-rotate"),
      message: "<img src=z onerror=fixture()>" });
    const html = hbs.compile(template)(context);
    assert(!html.includes("JDRNINJA."), locale);
    assert(html.includes("&lt;img")); assert(!html.includes("<img src=x")); assert(!html.includes("<img src=y")); assert(!html.includes("<img src=z"));
    assert(html.includes("jn-pill--warning") && html.includes("&lt;img src&#x3D;y") && html.includes("&lt;img src&#x3D;z"));
    assert(html.includes('name="overlayTableCommandsEnabled"'));
    const player = hbs.compile(template)({ ...context, isGM: false });
    assert(!player.includes('name="overlayTableCommandsEnabled"'));
    assert(!html.includes('name="overlayEnabled"') && !player.includes('name="overlayEnabled"'), "the activation lives in Connections only");
    for (const action of html.matchAll(/data-action="(\w+)"/g)) assert.equal(typeof OverlayPanel.DEFAULT_OPTIONS.actions[action[1]], "function");
  }
});

/** The diagnostics the account's endpoint answers, with the parts a test changes. */
function accountAnswer(values = {}) {
  return { ok: true, tokenKind: "foundry", account: "Fixture GM", entitled: true,
    overlay: { exists: true, enabled: true, connectedClients: 1 }, tableCommands: { secondsSinceLastPoll: 3 }, ...values };
}

test("pill levels: a missing subscription or overlay is an error, a missing OBS source or poll a warning, the rest succeeds", () => {
  const ok = { level: "success", icon: "fa-circle-check" }, warning = { level: "warning", icon: "fa-triangle-exclamation" },
    error = { level: "error", icon: "fa-circle-xmark" };
  const pills = status => Object.fromEntries(Object.entries(diagnosticStatus(status)).map(([key, { ok: state, ...pill }]) => [key, [state, pill]]));
  assert.deepEqual(pills(accountAnswer()), { subscription: [true, ok], overlay: [true, ok], obs: [true, ok], poll: [true, ok] });
  assert.deepEqual(pills(accountAnswer({ entitled: false })).subscription, [false, error]);
  assert.deepEqual(pills(accountAnswer({ overlay: { exists: true, enabled: false, connectedClients: 1 } })).overlay, [false, error]);
  assert.deepEqual(pills(accountAnswer({ overlay: { exists: false, enabled: true, connectedClients: 1 } })).overlay, [false, error]);
  assert.deepEqual(pills(accountAnswer({ overlay: { exists: true, enabled: true, connectedClients: 0 } })).obs, [false, warning]);
  assert.deepEqual(pills(accountAnswer({ tableCommands: {} })).poll, [false, warning]);
  assert.deepEqual(pills(accountAnswer({ tableCommands: { secondsSinceLastPoll: null } })).poll, [false, warning]);
  // A partial answer never throws, and every line of it reads as missing.
  assert.deepEqual(Object.values(diagnosticStatus({ account: "Partial" })).map(line => line.ok), [false, false, false, false]);
});

test("the last accepted send is dated in Foundry's language, without seconds", () => {
  const moment = Date.UTC(2026, 9, 8, 19, 30, 45);
  assert.equal(formatMoment(moment, "en", { timeZone: "UTC" }).replace(/\s/g, " "), "Oct 8, 2026, 7:30 PM");
  assert.match(formatMoment(moment, "fr", { timeZone: "UTC" }), /19:30/);
  for (const locale of ["en", "fr", "es", "de", "it"]) assert.doesNotMatch(formatMoment(moment, locale, { timeZone: "UTC" }), /:45/, locale);
  for (const value of [0, null, undefined, "", "not a date", Number.NaN]) assert.equal(formatMoment(value, "en"), null, String(value));
  assert.match(formatMoment(moment, "not_a_locale", { timeZone: "UTC" }), /2026/);
});

test("each diagnostics line carries its pill beside its message; the account is no line of its own, and players get no poll line", async () => {
  const label = key => copy[`JDRNINJA.overlay.diag.${key}`];
  const panel = new OverlayPanel();
  panel._diagnostics = accountAnswer({ overlay: { exists: true, enabled: true, connectedClients: 0 } });
  const context = await panel._prepareContext();
  assert.deepEqual(context.rows.map(row => [row.label, row.level]), [[label("subscription"), "success"],
    [label("overlay"), "success"], [label("obs"), "warning"], [label("poll"), "success"]]);
  assert(!context.rows.some(row => row.label === label("account") || row.message === "Fixture GM"), "the account name is Connections' business");
  assert.equal(context.rows[2].message, copy["JDRNINJA.overlay.diag.obsMissing"]);
  assert.equal(context.rows[2].icon, "fa-triangle-exclamation");
  panel._diagnostics = accountAnswer({ entitled: false, overlay: { exists: false } });
  const refused = await panel._prepareContext();
  assert.deepEqual(refused.rows.slice(0, 2).map(row => [row.level, row.message]), [["error", copy["JDRNINJA.overlay.error.notEntitled"]],
    ["error", copy["JDRNINJA.overlay.error.overlayDisabled"]]]);
  game.user.isGM = false;
  assert.equal((await panel._prepareContext()).rows.some(row => row.label === label("poll")), false);
  // The last send reads like the rest of the window: Foundry's language, no seconds.
  settings.set("overlayLastSuccessAt", Date.UTC(2026, 9, 8, 19, 30, 45));
  const { lastSuccess } = await panel._prepareContext();
  assert.match(lastSuccess, /^Dernier envoi accepté : /); assert.doesNotMatch(lastSuccess, /:45/);
});

test("the diagnostics show whether the Dice So Nice look reaches the overlay, and name the DSN version when it cannot", async () => {
  const label = copy["JDRNINJA.overlay.diag.dice"];
  const panel = new OverlayPanel();
  panel._diagnostics = accountAnswer({ overlay: { exists: true, enabled: true, connectedClients: 1 } });
  const diceRow = async () => (await panel._prepareContext()).rows.find(row => row.label === label);
  assert.equal(await diceRow(), undefined);
  game.user = dsn64User("gm", {}, { isGM: true });
  game.modules = new Map([["dice-so-nice", { active: true, version: "9.0.0" }]]);
  game.dice3d = fakeDsn64();
  assert.deepEqual(await diceRow(), { label, message: copy["JDRNINJA.overlay.diag.diceOk"], level: "success", icon: "fa-circle-check" });
  game.dice3d = { DiceFactory: fakeDsn().DiceFactory };
  const unreadable = await diceRow();
  assert.equal(unreadable.level, "warning");
  assert.match(unreadable.message, /^Impossible de lire les réglages d'apparence de Dice So Nice 9\.0\.0\./);
});

test("the overlay window is one layout: a status line, three titled sections, and a footer whose one primary action is the test roll", async () => {
  const template = await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8");
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const strings = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    game.i18n.localize = key => strings[key] ?? key;
    const hbs = Handlebars.create(); hbs.registerHelper("localize", key => strings[key] ?? key);
    const panel = new OverlayPanel();
    panel._diagnostics = accountAnswer({ entitled: false });
    const html = hbs.compile(template)(await panel._prepareContext());
    const flat = html.replace(/\s+/g, " "), esc = value => Handlebars.escapeExpression(value);
    assert(!html.includes("JDRNINJA."), locale);
    // No frames: sections replace fieldsets, in a scrolling layout with a fixed footer.
    assert.match(html, /^<div class="standard-form jn-layout jn-overlay">/);
    assert(!html.includes("<fieldset") && !html.includes("<legend"), locale);
    assert.equal(html.match(/<footer class="form-footer jn-footer">/g).length, 1);
    assert.equal(html.match(/class="jn-section"/g).length, 3, "roll sending, Twitch table draws and diagnostics");
    // The status line comes first, before every section.
    assert(html.indexOf('class="jn-status-line"') > 0 && html.indexOf('class="jn-status-line"') < html.indexOf('class="jn-section"'), locale);
    assert.equal(html.match(/class="jn-status-line"/g).length, 1);
    const titles = [...html.matchAll(/<h3 class="jn-section__title"[^>]*>\s*<i class="([^"]+)" aria-hidden="true"><\/i>\s*([^<]+?)\s*<\/h3>/g)];
    assert.deepEqual(titles.map(match => match[2]), [strings["JDRNINJA.overlay.sendingTitle"], strings["JDRNINJA.overlay.tablesTitle"],
      strings["JDRNINJA.overlay.diagnostics"]], locale);
    assert(titles.every(match => /fa-(solid|brands) fa-/.test(match[1])), "each title has its icon");
    // The Twitch section's title is not repeated by its checkbox label.
    assert.notEqual(strings["JDRNINJA.overlay.tablesTitle"], strings["JDRNINJA.overlay.tablesEnable"], locale);
    assert(flat.includes(`<label for="jdr-ninja-overlay-tables">${esc(strings["JDRNINJA.overlay.tablesEnable"])}</label>`), locale);
    // One primary button, the test roll, in the footer; the other actions are never primary, and none sits in the footer
    // but the diagnostics read (and Cancel while busy): « Configure the connections » only appears as a blocked state's action.
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(match => match[0]);
    const bright = buttons.filter(button => /class="[^"]*\bbright\b[^"]*"/.test(button));
    assert.equal(bright.length, 1, locale);
    assert(bright[0].includes('data-action="testRoll"') && bright[0].includes("disabled"), "disabled without a subscription");
    assert(bright[0].includes(`data-tooltip="${esc(strings["JDRNINJA.overlay.testHint"])}"`), locale);
    const footer = html.slice(html.indexOf("<footer"));
    assert.deepEqual([...footer.matchAll(/data-action="(\w+)"/g)].map(match => match[1]), ["testRoll", "diagnostics"], locale);
    assert(footer.indexOf("fa-dice-d20") > 0 && footer.indexOf('class="bright"') < footer.indexOf('data-action="diagnostics"'));
    assert(!html.includes('data-action="connections"'), "a working window has no « Configure the connections »");
    assert(!html.includes('data-action="subscription"'));
    // No activation, no paid notice, no account line: Connections and the status line own them.
    assert(!html.includes('name="overlayEnabled"') && !html.includes("jdr-ninja-overlay-enabled"), locale);
    for (const key of ["paidHint", "enable", "enableHint"]) {
      const removed = strings[`JDRNINJA.overlay.${key}`];
      assert(!removed || !flat.includes(esc(removed)), `${locale}: ${key}`);
    }
    assert(!flat.includes(`<dt>${esc(strings["JDRNINJA.overlay.diag.account"])}</dt>`), `${locale}: no account line`);
    // The diagnostics keep their table and live region.
    assert(flat.includes('<dl class="jn-diagnostics" aria-live="polite">'));
    // Pills carry the level, an icon and the message.
    assert(flat.includes('<span class="jn-pill jn-pill--error"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> '
      + `${esc(strings["JDRNINJA.overlay.error.notEntitled"])}</span>`), locale);
    assert(flat.includes('<span class="jn-pill jn-pill--success"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> '
      + `${esc(strings["JDRNINJA.overlay.diag.overlayActive"])}</span>`), locale);
    // Hooks the code and the screenshot tool use: the filter, the delay and the table draws have their only control here.
    for (const hook of ['name="overlayForwardFilter"', 'name="overlayCardHoldSeconds"',
      'name="overlayTableCommandsEnabled"', 'data-action="diagnostics"', 'data-action="testRoll"', 'data-action="commands"']) {
      assert(html.includes(hook), `${locale}: ${hook}`);
    }
    // Each control has its label; each information icon is focusable and names its tooltip.
    for (const [, id] of html.matchAll(/<(?:input|select) id="([\w-]+)"/g)) assert(html.includes(`<label for="${id}">`), `${locale}: ${id}`);
    const infos = [...html.matchAll(/<i class="fa-solid fa-circle-info jn-info"([^>]*)>/g)].map(match => match[1]);
    assert.equal(infos.length, 3, "delay, table draws and table setup: the test roll's hint is its button's tooltip");
    for (const attributes of infos) {
      assert(attributes.includes('tabindex="0"') && attributes.includes('role="img"'), locale);
      const label = attributes.match(/aria-label="([^"]+)"/)?.[1], tooltip = attributes.match(/data-tooltip="([^"]+)"/)?.[1];
      assert(label && label === tooltip, `${locale}: ${attributes}`);
    }
  }
});

test("a player has no Twitch section, and the footer keeps the test roll and the diagnostics read", async () => {
  const template = await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8");
  const hbs = Handlebars.create(); hbs.registerHelper("localize", key => copy[key] ?? key);
  game.user.isGM = false;
  const panel = new OverlayPanel();
  panel._diagnostics = accountAnswer();
  const html = hbs.compile(template)(await panel._prepareContext());
  assert.equal(html.match(/class="jn-section"/g).length, 2);
  assert(!html.includes("overlayTableCommandsEnabled") && !html.includes('data-action="commands"'));
  assert(!html.includes('data-action="subscription"') && !html.includes('data-action="connections"'));
  assert.deepEqual([...html.slice(html.indexOf("<footer")).matchAll(/data-action="(\w+)"/g)].map(match => match[1]), ["testRoll", "diagnostics"]);
  assert(!html.includes(copy["JDRNINJA.overlay.diag.poll"]), "no command poll line for a player");
  // Active: the test roll is the one enabled primary action.
  assert.doesNotMatch(html.slice(html.indexOf("<footer")), /disabled/);
});

test("the diagnostics section appears only with something to show, and the window never needs it to be usable", async () => {
  const template = await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8");
  const hbs = Handlebars.create(); hbs.registerHelper("localize", key => copy[key] ?? key);
  const panel = new OverlayPanel();
  const empty = hbs.compile(template)(await panel._prepareContext());
  assert.equal(empty.match(/class="jn-section"/g).length, 2);
  assert(!empty.includes(`> ${copy["JDRNINJA.overlay.diagnostics"]}`));
  settings.set("overlayLastSuccessAt", Date.UTC(2026, 9, 8, 19, 30, 45));
  const sent = hbs.compile(template)(await panel._prepareContext());
  assert.equal(sent.match(/class="jn-section"/g).length, 3);
  assert(sent.includes(copy["JDRNINJA.overlay.diagnostics"]) && sent.includes("Dernier envoi accepté"));
  settings.set("overlayLastErrorAt", Date.UTC(2026, 9, 9)); settings.set("overlayLastError", "Fixture failure");
  assert(hbs.compile(template)(await panel._prepareContext()).includes("Fixture failure"));
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

/**
 * Every account request waits for its test to answer it, so the window can be looked at while a read is in flight.
 * `open()` gives a rendered panel that the credential-change hook reaches, like the real one.
 */
function holdRequests() {
  const original = overlayRelay.request, pending = [];
  overlayRelay.request = options => new Promise(resolve => pending.push({ options, resolve, path: options.path }));
  const open = () => {
    const panel = new OverlayPanel();
    panel.rendered = true; OverlayPanel.instances.add(panel);
    return panel;
  };
  return { pending, open, restore: () => { overlayRelay.request = original; } };
}
const firstRender = { isFirstRender: true };
const DIAGNOSTICS = "/api/foundry/v1/overlay/diagnostics";

test("the window checks the account once per opening, on its first render, and never retries a failure by itself", async () => {
  const held = holdRequests();
  try {
    const panel = held.open();
    const first = await panel._prepareContext(firstRender);
    assert.deepEqual(held.pending.map(request => [request.path, request.options.token]), [[DIAGNOSTICS, "fixture-account-token"]]);
    // The window opens on « Checking », stays usable, and only the pill says so: no busy footer, no disabled control.
    assert.equal(first.status.state, "checking");
    assert.equal(first.status.pill.label, copy["JDRNINJA.panel.state.checking"]);
    assert.equal(first.status.step, null);
    assert.equal(first.busy, false); assert.equal(first.canCheck, true);
    held.pending[0].resolve({ ok: true, data: accountAnswer() });
    await flush();
    assert.equal(panel.renders, 1, "the answer redraws the window once");
    assert.equal(panel._diagnostics.account, "Fixture GM");
    // Neither the next render, nor a repeated « first render » option, nor a setting redraw starts another read.
    await panel._prepareContext(); await panel._prepareContext({ isFirstRender: false }); await panel._prepareContext(firstRender);
    OverlayPanel.renderAll(); await flush();
    assert.equal(held.pending.length, 1);
    assert.equal((await panel._prepareContext()).status.state, "active");
    // A failed read stays failed until the user retries.
    const failing = held.open();
    await failing._prepareContext(firstRender);
    held.pending[1].resolve({ ok: false, reason: "network" });
    await flush();
    await failing._prepareContext(); OverlayPanel.renderAll(); await flush();
    assert.equal(held.pending.length, 2);
    assert.equal((await failing._prepareContext()).status.state, "attention");
  } finally { held.restore(); }
});

test("the automatic check leaves every control usable and the footer without Cancel", async () => {
  const held = holdRequests();
  try {
    const panel = held.open();
    const context = await panel._prepareContext(firstRender);
    const hbs = Handlebars.create(); hbs.registerHelper("localize", key => copy[key] ?? key);
    const html = hbs.compile(await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8"))(context);
    assert(html.includes(copy["JDRNINJA.panel.state.checking"]));
    assert(!html.includes('data-action="cancel"'));
    assert.doesNotMatch(html.slice(html.indexOf("<section"), html.indexOf("<footer")), /<(?:select|input|button)[^>]*\bdisabled\b/, "the sections stay enabled");
    assert.match(html, /<button type="button" class="bright" data-action="testRoll"[^>]*disabled>/, "a test roll waits for the Active state");
    assert.match(html, /<button type="button" data-action="diagnostics"\s*>/, "the check stays available");
  } finally { held.restore(); }
});

test("without a saved account credential, or with the standalone module active, the window checks nothing", async () => {
  const held = holdRequests();
  try {
    settings.set("accountToken", "");
    const player = held.open();
    assert.equal((await player._prepareContext(firstRender)).status.state, "accountRequired");
    settings.set("accountToken", "fixture-account-token");
    game.modules = new Map([["jdr-ninja-vtt-overlay", { active: true }]]);
    const legacy = held.open();
    assert.equal((await legacy._prepareContext(firstRender)).status.state, "unavailable");
    assert.equal(held.pending.length, 0);
    // The opening is spent: a token saved later is checked by the user, not by a later render.
    game.modules = new Map();
    settings.set("accountToken", "fixture-new-token");
    await player._prepareContext(); await player._prepareContext(firstRender);
    assert.equal(held.pending.length, 0);
    assert.equal((await player._prepareContext()).status.state, "attention");
  } finally { held.restore(); }
});

test("closing the window cancels the automatic check and refuses its late answer", async () => {
  const held = holdRequests();
  try {
    const panel = held.open();
    await panel._prepareContext(firstRender);
    const [request] = held.pending;
    assert.equal(request.options.signal.aborted, false);
    await panel.close();
    assert(request.options.signal.aborted);
    const renders = panel.renders;
    request.resolve({ ok: true, data: accountAnswer() });
    await flush();
    assert.equal(panel._diagnostics, null);
    assert.equal(panel.renders, renders);
    assert.equal(OverlayPanel.instances.has(panel), false);
  } finally { held.restore(); }
});

test("an explicit check or test roll ends the automatic check, and the late answer of that check changes nothing", async () => {
  const held = holdRequests();
  try {
    for (const action of ["_check", "_test"]) {
      held.pending.length = 0;
      const panel = held.open();
      await panel._prepareContext(firstRender);
      const [auto] = held.pending;
      const explicit = panel[action](); await flush();
      assert(auto.options.signal.aborted, action);
      assert.equal(panel._auto, null);
      // The explicit operation makes the window busy; only a check shows « Checking » in the pill.
      const busy = await panel._prepareContext();
      assert.equal(busy.busy, true, action);
      assert.equal(busy.status.state, action === "_check" ? "checking" : "attention", "no answer describes the account yet");
      auto.resolve({ ok: true, data: accountAnswer({ account: "Late automatic" }) });
      await flush();
      assert.equal(panel._diagnostics, null, "the aborted read describes nothing");
      if (action === "_check") held.pending[1].resolve({ ok: false, reason: "unauthorized" });
      else {
        assert.equal(held.pending[1].path, "/api/foundry/v1/overlay/rolls");
        held.pending[1].resolve({ ok: true, data: { state: "rolled" } }); await flush();
        assert.equal(held.pending[2].path, DIAGNOSTICS, "a test roll reads the diagnostics again");
        held.pending[2].resolve({ ok: false, reason: "unauthorized" });
      }
      await explicit;
      assert.equal(panel._diagnostics, null);
      assert.equal(panel._failure, "unauthorized");
      assert.equal((await panel._prepareContext()).status.state, "attention");
    }
  } finally { held.restore(); }
});

test("an answer that arrives after the account credential changed is ignored, and the new credential is checked once", async () => {
  const held = holdRequests();
  try {
    // The credential changes while the read is in flight: the relay already refuses the answer...
    const panel = held.open();
    await panel._prepareContext(firstRender);
    settings.set("accountToken", "fixture-other-token"); overlayRelay.refresh(); OverlayPanel.refreshAll();
    held.pending[0].resolve({ ok: true, data: accountAnswer() });
    await flush();
    assert.equal(panel._diagnostics, null); assert.equal(panel._failure, "");
    // The new credential is checked once, like a new opening: its state is unknown, not wrong.
    assert.equal(held.pending.length, 2);
    assert.equal((await panel._prepareContext()).status.state, "checking");
    // ... and so does the window, whatever the relay says: the answer was asked for another credential.
    overlayRelay.diagnostics = async () => { settings.set("accountOrigin", "https://other.example"); return { ok: true, data: accountAnswer() }; };
    try {
      const late = held.open();
      await late._check();
      assert.equal(late._diagnostics, null); assert.equal(late._failure, "");
      settings.set("accountOrigin", "https://www.jdr.ninja");
      overlayRelay.diagnostics = async () => { settings.set("accountToken", "fixture-third-token"); return { ok: false, reason: "network" }; };
      await late._check();
      assert.equal(late._failure, "", "a stale failure is ignored as well");
    } finally { delete overlayRelay.diagnostics; }
  } finally { held.restore(); }
});

test("an answer that arrives before the first render completes is drawn once by that render, and never after the window closes", async () => {
  const held = holdRequests();
  try {
    // The window is not rendered yet: the first render is still preparing its context when the read fails.
    const panel = new OverlayPanel();
    assert.equal(panel.rendered, false);
    await panel._prepareContext(firstRender);
    held.pending[0].resolve({ ok: false, reason: "network" });
    await flush();
    assert.equal(panel.renders, 0, "nothing can be redrawn before the window is rendered");
    assert.equal(panel._failure, "network"); assert.equal(panel._auto, null);
    // The first render completes: its hook draws the answer, once.
    panel.element = { querySelector: () => null }; panel.rendered = true;
    panel._onRender({}, firstRender); await flush();
    assert.equal(panel.renders, 1);
    const drawn = await panel._prepareContext();
    assert.equal(drawn.status.state, "attention"); assert.equal(drawn.status.step.action.name, "diagnostics");
    panel._onRender({}, {}); await flush();
    assert.equal(panel.renders, 1, "a later render does not draw it again");
    assert.equal(held.pending.length, 1, "and nothing is checked again");

    // The window closes before its first render completes, or in the instant between that render and the redraw: nothing is drawn.
    const early = async () => {
      const closing = new OverlayPanel();
      await closing._prepareContext(firstRender);
      held.pending.at(-1).resolve({ ok: false, reason: "network" }); await flush();
      assert.equal(closing._drawOnRender, true);
      return closing;
    };
    const before = await early();
    await before.close(); await flush();
    assert.equal(before._drawOnRender, false); assert.equal(before.renders, 0);
    const during = await early();
    during.element = { querySelector: () => null }; during.rendered = true;
    during._onRender({}, firstRender); during.rendered = false; await flush();
    assert.equal(during.renders, 0);
  } finally { held.restore(); }
});

test("a window keeps the label and icon of the check it replaces with its own, and reads a saved credential nobody answered as to check", () => {
  const word = key => copy[`JDRNINJA.${key}`], retry = control("diagnostics", "Retry", "fa-rotate");
  const offer = status => [status.step.action.name, status.step.action.label, status.step.action.icon];
  const compatibility = { compatible: true };
  // A Connections check becomes the window's own, under the label the row gave it: only the name is the window's.
  assert.deepEqual(offer(windowState(creatureState({ compatibility, access: null }), { retry })), ["diagnostics", word("button.check"), "fa-rotate"]);
  assert.deepEqual(offer(windowState(atlasState({ enabled: true, configured: true }), { retry })), ["diagnostics", word("button.check"), "fa-rotate"]);
  assert.deepEqual(offer(windowState(creatureState({ compatibility, access: null, result: { ok: false, reason: "network" } }), { retry })),
    ["diagnostics", word("button.retry"), "fa-rotate"]);
  assert.deepEqual(offer(windowState(atlasState({ enabled: true, configured: true, result: { ok: false, reason: "network" } }), { retry })),
    ["diagnostics", word("button.retry"), "fa-rotate"]);
  assert.equal(windowState(creatureState({ compatibility, access: null }), {}).step.action, undefined, "without a retry the row has no action");
  // A saved token nothing has answered for: « Needs verification », no sentence, and the check.
  const unchecked = windowState(overlayState({ enabled: true, account: "unchecked" }), { retry });
  assert.deepEqual([unchecked.state, unchecked.reason, unchecked.pill.level, unchecked.pill.label, unchecked.step.level, unchecked.step.text, ...offer(unchecked)],
    ["attention", "check", "warning", word("status.saved"), "info", "", "diagnostics", word("button.check"), "fa-rotate"]);
  assert.equal(windowState(overlayState({ enabled: true, account: "unchecked" })).step, null, "no check to offer, no empty message");
  // With the failure's message the state keeps its pill and offers the window's own retry.
  const failed = windowState(overlayState({ enabled: true, account: "retry" }), { retry, message: "Down" });
  assert.deepEqual([failed.pill.label, failed.step.level, failed.step.text, ...offer(failed)],
    [word("panel.state.attention"), "error", "Down", "diagnostics", "Retry", "fa-rotate"]);
});

/** The state of the window for each way the account can answer: its pill, its message and its one action or link. */
const STATE_TABLE = [
  { name: "disabled", enabled: false, state: "disabled", pill: ["neutral", "fa-circle-minus", "panel.state.disabled"],
    text: "notice.disabled", action: ["connections", "menu.label", "fa-link"] },
  { name: "standalone module active", legacy: true, state: "unavailable", pill: ["error", "fa-circle-xmark", "panel.state.unavailable"],
    text: "overlay.error.legacyActive", role: "alert" },
  { name: "no token", token: "", state: "accountRequired", pill: ["warning", "fa-triangle-exclamation", "panel.state.accountRequired"],
    text: "notice.connectAccount", action: ["connections", "menu.label", "fa-link"] },
  { name: "checking", checking: true, state: "checking", pill: ["info", "fa-spinner fa-spin", "panel.state.checking"] },
  // A saved token and no answer yet, after « Cancel » for example: it reads « Needs verification » and offers the check.
  { name: "saved token, no answer yet", state: "attention", pill: ["warning", "fa-triangle-exclamation", "status.saved"],
    action: ["diagnostics", "button.check", "fa-rotate"] },
  { name: "token refused", answer: { ok: false, reason: "unauthorized" }, state: "attention",
    pill: ["warning", "fa-triangle-exclamation", "panel.state.attention"], text: "notice.reconnectAccount", action: ["connections", "menu.label", "fa-link"] },
  { name: "invalid response", answer: { ok: true, data: { ok: true } }, state: "attention",
    pill: ["warning", "fa-triangle-exclamation", "panel.state.attention"], text: "notice.reconnectAccount", action: ["connections", "menu.label", "fa-link"] },
  { name: "a token that is not an account's", answer: { ok: true, data: { ...accountAnswer(), tokenKind: "atlas" } }, state: "attention",
    pill: ["warning", "fa-triangle-exclamation", "panel.state.attention"], text: "notice.reconnectAccount", action: ["connections", "menu.label", "fa-link"] },
  ...["network", "server", "rateLimited"].map(reason => ({ name: `${reason} failure`, answer: { ok: false, reason }, state: "attention",
    pill: ["warning", "fa-triangle-exclamation", "panel.state.attention"], text: `error.${reason}`, role: "alert",
    action: ["diagnostics", "button.retry", "fa-rotate"] })),
  { name: "no subscription", answer: { ok: true, data: accountAnswer({ entitled: false }) }, state: "subscriptionRequired",
    pill: ["warning", "fa-triangle-exclamation", "panel.state.subscriptionRequired"], text: "overlay.error.notEntitled",
    link: "https://www.jdr.ninja/vtt-overlay/abonnement" },
  { name: "active", answer: { ok: true, data: accountAnswer() }, state: "active", pill: ["success", "fa-circle-check", "panel.state.active"] },
];

test("each state of the overlay window shows its pill, its message and its one action, and only Active allows a test roll", async () => {
  const template = await readFile(new URL("../templates/overlay.hbs", import.meta.url), "utf8");
  const hbs = Handlebars.create(); hbs.registerHelper("localize", key => copy[key] ?? key);
  const render = hbs.compile(template), esc = value => Handlebars.escapeExpression(value), word = key => copy[`JDRNINJA.${key}`];
  const held = holdRequests();
  try {
    for (const row of STATE_TABLE) {
      if (row.enabled === false) settings.set("overlayEnabled", false);
      if (row.token !== undefined) settings.set("accountToken", row.token);
      game.modules = new Map(row.legacy ? [["jdr-ninja-vtt-overlay", { active: true }]] : []);
      const panel = held.open();
      if (row.checking) await panel._prepareContext(firstRender);
      if (row.answer) {
        const check = panel._check(); await flush();
        held.pending.at(-1).resolve(row.answer); await check;
      }
      const context = await panel._prepareContext();
      assert.equal(context.status.state, row.state, row.name);
      const html = render(context), flat = html.replace(/\s+/g, " "), line = flat.slice(0, flat.indexOf("<section"));
      const [level, icon, label] = row.pill;
      assert(line.includes(`<span class="jn-pill jn-pill--${level}" role="status"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${esc(word(label))}</span>`), `${row.name}: pill`);
      if (row.text) {
        const role = row.role ?? "status";
        assert(line.includes(`<p role="${role}">${esc(word(row.text))}</p>`), `${row.name}: message`);
      } else assert(!line.includes("<p"), `${row.name}: no message`);
      const buttons = [...line.matchAll(/<button type="button" data-action="(\w+)"><i class="fa-solid ([\w -]+)" aria-hidden="true"><\/i> ([^<]+)<\/button>/g)];
      assert.deepEqual(buttons.map(match => [match[1], match[3], match[2]]), row.action ? [[row.action[0], esc(word(row.action[1])), row.action[2]]] : [], `${row.name}: action`);
      assert.equal(line.includes("<a "), Boolean(row.link), `${row.name}: link`);
      if (row.link) assert(line.includes(`<a href="${row.link}" target="_blank" rel="noopener noreferrer" data-jdr-subscriptions="overlay">${esc(word("creatures.subscription"))}</a>`));
      // « Configure the connections » only ever sits in the message of a window that a connection blocks.
      assert.equal(flat.includes('data-action="connections"'), row.action?.[0] === "connections", `${row.name}: connections`);
      assert.equal(context.canTest, row.state === "active", `${row.name}: test roll`);
      assert.equal(/<button[^>]*data-action="testRoll"[^>]*disabled>/.test(html), row.state !== "active", `${row.name}: test roll button`);
      assert.equal((html.match(/<button[^>]*class="bright"/g) ?? []).length, 1, `${row.name}: one primary action`);
      OverlayPanel.instances.delete(panel); held.pending.length = 0;
      settings.set("overlayEnabled", true); settings.set("accountToken", "fixture-account-token");
    }
  } finally { held.restore(); }
});

test("a refused test roll is reported once: a state that already says it hides the repeat", async () => {
  const held = holdRequests();
  try {
    const panel = held.open();
    panel._diagnostics = accountAnswer();
    const test = panel._test(); await flush();
    assert.equal(held.pending[0].path, "/api/foundry/v1/overlay/rolls");
    held.pending[0].resolve({ ok: true, data: { state: "overlayDisabled" } }); await flush();
    held.pending[1].resolve({ ok: true, data: accountAnswer({ overlay: { exists: false, enabled: false, connectedClients: 0 } }) });
    await test;
    const context = await panel._prepareContext();
    assert.equal(context.error, copy["JDRNINJA.overlay.error.overlayDisabled"]);
    assert.deepEqual(notices, [copy["JDRNINJA.overlay.error.overlayDisabled"]]);
    assert.equal(context.status.state, "active");
    // The state's own message covers a refusal it already says: no second alert beside the status line.
    panel._error = copy["JDRNINJA.overlay.error.notEntitled"];
    panel._diagnostics = accountAnswer({ entitled: false });
    assert.equal((await panel._prepareContext()).error, "");
  } finally { held.restore(); }
});
