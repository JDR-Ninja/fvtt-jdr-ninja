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
const { VariablePanel, VT, variableError, dependencies, typedValue, PILLS } = await import("../scripts/variables/panel.js");
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
test("dependency discovery counts a variable used as a part of a document path", () => {
  const stores = { world: emptyStore(), personal: emptyStore() };
  const hero = { op: "ref", scope: "world", id: "hero" }, ability = { op: "ref", scope: "personal", id: "ability" };
  const field = { op: "field", args: [hero], path: ["system", "abilities", ability, "value"] };
  stores.world.variables.push({ id: "plain", name: "Plain", expression: { op: "ref", scope: "world", id: "other" } });
  stores.world.variables.push({ id: "wrapped", name: "Wrapped", expression: { op: "add", args: [{ op: "literal", type: "number", value: 1 }, field] } });
  assert.deepEqual(dependencies(stores, "personal", "variables", "ability"), [`${VT("world")}: Wrapped`]);
  assert.deepEqual(dependencies(stores, "world", "variables", "hero"), [`${VT("world")}: Wrapped`]);
  assert.deepEqual(dependencies(stores, "world", "variables", "other"), [`${VT("world")}: Plain`]);
  assert.deepEqual(dependencies(stores, "world", "variables", "ability"), [], "a reference is matched by scope and id");
  assert.deepEqual(dependencies(stores, "personal", "lists", "ability"), [], "a path part is never a list dependency");
});

