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
const { ConnectionPanel, connectionPill, creaturePill } = await import("../scripts/connection-panel.js");
const { streamDeckBridge } = await import("../scripts/stream-deck/bridge.js");
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
      // The creature card and its buttons carry no premium marker.
      assert(html.includes(`>${Handlebars.escapeExpression(strings["JDRNINJA.creatures.heading"])}</h3>`));
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
    // Services are pills with an icon and their text, never badges; the blocks are cards and sections, never fieldsets.
    assert(!html.includes("<fieldset") && !html.includes("<legend") && !html.includes('class="badge'));
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

const withTemplate = async (language, callback) => {
  const copy = JSON.parse(await readFile(new URL(`../lang/${language}.json`, import.meta.url), "utf8"));
  const renderer = Handlebars.create();
  renderer.registerHelper("localize", key => copy[key] ?? key);
  const render = renderer.compile(await readFile(new URL("../templates/connections.hbs", import.meta.url), "utf8"));
  return callback(render, copy);
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;
// Earlier tests leave a locale installed: these ones compare keys, so they read the key itself as the text.
const keysAsText = () => { game.i18n = { localize: key => key, format: key => key }; };

test("a connection state maps to one pill level, derived from the state alone", () => {
  assert.deepEqual(connectionPill({ configured: false, verified: false, failed: false }), { level: "neutral", icon: "fa-circle-minus" });
  assert.deepEqual(connectionPill({ configured: true, verified: false, failed: false }), { level: "warning", icon: "fa-triangle-exclamation" });
  assert.deepEqual(connectionPill({ configured: true, verified: false, failed: true }), { level: "error", icon: "fa-circle-xmark" });
  assert.deepEqual(connectionPill({ configured: false, verified: false, failed: true }), { level: "error", icon: "fa-circle-xmark" });
  assert.deepEqual(connectionPill({ configured: true, verified: true, failed: false }), { level: "success", icon: "fa-circle-check" });
});

test("the account and Atlas pills follow the saved token and the last check", async () => {
  keysAsText();
  const savedSettings = game.settings;
  try {
    game.settings = { ...savedSettings, get: (module, key) => key === "accountToken" ? "" : savedSettings.get(module, key) };
    assert.equal((await new ConnectionPanel()._prepareContext()).account.pill.level, "neutral");
    // A panel reads the settings it was created with.
    game.settings = savedSettings;
    const panel = new ConnectionPanel();
    const stored = await panel._prepareContext();
    assert.equal(stored.account.pill.level, "warning");
    assert.equal(stored.atlas.pill.level, "warning");
    panel._results.account = { ok: false, reason: "unauthorized" };
    const rejected = await panel._prepareContext();
    assert.equal(rejected.account.pill.level, "error");
    assert.equal(rejected.account.status, "JDRNINJA.status.saved");
    assert.equal(rejected.atlas.pill.level, "warning");
    panel._results.account = { ok: false, reason: "unconfigured" };
    assert.equal((await panel._prepareContext()).account.pill.level, "warning");
    panel._results.account = { ok: true, label: "Account", allowed: false };
    panel._results.atlas = { ok: true, label: "World", allowed: true };
    const verified = await panel._prepareContext();
    assert.equal(verified.account.pill.level, "success");
    assert.equal(verified.atlas.pill.level, "success");
  } finally { game.settings = savedSettings; }
});

test("the creatures pill puts an incompatible system first, then the access state, and an error for anything the server reports", () => {
  keysAsText();
  const compatible = { compatible: true, code: "compatible", label: "compatible" };
  const levels = status => creaturePill(status, compatible);
  assert.deepEqual([levels("available").level, levels("available").label, levels("available").message], ["success", "JDRNINJA.creatures.status.available", ""]);
  assert.deepEqual([levels("notChecked").level, levels("notChecked").label], ["neutral", "JDRNINJA.creatures.status.notChecked"]);
  assert.deepEqual([levels("disabled").level, levels("disabled").label, levels("disabled").message], ["neutral", "JDRNINJA.panel.state.disabled", ""]);
  for (const status of ["connectionRequired", "devicePermissionRequired", "tierRequired", "incompatibleSystem"]) {
    const pill = levels(status);
    assert.deepEqual([pill.level, pill.label, pill.message], ["warning", "JDRNINJA.panel.state.attention", `JDRNINJA.creatures.error.${status}`], status);
  }
  for (const status of ["verificationUnavailable", "unauthorized", "apiUnavailable", "somethingNew"]) {
    const pill = levels(status);
    assert.deepEqual([pill.level, pill.label], ["error", "JDRNINJA.panel.state.unavailable"], status);
  }
  assert.deepEqual([levels("available").icon, levels("tierRequired").icon, levels("other").icon, levels("notChecked").icon],
    ["fa-circle-check", "fa-triangle-exclamation", "fa-circle-xmark", "fa-circle-minus"]);
  // Another game system cannot import at all; an untested version only warns. Both name the cause in the pill.
  const other = creaturePill("available", { compatible: false, code: "dndRequired", label: "D&D required" });
  assert.deepEqual([other.level, other.label, other.message], ["error", "D&D required", ""]);
  const version = creaturePill("disabled", { compatible: false, code: "versionUnsupported", label: "Untested version" });
  assert.deepEqual([version.level, version.label], ["warning", "Untested version"]);
});

test("the Stream Deck card carries the pill of the bridge state", async () => {
  keysAsText();
  const saved = streamDeckBridge.state;
  try {
    for (const [state, level] of [["ready", "success"], ["connecting", "warning"], ["disabled", "neutral"], ["disconnected", "error"]]) {
      streamDeckBridge.state = state;
      const context = await new ConnectionPanel()._prepareContext();
      assert.equal(context.streamDeck.pill.level, level, state);
      assert.equal(context.streamDeck.pill.label, `JDRNINJA.streamDeck.state.${state}`);
    }
  } finally { streamDeckBridge.state = saved; }
});

test("the creatures card states a restriction once: as the pill message, or as the alert of the check that failed", async () => {
  keysAsText();
  const savedSettings = game.settings, savedAccess = creatureClient.access;
  game.system = { id: "dnd5e", title: "Dungeons & Dragons Fifth Edition", version: "5.3.3" };
  game.release = { generation: 14 };
  game.settings = { ...savedSettings, get: (module, key) => key === "creaturesEnabled" ? true : savedSettings.get(module, key) };
  try {
    creatureClient.access = { allowed: false, entitled: false, reason: "tierRequired" };
    const panel = new ConnectionPanel();
    let context = await panel._prepareContext();
    assert.equal(context.creatures.compatibility.compatible, true);
    assert.deepEqual([context.creatures.pill.level, context.creatures.message, context.creatures.error],
      ["warning", "JDRNINJA.creatures.error.tierRequired", ""]);
    panel._results.creatures = { ok: false, reason: "tierRequired" };
    context = await panel._prepareContext();
    assert.deepEqual([context.creatures.pill.level, context.creatures.message, context.creatures.error],
      ["warning", "", "JDRNINJA.creatures.error.tierRequired"]);
    creatureClient.access = { allowed: true, entitled: true };
    panel._results.creatures = { ok: true };
    context = await panel._prepareContext();
    assert.deepEqual([context.creatures.pill.level, context.creatures.message, context.creatures.error], ["success", "", ""]);
  } finally { delete game.system; delete game.release; game.settings = savedSettings; creatureClient.access = savedAccess; }
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

test("the Connections template keeps one card per service and one primary action at most", async () => {
  for (const language of ["en", "fr"]) await withTemplate(language, async (render, copy) => {
    const context = await new ConnectionPanel()._prepareContext();
    const html = render(context);
    assert.equal(count(html, /class="jn-card /g), 4, language);
    assert.equal(count(render({ ...context, isGM: false }), /class="jn-card /g), 2, language);
    // Each service has its name as a heading and its own pill; nothing is a fieldset.
    for (const service of ["stream-deck", "account", "creatures", "atlas"]) {
      assert(html.includes(`<h3 id="jdr-ninja-service-${service}">`), service);
      assert(html.includes(`aria-labelledby="jdr-ninja-service-${service}"`), service);
    }
    assert(!html.includes("<fieldset") && !html.includes("<legend"));
    assert.equal(count(html, /class="jn-pill /g), 4);
    // A pill is never colour alone: it holds an icon and a text.
    for (const pill of html.matchAll(/<span class="jn-pill [^>]*>(.*?)<\/span>/g)) {
      assert(/<i class="fa-solid [\w -]+" aria-hidden="true"/.test(pill[1]), pill[0]);
      assert(/[^<>\s]/.test(pill[1].replace(/<[^>]*>/g, "")), pill[0]);
    }
    // A browser without an account has one primary action: connect. Once connected there is none.
    const unconnected = render({ ...context, account: { ...context.account, configured: false } });
    assert.equal(count(unconnected, /class="bright"/g), 1);
    assert(/class="bright" data-action="pair"/.test(unconnected));
    assert.equal(count(render({ ...context, account: { ...context.account, configured: true } }), /class="bright"/g), 0);
    // Destructive actions use the error colour; the actions that only change state do not.
    for (const action of ["disconnectAccount", "disconnectAtlas"]) assert(html.includes(`class="jn-danger" data-action="${action}"`), action);
    for (const action of ["pair", "checkAccount", "saveAtlas", "checkAtlas", "openOverlay", "openStreamDeck", "openAtlas"]) {
      assert(!new RegExp(`class="jn-danger" data-action="${action}"`).test(html), action);
    }
    // The enable hints are tooltips on focusable icons that also carry the text for assistive technology.
    const hints = [...html.matchAll(/<i class="fa-solid fa-circle-info jn-info"[^>]*>/g)].map(match => match[0]);
    assert(hints.length >= 5);
    for (const hint of hints) {
      assert(/tabindex="0"/.test(hint) && /role="img"/.test(hint) && /aria-label="[^"]+"/.test(hint) && /data-tooltip="[^"]+"/.test(hint), hint);
    }
    for (const key of ["streamDeck.enableHint", "overlay.enableHint", "creatures.enableHint", "atlas.enableHint"]) {
      const text = Handlebars.escapeExpression(copy[`JDRNINJA.${key}`]);
      assert(html.includes(`data-tooltip="${text}"`), key);
      assert(!html.includes(`<p class="hint">${text}</p>`), key);
    }
    // The statements about who shares a credential stay visible.
    for (const key of ["account.hint", "atlas.hint"]) assert(html.includes(Handlebars.escapeExpression(copy[`JDRNINJA.${key}`])), key);
    // Every field has its label, and every service switch also names its card.
    for (const input of html.matchAll(/<input id="([\w-]+)"/g)) assert(html.includes(`for="${input[1]}"`), input[1]);
    for (const input of html.matchAll(/<input id="[\w-]+" name="(?:streamDeck|creatures|atlas)Enabled"[^>]*>/g)) {
      assert(/aria-labelledby="[\w-]+ jdr-ninja-service-[\w-]+"/.test(input[0]), input[0]);
    }
  });
});

test("the Connections template keeps the hooks the code and the screenshot tool use, with advanced settings folded away", async () => {
  await withTemplate("en", async render => {
    const panel = new ConnectionPanel();
    panel._results.account = { ok: true, label: "Demo account", allowed: true };
    panel._results.atlas = { ok: true, label: "Demo world", allowed: true };
    const context = await panel._prepareContext();
    const html = render(context);
    // The label of the account and of the Atlas world sits in the status line the tool waits for.
    assert(/<span class="jdr-ninja__status" aria-live="polite"><strong>Demo account<\/strong><\/span>/.test(html));
    assert(/<span class="jdr-ninja__status" aria-live="polite"><strong>Demo world<\/strong><\/span>/.test(html));
    const advanced = html.indexOf('<details class="jdr-ninja__advanced" data-sync="advanced">');
    assert(advanced > 0 && !/<details[^>]*\bopen\b/.test(html), "Advanced options start closed and keep their state across renders");
    // What the first connection needs stays outside the closed disclosure.
    for (const hook of ['name="streamDeckEnabled"', 'name="overlayEnabled"', 'name="creaturesEnabled"', 'name="atlasEnabled"', 'name="atlasToken"',
      'name="deviceName"', 'data-action="pairCreatures"', 'data-action="checkCreatures"', 'data-action="saveAtlas"', 'data-action="pair"']) {
      assert(html.indexOf(hook) > 0 && html.indexOf(hook) < advanced, hook);
    }
    // The manual token, the site addresses and device management are advanced.
    for (const hook of ['name="accountToken"', 'name="accountOrigin"', 'name="atlasOrigin"', 'data-action="saveAccount"',
      'data-action="manageAccount"', 'data-action="manageAtlas"']) {
      assert(html.indexOf(hook) > advanced, hook);
    }
    // The wait is a footer with the one way out, only while an operation runs.
    assert(!html.includes('data-action="cancel"'));
    assert(/<footer class="form-footer jn-footer jdr-ninja__busy" role="status">/.test(render({ ...context, busy: true })));
    assert(html.includes('class="standard-form jn-layout') && html.includes('<div class="jn-scroll">'));
  });
});
