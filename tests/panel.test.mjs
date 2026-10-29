import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { registerSettings } from "../scripts/settings.js";
import { ENDPOINTS } from "../scripts/constants.js";
import { creatureClient } from "../scripts/creatures/api.js";

class Application {
  rendered = false;
  renders = [];
  fronted = 0;
  async render() { this.rendered = true; this.renders.push(await this._prepareContext()); return this; }
  async close() { this.rendered = false; return this; }
  bringToFront() { this.fronted++; }
  // The real mixin swaps the part's HTML: here the "HTML" is the list of fields the new content holds.
  _replaceHTML(result, content) { content.fields = result; }
}
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } },
  utils: { escapeHTML: value => Handlebars.escapeExpression(value),
    isNewerVersion: (version, other) => String(version).localeCompare(String(other), undefined, { numeric: true }) > 0 } };
globalThis.game = { settings: { get: (_module, key) => key.endsWith("Token") ? "fixture-secret" : "https://www.jdr.ninja" },
  user: { isGM: true, name: "GM" }, world: { title: "Test world" }, i18n: { localize: key => key, format: key => key } };
const { ConnectionPanel, accountStatus, accountState, overlayState, creatureState, atlasState, streamDeckState } = await import("../scripts/connection-panel.js");
const { streamDeckBridge } = await import("../scripts/stream-deck/bridge.js");
const { MonsterGeneratorPanel, NpcGeneratorPanel } = await import("../scripts/creatures/panel.js");
const { VariablePanel } = await import("../scripts/variables/panel.js");
const { MacroArgumentsPanel } = await import("../scripts/variables/macro-panel.js");

const flush = () => new Promise(resolve => setImmediate(resolve));
// Earlier tests leave a locale installed: these ones compare keys, so they read the key itself as the text.
const keysAsText = () => { game.i18n = { localize: key => key, format: key => key }; };
/** Settings whose values a test controls; anything unset reads as saved tokens, the default site and switched-off features. */
const fixtureSettings = (values = {}) => ({ values,
  get: (_module, key) => key in values ? values[key] : key.endsWith("Token") ? "fixture-secret" : key.endsWith("Origin") ? "https://www.jdr.ninja" : false,
  set: async (_module, key, value) => { values[key] = value; } });
/** A GM world where the creature generators can import and Atlas can sync. */
const compatibleWorld = () => {
  game.system = { id: "dnd5e", title: "Dungeons & Dragons Fifth Edition", version: "5.3.3" };
  game.release = { generation: 14 };
};
const leaveWorld = () => { delete game.system; delete game.release; };
/** Records the answer a check gave, for the credential the panel holds now. */
const settle = (panel, kind, result) => { panel._results[kind] = { ...result, stamp: panel._stamp(kind) }; };
const withTemplate = async (language, callback) => {
  const copy = JSON.parse(await readFile(new URL(`../lang/${language}.json`, import.meta.url), "utf8"));
  const renderer = Handlebars.create();
  renderer.registerHelper("localize", key => copy[key] ?? key);
  const render = renderer.compile(await readFile(new URL("../templates/connections.hbs", import.meta.url), "utf8"));
  return callback(render, copy);
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const actionNames = state => state.actions.map(control => control.variant ? `${control.name}.${control.variant}` : control.name);

test("settings keep account tokens client-scoped and Atlas tokens world-scoped, outside native configuration fields", () => {
  const settings = [];
  let menu;
  const previous = game.settings;
  game.settings = { register: (_module, key, options) => settings.push({ key, ...options }),
    registerMenu: (_module, key, options) => { if (key === "connections") menu = options; } };
  try { registerSettings({ menus: { connections: ConnectionPanel } }); } finally { game.settings = previous; }
  assert.equal(settings.length, 20);
  for (const setting of settings) {
    assert.equal(setting.scope, setting.key === "variablesPersonal" ? "user" : setting.key === "variablesWorld" || setting.key.startsWith("atlas") ? "world" : "client");
  }
  const toggle = settings.find(setting => setting.key === "atlasEnabled");
  assert.equal(toggle.type, Boolean);
  assert.equal(toggle.default, false);
  for (const key of ["overlayEnabled", "overlayTableCommandsEnabled"]) {
    const setting = settings.find(setting => setting.key === key);
    assert.equal(setting.type, Boolean);
    assert.equal(setting.default, false);
    assert.equal(setting.scope, "client");
  }
  assert.equal(menu.restricted, false);
  assert(menu.type.prototype instanceof Application);
  assert.equal(menu.type.panel, ConnectionPanel);
});

test("the settings tab lists only windows to open: Connections first, and no setting of the module is a native line", () => {
  const settings = new Map(), menus = new Map();
  const callbacks = { onAtlasChange() {}, onAccountChange() {}, onOverlaySwitch() {}, onOverlayPreference() {}, onStreamDeckChange() {}, onCreaturesChange() {} };
  const previous = game.settings, previousGM = game.user.isGM;
  game.settings = { register: (_module, key, options) => settings.set(key, options), registerMenu: (_module, key, options) => menus.set(key, options) };
  try {
    for (const isGM of [true, false]) {
      game.user.isGM = isGM;
      settings.clear(); menus.clear();
      registerSettings({ menus: { connections: ConnectionPanel, monster: MonsterGeneratorPanel, npc: NpcGeneratorPanel,
        variables: VariablePanel, macroArguments: MacroArgumentsPanel }, ...callbacks });
      // V14 SettingsConfig#_prepareCategoryData lists the `config` settings of a module after all its menus.
      assert.deepEqual([...settings].filter(([, setting]) => setting.config).map(([key]) => key), [], `GM ${isGM}`);
      for (const [key, setting] of settings) {
        assert.equal(setting.name, undefined, key);
        assert.equal(setting.hint, undefined, key);
      }
      assert.equal(settings.size, 20);
    }
    // The saved values survive: keys, scopes, defaults, choices and callbacks are those of the native lines.
    const field = key => settings.get(key);
    assert.deepEqual([field("atlasEnabled").scope, field("atlasEnabled").default, field("atlasEnabled").onChange], ["world", false, callbacks.onAtlasChange]);
    assert.deepEqual([field("creaturesEnabled").scope, field("creaturesEnabled").default, field("creaturesEnabled").onChange], ["client", false, callbacks.onCreaturesChange]);
    assert.deepEqual([field("overlayEnabled").scope, field("overlayEnabled").default, field("overlayEnabled").onChange], ["client", false, callbacks.onOverlaySwitch]);
    assert.deepEqual([field("overlayTableCommandsEnabled").default, field("overlayTableCommandsEnabled").onChange], [false, callbacks.onOverlaySwitch]);
    assert.deepEqual([field("streamDeckEnabled").scope, field("streamDeckEnabled").default, field("streamDeckEnabled").onChange], ["client", false, callbacks.onStreamDeckChange]);
    const filter = field("overlayForwardFilter"), hold = field("overlayCardHoldSeconds");
    assert.deepEqual([filter.type, filter.default, Object.keys(filter.choices), filter.onChange], [String, "allPublic", ["allPublic", "playersOnly"], callbacks.onOverlayPreference]);
    assert.deepEqual([hold.type, hold.default, Object.keys(hold.choices), hold.onChange], [String, "0", ["0", "1", "2", "3", "5"], callbacks.onOverlayPreference]);
  } finally { game.settings = previous; game.user.isGM = previousGM; }
});

test("every settings menu registers a launcher that opens its window's singleton, never a second window", async () => {
  const menus = new Map();
  const previous = game.settings;
  game.settings = { register() {}, registerMenu: (_module, key, options) => menus.set(key, options) };
  const windows = { connections: ConnectionPanel, monsterGenerator: MonsterGeneratorPanel, npcGenerator: NpcGeneratorPanel,
    variables: VariablePanel, macroArguments: MacroArgumentsPanel };
  try {
    registerSettings({ menus: { connections: ConnectionPanel, monster: MonsterGeneratorPanel, npc: NpcGeneratorPanel,
      variables: VariablePanel, macroArguments: MacroArgumentsPanel } });
  } finally { game.settings = previous; }
  assert.deepEqual([...menus.keys()].sort(), Object.keys(windows).sort());
  // V14 lists the menus of a module in registration order, before its settings: Connections is the first line.
  assert.deepEqual([...menus.keys()], ["connections", "monsterGenerator", "npcGenerator", "variables", "macroArguments"]);
  assert.equal(menus.get("connections").name, "JDRNINJA.menu.name");
  assert.equal(menus.get("connections").label, "JDRNINJA.menu.label");
  assert.equal(menus.get("connections").icon, "fa-solid fa-link");
  // Generator menus show the short label and their window's icon, with no premium marker, and each its own hint.
  for (const [key, kind] of [["monsterGenerator", "monster"], ["npcGenerator", "npc"]]) {
    assert.equal(menus.get(key).label, `JDRNINJA.creatures.${kind}Shortcut`);
    assert.equal(menus.get(key).hint, `JDRNINJA.creatures.${kind}MenuHint`);
    assert.equal(menus.get(key).icon, windows[key].DEFAULT_OPTIONS.window.icon);
  }
  assert.equal(menus.get("monsterGenerator").icon, "fa-solid fa-dragon");
  assert.equal(menus.get("npcGenerator").icon, "fa-solid fa-masks-theater");
  // Variables and Macros: the line carries the window's name and introduction, the button names the action.
  for (const [key, button, hint, icon] of [["variables", "variablesButton", "variables.hint", "fa-solid fa-sliders"],
    ["macroArguments", "macroArgumentsButton", "variables.macroHint", "fa-solid fa-code"]]) {
    const menu = menus.get(key);
    assert.equal(menu.name, `JDRNINJA.variables.menu.${key}`);
    assert.equal(menu.label, `JDRNINJA.variables.menu.${button}`);
    assert.notEqual(menu.label, menu.name);
    assert.equal(menu.hint, `JDRNINJA.${hint}`);
    assert.equal(menu.icon, icon);
  }
  assert.notEqual(menus.get("variables").hint, menus.get("macroArguments").hint);
  // Read aloud, in every language: the button does not repeat the name of its line, and each hint is its own sentence.
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const copy = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    for (const key of ["variables", "macroArguments"]) {
      assert(copy[`JDRNINJA.variables.menu.${key}Button`], `${locale} ${key}`);
      assert.notEqual(copy[`JDRNINJA.variables.menu.${key}Button`], copy[`JDRNINJA.variables.menu.${key}`], `${locale} ${key}`);
    }
    for (const key of ["creatures.monsterMenuHint", "creatures.npcMenuHint"]) assert(copy[`JDRNINJA.${key}`], `${locale} ${key}`);
    assert.notEqual(copy["JDRNINJA.creatures.monsterMenuHint"], copy["JDRNINJA.creatures.npcMenuHint"], locale);
    assert.notEqual(copy["JDRNINJA.variables.hint"], copy["JDRNINJA.variables.macroHint"], locale);
  }
  for (const [key, Window] of Object.entries(windows)) {
    const menu = menus.get(key), opened = { window: key };
    assert(menu.type.prototype instanceof Application, key);
    assert(!(menu.type.prototype instanceof Window), key);
    // V14 SettingsConfig#onOpenSubmenu: `new menu.type()` then `render(true)`.
    const open = Window.open;
    Window.open = () => opened;
    try { assert.equal(await new menu.type().render(true), opened, key); }
    finally { Window.open = open; }
  }
});

