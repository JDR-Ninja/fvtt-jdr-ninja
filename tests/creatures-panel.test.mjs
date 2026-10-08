import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { gameFixture, catalogFixture, resultFixture, capabilityFixture, requestId, identity } from "./creatures-fixture.mjs";
import { creatureClient } from "../scripts/creatures/api.js";

class Application {
  rendered = false;
  renders = 0;
  fronted = 0;
  async render() { this.rendered = true; this.renders++; this.context = await this._prepareContext(); return this; }
  async close() { this.rendered = false; return this; }
  bringToFront() { this.fronted++; }
}
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } } };
globalThis.game = { ...gameFixture(), i18n: { localize: key => key, format: key => key }, folders: { contents: [] } };
globalThis.ui = { notifications: { warn() {} } };
const { MonsterGeneratorPanel, NpcGeneratorPanel } = await import("../scripts/creatures/panel.js");

test("the two native panels cover all fields, NPC advanced options remain visible and no premium marker shows", async () => {
  const template = await readFile(new URL("../templates/creatures.hbs", import.meta.url), "utf8");
  for (const locale of ["en", "fr", "es", "de", "it"]) {
    const strings = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
    game.i18n = { localize: key => strings[key] ?? key, format: (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), strings[key] ?? key) };
    const renderer = Handlebars.create(); renderer.registerHelper("localize", key => game.i18n.localize(key));
    for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
      const panel = new Class(); panel._initialized = true;
      panel._catalog = catalogFixture(panel.kind); panel._options = { ...panel._catalog.defaults };
      panel._preview = resultFixture({ requestId, catalogVersion: panel._catalog.catalogVersion, options: panel._options }, panel.kind);
      panel._name = '<img src=x onerror="unsafe()">';
      creatureClient.access = { allowed: true, entitled: true }; creatureClient.cooldownUntil = 0;
      const context = await panel._prepareContext(), html = renderer.compile(template)(context);
      assert(!html.includes("JDRNINJA.")); assert(!html.includes("fa-gem"));
      assert(!html.includes('data-jdr-subscriptions='));
      assert(html.includes('data-compatibility="compatible"'));
      assert(html.includes(Handlebars.escapeExpression(strings['JDRNINJA.creatures.compatibility.compatible'])));
      assert(!html.includes('<img')); assert(html.includes("&lt;img"));
      assert(html.includes('data-action="create"')); assert(html.includes('name="challengeRating"'));
      assert(!JSON.stringify(context).includes("fixture-token"));
      if (panel.kind === "npc") {
        assert(html.includes(strings["JDRNINJA.creatures.advanced"]));
        assert.equal(context.primaryFields.length, 4); assert.equal(context.advancedFields.length, 6);
        assert(html.includes('name="includeSecret"')); assert(!html.includes('name="language"'));
      } else { assert.equal(context.primaryFields.length, 7); assert(!context.hasAdvanced); }
      for (const action of html.matchAll(/data-action="(\w+)"/g)) assert.equal(typeof Class.DEFAULT_OPTIONS.actions[action[1]], "function");
    }
  }
});

test("both generators offer the subscription link only after a subscription denial, never as a standing button", async () => {
  const savedGame = game, savedAccess = creatureClient.access;
  const strings = JSON.parse(await readFile(new URL('../lang/fr.json', import.meta.url), 'utf8'));
  const renderer = Handlebars.create(); renderer.registerHelper('localize', key => strings[key] ?? key);
  const render = renderer.compile(await readFile(new URL('../templates/creatures.hbs', import.meta.url), 'utf8'));
  try {
    globalThis.game = { ...gameFixture(), folders: { contents: [] }, i18n: savedGame.i18n };
    for (const [token, access, error, expected] of [
      ['', null, '', false], ['fixture-token', null, '', false],
      ['fixture-token', { entitled: false, reason: 'tierRequired' }, '', true],
      ['fixture-token', null, 'tierRequired', true],
      ['fixture-token', { entitled: true, allowed: true }, 'unauthorized', false],
      ['fixture-token', { entitled: true, allowed: false, reason: 'devicePermissionRequired' }, '', false],
      ['fixture-token', { entitled: true, allowed: true }, '', false],
    ]) {
      game.values.accountToken = token; game.values.creaturesEnabled = false; creatureClient.access = access;
      for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
        const panel = new Class(); panel._error = error;
        const context = await panel._prepareContext(), html = render(context);
        assert.equal(context.showSubscriptionLink, expected);
        assert.equal(html.includes('data-jdr-subscriptions="creatures"'), expected);
        assert(!html.includes('data-action="subscription"'));
        if (expected) assert(html.includes('href="https://www.jdr.ninja/abonnements" target="_blank" rel="noopener noreferrer"'));
        assert(!JSON.stringify(context).includes('fixture-token'));
      }
    }
  } finally { globalThis.game = savedGame; creatureClient.access = savedAccess; }
});

