import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { emptyStore, copy } from "../scripts/variables/schema.js";
import { variableService } from "../scripts/variables/service.js";
import { registerVariableSettings } from "../scripts/variables/settings.js";
import { menuLauncher } from "../scripts/settings.js";

class App {
  rendered = false; renders = 0; fronted = 0;
  element = { querySelector: () => null, querySelectorAll: () => [], ownerDocument: {} };
  async render() { this.rendered = true; this.renders++; this.context = await this._prepareContext(); this._onRender?.(this.context, {}); return this; }
  async close() { this.rendered = false; }
  bringToFront() { this.fronted++; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
/** Counts live subscriptions to the variable service and lets a test send its notifications. */
function subscriptions() {
  const active = new Set();
  variableService.subscribe = listener => { active.add(listener); return () => active.delete(listener); };
  return { active, notify: () => { for (const listener of active) listener({}); },
    restore: () => { delete variableService.subscribe; } };
}
globalThis.foundry = { applications: { api: { ApplicationV2: App, HandlebarsApplicationMixin: base => base, DialogV2: { confirm: async () => true } } } };
const user = { id: "gm", isGM: true, role: 4, active: true, can: () => true }, stored = { world: { ...emptyStore(), controller: "gm" }, personal: emptyStore() };
const collection = { contents: [], get: () => undefined };
globalThis.game = { user, world: { id: "fixture" }, users: { contents: [user], get: id => id === user.id ? user : null },
  settings: { get: (_m, key) => copy(stored[key === "variablesWorld" ? "world" : "personal"]) }, i18n: { localize: key => key },
  actors: collection, journal: collection, macros: collection, scenes: collection, playlists: collection, tables: collection, combats: collection };
globalThis.canvas = {};
globalThis.ui = { notifications: { warn: () => {} } };
const { VariablePanel, dependencies, typedValue } = await import("../scripts/variables/panel.js");
const { MacroArgumentsPanel } = await import("../scripts/variables/macro-panel.js");

test("advanced menus are available to players, use native user storage and have no activation preference", () => {
  const settings = [], menus = []; const previous = game.settings;
  game.settings = { register: (_m, key, options) => settings.push({ key, ...options }), registerMenu: (_m, key, options) => menus.push({ key, ...options }) };
  try { registerVariableSettings(menuLauncher(VariablePanel), menuLauncher(MacroArgumentsPanel)); } finally { game.settings = previous; }
  assert.deepEqual(settings.map(s => [s.key, s.scope, s.config]), [["variablesWorld", "world", false], ["variablesPersonal", "user", false]]);
  assert.equal(menus.length, 2); assert(menus.every(menu => !menu.restricted)); assert(!settings.some(s => s.key.endsWith("Enabled")));
});
test("management templates render in all five locales and escape authored fields and macro examples", async () => {
  const templates = await Promise.all(["variables", "macro-arguments"].map(name => readFile(new URL(`../templates/${name}.hbs`, import.meta.url), "utf8")));
  const authored = { id: "x", name: '<script>alert("x")</script>', type: "number", kind: "stored", constraints: {}, current: 1, default: 2 };
  stored.personal.variables = [authored]; const variablePanel = new VariablePanel(); variablePanel.draft = copy(authored); variablePanel.baseRevision = 0;
  for (const lang of ["fr", "en", "de", "es", "it"]) {
    const locale = JSON.parse(await readFile(new URL(`../lang/${lang}.json`, import.meta.url), "utf8")); game.i18n.localize = key => locale[key] ?? key;
    Handlebars.registerHelper("localize", key => locale[key] ?? key);
    const context = await variablePanel._prepareContext(); const html = Handlebars.compile(templates[0])(context);
    assert(!html.includes("JDRNINJA.")); assert(html.includes("&lt;script&gt;")); assert(!html.includes("<script>"));
    const macroHtml = Handlebars.compile(templates[1])({ selected: true, macros: [{ id: "m", name: authored.name }], arguments: [], sample: '<script>unsafe</script>' });
    assert(!macroHtml.includes("JDRNINJA.")); assert(macroHtml.includes("&lt;script&gt;"));
  }
  await variablePanel.close(); stored.personal.variables = [];
});
test("tab controls avoid Foundry's reserved ApplicationV2 action and current choices retain selected IDs", async () => {
  const template = await readFile(new URL("../templates/variables.hbs", import.meta.url), "utf8");
  assert(!template.includes('data-action="tab"')); assert(template.includes('data-action="switchTab"'));
  stored.personal.lists = [{ id: "l", name: "List", type: "number", entries: [{ id: "a", label: "A", value: 1 }, { id: "b", label: "B", value: 1 }] }];
  stored.personal.variables = [{ id: "v", name: "V", type: "number", kind: "list", constraints: {}, list: { scope: "personal", id: "l" }, current: "b", default: "a", wrap: false }];
  const panel = new VariablePanel(); panel.draft = copy(stored.personal.variables[0]); panel.baseRevision = 0;
  const context = await panel._prepareContext(); assert.equal(context.editor.currentEntryChoices.find(c => c.selected).value, "b"); assert.equal(context.editor.entryChoices.find(c => c.selected).value, "a");
  await panel.close(); stored.personal.variables = []; stored.personal.lists = [];
});
test("live changes mark conflicts and refresh previews without rendering over unsaved fields or focus", async () => {
  const panel = new VariablePanel(); panel.draft = { id: "d" }; panel.baseRevision = 0; panel.rendered = true; let renders = 0, hidden;
  panel.render = async () => { renders++; };
  const stale = { toggleAttribute: (_name, value) => { hidden = value; } }, message = { textContent: "" };
  panel.element = { querySelector: selector => selector === "[data-stale]" ? stale : message, querySelectorAll: () => [] };
  stored.personal.revision = 1; await panel._refreshState(); assert.equal(hidden, false); assert.equal(renders, 0); assert.deepEqual(panel.draft, { id: "d" });
  stored.personal.revision = 0; await panel.close();
});
test("the variables and macro windows are singletons that listen only while shown", async () => {
  const service = subscriptions();
  try {
    const panel = VariablePanel.open(); await flush();
    assert.equal(VariablePanel.open(), panel); assert.equal(panel.renders, 1); assert.equal(panel.fronted, 1);
    assert.equal(service.active.size, 1);
    await panel.render(); assert.equal(service.active.size, 1);
    await panel.close(); assert.equal(service.active.size, 0); assert.equal(VariablePanel._instance, null);
    const next = VariablePanel.open(); assert.notEqual(next, panel); await flush(); await next.close();
    const macro = MacroArgumentsPanel.open(); await flush();
    assert.equal(MacroArgumentsPanel.open(), macro); assert.equal(macro.renders, 1); assert.equal(macro.fronted, 1);
    await macro.close(); assert.equal(MacroArgumentsPanel._instance, null);
  } finally { service.restore(); }
});
test("with no draft, world changes rewrite values in place; only a definition change redraws, keeping the search, focus and caret", async () => {
  const service = subscriptions();
  const hp = { id: "hp", name: "HP", type: "number", kind: "stored", constraints: {}, current: 3, default: 0 };
  stored.personal.variables = [hp];
  const panel = new VariablePanel(), view = { renders: 0, prepares: 0, focused: null, controls: [], cells: [] };
  const prepare = panel._prepareContext.bind(panel);
  panel._prepareContext = async () => { view.prepares++; return prepare(); };
  panel.element = { ownerDocument: { get activeElement() { return view.focused; } }, querySelector: () => null,
    querySelectorAll: selector => selector === "[data-state-id]" ? view.cells : selector === "[name], [data-action]" ? view.controls : [] };
  // A fresh DOM per render, as Foundry replaces the window content: nothing in it is focused.
  const draw = context => {
    const search = { name: "search", tagName: "INPUT", dataset: {}, value: context.search, selectionStart: 0, selectionEnd: 0,
      focus() { view.focused = this; }, setSelectionRange(start, end) { Object.assign(this, { selectionStart: start, selectionEnd: end }); } };
    view.controls = [search, ...context.rows.map(row => ({ name: "", tagName: "BUTTON", dataset: { action: "select", id: row.id },
      focus() { view.focused = this; } }))];
    view.cells = context.rows.map(row => ({ dataset: { stateId: row.id }, textContent: row.value }));
    view.search = search; panel._onRender(context, {});
  };
  panel.rendered = true;
  panel.render = async () => { view.renders++; draw(await panel._prepareContext()); return panel; };
  try {
    draw(await panel._prepareContext());
    assert.equal(service.active.size, 1); assert.equal(view.cells[0].textContent, "3");
    panel.search = "h"; Object.assign(view.search, { value: "h", selectionStart: 1, selectionEnd: 1 }); view.focused = view.search;
    const typing = view.search;
    hp.current = 7; view.prepares = 0;
    for (let i = 0; i < 5; i++) service.notify();
    await panel._refreshing;
    assert.equal(view.prepares, 1); assert.equal(view.renders, 0);
    assert.equal(view.cells[0].textContent, "7"); assert.equal(view.focused, typing);
    stored.personal.variables = [hp, { id: "mp", name: "MP", type: "number", kind: "stored", constraints: {}, current: 2, default: 0 }];
    service.notify(); await panel._refreshing;
    assert.equal(view.renders, 1); assert.notEqual(view.search, typing);
    assert.equal(view.focused, view.search); assert.equal(view.search.value, "h");
    assert.deepEqual([view.search.selectionStart, view.search.selectionEnd], [1, 1]);
    assert.deepEqual(view.cells.map(cell => cell.textContent), ["7", "2"]);
    const rows = (await prepare()).rows; assert.deepEqual(rows.map(row => [row.id, row.hidden]), [["hp", false], ["mp", true]]);
  } finally { stored.personal.variables = []; await panel.close(); service.restore(); }
  assert.equal(service.active.size, 0);
});
test("dependency discovery is explicit about scope and limited to the current user's stores", () => {
  const stores = { world: emptyStore(), personal: emptyStore() };
  stores.personal.variables.push({ id: "use", name: "Use", kind: "list", list: { scope: "world", id: "list" } });
  stores.world.variables.push({ id: "use2", name: "Derived", expression: { op: "ref", scope: "world", id: "ref" } });
  assert.equal(dependencies(stores, "world", "lists", "list").length, 1); assert.equal(dependencies(stores, "world", "variables", "ref").length, 1);
  assert.equal(dependencies(stores, "personal", "lists", "list").length, 0);
});
test("typed editor accepts false/zero without truthiness coercion and recipes stay explicit", () => {
  assert.equal(typedValue("number", "0"), 0); assert.equal(typedValue("boolean", "false"), false); assert.throws(() => typedValue("number", ""));
  assert.deepEqual(typedValue("Actor", "", "userCharacter", "user"), { source: "userCharacter", userId: "user" });
  assert.deepEqual(typedValue("Token", "", "selectedToken"), { source: "selectedToken" });
});