test("Connections has one window: reopening fronts it, the menu reuses it and closing allows a fresh one", async () => {
  const first = ConnectionPanel.open();
  await flush();
  assert.equal(first.renders.length, 1);
  assert.equal(ConnectionPanel.open(), first);
  const previous = game.settings;
  let menu;
  game.settings = { register() {}, registerMenu: (_module, key, options) => { if (key === "connections") menu = options; } };
  try { registerSettings({ menus: { connections: ConnectionPanel } }); } finally { game.settings = previous; }
  assert.equal(await new menu.type().render(true), first);
  assert.equal(first.renders.length, 1);
  assert.equal(first.fronted, 2);
  await first.close();
  assert.equal(ConnectionPanel.instance, null);
  const second = ConnectionPanel.open();
  assert.notEqual(second, first);
  await second.close();
});

test("the Connections window is titled like its menu", () => {
  assert.equal(ConnectionPanel.DEFAULT_OPTIONS.window.title, "JDRNINJA.menu.name");
  assert.equal(ConnectionPanel.DEFAULT_OPTIONS.window.icon, "fa-solid fa-link");
});

test("render context never contains saved credentials or equates a stored token with verified authentication", async () => {
  keysAsText();
  const panel = new ConnectionPanel();
  const context = await panel._prepareContext();
  assert(!JSON.stringify(context).includes("fixture-secret"));
  assert.equal(context.account.state, "unchecked");
  assert.equal(context.account.pill.label, "JDRNINJA.status.saved");
  assert.equal(context.account.label, "");
  settle(panel, "account", { ok: true, label: "Test account", allowed: false });
  const checked = await panel._prepareContext();
  assert(!JSON.stringify(checked).includes("fixture-secret"));
  assert.equal(checked.account.state, "verified");
  assert.equal(checked.account.pill.label, "JDRNINJA.status.connected");
  assert.equal(checked.account.label, "Test account");
});

test("a player sees the account, Stream Deck and the overlay, never the creatures or Atlas", async () => {
  const previous = game.user.isGM;
  game.user.isGM = false;
  try {
    const context = await new ConnectionPanel()._prepareContext();
    assert.equal(context.isGM, false);
    assert.deepEqual(context.features.map(feature => feature.id), ["stream-deck", "overlay"]);
    assert.equal(context.atlas.configured, false);
    assert.equal(context.atlas.tokenInAdvanced, false);
  } finally { game.user.isGM = previous; }
});

test("a subscription link appears only where a subscription is missing: no account, or a check that found none", async () => {
  keysAsText();
  const savedAccess = creatureClient.access, savedSettings = game.settings;
  compatibleWorld();
  try {
    await withTemplate("fr", async render => {
      for (const [values, account, atlas, access, links] of [
        [{ accountToken: "" }, null, null, null, ["account"]],
        [{}, null, null, null, []],
        [{ overlayEnabled: true }, { ok: false, reason: "unauthorized" }, null, null, []],
        [{ overlayEnabled: true }, { ok: true, label: "GM", allowed: false }, null, null, ["overlay"]],
        [{ overlayEnabled: true, creaturesEnabled: true }, { ok: true, label: "GM", allowed: true }, null,
          { allowed: false, entitled: false, reason: "tierRequired" }, ["creatures"]],
        [{ creaturesEnabled: true }, null, null, { allowed: false, entitled: true, reason: "devicePermissionRequired" }, []],
        [{ atlasEnabled: true }, null, { ok: true, label: "World", allowed: false }, null, ["atlas"]],
      ]) {
        game.settings = fixtureSettings(values);
        creatureClient.access = access;
        const panel = new ConnectionPanel();
        if (account) settle(panel, "account", account);
        if (atlas) settle(panel, "atlas", atlas);
        const html = render(await panel._prepareContext());
        assert.deepEqual([...html.matchAll(/data-jdr-subscriptions="(\w+)"/g)].map(match => match[1]), links, JSON.stringify(values));
        // The overlay has its own offers page; every other link opens the subscriptions of the site.
        for (const link of html.matchAll(/<a href="([^"]+)"[^>]*data-jdr-subscriptions="(\w+)"/g)) {
          const path = link[2] === "overlay" ? "/vtt-overlay/abonnement" : "/abonnements";
          assert(link[0].startsWith(`<a href="https://www.jdr.ninja${path}" target="_blank" rel="noopener noreferrer"`), link[0]);
        }
        // Nothing carries a premium marker.
        assert(!html.includes("fa-gem")); assert(!html.includes("(Premium)"));
      }
      // The links follow the saved site address, not the default one.
      game.settings = fixtureSettings({ accountToken: "", accountOrigin: "http://localhost:3000" });
      const local = render(await new ConnectionPanel()._prepareContext());
      assert(local.includes('<a href="http://localhost:3000/abonnements" target="_blank" rel="noopener noreferrer" data-jdr-subscriptions="account">'));
    });
  } finally { creatureClient.access = savedAccess; game.settings = savedSettings; leaveWorld(); }
});

test("the panel serializes operations and closing aborts a pending flow without rendering a late result", async () => {
  const panel = new ConnectionPanel();
  let signal;
  let release;
  const pending = panel._run("account", async currentSignal => {
    signal = currentSignal;
    return new Promise(resolve => { release = resolve; });
  });
  // Allow the initial render and action to begin.
  await flush();
  let duplicate = false;
  await panel._run("account", async () => { duplicate = true; });
  assert.equal(duplicate, false);
  await panel.close();
  assert.equal(signal.aborted, true);
  const rendersAtClose = panel.renders.length;
  release({ ok: true, label: "Late account", allowed: true });
  await pending;
  assert.equal(panel._results.account, null);
  assert.equal(panel.renders.length, rendersAtClose);
  assert.equal(panel._operation, null);
});

test("a cancelled challenge is removed and another attempt is allowed", async () => {
  const panel = new ConnectionPanel();
  const pending = panel._run("account", async signal => {
    panel._challenge = { userCode: "fixture-code", verificationUrl: "https://www.jdr.ninja/vtt-overlay/lier" };
    return new Promise(resolve => signal.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true }));
  }, { attempt: true, pairing: { creatures: false } });
  await flush();
  assert.equal((await panel._prepareContext()).account.state, "pairing");
  panel._cancel();
  await pending;
  assert.equal(panel._challenge, null);
  assert.equal(panel._operation, null);
  assert.equal(panel._pairing, null);
  await panel._run("account", async () => ({ ok: true, label: "Another account", allowed: true }));
  assert.equal(panel._results.account.label, "Another account");
});

