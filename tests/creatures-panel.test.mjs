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
const { MonsterGeneratorPanel, NpcGeneratorPanel, CreaturePanel, compatibilityLevel, accessStatus, PILL_ICONS } = await import("../scripts/creatures/panel.js");
const english = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));

/** Runs `run` with the English strings, the template compiled and a granted GM, then restores the shared client. */
async function inEnglish(run) {
  const savedGame = game, savedAccess = creatureClient.access, savedCooldown = creatureClient.cooldownUntil;
  const format = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), english[key] ?? key);
  globalThis.game = { ...gameFixture(), folders: { contents: [] }, i18n: { localize: key => english[key] ?? key, format } };
  const renderer = Handlebars.create(); renderer.registerHelper("localize", key => english[key] ?? key);
  const compiled = renderer.compile(await readFile(new URL("../templates/creatures.hbs", import.meta.url), "utf8"));
  const render = context => compiled(context).replace(/>\s+</g, "><");
  creatureClient.access = { allowed: true, entitled: true }; creatureClient.cooldownUntil = 0;
  try { await run(render); } finally { globalThis.game = savedGame; creatureClient.access = savedAccess; creatureClient.cooldownUntil = savedCooldown; }
}
/** A generator with its catalog loaded, and optionally a preview, the created actor or a running request. */
function panelWith(Class, { preview = false, actor = false, busy = false } = {}) {
  const panel = new Class(); panel._initialized = true;
  panel._catalog = catalogFixture(panel.kind); panel._options = { ...panel._catalog.defaults };
  if (preview) { panel._preview = resultFixture({ requestId, catalogVersion: panel._catalog.catalogVersion, options: panel._options }, panel.kind); panel._name = panel._preview.source.name; }
  if (actor) panel._actor = { id: "actor" };
  if (busy) panel._controller = new AbortController();
  return panel;
}
/** Every `button.bright` of a rendering: its action and whether it is disabled. */
const bright = html => [...html.matchAll(/<button type="button" class="bright" data-action="(\w+)"([^>]*)>/g)]
  .map(match => ({ action: match[1], disabled: /\bdisabled\b/.test(match[2]) }));
const actions = html => [...html.matchAll(/<button type="button"(?: class="bright")? data-action="(\w+)"/g)].map(match => match[1]).sort();

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
      assert.equal(bright(html).length, 1, locale);
    }
  }
});

test("the window is one layout with a scrolling content and a fixed footer, with no frames inside frames", async () => {
  await inEnglish(async render => {
    for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
      for (const flags of [{}, { preview: true }, { preview: true, actor: true }, { preview: true, busy: true }]) {
        const html = render(await panelWith(Class, flags)._prepareContext());
        assert(html.startsWith('<div class="standard-form jn-layout jn-creatures">'));
        assert.equal(html.match(/class="jn-scroll"/g).length, 1); assert.equal(html.match(/class="form-footer jn-footer"/g).length, 1);
        assert(!html.includes("<fieldset") && !html.includes("<legend"));
        assert(html.indexOf('class="jn-scroll"') < html.indexOf('class="form-footer jn-footer"'));
        assert(!html.slice(0, html.indexOf('<footer')).includes("<button type=\"button\" class=\"bright\""), "the primary action lives in the footer");
        assert(!html.includes("jdr-ninja__actions"));
      }
    }
  });
  assert.deepEqual(CreaturePanel.PARTS.body.scrollable, [".jn-scroll"]);
});

