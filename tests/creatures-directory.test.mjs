import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gameFixture, capabilityFixture } from "./creatures-fixture.mjs";

class Application { async render() { return this; } async close() { return this; } }
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } } };
const strings = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
const hooks = new Map();
globalThis.Hooks = { on: (name, fn) => hooks.set(name, fn) };
globalThis.HTMLElement = class {};
/** The few DOM members the shortcuts use: children, class selectors, append, remove, data attributes and click listeners. */
class Element extends globalThis.HTMLElement {
  nodes = []; dataset = {}; attributes = {}; listeners = {}; parent = null; className = "";
  constructor(tag) { super(); this.tag = tag; }
  get children() { return this.nodes.filter(node => node instanceof Element); }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.nodes.map(node => typeof node === "string" ? node : node.textContent).join(""); }
  get title() { return this.attributes.title; }
  append(...items) { for (const item of items) { if (item instanceof Element) { item.remove(); item.parent = this; } this.nodes.push(item); } }
  remove() { this.parent?.nodes.splice(this.parent.nodes.indexOf(this), 1); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  hasClass(name) { return this.className.split(/\s+/).includes(name); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.hasClass(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.ui = { actors: { rendered: true, renders: 0, render() { this.renders++; } }, notifications: { warn() {} } };
const { creatureClient } = await import("../scripts/creatures/api.js");
const { renderCreatureButtons, registerCreatureIntegration } = await import("../scripts/creatures/integration.js");
const { MonsterGeneratorPanel, NpcGeneratorPanel } = await import("../scripts/creatures/panel.js");
registerCreatureIntegration();

const child = (parent, className, tag = "div") => { const element = new Element(tag); element.className = className; parent.append(element); return element; };
/** The Actors directory as the render hook receives it (jQuery-free V14 HTML), by default with Foundry's header actions. */
function directory({ header = true, footer = false } = {}) {
  const root = child(new Element("body"), "directory");
  const actions = header ? child(root, "header-actions") : null;
  if (actions) child(actions, "create-entry", "button");
  if (footer) child(root, "directory-footer");
  return { html: [root], root, actions, buttons: () => root.querySelectorAll(".jdr-ninja-creature-open"), rows: () => root.querySelectorAll(".jn-directory-actions") };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let calls, answer;
function reset(current = gameFixture()) {
  globalThis.game = { ...current, i18n: { localize: key => strings[key] ?? key } };
  creatureClient.invalidate(); calls = 0; ui.actors.renders = 0;
  creatureClient.request = async () => { calls++; return answer(); };
}
/** Another integration (Atlas) creating the shared row with its own shortcut before ours renders. */
function atlasShortcut(parent) {
  const row = parent.querySelector(".jn-directory-actions") ?? child(parent, "jn-directory-actions");
  child(row, "jdr-ninja-atlas-open jn-directory-button", "button");
  return row;
}

test("generator shortcuts appear only after the server grants access, with short labels and no premium marker", async () => {
  reset(); answer = () => ({ ok: true, data: capabilityFixture() });
  const view = directory();
  renderCreatureButtons(null, view.html);
  assert.equal(view.buttons().length, 0, "unknown access shows nothing");
  assert.equal(view.rows().length, 0, "and no empty row");
  await settle();
  assert.equal(calls, 1); assert.equal(ui.actors.renders, 1, "granted access redraws the directory");
  renderCreatureButtons(null, view.html); renderCreatureButtons(null, view.html);
  assert.equal(calls, 1, "known access is not checked again");
  const buttons = view.buttons();
  assert.deepEqual(buttons.map(button => [button.className, button.textContent, button.dataset.tooltip]), [
    ["jdr-ninja-creature-open jn-directory-button", strings["JDRNINJA.creatures.monsterShortcut"], strings["JDRNINJA.creatures.monster"]],
    ["jdr-ninja-creature-open jn-directory-button", strings["JDRNINJA.creatures.npcShortcut"], strings["JDRNINJA.creatures.npc"]]]);
  assert(buttons.every(button => !/premium/i.test(button.textContent)));
  assert(buttons.every(button => button.type === "button" && button.title === undefined), "the tooltip replaces the title attribute");
  assert.deepEqual(buttons.map(button => [button.children[0].tag, button.children[0].className, button.children[0].attributes["aria-hidden"]]), [
    ["i", "fa-solid fa-dragon", "true"], ["i", "fa-solid fa-user", "true"]], "an icon each, hidden from assistive technology");
  // Both live in one compact row, below Foundry's own buttons and inside the header actions.
  assert.equal(view.rows().length, 1); assert.equal(view.rows()[0].parent, view.actions);
  assert.equal(view.rows()[0].children.length, 2); assert(buttons.every(button => button.parent === view.rows()[0]));
  assert.equal(view.actions.nodes.indexOf(view.rows()[0]), 1, "after Foundry's own button");
  // A click opens the matching window.
  buttons[0].listeners.click(); buttons[1].listeners.click();
  assert(MonsterGeneratorPanel.instance); assert(NpcGeneratorPanel.instance);
  assert.notEqual(MonsterGeneratorPanel.instance, NpcGeneratorPanel.instance);
  await MonsterGeneratorPanel.instance.close(); await NpcGeneratorPanel.instance.close();
});

test("the shortcuts reuse the shared row another integration created and never add a second one, in either order", async () => {
  reset(); answer = () => ({ ok: true, data: capabilityFixture() });
  renderCreatureButtons(null, directory().html); await settle();
  // Atlas first: our buttons join its row.
  const atlasFirst = directory(); atlasShortcut(atlasFirst.actions);
  renderCreatureButtons(null, atlasFirst.html);
  assert.equal(atlasFirst.rows().length, 1);
  assert.deepEqual(atlasFirst.rows()[0].children.map(button => button.className),
    ["jdr-ninja-atlas-open jn-directory-button", "jdr-ninja-creature-open jn-directory-button", "jdr-ninja-creature-open jn-directory-button"]);
  // Ours first: Atlas finds the row and joins it.
  const ours = directory();
  renderCreatureButtons(null, ours.html); atlasShortcut(ours.actions);
  assert.equal(ours.rows().length, 1); assert.equal(ours.rows()[0].children.length, 3);
  assert(ours.rows()[0].children.at(-1).hasClass("jdr-ninja-atlas-open"));
  // Rendering again never duplicates our buttons or the row.
  for (let i = 0; i < 3; i++) renderCreatureButtons(null, ours.html);
  assert.equal(ours.rows().length, 1); assert.equal(ours.buttons().length, 2);
});

test("a new render replaces the shortcuts; losing access removes them and an empty row, never another integration's button", async () => {
  reset(); answer = () => ({ ok: true, data: capabilityFixture() });
  renderCreatureButtons(null, directory().html); await settle();
  const alone = directory();
  renderCreatureButtons(null, alone.html); assert.equal(alone.buttons().length, 2);
  game.values.creaturesEnabled = false;
  renderCreatureButtons(null, alone.html);
  assert.equal(alone.buttons().length, 0); assert.equal(alone.rows().length, 0, "our row leaves with our buttons");
  game.values.creaturesEnabled = true;
  const shared = directory(); atlasShortcut(shared.actions);
  renderCreatureButtons(null, shared.html); assert.equal(shared.buttons().length, 2);
  game.values.creaturesEnabled = false;
  renderCreatureButtons(null, shared.html);
  assert.equal(shared.buttons().length, 0); assert.equal(shared.rows().length, 1, "the row keeps the other integration");
  assert.deepEqual(shared.rows()[0].children.map(button => button.className), ["jdr-ninja-atlas-open jn-directory-button"]);
});

test("without header actions the shortcuts fall back to the directory footer, then to the root, in the same kind of row", async () => {
  reset(); answer = () => ({ ok: true, data: capabilityFixture() });
  renderCreatureButtons(null, directory().html); await settle();
  const footer = directory({ header: false, footer: true });
  renderCreatureButtons(null, footer.html);
  assert.equal(footer.rows().length, 1); assert(footer.rows()[0].parent.hasClass("directory-footer")); assert.equal(footer.buttons().length, 2);
  const bare = directory({ header: false });
  renderCreatureButtons(null, bare.html); renderCreatureButtons(null, bare.html);
  assert.equal(bare.rows().length, 1); assert.equal(bare.rows()[0].parent, bare.root); assert.equal(bare.buttons().length, 2);
  // Both the jQuery-wrapped and the plain element forms of the hook argument work.
  const plain = directory(); renderCreatureButtons(null, plain.root); assert.equal(plain.buttons().length, 2);
});

test("denied, failed or locally unavailable access shows no shortcut and never loops on checks", async () => {
  for (const [name, reply] of [["subscription", () => ({ ok: true, data: capabilityFixture(true, false) })],
    ["permission", () => ({ ok: true, data: capabilityFixture(false, true) })], ["network", () => ({ ok: false, reason: "network" })]]) {
    reset(); answer = reply;
    const view = directory();
    for (let i = 0; i < 3; i++) { renderCreatureButtons(null, view.html); await settle(); }
    assert.equal(view.buttons().length, 0, name); assert.equal(view.rows().length, 0, name);
    assert.equal(calls, 1, name); assert.equal(ui.actors.renders, 0, name);
  }
  for (const [name, change] of [["disabled", values => { values.creaturesEnabled = false; }], ["token", values => { values.accountToken = ""; }],
    ["player", (_values, current) => { current.user.isGM = false; }], ["system", (_values, current) => { current.system.version = "5.2.0"; }]]) {
    const current = gameFixture(); change(current.values, current); reset(current);
    answer = () => assert.fail("HTTP must not run");
    const view = directory();
    renderCreatureButtons(null, view.html); await settle();
    assert.equal(view.buttons().length, 0, name); assert.equal(view.rows().length, 0, name); assert.equal(calls, 0, name);
  }
});

test("only a role change resets generator access; other user updates keep the shortcuts", async () => {
  reset(); answer = () => ({ ok: true, data: capabilityFixture() });
  renderCreatureButtons(null, directory().html); await settle();
  const revision = creatureClient.revision, update = hooks.get("updateUser");
  update({ id: game.user.id }, { hotbar: { 1: "macro" } });
  assert.equal(creatureClient.revision, revision); assert.equal(creatureClient.access.allowed, true);
  update({ id: game.user.id }, { role: 1 });
  assert.equal(creatureClient.revision, revision + 1); assert.equal(creatureClient.access, null);
});