test("the real template renders every locale, keeps creatures and Atlas from players, and escapes server-provided labels", async () => {
  const source = await readFile(new URL("../templates/connections.hbs", import.meta.url), "utf8");
  const previousGM = game.user.isGM;
  try {
    for (const locale of ["fr", "en", "es", "de", "it"]) {
      const copy = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
      game.i18n = { localize: key => copy[key] ?? key, format: (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), copy[key] ?? key) };
      const renderer = Handlebars.create();
      renderer.registerHelper("localize", key => copy[key] ?? key);
      const render = renderer.compile(source);
      game.user.isGM = true;
      const panel = new ConnectionPanel();
      settle(panel, "account", { ok: true, label: '<img src=x onerror="fixture()">', allowed: true });
      const context = await panel._prepareContext();
      context.features.find(feature => feature.id === "atlas").summary = '<img src=y onerror="fixture()">';
      context.busy = true;
      context.challenge = { userCode: "ABCD-EFGH", verificationUrl: "https://www.jdr.ninja/vtt-overlay/lier?code=ABCD-EFGH" };
      const html = render(context);
      assert(!html.includes("JDRNINJA."), `${locale}: unresolved locale key`);
      assert(!html.includes("<img"));
      assert(html.includes("&lt;img src&#x3D;x") && html.includes("&lt;img src&#x3D;y"));
      assert(!html.includes("fixture-secret"));
      assert.equal(count(html, /name="atlasToken"/g), 1);
      // One site address for the account and Atlas, and no field of its own for Atlas.
      assert.equal(count(html, /name="accountOrigin"/g), 1);
      assert.equal(count(html, /type="url"/g), 1);
      assert(!html.includes('name="atlasOrigin"'));
      assert(html.includes('name="atlasEnabled" type="checkbox"'));
      assert(html.includes('data-compatibility="dndRequired"'));
      assert(html.includes(Handlebars.escapeExpression(copy["JDRNINJA.creatures.compatibility.dndRequired"])));
      assert(html.includes('data-action="cancel"'));
      assert(html.includes("ABCD-EFGH"));
      game.user.isGM = false;
      const player = render(await new ConnectionPanel()._prepareContext());
      for (const hook of ['name="atlasToken"', 'name="atlasEnabled"', 'name="creaturesEnabled"', 'data-action="pairCreatures"', "data-atlas-origin"]) {
        assert(!player.includes(hook), `${locale}: ${hook}`);
      }
      assert.equal(count(player, /name="accountOrigin"/g), 1, locale);
      // States are pills with an icon and their text, never badges; the blocks are a card, rows and sections, never fieldsets.
      assert(!html.includes("<fieldset") && !html.includes("<legend") && !html.includes('class="badge'));
      for (const action of [...html.matchAll(/data-action="(\w+)"/g), ...player.matchAll(/data-action="(\w+)"/g)]) {
        assert.equal(typeof ConnectionPanel.DEFAULT_OPTIONS.actions[action[1]], "function", action[1]);
      }
    }
  } finally { game.user.isGM = previousGM; }
});

test("the integration checkbox persists a boolean, checks a saved world token as it turns on, and refuses a player", async () => {
  const saved = [], checks = [];
  const previous = game.settings;
  const previousGM = game.user.isGM;
  game.settings = { ...previous, set: async (_module, key, value) => saved.push([key, value]) };
  const panel = new ConnectionPanel();
  panel._autoCheck = kind => checks.push(kind);
  try {
    await panel._toggleAtlas({ currentTarget: { checked: true } });
    await panel._toggleAtlas({ currentTarget: { checked: false } });
    assert.deepEqual(saved, [["atlasEnabled", true], ["atlasEnabled", false]]);
    assert.deepEqual(checks, ["atlas"]);
    game.user.isGM = false;
    await panel._toggleAtlas({ currentTarget: { checked: true } });
    assert.equal(saved.length, 2);
  } finally { game.settings = previous; game.user.isGM = previousGM; }
});

test("cancelling before the initial render completes prevents a local operation", async () => {
  const panel = new ConnectionPanel();
  let finishRender;
  panel.render = () => new Promise(resolve => { finishRender = resolve; });
  let changed = false;
  const pending = panel._run("account", async () => { changed = true; });
  await panel.close();
  finishRender();
  await pending;
  assert.equal(changed, false);
});

test("the account banner maps each state to one pill, its message and only the actions that state needs", () => {
  keysAsText();
  const row = state => [state.state, state.pill.level, state.pill.label, actionNames(state), state.error];
  assert.deepEqual(row(accountState({ configured: false })),
    ["none", "neutral", "JDRNINJA.status.disconnected", ["pair.bright"], ""]);
  const none = accountState({ configured: false, result: { ok: false, reason: "unconfigured" } });
  assert.deepEqual([none.state, none.intro, none.link.kind, none.link.href], ["none", "JDRNINJA.account.needed", "account", "https://www.jdr.ninja/abonnements"]);
  assert.deepEqual(row(accountState({ configured: false, pairing: true })), ["pairing", "info", "JDRNINJA.panel.state.pending", [], ""]);
  const checking = accountState({ configured: true, checking: true });
  assert.deepEqual([...row(checking), checking.pill.icon], ["checking", "info", "JDRNINJA.panel.state.checking", ["disconnectAccount.jn-danger"], "", "fa-spinner fa-spin"]);
  const verified = accountState({ configured: true, result: { ok: true, label: "Demo GM", allowed: false } });
  assert.deepEqual([...row(verified), verified.label, verified.intro, verified.link],
    ["verified", "success", "JDRNINJA.status.connected", ["pair", "disconnectAccount.jn-danger"], "", "Demo GM", "", null]);
  assert.equal(verified.actions[0].label, "JDRNINJA.account.change");
  for (const reason of ["network", "server", "rateLimited", "invalidClientHeader"]) {
    const state = accountState({ configured: true, result: { ok: false, reason } });
    assert.deepEqual(row(state), ["retry", "error", "JDRNINJA.panel.state.error", ["checkAccount", "disconnectAccount.jn-danger"], `JDRNINJA.error.${reason}`], reason);
    assert.equal(state.actions[0].label, "JDRNINJA.button.retry");
  }
  for (const reason of ["unauthorized", "invalidResponse"]) {
    const state = accountState({ configured: true, result: { ok: false, reason } });
    assert.deepEqual(row(state), ["reconnect", "error", "JDRNINJA.panel.state.error", ["pair", "disconnectAccount.jn-danger"], `JDRNINJA.error.${reason}`], reason);
    assert.equal(state.actions[0].label, "JDRNINJA.button.reconnect");
  }
  assert.deepEqual(row(accountState({ configured: true })), ["unchecked", "warning", "JDRNINJA.status.saved", ["checkAccount", "disconnectAccount.jn-danger"], ""]);
  // A failed pairing keeps the state of the saved credential and adds its own message.
  assert.deepEqual(row(accountState({ configured: true, result: { ok: true, label: "Demo GM" }, error: "Denied" })),
    ["verified", "success", "JDRNINJA.status.connected", ["pair", "disconnectAccount.jn-danger"], "Denied"]);
  assert.equal(accountStatus({ configured: true, result: { ok: true }, checking: true }), "checking");
  assert.equal(accountStatus({ configured: true, result: { ok: false, reason: "unconfigured" } }), "unchecked");
});

test("the overlay row needs the account, then its subscription, and says which step is missing", () => {
  keysAsText();
  const row = state => [state.state, state.pill.level, state.pill.label, state.step?.level ?? null, state.step?.role ?? null, state.step?.text ?? null];
  assert.deepEqual(row(overlayState({ enabled: false, account: "verified", allowed: true })), ["disabled", "neutral", "JDRNINJA.panel.state.disabled", null, null, null]);
  assert.deepEqual(row(overlayState({ enabled: true, legacy: true, account: "verified", allowed: true })),
    ["unavailable", "error", "JDRNINJA.panel.state.unavailable", "error", "alert", "JDRNINJA.overlay.error.legacyActive"]);
  assert.deepEqual(row(overlayState({ enabled: true, account: "none" })),
    ["accountRequired", "warning", "JDRNINJA.panel.state.accountRequired", "warning", "status", "JDRNINJA.panel.step.connectAccount"]);
  assert.deepEqual(row(overlayState({ enabled: true, account: "checking" })), ["checking", "info", "JDRNINJA.panel.state.checking", null, null, null]);
  const limited = overlayState({ enabled: true, account: "verified", allowed: false });
  assert.deepEqual([...row(limited), limited.step.link.kind],
    ["subscriptionRequired", "warning", "JDRNINJA.panel.state.subscriptionRequired", "warning", "status", "JDRNINJA.overlay.error.notEntitled", "overlay"]);
  assert.deepEqual(row(overlayState({ enabled: true, account: "verified", allowed: true })), ["active", "success", "JDRNINJA.panel.state.active", null, null, null]);
  assert.equal(overlayState({ enabled: true, account: "reconnect" }).step.text, "JDRNINJA.panel.step.reconnectAccount");
  for (const account of ["retry", "unchecked"]) {
    assert.deepEqual(row(overlayState({ enabled: true, account })),
      ["attention", "warning", "JDRNINJA.panel.state.attention", "warning", "status", "JDRNINJA.panel.step.checkAccount"], account);
  }
});