const numberVariable = (id, name) => ({ id, name, type: "number", kind: "stored", constraints: {}, current: 1, default: 1 });
const setVariables = (world, personal) => { stored.world.variables = world; stored.personal.variables = personal; };
/** A panel editing a new computed variable whose expression text is `text`, in the given scope. */
function expressionEditor(scope, text) {
  const panel = new VariablePanel(); panel.scope = scope; panel.stores = variableService.stores();
  panel.draft = { id: "calc", name: "Calc", type: "number", kind: "computed", constraints: {}, expression: { op: "literal", type: "number", value: 0 } };
  panel.expressionText = text; panel.baseRevision = 0; return panel;
}
const failsWith = code => error => error.code === code;
test("variables are written and listed by name alone, with no scope or identifier", async () => {
  const level = { op: "ref", scope: "world", id: "w1" };
  const computed = (id, name, expression) => ({ id, name, type: "number", kind: "computed", constraints: {}, expression });
  setVariables([numberVariable("w1", "Level")], [numberVariable("p1", "Mine"),
    computed("c1", "Alias", level), computed("c2", "Double", { op: "multiply", args: [level, { op: "literal", type: "number", value: 2 }] })]);
  try {
    const panel = new VariablePanel(); panel.stores = variableService.stores();
    assert.equal(panel.label("world", "w1"), "Level"); assert.equal(panel.label("personal", "p1"), "Mine");
    assert.equal(panel.label("world", "gone"), "gone", "the id only stands in for a variable that no longer exists");
    assert.equal(panel.label("personal", "w1"), "w1", "a reference is looked up in its own scope");
    // A stored reference reappears as the name the user typed.
    panel.scope = "personal"; panel.baseRevision = 0;
    const shown = async id => { panel.draft = copy(stored.personal.variables.find(v => v.id === id)); return (await panel._prepareContext()).editor.expressionText; };
    const alias = await shown("c1"); assert.equal(alias, "@{Level}"); assert(!/World|Personal|\[|w1/.test(alias));
    assert.equal(await shown("c2"), "@{Level} * 2");
  } finally { setVariables([], []); }
});
test("an expression name resolves to exactly one variable, trimmed and compared exactly", () => {
  setVariables([numberVariable("w1", "Level "), numberVariable("w2", "Tier")], [numberVariable("p1", "Mine")]);
  try {
    const ref = (scope, id) => ({ op: "ref", scope, id }), literal = value => ({ op: "literal", type: "number", value });
    assert.deepEqual(expressionEditor("personal", "@{Level} * 2").compiledDraft().expression, { op: "multiply", args: [ref("world", "w1"), literal(2)] });
    assert.deepEqual(expressionEditor("personal", "@{ Level  } + @{Mine}").compiledDraft().expression, { op: "add", args: [ref("world", "w1"), ref("personal", "p1")] });
    for (const text of ["@{Absent} + 1", "@{level} + 1", "@{World: Level} + 1", "@{w1} + 1"]) {
      assert.throws(() => expressionEditor("personal", text).compiledDraft(), failsWith("missingVariable"), text);
    }
  } finally { setVariables([], []); }
});
test("two variables sharing a name make the reference ambiguous, in the scopes the editor can read", () => {
  setVariables([numberVariable("w1", "Level"), numberVariable("w2", "Tier"), numberVariable("w3", "Tier")], [numberVariable("p1", "Level")]);
  try {
    // A personal variable hides nothing: the world one with the same name is a second match for a personal editor.
    assert.throws(() => expressionEditor("personal", "@{Level} + 1").compiledDraft(), failsWith("duplicateName"));
    assert.throws(() => expressionEditor("world", "@{Tier} + 1").compiledDraft(), failsWith("duplicateName"));
    assert.throws(() => expressionEditor("personal", "@{Tier} + 1").compiledDraft(), failsWith("duplicateName"));
    // The world editor never sees the personal "Level", so that name is not ambiguous there.
    assert.deepEqual(expressionEditor("world", "@{Level} + 1").compiledDraft().expression.args[0], { op: "ref", scope: "world", id: "w1" });
  } finally { setVariables([], []); }
});
test("the world editor cannot resolve a personal variable", () => {
  setVariables([numberVariable("w1", "Level")], [numberVariable("p1", "Mine")]);
  try {
    assert.throws(() => expressionEditor("world", "@{Mine} + 1").compiledDraft(), failsWith("missingVariable"));
    assert.deepEqual(expressionEditor("personal", "@{Mine} + 1").compiledDraft().expression.args[0], { op: "ref", scope: "personal", id: "p1" });
    assert.deepEqual(expressionEditor("world", "@{Level} + 1").compiledDraft().expression.args[0], { op: "ref", scope: "world", id: "w1" });
  } finally { setVariables([], []); }
});
test("the insert list groups names by scope, omits empty groups and the edited variable, and inserts @{Name}", async () => {
  setVariables([numberVariable("w1", "Level")], [numberVariable("p1", "Mine"), numberVariable("calc", "Calc")]);
  try {
    const personal = expressionEditor("personal", ""); personal.draft.id = "calc";
    const groups = (await personal._prepareContext()).editor.referenceGroups;
    assert.deepEqual(groups.map(group => [group.label, group.options.map(o => [o.value, o.label])]),
      [[VT("world"), [["world:w1", "Level"]]], [VT("personal"), [["personal:p1", "Mine"]]]]);
    const world = expressionEditor("world", ""); world.draft.id = "calc";
    assert.deepEqual((await world._prepareContext()).editor.referenceGroups.map(group => group.label), [VT("world")]);
    setVariables([], [numberVariable("p1", "Mine")]);
    assert.deepEqual((await expressionEditor("personal", "")._prepareContext()).editor.referenceGroups.map(group => group.label), [VT("personal")]);

    setVariables([numberVariable("w1", "Level")], []);
    const panel = expressionEditor("personal", "1 + "); panel.stores = variableService.stores();
    const input = { value: "1 + ", selectionStart: 4, selectionEnd: 4, focus() {},
      setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); } };
    panel.element = { querySelector: selector => selector === '[name="reference"]' ? { value: "world:w1" } : selector === '[data-field="expression"]' ? input : null, querySelectorAll: () => [] };
    await panel._action("insert", {});
    assert.equal(input.value, "1 + @{Level}"); assert.equal(panel.expressionText, "1 + @{Level}"); assert(panel.dirty);
    assert.equal(panel.compiledDraft().expression.args[1].id, "w1");
  } finally { setVariables([], []); }
});
test("the variables template renders the grouped insert list and the path hint in all five locales", async () => {
  const template = Handlebars.compile(await readFile(new URL("../templates/variables.hbs", import.meta.url), "utf8"));
  setVariables([numberVariable("w1", "Level")], [numberVariable("p1", "<b>Mine</b>")]);
  const panel = expressionEditor("personal", "@{Level} * 2"); const previous = game.i18n.localize;
  try {
    for (const lang of ["fr", "en", "de", "es", "it"]) {
      const locale = JSON.parse(await readFile(new URL(`../lang/${lang}.json`, import.meta.url), "utf8"));
      game.i18n.localize = key => locale[key] ?? key; Handlebars.registerHelper("localize", key => locale[key] ?? key);
      const html = template(await panel._prepareContext());
      assert(!html.includes("JDRNINJA."), lang);
      const escaped = key => Handlebars.escapeExpression(locale[key]);
      assert(html.includes(`<optgroup label="${escaped("JDRNINJA.variables.world")}"><option value="world:w1">Level</option></optgroup>`), lang);
      assert(html.includes(`<optgroup label="${escaped("JDRNINJA.variables.personal")}"><option value="personal:p1">&lt;b&gt;Mine&lt;/b&gt;</option></optgroup>`), lang);
      assert(html.indexOf("<optgroup") < html.indexOf("data-action=\"insert\"") && html.includes("@{Level} * 2"), lang);
      const hint = locale["JDRNINJA.variables.expressionHint"];
      assert(html.includes(escaped("JDRNINJA.variables.expressionHint")), lang); assert(hint.includes("@{") && hint.includes(".system.attributes.inspiration"), lang);
      assert(!/documentName|documentUuid/.test(hint), lang);
      for (const name of ["min", "max", "clamp", "round", "floor", "ceil", "abs", "if", "concat", "true", "false"]) assert(hint.includes(name), `${lang} ${name}`);
      const duplicate = locale["JDRNINJA.variables.error.duplicateName"];
      assert(duplicate, lang); assert.equal(variableError({ code: "duplicateName" }), duplicate, lang);
    }
  } finally { game.i18n.localize = previous; setVariables([], []); }
});
test("typed editor accepts false/zero without truthiness coercion and recipes stay explicit", () => {
  assert.equal(typedValue("number", "0"), 0); assert.equal(typedValue("boolean", "false"), false); assert.throws(() => typedValue("number", ""));
  assert.deepEqual(typedValue("Actor", "", "userCharacter", "user"), { source: "userCharacter", userId: "user" });
  assert.deepEqual(typedValue("Token", "", "selectedToken"), { source: "selectedToken" });
});

