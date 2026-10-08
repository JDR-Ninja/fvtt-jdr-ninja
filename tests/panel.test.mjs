import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { registerSettings } from "../scripts/settings.js";
import { creatureClient } from "../scripts/creatures/api.js";

class Application {
  rendered = false;
  renders = [];
  fronted = 0;
  async render() { this.rendered = true; this.renders.push(await this._prepareContext()); return this; }
  async close() { this.rendered = false; return this; }
  bringToFront() { this.fronted++; }
}
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } } };
globalThis.game = { settings: { get: (_module, key) => key.endsWith("Token") ? "fixture-secret" : "https://www.jdr.ninja" },
  user: { isGM: true, name: "GM" }, world: { title: "Test world" }, i18n: { localize: key => key, format: key => key } };
const { ConnectionPanel } = await import("../scripts/connection-panel.js");
const { MonsterGeneratorPanel, NpcGeneratorPanel } = await import("../scripts/creatures/panel.js");
const { VariablePanel } = await import("../scripts/variables/panel.js");
const { MacroArgumentsPanel } = await import("../scripts/variables/macro-panel.js");

test("settings keep account tokens client-scoped and Atlas tokens world-scoped, outside native configuration fields", () => {
  const settings = [];
  let menu;
  const previous = game.settings;
  game.settings = { register: (_module, key, options) => settings.push({ key, ...options }),
    registerMenu: (_module, _key, options) => { menu = options; } };
  try { registerSettings({ menus: { connections: ConnectionPanel } }); } finally { game.settings = previous; }
  assert.equal(settings.length, 20);
  for (const setting of settings) {
    assert.equal(setting.scope, setting.key === "variablesPersonal" ? "user" : setting.key === "variablesWorld" || setting.key.startsWith("atlas") ? "world" : "client");
    assert.equal(setting.config, ["atlasEnabled", "overlayEnabled", "overlayForwardFilter",
      "overlayCardHoldSeconds", "overlayTableCommandsEnabled", "streamDeckEnabled", "creaturesEnabled"].includes(setting.key));
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
  // Generator menus show the short label and their window's icon, with no premium marker.
  for (const [key, kind] of [["monsterGenerator", "monster"], ["npcGenerator", "npc"]]) {
    assert.equal(menus.get(key).label, `JDRNINJA.creatures.${kind}Shortcut`);
    assert.equal(menus.get(key).icon, windows[key].DEFAULT_OPTIONS.window.icon);
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
  await new Promise(resolve => setImmediate(resolve));
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

test("players never see the GM-only creature and Twitch table switches in Configure Settings; GMs do", () => {
  const settings = new Map();
  const previous = game.settings, previousGM = game.user.isGM;
  game.settings = { register: (_module, key, options) => settings.set(key, options), registerMenu() {} };
  try {
    registerSettings({ menus: { connections: ConnectionPanel } });
    // V14 SettingsConfig#_prepareCategoryData lists `config` settings and hides only world-scope ones from players.
    const listed = () => [...settings].filter(([, s]) => s.config && s.scope !== "world").map(([key]) => key);
    game.user.isGM = true;
    assert(listed().includes("creaturesEnabled")); assert(listed().includes("overlayTableCommandsEnabled"));
    game.user.isGM = false;
    assert.deepEqual(listed().sort(), ["overlayCardHoldSeconds", "overlayEnabled", "overlayForwardFilter", "streamDeckEnabled"]);
  } finally { game.settings = previous; game.user.isGM = previousGM; }
});

test("render context never contains saved credentials or equates a stored token with verified authentication", async () => {
  const panel = new ConnectionPanel();
  const context = await panel._prepareContext();
  assert(!JSON.stringify(context).includes("fixture-secret"));
  assert.equal(context.account.configured, true);
  assert.equal(context.account.status, "JDRNINJA.status.saved");
  assert.equal(context.account.label, "");
  panel._results.account = { ok: true, label: "Test account", allowed: false };
  const checked = await panel._prepareContext();
  assert.equal(checked.account.status, "JDRNINJA.status.connected");
  assert.equal(checked.account.limited, true);
});

test("the player context hides Atlas configuration", async () => {
  const previous = game.user.isGM;
  game.user.isGM = false;
  try {
    const context = await new ConnectionPanel()._prepareContext();
    assert.equal(context.isGM, false);
    assert.equal(context.atlas.configured, false);
  } finally { game.user.isGM = previous; }
});

test("Connections keeps one subscription link without an account, otherwise only after an access check finds no subscription", async () => {
  const savedAccess = creatureClient.access, savedSettings = game.settings;
  const strings = JSON.parse(await readFile(new URL('../lang/fr.json', import.meta.url), 'utf8'));
  const renderer = Handlebars.create(); renderer.registerHelper('localize', key => strings[key] ?? key);
  const render = renderer.compile(await readFile(new URL('../templates/connections.hbs', import.meta.url), 'utf8'));
  try {
    for (const [token, account, creatureAccess, accountLink, creatureLink] of [
      ['', null, null, true, false],
      ['fixture-secret', null, null, false, false],
      ['fixture-secret', { ok: false, reason: 'unauthorized' }, null, false, false],
      ['fixture-secret', { ok: true, allowed: false }, { entitled: true }, true, false],
      ['fixture-secret', { ok: true, allowed: true }, { entitled: false, reason: 'tierRequired' }, false, true],
      ['fixture-secret', { ok: true, allowed: true }, { entitled: true, reason: 'devicePermissionRequired' }, false, false],
    ]) {
      game.settings = { ...savedSettings, get: (module, key) => key === "accountToken" ? token : savedSettings.get(module, key) };
      const panel = new ConnectionPanel(); panel._results.account = account; creatureClient.access = creatureAccess;
      const context = await panel._prepareContext(), html = render(context);
      assert.equal(context.account.showSubscriptionLink, accountLink);
      assert.equal(context.creatures.showSubscriptionLink, creatureLink);
      assert.equal(html.includes('data-jdr-subscriptions="account"'), accountLink);
      assert.equal(html.includes('data-jdr-subscriptions="creatures"'), creatureLink);
      if (accountLink || creatureLink) assert(html.includes('href="https://www.jdr.ninja/abonnements" target="_blank" rel="noopener noreferrer"'));
      // The creature section and its buttons carry no premium marker.
      assert(html.includes(`<legend>${Handlebars.escapeExpression(strings["JDRNINJA.creatures.heading"])}</legend>`));
      for (const kind of ["monster", "npc"]) assert(html.includes(Handlebars.escapeExpression(strings[`JDRNINJA.creatures.${kind}Shortcut`])));
      assert(!html.includes("fa-gem")); assert(!html.includes("(Premium)"));
      const player = render({ ...context, isGM: false });
      assert.equal(player.includes('data-jdr-subscriptions="account"'), accountLink);
      assert(!player.includes('data-jdr-subscriptions="creatures"'));
    }
  } finally { creatureClient.access = savedAccess; game.settings = savedSettings; }
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
  await new Promise(resolve => setImmediate(resolve));
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
  });
  await new Promise(resolve => setImmediate(resolve));
  panel._cancel();
  await pending;
  assert.equal(panel._challenge, null);
  assert.equal(panel._operation, null);
  await panel._run("account", async () => ({ ok: true, label: "Another account", allowed: true }));
  assert.equal(panel._results.account.label, "Another account");
});

test("the real template renders every locale, hides Atlas for players, and escapes server-provided labels", async () => {
  const template = Handlebars.compile(await readFile(new URL("../templates/connections.hbs", import.meta.url), "utf8"));
  const renderer = Handlebars.create();
  const source = await readFile(new URL("../templates/connections.hbs", import.meta.url), "utf8");
  for (const locale of ["fr", "en", "es", "de", "it"]) {
    const copy = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    game.i18n = { localize: key => copy[key] ?? key, format: (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), copy[key] ?? key) };
    renderer.registerHelper("localize", key => copy[key] ?? key);
    const render = renderer.compile(source);
    const panel = new ConnectionPanel();
    const context = await panel._prepareContext();
    context.account.label = '<img src=x onerror="fixture()">';
    context.account.status = copy["JDRNINJA.status.connected"];
    context.atlas.status = copy["JDRNINJA.status.saved"];
    context.atlas.integrationNotice = copy["JDRNINJA_ATLAS_SYNC.status.INTEGRATION_DISABLED"];
    context.creatures.status = copy[context.creatures.status] ?? context.creatures.status;
    context.account.error = copy["JDRNINJA.error.network"];
    context.account.limited = true;
    context.busy = true;
    context.challenge = { userCode: "ABCD-EFGH", verificationUrl: "https://www.jdr.ninja/vtt-overlay/lier?code=ABCD-EFGH" };
    const html = render(context);
    assert(!html.includes("JDRNINJA."), `${locale}: unresolved locale key`);
    assert(!html.includes("<img"));
    assert(html.includes("&lt;img"));
    assert(!html.includes("fixture-secret"));
    assert(html.includes('name="atlasToken"'));
    assert(html.includes('name="atlasEnabled" type="checkbox"'));
    assert(html.includes('data-compatibility="dndRequired"'));
    assert(html.includes(Handlebars.escapeExpression(copy['JDRNINJA.creatures.compatibility.dndRequired'])));
    assert(html.includes('data-action="cancel"'));
    assert(html.includes("ABCD-EFGH"));
    assert(!render({ ...context, isGM: false }).includes('name="atlasToken"'));
    assert(!render({ ...context, isGM: false }).includes('name="atlasEnabled"'));
    for (const action of html.matchAll(/data-action="(\w+)"/g)) {
      assert.equal(typeof ConnectionPanel.DEFAULT_OPTIONS.actions[action[1]], "function", action[1]);
    }
  }
  assert.equal(typeof template, "function");
});

test("the integration checkbox persists a boolean and refuses changes by a player", async () => {
  const saved = [];
  const previous = game.settings;
  const previousGM = game.user.isGM;
  game.settings = { ...previous, set: async (_module, key, value) => saved.push([key, value]) };
  const panel = new ConnectionPanel();
  try {
    await panel._toggleAtlas({ currentTarget: { checked: true } });
    await panel._toggleAtlas({ currentTarget: { checked: false } });
    assert.deepEqual(saved, [["atlasEnabled", true], ["atlasEnabled", false]]);
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