test("exactly one primary button follows the flow: generate, create, then open the sheet", async () => {
  await inEnglish(async render => {
    for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
      const done = `<span class="jn-pill jn-pill--success" role="status"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${english["JDRNINJA.creatures.imported"]}</span>`;
      // The window's own buttons are listed exactly: the primary one, the secondary ones, and the two header actions.
      const flow = async (flags, expected, others) => {
        const html = render(await panelWith(Class, flags)._prepareContext());
        assert.deepEqual(bright(html).map(button => button.action), [expected], JSON.stringify(flags));
        assert.deepEqual(actions(html), [expected, "check", "connections", ...others].sort(), JSON.stringify(flags));
        return html;
      };
      // Before any preview the one button generates; secondary actions only exist once there is something to dismiss or redo.
      assert(!(await flow({}, "generate", [])).includes(done));
      // A preview: create is the main action, generating again and dismissing are secondary.
      const preview = await flow({ preview: true }, "create", ["dismiss", "generate"]);
      assert(!bright(preview)[0].disabled); assert(!preview.includes(done));
      // Created: the sheet takes over and Create actor is no longer offered, not even disabled.
      const created = await flow({ preview: true, actor: true }, "sheet", ["dismiss", "generate"]);
      assert(created.includes(done)); assert(!bright(created)[0].disabled);
      // A running request still has one primary button, disabled, and a way to cancel.
      const busy = await flow({ preview: true, busy: true }, "create", ["cancel", "dismiss", "generate"]);
      assert(bright(busy)[0].disabled);
      assert(busy.includes('data-action="dismiss" disabled') && busy.includes('data-action="check" disabled'));
      assert(bright(render(await panelWith(Class, { busy: true })._prepareContext()))[0].disabled);
    }
    // Without a catalog (not connected, disabled, no access) the single primary button exists, disabled.
    const bare = new MonsterGeneratorPanel(); bare._initialized = true;
    const html = render(await bare._prepareContext());
    assert.deepEqual(bright(html), [{ action: "generate", disabled: true }]); assert(!html.includes("data-creature-option"));
  });
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
    for (const [system, core, code, level] of [
      [{ id: 'dnd5e', version: '5.3.3' }, 14, 'compatible', 'success'],
      [{ id: 'pf2e', title: '<img src=x>', version: '5.3.3' }, 14, 'dndRequired', 'error'],
      [{ id: 'dnd5e', version: '5.3.4' }, 14, 'versionUnsupported', 'warning'],
      [{ id: 'dnd5e', version: '5.3.3' }, 15, 'versionUnsupported', 'warning'],
      [null, undefined, 'dndRequired', 'error'],
    ]) {
      globalThis.game = { ...gameFixture(), system, release: { generation: core }, folders: { contents: [] },
        i18n: { localize: key => strings[key] ?? key, format: (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), strings[key] ?? key) } };
      game.values.creaturesEnabled = false;
      for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
        const context = await new Class()._prepareContext(), html = render(context);
        assert.equal(context.compatibility.code, code); assert.equal(context.enabled, false);
        assert.equal(context.compatibility.level, level); assert.equal(context.compatibility.icon, PILL_ICONS[level]);
        assert(!context.canGenerate); assert(!context.canCreate);
        assert(html.includes(`data-compatibility="${code}"`));
        assert(html.includes(`class="jn-pill jn-pill--${level}" role="status" data-compatibility="${code}"`));
        assert(html.includes(`fa-solid ${PILL_ICONS[level]}`), "the level also shows as an icon");
        assert(html.includes(Handlebars.escapeExpression(strings[`JDRNINJA.creatures.compatibility.${code}`])));
        assert(html.includes(Handlebars.escapeExpression(strings['JDRNINJA.creatures.compatibility.current'].split('{')[0])));
        assert(!html.includes('<img')); assert(!html.includes('JDRNINJA.'));
        assert.equal(bright(html).length, 1);
      }
    }
  } finally { globalThis.game = savedGame; }
});

test("pill levels are derived once: compatibility codes and access states each map to a level and an icon", async () => {
  assert.deepEqual(["compatible", "versionUnsupported", "dndRequired", "unknown"].map(compatibilityLevel), ["success", "warning", "error", "neutral"]);
  for (const level of ["success", "warning", "error", "info", "neutral"]) assert.match(PILL_ICONS[level], /^fa-[a-z-]+$/);
  assert.equal(new Set(Object.values(PILL_ICONS)).size, 5, "each level has its own icon, so colour never carries the state alone");
  await inEnglish(async () => {
    assert.deepEqual(accessStatus("available"), { pill: { level: "success", icon: "fa-circle-check", label: english["JDRNINJA.creatures.status.available"] }, message: "" });
    assert.deepEqual(accessStatus("checking"), { pill: { level: "info", icon: "fa-spinner fa-spin", label: english["JDRNINJA.creatures.status.checking"] }, message: "" });
    assert.deepEqual(accessStatus("notChecked"), { pill: { level: "neutral", icon: "fa-circle-minus", label: english["JDRNINJA.creatures.status.notChecked"] }, message: "" });
    // A restriction, a denial or a failure is a message, shown once: the last failure keeps its own alert.
    for (const code of ["disabled", "connectionRequired", "incompatibleSystem", "devicePermissionRequired", "tierRequired"]) {
      assert.deepEqual(accessStatus(code, "network"), { pill: null, message: english[`JDRNINJA.creatures.error.${code}`] }, code);
    }
    assert.deepEqual(accessStatus("network", "network"), { pill: null, message: "" });
  });
});