// Window structure: native V14 form groups, segmented tabs, state pills and a fixed footer, with every hook the code, the tools and the screenshots use.
const PILL = /<span class="jn-pill jn-pill--(\w+)"><i class="fa-solid ([\w-]+)" aria-hidden="true"><\/i>([^<]*)<\/span>/g;
const countOf = (html, pattern) => (html.match(pattern) ?? []).length;
const actions = html => new Set([...html.matchAll(/data-action="(\w+)"/g)].map(match => match[1]));
async function renderEnglish(template, context) {
  const locale = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
  game.i18n.localize = key => locale[key] ?? key; Handlebars.registerHelper("localize", key => locale[key] ?? key);
  return { html: Handlebars.compile(template)(context), locale };
}
const heroInspiration = { id: "hero-inspiration", name: "Hero inspiration", type: "boolean", kind: "computed", constraints: {}, expression: { op: "literal", type: "boolean", value: true } };

test("the variables window uses tabs, a footer with one primary action and no fieldset, and keeps its hooks", async () => {
  const template = await readFile(new URL("../templates/variables.hbs", import.meta.url), "utf8");
  setVariables([heroInspiration, numberVariable("ritual", "Ritual countdown")], []);
  try {
    const panel = new VariablePanel(); panel.scope = "world"; panel.draft = copy(heroInspiration); panel.baseRevision = 0;
    const { html } = await renderEnglish(template, await panel._prepareContext());
    assert(!/<fieldset|<legend/.test(html), "sections replace fieldsets");
    // Scope and list tabs are real tabs: a tab list, tab roles, aria-selected and no pressed state on a tab.
    assert.equal(countOf(html, /role="tablist"/g), 2); assert.equal(countOf(html, /role="tab"/g), 4);
    assert.equal(countOf(html, /class="jn-tabs" role="tablist"/g), 2);
    assert(html.includes('role="tab" data-action="scope" data-value="world" aria-selected="true"'));
    assert(html.includes('role="tab" data-action="scope" data-value="personal" aria-selected="false"'));
    assert(html.includes('role="tab" data-action="switchTab" data-value="variables" aria-selected="true"'));
    assert(!/role="tab"[^>]*aria-pressed/.test(html));
    // The selected record keeps aria-pressed and the value cells the live refresh patches in place.
    assert(/data-action="select" data-id="hero-inspiration" data-row-name="Hero inspiration" aria-pressed="true"/.test(html));
    assert(/data-action="select" data-id="ritual" data-row-name="Ritual countdown" aria-pressed="false"/.test(html));
    assert(html.includes('data-state-id="hero-inspiration"') && html.includes('data-state-id="ritual"'));
    // The window actions live in the footer: one primary button, the destructive one last and in the error colour.
    const footer = html.slice(html.indexOf('<footer class="form-footer jn-footer">')); assert(footer.includes("</footer>"));
    assert.equal(countOf(html, /class="bright"/g), 1); assert(footer.includes('class="bright" data-action="save"'));
    assert(footer.includes('class="jn-danger" data-action="remove"'));
    const order = ["save", "preview", "duplicate", "reload", "remove"].map(name => footer.indexOf(`data-action="${name}"`));
    assert(order.every(position => position > 0) && order.every((position, index) => index === 0 || position > order[index - 1]), "footer order");
    assert(!html.slice(0, html.indexOf("<footer")).includes('data-action="save"') && !html.slice(0, html.indexOf("<footer")).includes('data-action="remove"'));
    for (const hook of ["scope", "switchTab", "select", "create", "save", "preview", "duplicate", "reload", "remove", "insert", "controller"]) assert(actions(html).has(hook), hook);
    for (const hook of ['data-field="name"', 'data-field="type"', 'data-field="kind"', 'data-field="expression"', 'name="reference"', 'name="search"', 'name="controller"']) assert(html.includes(hook), hook);
    assert(html.includes('class="jn-variable-columns"')); assert(html.includes("data-stale") && html.includes('data-message role="status"'));
    // Every field keeps an associated label.
    for (const id of ["jn-variable-name", "jn-variable-type", "jn-variable-kind", "jn-variable-expression"]) assert(html.includes(`for="${id}"`) && html.includes(`id="${id}"`), id);
    // A new definition has nothing to delete, and a window with no draft has no footer.
    panel.draft = { id: "new", name: "", type: "number", kind: "stored", current: 0, default: 0, constraints: {} };
    const created = (await renderEnglish(template, await panel._prepareContext())).html;
    assert(!created.includes('data-action="remove"')); assert.equal(countOf(created, /class="bright"/g), 1);
    panel.draft = null;
    const idle = (await renderEnglish(template, await panel._prepareContext())).html;
    assert(!idle.includes("<footer") && !idle.includes('class="bright"')); assert(idle.includes("JDRNINJA") === false);
  } finally { setVariables([], []); }
});
test("the world controller and the write state show as pills whose colour, icon and text agree", async () => {
  const template = await readFile(new URL("../templates/variables.hbs", import.meta.url), "utf8");
  assert.deepEqual(Object.keys(PILLS).sort(), ["offline", "online", "readOnly", "writable"]);
  assert.deepEqual([PILLS.online.level, PILLS.offline.level, PILLS.writable.level, PILLS.readOnly.level], ["success", "warning", "success", "neutral"]);
  assert.equal(new Set(Object.values(PILLS).map(pill => pill.icon)).size, 4, "each state has its own icon");
  const panel = new VariablePanel(); panel.scope = "world";
  const pills = async () => { const { html, locale } = await renderEnglish(template, await panel._prepareContext());
    return { locale, found: [...html.matchAll(PILL)].map(([, level, icon, text]) => ({ level, icon, text })) }; };
  try {
    let { locale, found } = await pills();
    assert.deepEqual(found, [{ level: "success", icon: PILLS.writable.icon, text: locale["JDRNINJA.variables.writable"] },
      { level: "success", icon: PILLS.online.icon, text: locale["JDRNINJA.variables.online"] }]);
    // The controller goes offline: the window turns read-only and says so with a warning and a neutral pill.
    user.active = false;
    ({ found } = await pills());
    assert.deepEqual(found, [{ level: "neutral", icon: PILLS.readOnly.icon, text: locale["JDRNINJA.variables.readOnly"] },
      { level: "warning", icon: PILLS.offline.icon, text: locale["JDRNINJA.variables.offline"] }]);
    const context = await panel._prepareContext(); assert.equal(context.controllerPill, PILLS.offline); assert.equal(context.statusPill, PILLS.readOnly);
    // With no assigned GM the controller reads as offline too.
    stored.world.controller = "gone";
    assert.equal((await panel._prepareContext()).controllerPill, PILLS.offline);
  } finally { user.active = true; stored.world.controller = "gm"; }
});
test("a read-only editor disables its controls and offers no write action", async () => {
  const template = await readFile(new URL("../templates/variables.hbs", import.meta.url), "utf8");
  const list = { id: "l", name: "List", type: "number", entries: [{ id: "a", label: "A", value: 1 }, { id: "b", label: "B", value: 2 }] };
  stored.world.lists = [list]; setVariables([numberVariable("w1", "Level")], []); user.active = false;
  try {
    const panel = new VariablePanel(); panel.scope = "world"; panel.baseRevision = 0;
    const open = async (collection, record) => { panel.collection = collection; panel.draft = copy(record); return (await renderEnglish(template, await panel._prepareContext())).html; };
    const variable = await open("variables", stored.world.variables[0]);
    assert(/<input id="jn-variable-name"[^>]*disabled/.test(variable)); assert(/<select id="jn-variable-kind"[^>]*disabled/.test(variable));
    assert(/<input id="jn-value-default-value"[^>]*disabled/.test(variable)); assert(/name="operation"[^>]*disabled/.test(variable) && /data-action="mutate" disabled/.test(variable));
    for (const hidden of ["save", "duplicate", "remove", "create"]) assert(!actions(variable).has(hidden), hidden);
    assert(actions(variable).has("preview") && actions(variable).has("reload")); assert.equal(countOf(variable, /class="bright"/g), 0);
    const entries = await open("lists", list);
    assert(/data-action="entryAdd" disabled/.test(entries)); assert(/data-action="entryRemove"[^>]*disabled/.test(entries));
    assert(/data-action="entryUp" data-id="a"[^>]*disabled/.test(entries) && /data-action="entryDown" data-id="b"[^>]*disabled/.test(entries));
  } finally { user.active = true; stored.world.lists = []; setVariables([], []); }
});
test("list entries and value cards keep their value hooks, labels and move controls", async () => {
  const template = await readFile(new URL("../templates/variables.hbs", import.meta.url), "utf8");
  const list = { id: "l", name: "List", type: "number", entries: [{ id: "a", label: "A", value: 1 }, { id: "b", label: "B", value: 2 }] };
  stored.personal.lists = [list];
  try {
    const panel = new VariablePanel(); panel.collection = "lists"; panel.draft = copy(list); panel.baseRevision = 0;
    const { html, locale } = await renderEnglish(template, await panel._prepareContext());
    assert.equal(countOf(html, /data-value-key="/g), 2); assert(html.includes('data-value-key="a"') && html.includes('data-value-key="b"'));
    for (const key of ["a", "b"]) for (const field of ["label", "value"]) assert(html.includes(`id="jn-value-${key}-${field}"`) && html.includes(`for="jn-value-${key}-${field}"`) && html.includes(`data-value-field="${field}"`));
    // Icon-only controls carry their name and tooltip; the first entry cannot move up, the last cannot move down.
    for (const [action, key] of [["entryUp", "up"], ["entryDown", "down"], ["entryRemove", "remove"]]) {
      const text = Handlebars.escapeExpression(locale[`JDRNINJA.variables.${key}`]);
      assert.equal(countOf(html, new RegExp(`data-action="${action}" data-id="[ab]" aria-label="${text}" data-tooltip="${text}"`, "g")), 2, action);
    }
    assert(/data-action="entryUp" data-id="a"[^>]*disabled/.test(html) && !/data-action="entryUp" data-id="b"[^>]*disabled/.test(html));
    assert(/data-action="entryDown" data-id="b"[^>]*disabled/.test(html) && !/data-action="entryDown" data-id="a"[^>]*disabled/.test(html));
    assert(/class="jn-icon-button jn-danger" data-action="entryRemove"/.test(html));
    assert(actions(html).has("entryAdd") && html.indexOf('data-value-key="b"') < html.indexOf('data-action="entryAdd"'));
    assert(!/<fieldset|<legend/.test(html));
  } finally { stored.personal.lists = []; }
});
test("the macro window shows its arguments as a table with a footer, and keeps every hook", async () => {
  const template = await readFile(new URL("../templates/macro-arguments.hbs", import.meta.url), "utf8");
  const declaration = { version: 1, arguments: [{ name: "target", type: "Token", required: true }, { name: "amount", type: "number", required: true, default: 5 },
    { name: "damageType", type: "text", required: false, default: "fire" }] };
  const macro = { id: "m", name: "Deal damage", type: "script", canExecute: true, testUserPermission: () => true, getFlag: () => declaration };
  const previous = game.macros; game.macros = { contents: [macro], get: id => id === "m" ? macro : undefined };
  try {
    const panel = new MacroArgumentsPanel(); panel.macroId = "m"; panel.draft = copy(declaration); panel.base = JSON.stringify(declaration);
    const { html, locale } = await renderEnglish(template, await panel._prepareContext());
    assert(!/<fieldset|<legend/.test(html), "no fieldset per argument");
    assert(html.includes('<table class="jn-arguments">')); assert.equal(countOf(html, /<th scope="col"/g), 5);
    assert.equal(countOf(html, /<tr data-argument="\d">/g), 3); for (const index of [0, 1, 2]) assert(html.includes(`<tr data-argument="${index}">`));
    for (const field of ["name", "type", "required", "hasDefault", "default"]) assert.equal(countOf(html, new RegExp(`data-arg-field="${field}"`, "g")), 3, field);
    assert(html.includes('value="fire"') && html.includes('value="5"'));
    // Removing is an icon button in the error colour, named and with a tooltip, one per row, keeping the index it removes.
    const remove = Handlebars.escapeExpression(locale["JDRNINJA.variables.remove"]);
    for (const index of [0, 1, 2]) assert(html.includes(`class="jn-icon-button jn-danger" data-action="remove" data-index="${index}" aria-label="${remove}" data-tooltip="${remove}"`), `remove ${index}`);
    // Every table control is named, since the column headers are not labels.
    assert.equal(countOf(html, /<input type="text" maxlength="64" data-arg-field="name"[^>]*aria-label="[^"]+"/g), 3);
    assert.equal(countOf(html, /<select data-arg-field="type" aria-label="[^"]+"/g), 3);
    // The picker sits in a toolbar, "Add argument" under the table, the window actions in the footer.
    assert(/<div class="jn-toolbar jn-macro-picker">\s*<select name="macro"/.test(html) && html.includes('data-action="load"'));
    const footerAt = html.indexOf('<footer class="form-footer jn-footer">'); assert(footerAt > 0);
    assert(html.indexOf("</table>") < html.indexOf('data-action="add"') && html.indexOf('data-action="add"') < footerAt);
    const footer = html.slice(footerAt);
    assert.equal(countOf(html, /class="bright"/g), 1); assert(footer.includes('class="bright" data-action="save"'));
    assert(footer.includes('class="jn-danger" data-action="disable"')); assert(footer.indexOf('data-action="save"') < footer.indexOf('data-action="disable"'));
    assert(html.includes(`<pre class="jn-code"><code>${Handlebars.escapeExpression("const args = scope.jdrNinja.arguments;")}`));
    assert(html.includes('data-argument') && html.includes('role="status"'));
    // Without an argument there is no table, only the add button; without a macro there is nothing to save.
    panel.draft = { version: 1, arguments: [] };
    const bare = (await renderEnglish(template, await panel._prepareContext())).html;
    assert(!bare.includes("<table") && actions(bare).has("add") && actions(bare).has("save"));
    panel.macroId = "";
    const idle = (await renderEnglish(template, await panel._prepareContext())).html;
    assert(!idle.includes("<footer") && !idle.includes("<table") && !actions(idle).has("add") && actions(idle).has("load"));
  } finally { game.macros = previous; }
});
test("the window strings exist in every language and the old argument legend is gone", async () => {
  for (const lang of ["fr", "en", "de", "es", "it"]) {
    const locale = JSON.parse(await readFile(new URL(`../lang/${lang}.json`, import.meta.url), "utf8"));
    for (const key of ["values", "arguments", "online", "offline", "writable", "readOnly", "up", "down", "remove", "openDocument"]) assert(locale[`JDRNINJA.variables.${key}`], `${lang} ${key}`);
    assert(!("JDRNINJA.variables.argument" in locale), lang);
  }
});