test("the creatures row puts the system first, offers the device permission only when it is missing, and no button once available", () => {
  keysAsText();
  const compatible = { compatible: true, code: "compatible", label: "compatible" };
  const state = options => creatureState({ compatibility: compatible, ...options });
  const row = value => [value.state, value.pill.level, value.pill.label, value.step?.text ?? null, value.step?.action?.name ?? null, value.step?.link?.kind ?? null];
  // Another game system cannot import at all; an untested version only warns. Both name the cause and the requirement.
  const other = creatureState({ compatibility: { compatible: false, code: "dndRequired", label: "D&D required", current: "System: pf2e" }, restriction: "disabled" });
  assert.deepEqual([...row(other), other.step.detail, other.step.role], ["incompatible", "error", "D&D required", "System: pf2e", null, null, "JDRNINJA.creatures.error.incompatibleSystem", "alert"]);
  const version = creatureState({ compatibility: { compatible: false, code: "versionUnsupported", label: "Untested version", current: "System: dnd5e 4" } });
  assert.deepEqual(row(version).slice(0, 3), ["incompatible", "warning", "Untested version"]);
  assert.deepEqual(row(state({ restriction: "disabled" })), ["disabled", "neutral", "JDRNINJA.panel.state.disabled", null, null, null]);
  assert.deepEqual(row(state({ restriction: "connectionRequired" })),
    ["accountRequired", "warning", "JDRNINJA.panel.state.accountRequired", "JDRNINJA.panel.step.connectAccount", null, null]);
  assert.deepEqual(row(state({ checking: true })), ["checking", "info", "JDRNINJA.panel.state.checking", null, null, null]);
  const available = state({ access: { allowed: true, entitled: true } });
  assert.deepEqual([...row(available), available.step.level], ["available", "success", "JDRNINJA.creatures.status.available", "JDRNINJA.panel.step.creaturesAvailable", null, null, "info"]);
  for (const permission of [state({ access: { allowed: false, entitled: true, reason: "devicePermissionRequired" } }),
    state({ result: { ok: false, reason: "devicePermissionRequired" } })]) {
    assert.deepEqual(row(permission), ["devicePermissionRequired", "warning", "JDRNINJA.panel.state.permissionRequired",
      "JDRNINJA.panel.step.devicePermission", "pairCreatures", null]);
    assert.equal(permission.step.action.label, "JDRNINJA.creatures.authorize");
  }
  assert.deepEqual(row(state({ access: { allowed: false, entitled: false, reason: "tierRequired" } })),
    ["tierRequired", "warning", "JDRNINJA.panel.state.subscriptionRequired", "JDRNINJA.creatures.error.tierRequired", null, "creatures"]);
  for (const reason of ["unauthorized", "wrongDeviceKind"]) {
    assert.deepEqual(row(state({ result: { ok: false, reason } })), ["attention", "warning", "JDRNINJA.panel.state.attention", "JDRNINJA.panel.step.reconnectAccount", null, null], reason);
  }
  assert.deepEqual(row(state({})), ["notChecked", "neutral", "JDRNINJA.status.saved", "", "checkCreatures", null]);
  for (const reason of ["verificationUnavailable", "apiUnavailable", "network", "somethingNew"]) {
    const failed = state({ result: { ok: false, reason } });
    assert.deepEqual([...row(failed), failed.step.role, failed.step.action.label],
      ["unavailable", "error", "JDRNINJA.panel.state.unavailable", `JDRNINJA.creatures.error.${reason}`, "checkCreatures", null, "alert", "JDRNINJA.button.retry"], reason);
  }
  // A grant wins over an older failure of this window.
  assert.equal(state({ access: { allowed: true }, result: { ok: false, reason: "network" } }).state, "available");
  // The device permission is the only state that asks for a new authorization.
  const every = [other, version, state({ restriction: "disabled" }), state({ restriction: "connectionRequired" }), state({ checking: true }), available,
    state({ access: { allowed: false, reason: "tierRequired" } }), state({ result: { ok: false, reason: "unauthorized" } }), state({}),
    state({ result: { ok: false, reason: "network" } }), state({ access: { allowed: false, reason: "devicePermissionRequired" } })];
  assert.deepEqual(every.filter(value => value.step?.action?.name === "pairCreatures").map(value => value.state), ["devicePermissionRequired"]);
});

test("the Atlas row asks for its token in the row, reports the world once verified, and offers a new check only after a failure", () => {
  keysAsText();
  const row = value => [value.state, value.pill.level, value.pill.label, value.step?.text ?? null, value.step?.field === true, value.step?.action?.name ?? null, value.label];
  assert.deepEqual(row(atlasState({ enabled: true, notice: "Legacy module", configured: true })), ["unavailable", "error", "JDRNINJA.panel.state.unavailable", "Legacy module", false, null, ""]);
  assert.deepEqual(row(atlasState({ enabled: false, configured: true })), ["disabled", "neutral", "JDRNINJA.panel.state.disabled", null, false, null, ""]);
  assert.deepEqual(row(atlasState({ enabled: true, configured: true, checking: true })), ["checking", "info", "JDRNINJA.panel.state.checking", null, false, null, ""]);
  assert.deepEqual(row(atlasState({ enabled: true, configured: false })), ["tokenRequired", "warning", "JDRNINJA.panel.state.tokenRequired", "", true, null, ""]);
  assert.deepEqual(row(atlasState({ enabled: true, configured: true, result: { ok: true, label: "Sunken Crown", allowed: true } })),
    ["connected", "success", "JDRNINJA.status.connected", null, false, null, "Sunken Crown"]);
  const limited = atlasState({ enabled: true, configured: true, result: { ok: true, label: "Sunken Crown", allowed: false } });
  assert.deepEqual([...row(limited), limited.step.link.kind],
    ["subscriptionRequired", "warning", "JDRNINJA.panel.state.subscriptionRequired", "JDRNINJA.atlas.limited", false, null, "Sunken Crown", "atlas"]);
  const rejected = atlasState({ enabled: true, configured: true, result: { ok: false, reason: "unauthorized" } });
  assert.deepEqual([...row(rejected), rejected.step.role], ["rejected", "error", "JDRNINJA.panel.state.error", "JDRNINJA.error.unauthorized", true, null, "", "alert"]);
  const failed = atlasState({ enabled: true, configured: true, result: { ok: false, reason: "network" } });
  assert.deepEqual([...row(failed), failed.step.action.label], ["failed", "error", "JDRNINJA.panel.state.error", "JDRNINJA.error.network", false, "checkAtlas", "", "JDRNINJA.button.retry"]);
  assert.deepEqual(row(atlasState({ enabled: true, configured: true })), ["unchecked", "warning", "JDRNINJA.status.saved", "", false, "checkAtlas", ""]);
  // A pasted token that failed keeps the field and says why.
  const refused = atlasState({ enabled: true, configured: false, error: "Refused" });
  assert.deepEqual([refused.state, refused.step.level, refused.step.role, refused.step.text, refused.step.field], ["tokenRequired", "error", "alert", "Refused", true]);
  const kept = atlasState({ enabled: true, configured: true, result: { ok: true, label: "Sunken Crown", allowed: true }, error: "Refused" });
  assert.deepEqual([kept.state, kept.step.text, kept.label], ["connected", "Refused", "Sunken Crown"]);
});

test("the Stream Deck row carries the pill of the bridge state and asks for the companion key only when it is missing", async () => {
  keysAsText();
  const saved = streamDeckBridge.state;
  try {
    for (const [state, level] of [["ready", "success"], ["connecting", "warning"], ["disabled", "neutral"], ["disconnected", "error"], ["unconfigured", "error"]]) {
      streamDeckBridge.state = state;
      const row = (await new ConnectionPanel()._prepareContext()).features[0];
      assert.equal(row.id, "stream-deck");
      assert.equal(row.pill.level, level, state);
      assert.equal(row.pill.label, `JDRNINJA.streamDeck.state.${state}`);
      assert.equal(row.step?.text ?? null, state === "unconfigured" ? "JDRNINJA.panel.step.streamDeckKey" : null, state);
      assert.equal(row.step?.action ?? null, null);
    }
    assert.deepEqual(streamDeckState("unconfigured").step.role, "status");
  } finally { streamDeckBridge.state = saved; }
});