test("compatibility badge distinguishes game systems and untested versions even before enablement, with escaped installed names", async () => {
  const savedGame = game;
  const strings = JSON.parse(await readFile(new URL('../lang/fr.json', import.meta.url), 'utf8'));
  const renderer = Handlebars.create(); renderer.registerHelper('localize', key => strings[key] ?? key);
  const render = renderer.compile(await readFile(new URL('../templates/creatures.hbs', import.meta.url), 'utf8'));
  try {
    for (const [system, core, code] of [
      [{ id: 'dnd5e', version: '5.3.3' }, 14, 'compatible'],
      [{ id: 'pf2e', title: '<img src=x>', version: '5.3.3' }, 14, 'dndRequired'],
      [{ id: 'dnd5e', version: '5.3.4' }, 14, 'versionUnsupported'],
      [{ id: 'dnd5e', version: '5.3.3' }, 15, 'versionUnsupported'],
      [null, undefined, 'dndRequired'],
    ]) {
      globalThis.game = { ...gameFixture(), system, release: { generation: core }, folders: { contents: [] },
        i18n: { localize: key => strings[key] ?? key, format: (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), strings[key] ?? key) } };
      game.values.creaturesEnabled = false;
      for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
        const context = await new Class()._prepareContext(), html = render(context);
        assert.equal(context.compatibility.code, code); assert.equal(context.enabled, false);
        assert(!context.canGenerate); assert(!context.canCreate);
        assert(html.includes(`data-compatibility="${code}"`));
        assert(html.includes(Handlebars.escapeExpression(strings[`JDRNINJA.creatures.compatibility.${code}`])));
        assert(!html.includes('<img')); assert(!html.includes('JDRNINJA.'));
      }
    }
  } finally { globalThis.game = savedGame; }
});
test("catalog refresh preserves explicit FP and existing invalid selections instead of silently replacing them", async () => {
  const panel = new NpcGeneratorPanel(); panel._initialized = true;
  panel._options = { ...catalogFixture("npc").defaults, challengeRating: "15", variantId: "old-variant" };
  const saved = creatureClient.request;
  creatureClient.request = async options => ({ ok: true, data: options.path.endsWith("capabilities") ? capabilityFixture() : catalogFixture("npc") });
  try {
    await panel._load();
    assert.equal(panel._options.challengeRating, "15"); assert.equal(panel._options.variantId, "old-variant");
    const context = await panel._prepareContext(); assert(context.invalidOptions); assert(!context.canGenerate);
  } finally { creatureClient.request = saved; }
});
test("changing options marks a retained preview as original and leaves it independently importable", async () => {
  const panel = new MonsterGeneratorPanel(); panel._initialized = true;
  panel._catalog = catalogFixture(); panel._options = { ...panel._catalog.defaults };
  panel._preview = resultFixture({ requestId, catalogVersion: panel._catalog.catalogVersion, options: panel._options });
  panel._options.challengeRating = "15";
  const context = await panel._prepareContext(); assert(context.preview.changed); assert(context.canCreate);
});
test("close and integration invalidation discard late generation results", async () => {
  for (const end of [panel => panel.close(), panel => panel.invalidate()]) {
    const panel = new MonsterGeneratorPanel(); panel._initialized = true;
    panel._catalog = catalogFixture(); panel._options = { ...panel._catalog.defaults };
    let release;
    const saved = creatureClient.request, oldSanitize = creatureClient.sanitize;
    creatureClient.request = options => new Promise(resolve => { release = () => resolve({ ok: true, data: resultFixture(options.body) }); });
    creatureClient.sanitize = identity;
    try {
      const pending = panel._generate();
      while (!release) await new Promise(resolve => setImmediate(resolve));
      await end(panel); release(); await pending;
      assert.equal(panel._preview, null);
    } finally { creatureClient.request = saved; creatureClient.sanitize = oldSanitize; }
  }
});
test("each generator has one window: menus, shortcuts and the API reuse it, closing allows a fresh one, players get none", async () => {
  const monster = MonsterGeneratorPanel.open(), npc = NpcGeneratorPanel.open();
  assert.notEqual(monster, npc);
  assert.equal(MonsterGeneratorPanel.open(), monster); assert.equal(NpcGeneratorPanel.open(), npc);
  assert.equal(monster.renders, 1); assert.equal(monster.fronted, 1);
  await monster.close();
  assert.equal(MonsterGeneratorPanel.instance, null); assert.equal(NpcGeneratorPanel.instance, npc);
  const reopened = MonsterGeneratorPanel.open(); assert.notEqual(reopened, monster);
  await reopened.close(); await npc.close();
  const savedUser = game.user, savedUi = globalThis.ui, warnings = [];
  game.user = { id: "player", isGM: false }; globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
  try { assert.equal(MonsterGeneratorPanel.open(), null); assert.equal(warnings.length, 1); assert.equal(MonsterGeneratorPanel.instance, null); }
  finally { game.user = savedUser; globalThis.ui = savedUi; }
});