test("the access state shows as a pill, and any other state as one notice instead of repeating the failure", async () => {
  await inEnglish(async render => {
    const state = async (prepare, access = { allowed: true, entitled: true }) => {
      creatureClient.access = access;
      const panel = panelWith(MonsterGeneratorPanel); prepare?.(panel);
      const context = await panel._prepareContext(); return { context, html: render(context) };
    };
    const available = await state();
    assert.equal(available.context.status.pill.level, "success");
    assert(available.html.includes('<span class="jn-creature-status" aria-live="polite"><span class="jn-pill jn-pill--success"><i class="fa-solid fa-circle-check"'));
    assert(!available.html.includes("notice-warning") && !available.html.includes('role="alert"'));
    assert.equal((await state(null, null)).context.status.pill.level, "neutral");
    assert.equal((await state(panel => { panel._controller = new AbortController(); })).context.status.pill.level, "info");
    // A failed operation: the alert states it once, the pill leaves room for it and no second notice repeats it.
    const failed = await state(panel => { panel._error = "network"; });
    assert.equal(failed.context.status.pill, null); assert.equal(failed.context.status.message, "");
    assert.equal(failed.html.split(english["JDRNINJA.creatures.error.network"]).length - 1, 1);
    assert(failed.html.includes('class="notice notice-error" role="alert"')); assert(!failed.html.includes("notice-warning"));
    // A denial is a warning notice with its message, and the subscription link follows it.
    const denied = await state(null, { allowed: false, entitled: false, reason: "tierRequired" });
    assert.equal(denied.context.status.pill, null);
    assert(denied.html.includes(`<p class="notice notice-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${english["JDRNINJA.creatures.error.tierRequired"]}</p>`));
    assert(!denied.html.includes('role="alert"')); assert(denied.html.includes('data-jdr-subscriptions="creatures"'));
    // A restriction next to a failure: the restriction is the notice and the failure keeps its own alert.
    game.values.creaturesEnabled = false;
    const disabled = await state(panel => { panel._error = "network"; });
    assert.equal(disabled.context.status.pill, null); assert.equal(disabled.context.status.message, english["JDRNINJA.creatures.error.disabled"]);
    assert(disabled.html.includes("notice-warning")); assert(disabled.html.includes('class="notice notice-error" role="alert"'));
    assert.equal(disabled.html.split(english["JDRNINJA.creatures.error.network"]).length - 1, 1);
  });
});

test("a selected role, profile or recommended FP explains itself under its field, linked to it", async () => {
  await inEnglish(async render => {
    const monster = panelWith(MonsterGeneratorPanel);
    monster._catalog.choices.role[0].description = "Soaks up hits & hits hard.";
    monster._catalog.choices.combatProfile[0].description = "A single creature.";
    const context = await monster._prepareContext(), html = render(context);
    const field = name => context.primaryFields.find(item => item.name === name);
    assert.equal(field("role").hint, "Soaks up hits & hits hard."); assert.equal(field("challengeRating").hint, "");
    assert(html.includes('<p class="hint" id="jn-monster-role-hint">Soaks up hits &amp; hits hard.</p>'));
    assert(html.includes('aria-describedby="jn-monster-role-hint"')); assert(html.includes('aria-describedby="jn-monster-combatProfile-hint"'));
    assert(!html.includes('aria-describedby="jn-monster-family-hint"')); assert.equal(html.match(/class="hint"/g).length, 2);
    // The role hint sits in the same grid cell as its select, so it reads as that field's help.
    const cell = html.slice(html.indexOf('<label for="jn-monster-role">'), html.indexOf('id="jn-monster-role-hint"'));
    assert(!cell.includes('<label for="jn-monster-family">'));
    const npc = panelWith(NpcGeneratorPanel); npc._options.presetId = "guard";
    const npcContext = await npc._prepareContext();
    assert.equal(npcContext.primaryFields.find(item => item.name === "challengeRating").hint, `${english["JDRNINJA.creatures.recommendation"]} 1/4`);
    assert(render(npcContext).includes(`id="jn-npc-challengeRating-hint">${english["JDRNINJA.creatures.recommendation"]} 1/4</p>`));
    npc._options.presetId = "random"; assert.equal((await npc._prepareContext()).primaryFields.find(item => item.name === "challengeRating").hint, "");
  });
});