test("the Stream Deck pill follows the bridge without a new render, and closing stops it", async () => {
  keysAsText();
  const pill = { className: "", icon: { className: "" }, text: { textContent: "" },
    querySelector(selector) { return selector === "[data-pill-icon]" ? this.icon : this.text; } };
  const panel = new ConnectionPanel();
  panel.rendered = true;
  panel.element = { querySelector: selector => selector === "[data-stream-deck-status]" ? pill : null };
  const saved = streamDeckBridge.state;
  try {
    // A second render never adds a second subscription.
    panel._onRender({}, {});
    panel._onRender({}, {});
    streamDeckBridge.notify("ready");
    assert.equal(pill.className, "jn-pill jn-pill--success");
    assert.equal(pill.icon.className, "fa-solid fa-circle-check");
    assert.equal(pill.text.textContent, "JDRNINJA.streamDeck.state.ready");
    streamDeckBridge.notify("disconnected", "connectionFailed");
    assert.equal(pill.className, "jn-pill jn-pill--error");
    assert.equal(pill.text.textContent, "JDRNINJA.streamDeck.state.disconnected");
    await panel.close();
    streamDeckBridge.notify("ready");
    assert.equal(pill.text.textContent, "JDRNINJA.streamDeck.state.disconnected");
  } finally { await panel.close(); streamDeckBridge.state = saved; streamDeckBridge.error = ""; }
});

