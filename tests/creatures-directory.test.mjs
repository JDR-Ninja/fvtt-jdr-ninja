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
globalThis.document = { createElement: tag => ({ tag, addEventListener() {} }) };
globalThis.ui = { actors: { rendered: true, renders: 0, render() { this.renders++; } }, notifications: { warn() {} } };
const { creatureClient } = await import("../scripts/creatures/api.js");
const { renderCreatureButtons, registerCreatureIntegration } = await import("../scripts/creatures/integration.js");
registerCreatureIntegration();

/** The Actors directory header as the render hook receives it (jQuery-free V14 HTML). */
function directory() {
  const children = [];
  const header = { append: (...items) => children.push(...items) };
  const root = { querySelector: selector => selector === ".header-actions" ? header : null,
    querySelectorAll: selector => children.filter(child => `.${child.className}` === selector)
      .map(child => ({ remove: () => children.splice(children.indexOf(child), 1) })) };
  return { html: [root], children };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let calls, answer;
function reset(current = gameFixture()) {
  globalThis.game = { ...current, i18n: { localize: key => strings[key] ?? key } };
  creatureClient.invalidate(); calls = 0; ui.actors.renders = 0;
  creatureClient.request = async () => { calls++; return answer(); };
}

test("generator shortcuts appear only after the server grants access, with short labels and no premium marker", async () => {
  reset(); answer = () => ({ ok: true, data: capabilityFixture() });
  const view = directory();
  renderCreatureButtons(null, view.html);
  assert.equal(view.children.length, 0, "unknown access shows nothing");
  await settle();
  assert.equal(calls, 1); assert.equal(ui.actors.renders, 1, "granted access redraws the directory");
  renderCreatureButtons(null, view.html); renderCreatureButtons(null, view.html);
  assert.equal(calls, 1, "known access is not checked again");
  assert.deepEqual(view.children.map(button => [button.className, button.textContent, button.title]), [
    ["jdr-ninja-creature-open", strings["JDRNINJA.creatures.monsterShortcut"], strings["JDRNINJA.creatures.monster"]],
    ["jdr-ninja-creature-open", strings["JDRNINJA.creatures.npcShortcut"], strings["JDRNINJA.creatures.npc"]]]);
  assert(view.children.every(button => !/premium/i.test(button.textContent)));
});

test("denied, failed or locally unavailable access shows no shortcut and never loops on checks", async () => {
  for (const [name, reply] of [["subscription", () => ({ ok: true, data: capabilityFixture(true, false) })],
    ["permission", () => ({ ok: true, data: capabilityFixture(false, true) })], ["network", () => ({ ok: false, reason: "network" })]]) {
    reset(); answer = reply;
    const view = directory();
    for (let i = 0; i < 3; i++) { renderCreatureButtons(null, view.html); await settle(); }
    assert.equal(view.children.length, 0, name); assert.equal(calls, 1, name); assert.equal(ui.actors.renders, 0, name);
  }
  for (const [name, change] of [["disabled", values => { values.creaturesEnabled = false; }], ["token", values => { values.accountToken = ""; }],
    ["player", (_values, current) => { current.user.isGM = false; }], ["system", (_values, current) => { current.system.version = "5.2.0"; }]]) {
    const current = gameFixture(); change(current.values, current); reset(current);
    answer = () => assert.fail("HTTP must not run");
    const view = directory();
    renderCreatureButtons(null, view.html); await settle();
    assert.equal(view.children.length, 0, name); assert.equal(calls, 0, name);
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