test("options sit in a two-column grid, advanced ones fold away with the checkbox beside its label, invalid ones carry an icon", async () => {
  await inEnglish(async render => {
    const npc = panelWith(NpcGeneratorPanel); npc._options.variantId = "gone"; npc._options.includeSecret = true;
    const context = await npc._prepareContext(), html = render(context);
    assert.equal(html.match(/class="jn-grid-2"/g).length, 2, "primary options, then the advanced ones");
    assert.equal(html.match(/<details class="jn-creature-advanced" data-creature-advanced >/g).length, 1);
    npc._advanced = true; assert(render(await npc._prepareContext()).includes('data-creature-advanced open>'));
    assert(html.includes('<div class="form-group jn-creature-check"><div class="form-fields"><input id="jn-npc-includeSecret" name="includeSecret" type="checkbox" data-creature-option checked'));
    assert(html.includes('for="jn-npc-includeSecret"'));
    // The unavailable variant is flagged by aria-invalid, an icon in its label and the alert, not by colour alone.
    assert(context.invalidOptions); assert(html.includes('<select id="jn-npc-variantId" name="variantId" data-creature-option aria-invalid="true"'));
    assert(html.includes('<label for="jn-npc-variantId">Variant <i class="fa-solid fa-circle-exclamation jn-creature-invalid" aria-hidden="true"></i></label>'));
    assert(html.includes('class="notice notice-error" role="alert"')); assert(html.includes(english["JDRNINJA.creatures.error.invalidOptions"]));
    assert(html.includes("gone (unavailable)"));
    // Every field keeps a label and the hooks the script reads.
    for (const field of [...context.primaryFields, ...context.advancedFields]) {
      assert(html.includes(`<label for="${field.id}">`)); assert(html.includes(`id="${field.id}" name="${field.name}" `));
    }
    assert.equal(html.match(/data-creature-option/g).length, 10);
    // While a request runs every option is disabled, as the former fieldset did.
    npc._controller = new AbortController();
    const busy = render(await npc._prepareContext());
    assert.equal(busy.match(/data-creature-option[^>]*disabled/g).length, 10);
    assert(!render(await panelWith(MonsterGeneratorPanel)._prepareContext()).includes("jn-creature-advanced"));
  });
});

test("the preview is a stat block card, the creation fields a section, and imported HTML is rendered without styles of ours", async () => {
  await inEnglish(async render => {
    const panel = panelWith(MonsterGeneratorPanel, { preview: true }); panel._preview.source.biography = '<h2>Lair</h2><p>A <b>moss</b> beast.</p>';
    const html = render(await panel._prepareContext());
    assert(html.includes('<article class="jn-card jn-creature-preview" aria-labelledby="jn-monster-preview-name">'));
    assert(html.includes('<h3 id="jn-monster-preview-name">Fixture monster</h3>'));
    const meta = html.slice(html.indexOf('class="jn-creature-meta"'), html.indexOf("</p>", html.indexOf('class="jn-creature-meta"')));
    assert.deepEqual([...meta.matchAll(/<strong>([^<]*)<\/strong>/g)].map(match => match[1]), ["1/4", "14", "27"], "FP, AC then HP");
    assert.deepEqual([...meta.matchAll(/class="jn-muted">([^<]*)</g)].map(match => match[1]), ["Challenge rating", "AC", "HP"]);
    assert(html.includes('<div class="jn-creature-biography"><h2>Lair</h2><p>A <b>moss</b> beast.</p></div>'));
    assert(!/<[^>]*\bstyle=/.test(html), "no inline style");
    assert(html.includes('<details class="jn-creature-rules">') && html.includes(`<summary>${english["JDRNINJA.creatures.rules"]}</summary>`));
    assert.equal(html.match(/class="jn-creature-entry"/g).length, 3);
    assert(html.includes(english["JDRNINJA.creatures.manualLimit"]));
    assert(!html.includes(english["JDRNINJA.creatures.changed"]), "the retained-options note shows only after a change");
    panel._options.challengeRating = "15"; assert(render(await panel._prepareContext()).includes(english["JDRNINJA.creatures.changed"]));
    // Create in this world: a titled section with the name and folder, in the same two columns.
    assert(html.includes('<section class="jn-section jn-creature-destination" aria-labelledby="jn-monster-destination">'));
    assert(html.includes(`<h3 class="jn-section__title" id="jn-monster-destination"><i class="fa-solid fa-earth-europe" aria-hidden="true"></i> ${english["JDRNINJA.creatures.destination"]}`));
    assert(html.includes("· Test</span>"), "the world name sits in the title row");
    assert(html.includes('<input id="jn-monster-name" name="importName" value="Fixture monster" maxlength="256" >'));
    assert(html.includes('<select id="jn-monster-folder" name="importFolder" >'));
    assert(html.includes(english["JDRNINJA.creatures.destinationHint"]));
    assert(!html.includes(english["JDRNINJA.creatures.imported"]), "no created pill before the actor exists");
    panel._controller = new AbortController();
    const busy = render(await panel._prepareContext());
    assert(busy.includes('name="importName" value="Fixture monster" maxlength="256" disabled>')); assert(busy.includes('name="importFolder" disabled>'));
  });
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