test("Connections shows each connection once: the account in its banner, then one row per feature", async () => {
  keysAsText();
  const previousGM = game.user.isGM, savedSettings = game.settings;
  try {
    for (const language of ["en", "fr"]) await withTemplate(language, async (render, copy) => {
      game.user.isGM = true;
      const html = render(await new ConnectionPanel()._prepareContext());
      assert.equal(count(html, /class="jn-card /g), 1, language);
      assert(html.includes('<section class="jn-card jn-banner" role="group" aria-labelledby="jdr-ninja-account-name"'));
      assert.deepEqual([...html.matchAll(/data-feature="([\w-]+)"/g)].map(match => match[1]), ["stream-deck", "overlay", "creatures", "atlas"]);
      for (const service of ["stream-deck", "overlay", "creatures", "atlas"]) {
        assert(html.includes(`<h4 id="jdr-ninja-service-${service}">`), service);
        assert(html.includes(`role="group" aria-labelledby="jdr-ninja-service-${service}"`), service);
      }
      // The duplicated account and Atlas sections, the intro and the shortcuts left the window.
      assert(!html.includes("jn-status") && !html.includes("jn-services"));
      // Their copy was deleted from every locale: no key may render, and none may come back as an unused string.
      for (const key of ["panel.intro", "account.hint", "atlas.hint", "panel.enableBrowser", "panel.enableWorld", "creatures.permissionHint",
        "account.disconnect", "account.limited", "atlas.heading"]) {
        assert(!html.includes(`JDRNINJA.${key}`) && !(`JDRNINJA.${key}` in copy), key);
      }
      // These belong to the confirmations: their text is not shown in the window.
      for (const key of ["account.disconnectHint", "atlas.disconnectHint"]) {
        assert(!html.includes(Handlebars.escapeExpression(copy[`JDRNINJA.${key}`])) && !html.includes(`JDRNINJA.${key}`), key);
      }
      for (const action of ["openVariables", "openMacroArguments", "openMonster", "openNpc"]) {
        assert(!html.includes(`data-action="${action}"`), action);
        assert.equal(ConnectionPanel.DEFAULT_OPTIONS.actions[action], undefined, action);
      }
      game.user.isGM = false;
      const player = render(await new ConnectionPanel()._prepareContext());
      assert.deepEqual([...player.matchAll(/data-feature="([\w-]+)"/g)].map(match => match[1]), ["stream-deck", "overlay"]);
      game.user.isGM = true;
      // A pill is never colour alone: it holds an icon and a text.
      assert.equal(count(html, /class="jn-pill /g), 5);
      for (const pill of html.matchAll(/<span class="jn-pill [^>]*>(.*?)<\/span>/g)) {
        assert(/<i class="fa-solid [\w -]+" aria-hidden="true"/.test(pill[1]), pill[0]);
        assert(/[^<>\s]/.test(pill[1].replace(/<[^>]*>/g, "")), pill[0]);
      }
      // Only the Stream Deck switch keeps its information icon: it carries the security note.
      const hints = [...html.matchAll(/<i class="fa-solid fa-circle-info jn-info"[^>]*>/g)].map(match => match[0]);
      assert.equal(hints.length, 1);
      assert(/tabindex="0"/.test(hints[0]) && /role="img"/.test(hints[0]) && hints[0].includes('aria-label="JDRNINJA.streamDeck.enableHint" data-tooltip="JDRNINJA.streamDeck.enableHint"'));
      // Every field has its label, and every switch is named « Enable » plus its feature.
      for (const input of html.matchAll(/<input id="([\w-]+)"/g)) assert(html.includes(`for="${input[1]}"`), input[1]);
      const switches = [...html.matchAll(/<input id="jdr-ninja-([\w-]+)-enabled" name="(\w+)" type="checkbox" aria-labelledby="([^"]+)"/g)];
      assert.deepEqual(switches.map(match => match[2]), ["streamDeckEnabled", "overlayEnabled", "creaturesEnabled", "atlasEnabled"]);
      for (const [, id, , labelledBy] of switches) assert.equal(labelledBy, `jdr-ninja-${id}-enabled-label jdr-ninja-service-${id}`);
      assert.equal(count(html, new RegExp(`>${copy["JDRNINJA.panel.enable"]}</label>`, "g")), 4);
      // The windows of the features are icon buttons with their name for assistive technology and as a tooltip.
      for (const action of ["openStreamDeck", "openOverlay", "openAtlas"]) {
        assert(new RegExp(`<button type="button" class="jn-icon-button jn-open" data-action="${action}" aria-label="[^"]+" data-tooltip="[^"]+"`).test(html), action);
      }
      // « Configure » is a gear on the Stream Deck and overlay rows; the sliders mean only Variables.
      for (const [action, icon] of [["openStreamDeck", "fa-gear"], ["openOverlay", "fa-gear"]]) {
        assert(new RegExp(`data-action="${action}"[^>]*><i class="fa-solid ${icon}"`).test(html), action);
      }
      assert(!html.includes("fa-sliders"));
      assert(html.includes('<summary><i class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></i>'));
      assert(html.includes('<i class="fa-solid fa-user-ninja" aria-hidden="true"></i>', html.indexOf("<details")));
      assert(!html.includes('<i class="fa-solid fa-user"'));
    });
  } finally { game.user.isGM = previousGM; game.settings = savedSettings; }
});

test("Connections has one primary action at most, and its disconnections use the error colour", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access;
  compatibleWorld();
  try {
    await withTemplate("en", async render => {
      const states = [];
      for (const [values, account, atlas, access] of [
        [{ accountToken: "", atlasToken: "" }, null, null, null],
        [{ accountToken: "", atlasToken: "", atlasEnabled: true, creaturesEnabled: true }, null, null, null],
        [{ atlasEnabled: true, creaturesEnabled: true, overlayEnabled: true }, { ok: true, label: "GM", allowed: true }, { ok: true, label: "World", allowed: true }, { allowed: true }],
        [{ atlasEnabled: true, creaturesEnabled: true }, { ok: false, reason: "network" }, { ok: false, reason: "unauthorized" }, { allowed: false, reason: "devicePermissionRequired" }],
      ]) {
        game.settings = fixtureSettings(values);
        creatureClient.access = access;
        const panel = new ConnectionPanel();
        if (account) settle(panel, "account", account);
        if (atlas) settle(panel, "atlas", atlas);
        const html = render(await panel._prepareContext());
        states.push(html);
        assert(count(html, /class="bright"/g) <= 1, JSON.stringify(values));
        for (const action of ["pair", "checkAccount", "saveAtlas", "checkAtlas", "openOverlay", "openStreamDeck", "openAtlas", "pairCreatures", "checkCreatures", "saveAccount"]) {
          assert(!new RegExp(`class="[^"]*jn-danger[^"]*" data-action="${action}"`).test(html), action);
        }
      }
      // Without an account the one primary action is connecting it; once a token is saved there is none.
      assert.equal(count(states[0], /class="bright" data-action="pair"/g), 1);
      assert.equal(count(states[2], /class="bright"/g), 0);
      for (const html of states.slice(2)) {
        assert(html.includes('class="jn-danger" data-action="disconnectAccount"'));
        assert(html.includes('class="jn-danger" data-action="disconnectAtlas"'));
      }
      // Authorizing on the site appears only while the device permission is missing.
      assert.deepEqual(states.map(html => html.includes('data-action="pairCreatures"')), [false, false, false, true]);
    });
  } finally { game.settings = savedSettings; creatureClient.access = savedAccess; leaveWorld(); }
});

test("one Atlas token field at most: in the row while no token is saved or the saved one is refused, otherwise in the advanced options", async () => {
  keysAsText();
  const savedSettings = game.settings;
  compatibleWorld();
  try {
    await withTemplate("en", async render => {
      for (const [values, atlas, place] of [
        [{ atlasEnabled: true, atlasToken: "" }, null, "row"],
        [{ atlasEnabled: true }, { ok: true, label: "World", allowed: true }, "advanced"],
        [{ atlasEnabled: true }, { ok: false, reason: "unauthorized" }, "row"],
        [{ atlasEnabled: true }, { ok: false, reason: "network" }, "advanced"],
        [{ atlasEnabled: false }, null, "advanced"],
        [{ atlasEnabled: false, atlasToken: "" }, null, "none"],
      ]) {
        game.settings = fixtureSettings(values);
        const panel = new ConnectionPanel();
        if (atlas) settle(panel, "atlas", atlas);
        const html = render(await panel._prepareContext()), advanced = html.indexOf("<details");
        const fields = [...html.matchAll(/name="atlasToken"/g)].map(match => match.index < advanced ? "row" : "advanced");
        assert.deepEqual(fields, place === "none" ? [] : [place], JSON.stringify([values, atlas]));
        assert.equal(count(html, /id="jdr-ninja-atlas-token"/g), fields.length);
        // The site address stays in the advanced options even when they are closed: saving and pairing read it.
        assert(html.indexOf('name="accountOrigin"') > advanced && !html.includes('name="atlasOrigin"'));
      }
    });
  } finally { game.settings = savedSettings; leaveWorld(); }
});

test("the Connections template keeps the hooks the code and the screenshot tool use, with advanced settings folded away", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access;
  compatibleWorld();
  try {
    await withTemplate("en", async (render, copy) => {
      game.settings = fixtureSettings({ atlasEnabled: true, creaturesEnabled: true, overlayEnabled: true });
      creatureClient.access = { allowed: true, entitled: true };
      const panel = new ConnectionPanel();
      settle(panel, "account", { ok: true, label: "Demo account", allowed: true });
      settle(panel, "atlas", { ok: true, label: "Demo world", allowed: true });
      game.i18n = { localize: key => key, format: (key, values) => `${key} ${values.name}` };
      const context = await panel._prepareContext();
      const html = render(context);
      // The account name is the banner's heading; the Atlas world is in its row's sentence, with the row's state.
      assert(html.includes('<section class="jn-card jn-banner" role="group" aria-labelledby="jdr-ninja-account-name" data-state="verified">'));
      assert(html.includes('<h3 id="jdr-ninja-account-name" data-connection-label="account">Demo account</h3>'));
      assert(/<div class="jn-feature" role="group" aria-labelledby="jdr-ninja-service-atlas" data-feature="atlas" data-state="connected">/.test(html));
      assert(html.includes("JDRNINJA.panel.summary.atlasWorld Demo world"));
      assert.deepEqual(context.features.map(feature => feature.state), [context.features[0].state, "active", "available", "connected"]);
      const advanced = html.indexOf('<details class="jn-advanced" data-sync="advanced">');
      assert(advanced > 0 && !/<details[^>]*\bopen\b/.test(html), "Advanced options start closed and keep their state across renders");
      for (const hook of ['name="streamDeckEnabled"', 'name="overlayEnabled"', 'name="creaturesEnabled"', 'name="atlasEnabled"',
        'data-action="pair"', 'data-action="disconnectAccount"', 'data-action="openAtlas"']) {
        assert(html.indexOf(hook) > 0 && html.indexOf(hook) < advanced, hook);
      }
      // The site address, the device name, the manual token, the token of a connected world and device management are advanced.
      for (const hook of ['name="deviceName"', 'name="accountToken"', 'name="accountOrigin"', 'name="atlasToken"',
        'data-action="saveAccount"', 'data-action="saveAtlas"', 'data-action="manageAccount"', 'data-action="manageAtlas"', 'data-action="disconnectAtlas"']) {
        assert(html.indexOf(hook) > advanced, hook);
      }
      // One site address, at the head of the advanced options: before the Account and Atlas sections that read it.
      assert.equal(count(html, /name="accountOrigin"/g), 1);
      assert(!html.includes('name="atlasOrigin"'));
      const origin = html.indexOf('name="accountOrigin"');
      for (const marker of ['<h3 class="jn-section__title"', 'name="deviceName"', 'name="accountToken"', 'name="atlasToken"', 'data-action="saveAccount"', 'data-action="saveAtlas"']) {
        assert(origin < html.indexOf(marker, advanced), marker);
      }
      const escaped = key => Handlebars.escapeExpression(copy[`JDRNINJA.${key}`]);
      assert(html.includes(`<label for="jdr-ninja-account-origin">${escaped("field.server")}</label>`));
      assert(html.includes(`id="jdr-ninja-account-origin-hint">${escaped("field.serverHint")}</p>`));
      assert(html.includes(`<summary><i class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></i>${escaped("panel.advanced")}`));
      // Once everything is verified no check or authorization button is left.
      for (const action of ["checkAccount", "checkAtlas", "checkCreatures", "pairCreatures"]) assert(!html.includes(`data-action="${action}"`), action);
      assert(!html.includes("notice-error") && !html.includes('role="alert"'));
      // The wait is a footer with the one way out, only while an operation runs.
      assert(!html.includes('data-action="cancel"'));
      assert(/<footer class="form-footer jn-footer jn-busy" role="status">/.test(render({ ...context, busy: true })));
      assert(html.includes('class="standard-form jn-layout') && html.includes('<div class="jn-scroll">'));
      // A pairing that asks for the creature permission says so next to its code.
      const challenge = { userCode: "ABCD", verificationUrl: "https://www.jdr.ninja/vtt-overlay/lier" };
      const note = Handlebars.escapeExpression(copy["JDRNINJA.pairing.creatures"]);
      const pairing = render({ ...context, challenge, pairingCreatures: true });
      assert(pairing.includes(note) && pairing.includes('<strong class="jn-pairing-code">ABCD</strong>'));
      assert(!render({ ...context, challenge }).includes(note));
    });
  } finally { game.settings = savedSettings; creatureClient.access = savedAccess; leaveWorld(); }
});

test("pairing asks for the creature permission only for a GM who enabled the creatures", async () => {
  keysAsText();
  const savedSettings = game.settings, previousGM = game.user.isGM;
  try {
    for (const [isGM, creaturesEnabled, expected] of [[true, true, ["dnd-creatures"]], [true, false, []], [false, true, []], [false, false, []]]) {
      game.settings = fixtureSettings({ creaturesEnabled });
      game.user.isGM = isGM;
      const panel = new ConnectionPanel();
      const requests = [];
      panel._connections.pairAccount = async options => {
        requests.push(options.requestedCapabilities);
        assert.equal((await panel._prepareContext()).pairingCreatures, expected.length > 0);
        return { ok: false, reason: "denied" };
      };
      await panel._pair();
      assert.deepEqual(requests, [expected], JSON.stringify([isGM, creaturesEnabled]));
      // The failed attempt is reported without changing what is known of the saved token.
      const context = await panel._prepareContext();
      assert.deepEqual([context.account.state, context.account.error], ["unchecked", "JDRNINJA.error.denied"]);
      await panel._pairCreatures();
      assert.deepEqual(requests.slice(1), isGM ? [["dnd-creatures"]] : []);
    }
  } finally { game.settings = savedSettings; game.user.isGM = previousGM; }
});

/** A window whose fields hold these values, as `_field()` reads them from the rendered form. */
const withFields = (panel, fields) => {
  panel.element = { querySelector: selector => {
    const name = /^\[name="(\w+)"\]$/.exec(selector)?.[1];
    return name in fields ? { value: fields[name] } : null;
  } };
  return panel;
};

test("the one site address is read by the pairing and by both token saves", async () => {
  keysAsText();
  const savedSettings = game.settings;
  try {
    game.settings = fixtureSettings({});
    const fields = { accountOrigin: "https://other.example", accountToken: "account-token", atlasToken: "atlas-token", deviceName: "My table" };
    const panel = withFields(new ConnectionPanel(), fields);
    const calls = [];
    panel._connections.pairAccount = async options => { calls.push(["pair", options.origin, options.deviceName]); return { ok: false, reason: "denied" }; };
    panel._connections.connect = async (kind, options) => { calls.push([kind, options.origin, options.token]); return { ok: false, reason: "denied" }; };
    await panel._pair();
    await panel._saveAccount();
    await panel._saveAtlas();
    // Atlas has no address of its own: it takes the one of the form, like the account.
    assert.deepEqual(calls, [["pair", "https://other.example", "My table"], ["account", "https://other.example", "account-token"],
      ["atlas", "https://other.example", "atlas-token"]]);
    // There is no Atlas address field to read: a stray value under that name is ignored.
    fields.atlasOrigin = "https://ignored.example";
    calls.length = 0;
    await panel._saveAtlas();
    assert.deepEqual(calls, [["atlas", "https://other.example", "atlas-token"]]);
  } finally { game.settings = savedSettings; }
});

test("an edited site address saves nothing without a newly pasted token, and is saved only with the token being connected", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access, savedCheck = creatureClient.check;
  creatureClient.check = () => new Promise(() => {});
  try {
    const values = { accountToken: "saved-account", atlasToken: "saved-atlas", accountOrigin: "https://www.jdr.ninja", atlasOrigin: "https://www.jdr.ninja" };
    const writes = [], settings = fixtureSettings(values), set = settings.set;
    settings.set = async (module, key, value) => { writes.push([key, value]); return set(module, key, value); };
    game.settings = settings;
    const requests = [];
    const fields = { accountOrigin: "https://other.example", accountToken: "", atlasToken: "", deviceName: "My table" };
    const panel = withFields(new ConnectionPanel(), fields);
    panel._connections.request = async ({ origin, path, token }) => {
      requests.push([origin, token]);
      return path === ENDPOINTS.atlas ? { ok: true, data: { contractVersion: 1, status: "OK", world: { id: "world-1", name: "World" }, tier: { allowed: true } } }
        : { ok: true, data: { ok: true, tokenKind: "foundry", account: "Demo", entitled: true } };
    };
    // The saved token never goes to the edited address: no request, no write, and the window says why.
    await panel._saveAccount();
    await panel._saveAtlas();
    assert.deepEqual([writes, requests], [[], []]);
    assert.deepEqual([panel._errors.account, panel._errors.atlas], ["JDRNINJA.error.originChanged", "JDRNINJA.error.originChanged"]);
    assert.deepEqual([values.accountToken, values.accountOrigin, values.atlasToken, values.atlasOrigin],
      ["saved-account", "https://www.jdr.ninja", "saved-atlas", "https://www.jdr.ninja"]);
    // An unchanged address with no new token still re-saves the saved one: nothing travels to another site.
    fields.accountOrigin = "https://www.jdr.ninja";
    await panel._saveAccount();
    assert.deepEqual(requests, [["https://www.jdr.ninja", "saved-account"]]);

    // With a new token the address and the token are saved together, the old token cleared first.
    writes.length = 0; requests.length = 0;
    Object.assign(fields, { accountOrigin: "https://other.example", accountToken: "new-account-token", atlasToken: "new-atlas-token" });
    await panel._saveAccount();
    await panel._saveAtlas();
    assert.deepEqual(writes, [["accountToken", ""], ["accountOrigin", "https://other.example"], ["accountToken", "new-account-token"],
      ["atlasToken", ""], ["atlasOrigin", "https://other.example"], ["atlasToken", "new-atlas-token"]]);
    assert.deepEqual(requests, [["https://other.example", "new-account-token"], ["https://other.example", "new-atlas-token"]]);
    assert.deepEqual([values.accountOrigin, values.atlasOrigin], ["https://other.example", "https://other.example"]);
  } finally { game.settings = savedSettings; creatureClient.access = savedAccess; creatureClient.check = savedCheck; }
});

test("Atlas names its own address only while a saved Atlas token uses another one than the site address", async () => {
  keysAsText();
  const savedSettings = game.settings, previousGM = game.user.isGM;
  compatibleWorld();
  try {
    await withTemplate("en", async render => {
      game.i18n = { localize: key => key, format: (key, values) => `${key} ${values.origin}` };
      const local = "http://localhost:3000", site = "https://www.jdr.ninja";
      for (const [values, isGM, shown] of [
        [{}, true, null],
        [{ atlasOrigin: local }, true, local],
        [{ accountOrigin: local }, true, site],
        [{ accountOrigin: local, atlasOrigin: local }, true, null],
        [{ atlasOrigin: local, atlasToken: "" }, true, null],
        [{ atlasOrigin: local }, false, null],
      ]) {
        game.settings = fixtureSettings(values);
        game.user.isGM = isGM;
        const context = await new ConnectionPanel()._prepareContext();
        const html = render(context), note = html.indexOf("data-atlas-origin");
        const label = JSON.stringify([values, isGM]);
        assert.equal(context.atlas.originNote, shown ? `JDRNINJA.atlas.originDiffers ${shown}` : "", label);
        if (!shown) { assert.equal(note, -1, label); continue; }
        // One discreet line in the Atlas section of the advanced options, after the site address that applies to both.
        assert(html.includes(`<p class="jn-muted" data-atlas-origin>JDRNINJA.atlas.originDiffers ${shown}</p>`), label);
        assert.equal(count(html, /data-atlas-origin/g), 1, label);
        assert(note > html.indexOf('name="accountOrigin"') && html.indexOf('name="accountOrigin"') > html.indexOf("<details"), label);
        // The field itself shows the saved account address, never the Atlas one.
        assert(html.includes(`name="accountOrigin" type="url" value="${values.accountOrigin ?? site}"`), label);
      }
    });
  } finally { game.settings = savedSettings; game.user.isGM = previousGM; keysAsText(); leaveWorld(); }
});

test("automatic checks run once per opening in the background, and never without a saved token or a known creature access", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access, savedCheck = creatureClient.check;
  compatibleWorld();
  const calls = [], release = {};
  const pending = kind => new Promise(resolve => { release[kind] = resolve; });
  creatureClient.check = signal => { calls.push(["creatures", signal]); return pending("creatures"); };
  try {
    game.settings = fixtureSettings({ atlasEnabled: true, creaturesEnabled: true, overlayEnabled: true });
    creatureClient.access = null;
    const panel = new ConnectionPanel();
    panel._connections.check = (kind, { signal }) => { calls.push([kind, signal]); return pending(kind); };
    const opening = await panel._prepareContext({ isFirstRender: true });
    assert.deepEqual(calls.map(([kind]) => kind), ["account", "atlas", "creatures"]);
    // The window stays usable: no busy footer, and only the checked blocks say so.
    assert.equal(opening.busy, false);
    assert.equal(opening.account.state, "checking");
    assert.deepEqual(opening.features.slice(1).map(feature => feature.state), ["checking", "checking", "checking"]);
    // Neither the next render nor another first-render call of the same window checks again.
    panel.rendered = true;
    await panel.render();
    await panel._prepareContext({ isFirstRender: true });
    assert.equal(calls.length, 3);
    release.account({ ok: true, label: "Demo GM", allowed: true });
    release.atlas({ ok: false, reason: "network" });
    creatureClient.access = { allowed: true, entitled: true };
    release.creatures({});
    await flush();
    const checked = panel.renders.at(-1);
    assert.deepEqual([checked.account.state, ...checked.features.slice(1).map(feature => feature.state)], ["verified", "active", "available", "failed"]);
    // A failure is never retried on its own.
    await panel.render();
    assert.equal(calls.length, 3);
    await panel.close();

    // Nothing is checked without a saved token, and a creature access the Actors directory already knows is reused.
    calls.length = 0;
    game.settings = fixtureSettings({ accountToken: "", atlasToken: "", atlasEnabled: true, creaturesEnabled: true });
    const empty = new ConnectionPanel();
    empty._connections.check = (kind, { signal }) => { calls.push([kind, signal]); return pending(kind); };
    await empty._prepareContext({ isFirstRender: true });
    assert.deepEqual(calls, []);
    game.settings = fixtureSettings({ atlasEnabled: false, creaturesEnabled: true });
    creatureClient.access = { allowed: false, entitled: true, reason: "devicePermissionRequired" };
    const known = new ConnectionPanel();
    known._connections.check = (kind, { signal }) => { calls.push([kind, signal]); return pending(kind); };
    const context = await known._prepareContext({ isFirstRender: true });
    assert.deepEqual(calls.map(([kind]) => kind), ["account"]);
    assert.equal(context.features.find(feature => feature.id === "creatures").state, "devicePermissionRequired");
    await known.close();
  } finally { game.settings = savedSettings; creatureClient.access = savedAccess; creatureClient.check = savedCheck; leaveWorld(); }
});

test("closing aborts the automatic checks, an explicit operation replaces its own, and a late answer for another token is dropped", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access, savedCheck = creatureClient.check;
  compatibleWorld();
  const calls = [], release = {};
  const pending = kind => new Promise(resolve => { release[kind] = resolve; });
  creatureClient.check = signal => { calls.push(["creatures", signal]); return pending("creatures"); };
  try {
    game.settings = fixtureSettings({ atlasEnabled: true, creaturesEnabled: true });
    creatureClient.access = null;
    const closing = new ConnectionPanel();
    closing._connections.check = (kind, { signal }) => { calls.push([kind, signal]); return pending(kind); };
    await closing._prepareContext({ isFirstRender: true });
    closing.rendered = true;
    await closing.close();
    assert(calls.every(([, signal]) => signal.aborted));
    const renders = closing.renders.length;
    release.account({ ok: true, label: "Late", allowed: true });
    release.atlas({ ok: true, label: "Late", allowed: true });
    await flush();
    assert.deepEqual([closing._results.account, closing._results.atlas, closing.renders.length], [null, null, renders]);

    // A token saved while the check ran makes its answer describe nothing on screen.
    calls.length = 0;
    const values = { atlasEnabled: false, creaturesEnabled: false };
    game.settings = fixtureSettings(values);
    const stale = new ConnectionPanel();
    stale._connections.check = (kind, { signal }) => { calls.push([kind, signal]); return pending(kind); };
    await stale._prepareContext({ isFirstRender: true });
    values.accountToken = "another-secret";
    release.account({ ok: true, label: "Old account", allowed: true });
    await flush();
    assert.equal(stale._results.account, null);
    assert.equal((await stale._prepareContext()).account.state, "unchecked");

    // « Try again » starts an explicit check, which replaces the automatic one.
    values.accountToken = "fixture-secret";
    const explicit = new ConnectionPanel();
    explicit._connections.check = (kind, { signal }) => { calls.push([kind, signal]); return pending(kind); };
    await explicit._prepareContext({ isFirstRender: true });
    const automatic = calls.at(-1)[1];
    const retry = explicit._checkAccount();
    await flush();
    assert.equal(automatic.aborted, true);
    assert.equal(explicit._checks.account, null);
    assert.equal((await explicit._prepareContext()).busy, true);
    release.account({ ok: true, label: "Demo GM", allowed: true });
    await retry;
    assert.equal((await explicit._prepareContext()).account.label, "Demo GM");
  } finally { game.settings = savedSettings; creatureClient.access = savedAccess; creatureClient.check = savedCheck; leaveWorld(); }
});

test("a check that ends before the first render completes is drawn once by that render, and never after the window closes", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access, savedCheck = creatureClient.check;
  creatureClient.access = { allowed: true, entitled: true };
  const panels = [];
  try {
    game.settings = fixtureSettings({ atlasEnabled: false, creaturesEnabled: false });
    const open = async () => {
      const panel = new ConnectionPanel(); panels.push(panel);
      panel._connections.check = async () => ({ ok: false, reason: "network" });
      // The window is not rendered yet: the first render is still preparing its context when the check fails.
      await panel._prepareContext({ isFirstRender: true }); await flush();
      assert.equal(panel.rendered, false); assert.equal(panel.renders.length, 0, "nothing can be redrawn before the window is rendered");
      assert.equal(panel._drawOnRender, true);
      panel.element = { querySelector: () => null };
      return panel;
    };
    const panel = await open();
    panel.rendered = true; panel._onRender({}, { isFirstRender: true }); await flush();
    assert.equal(panel.renders.length, 1); assert.equal(panel.renders[0].account.state, "retry");
    panel._onRender({}, {}); await flush();
    assert.equal(panel.renders.length, 1, "a later render does not draw it again");

    // Closed before the first render completes, or between that render and the redraw: nothing is drawn.
    const closed = await open();
    await closed.close(); await flush();
    assert.equal(closed._drawOnRender, false); assert.equal(closed.renders.length, 0);
    const leaving = await open();
    leaving.rendered = true; leaving._onRender({}, { isFirstRender: true }); leaving.rendered = false; await flush();
    assert.equal(leaving.renders.length, 0);
  } finally {
    for (const panel of panels) await panel.close();
    game.settings = savedSettings; creatureClient.access = savedAccess; creatureClient.check = savedCheck;
  }
});

test("creature access is checked when its switch turns on and after a pairing succeeds, only while it is unknown", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access, savedCheck = creatureClient.check;
  compatibleWorld();
  let checks = 0;
  creatureClient.check = () => { checks++; return new Promise(() => {}); };
  try {
    const values = { creaturesEnabled: false };
    game.settings = fixtureSettings(values);
    creatureClient.access = null;
    const panel = new ConnectionPanel();
    await panel._toggleCreatures({ currentTarget: { checked: true } });
    assert.equal(values.creaturesEnabled, true);
    assert.equal(checks, 1);
    assert.equal((await panel._prepareContext()).features.find(feature => feature.id === "creatures").state, "checking");
    await panel.close();

    creatureClient.access = { allowed: true };
    const known = new ConnectionPanel();
    await known._toggleCreatures({ currentTarget: { checked: true } });
    assert.equal(checks, 1);

    creatureClient.access = null;
    const paired = new ConnectionPanel();
    paired._connections.pairAccount = async () => ({ ok: true, label: "Demo GM", allowed: true });
    await paired._pair();
    assert.equal(checks, 2);
    assert.equal(paired._results.account.label, "Demo GM");
    await paired.close();
  } finally { game.settings = savedSettings; creatureClient.access = savedAccess; creatureClient.check = savedCheck; leaveWorld(); }
});

test("each disconnection asks first: cancelling or closing keeps the token, confirming removes it", async () => {
  keysAsText();
  const savedSettings = game.settings, savedDialog = foundry.applications.api.DialogV2;
  const dialogs = [];
  let answer = false;
  foundry.applications.api.DialogV2 = { confirm: async config => { dialogs.push(config); return answer; } };
  try {
    const values = { accountToken: "fixture-secret", atlasToken: "fixture-secret" };
    game.settings = fixtureSettings(values);
    const panel = new ConnectionPanel();
    for (const kind of ["account", "atlas"]) {
      const disconnect = () => kind === "account" ? panel._disconnectAccount() : panel._disconnectAtlas();
      answer = false; await disconnect();
      answer = null; await disconnect();
      assert.equal(values[`${kind}Token`], "fixture-secret", kind);
      answer = true; await disconnect();
      assert.equal(values[`${kind}Token`], "", kind);
    }
    assert.equal(dialogs.length, 6);
    const [account, atlas] = [dialogs[0], dialogs[3]];
    assert.equal(account.window.title, "JDRNINJA.account.disconnectTitle");
    assert.equal(atlas.window.title, "JDRNINJA.atlas.disconnectTitle");
    assert(account.content.includes("<p>JDRNINJA.account.disconnectHint</p>"));
    assert(atlas.content.includes("<p>JDRNINJA.atlas.disconnectHint</p><p>JDRNINJA.atlas.disconnectWorld</p>"));
    assert(account.content.includes('<a href="https://www.jdr.ninja/vtt-overlay/foundry" target="_blank" rel="noopener noreferrer">JDRNINJA.account.manage</a>'));
    assert(atlas.content.includes('<a href="https://www.jdr.ninja/dojo/connexions-foundry" target="_blank" rel="noopener noreferrer">JDRNINJA.atlas.manage</a>'));
    for (const dialog of [account, atlas]) {
      assert.deepEqual([dialog.yes.label, dialog.yes.class, dialog.no.label, dialog.modal], ["JDRNINJA.button.disconnect", "jn-danger", "JDRNINJA.button.cancel", true]);
      assert(dialog.classes.includes("jdr-ninja"));
    }
    // An address that is not a valid origin leaves the link out instead of failing.
    values.accountToken = "fixture-secret"; values.accountOrigin = "javascript:alert(1)";
    answer = false;
    await panel._disconnectAccount();
    assert(!dialogs.at(-1).content.includes("<a"));
    assert.equal(values.accountToken, "fixture-secret");
  } finally { game.settings = savedSettings; foundry.applications.api.DialogV2 = savedDialog; }
});

test("a redraw keeps what is being typed, while an explicit operation starts from the saved state", () => {
  const panel = new ConnectionPanel();
  const field = (name, value, defaultValue = value) => ({ name, value, defaultValue });
  const rendered = () => [field("atlasToken", ""), field("deviceName", "Test world / GM"), field("accountOrigin", "https://new.example")];
  const content = { fields: [field("atlasToken", "typed", ""), field("deviceName", "My table", "Test world / GM"), field("accountOrigin", "https://www.jdr.ninja")],
    querySelectorAll: () => content.fields, querySelector: selector => content.fields.find(input => selector === `input[name="${input.name}"]`) };
  panel._replaceHTML(rendered(), content, {});
  // An untouched field shows the newly saved value.
  assert.deepEqual(content.fields.map(input => input.value), ["typed", "My table", "https://new.example"]);
  content.fields[0].value = "typed again";
  panel._replaceHTML(rendered(), content, { resetFields: true });
  assert.deepEqual(content.fields.map(input => input.value), ["", "Test world / GM", "https://new.example"]);
  // The one site address, typed and not yet saved, survives a redraw such as a finished background check.
  const address = [field("accountOrigin", "http://localhost:3000", "https://www.jdr.ninja")];
  const typed = { fields: address, querySelectorAll: () => typed.fields, querySelector: selector => typed.fields.find(input => selector === `input[name="${input.name}"]`) };
  panel._replaceHTML([field("accountOrigin", "https://www.jdr.ninja")], typed, {});
  assert.equal(typed.fields[0].value, "http://localhost:3000");
});
