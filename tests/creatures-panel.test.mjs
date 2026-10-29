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
const { MonsterGeneratorPanel, NpcGeneratorPanel, CreaturePanel } = await import("../scripts/creatures/panel.js");
const { PILL_ICONS } = await import("../scripts/ui/states.js");
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
      assert(!html.includes("jn-status-line") && context.status === null, "a compatible system with access shows nothing above the form");
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
        assert(!html.includes("jn-actions"));
      }
    }
  });
  assert.deepEqual(CreaturePanel.PARTS.body.scrollable, [".jn-scroll"]);
});

test("exactly one primary button follows the flow: generate, create, then open the sheet", async () => {
  await inEnglish(async render => {
    for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
      const done = `<span class="jn-pill jn-pill--success" role="status"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${english["JDRNINJA.creatures.imported"]}</span>`;
      // The window's own buttons are listed exactly: the primary one and the secondary ones. Nothing sits above the form.
      const flow = async (flags, expected, others) => {
        const html = render(await panelWith(Class, flags)._prepareContext());
        assert.deepEqual(bright(html).map(button => button.action), [expected], JSON.stringify(flags));
        assert.deepEqual(actions(html), [expected, ...others].sort(), JSON.stringify(flags));
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
      assert(busy.includes('data-action="dismiss" disabled'));
      assert(bright(render(await panelWith(Class, { busy: true })._prepareContext()))[0].disabled);
    }
    // Without a catalog (not connected, disabled, no access) the single primary button exists, disabled.
    const bare = new MonsterGeneratorPanel(); bare._initialized = true;
    const html = render(await bare._prepareContext());
    assert.deepEqual(bright(html), [{ action: "generate", disabled: true }]); assert(!html.includes("data-creature-option"));
  });
});

const text = key => english[`JDRNINJA.${key}`];
const granted = { allowed: true, entitled: true };

test("in the normal state nothing sits above the form: no pill, no system line, no connections or check button", async () => {
  await inEnglish(async render => {
    for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
      for (const flags of [{}, { preview: true }, { preview: true, actor: true }, { preview: true, busy: true }]) {
        const context = await panelWith(Class, flags)._prepareContext(), html = render(context), label = JSON.stringify(flags);
        assert.equal(context.status, null, label);
        assert(html.startsWith('<div class="standard-form jn-layout jn-creatures"><div class="jn-scroll"><div class="jn-section jn-creature-options"'), label);
        assert(!html.slice(0, html.indexOf('class="jn-section jn-creature-options"')).includes("jn-pill"), label);
        for (const gone of ["jn-status-line", "jn-creature-header", "jn-creature-system", "jn-info", "data-compatibility", 'data-action="check"', 'data-action="connections"']) {
          assert(!html.includes(gone), `${label} ${gone}`);
        }
        // Retired labels may be gone from the locales: only the ones that still exist can be looked for.
        for (const key of ["creatures.compatibility.compatible", "creatures.status.available", "creatures.connections", "creatures.check", "creatures.error.incompatibleSystem"]) {
          if (text(key) !== undefined) assert(!html.includes(Handlebars.escapeExpression(text(key))), `${label} ${key}`);
        }
        assert.equal(bright(html).length, 1, label);
      }
    }
  });
});

test("the window takes its labels and states from the shared module: no status or connections copy of its own", async () => {
  for (const file of ["../scripts/creatures/panel.js", "../templates/creatures.hbs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    for (const gone of ["creatures.status.checking", "creatures.status.notChecked", "creatures.connections", "creatures.check", "accessStatus", "compatibilityLevel"]) {
      assert(!source.includes(gone), `${file} ${gone}`);
    }
  }
  const panel = await readFile(new URL("../scripts/creatures/panel.js", import.meta.url), "utf8");
  assert(panel.includes('from "../ui/states.js"') && panel.includes('from "../ui/window.js"'));
});

test("an incompatible system or an untested version is the status line, with its pill, its sentence and its reason, and no button", async () => {
  await inEnglish(async render => {
    const base = game;
    for (const [system, core, code, level] of [
      [{ id: "pf2e", title: "<img src=x>", version: "5.3.3" }, 14, "dndRequired", "error"],
      [{ id: "dnd5e", version: "5.3.4" }, 14, "versionUnsupported", "warning"],
      [{ id: "dnd5e", version: "5.3.3" }, 15, "versionUnsupported", "warning"],
      [null, undefined, "dndRequired", "error"],
    ]) {
      globalThis.game = { ...base, system, release: { generation: core } };
      for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
        const context = await panelWith(Class)._prepareContext(), html = render(context), { status } = context;
        assert.equal(status.state, "incompatible", code);
        assert.deepEqual([status.pill.level, status.pill.icon, status.pill.label], [level, PILL_ICONS[level], text(`creatures.compatibility.${code}`)]);
        assert(html.includes(`<div class="jn-status-line" data-status="incompatible"><span class="jn-pill jn-pill--${level}" role="status"><i class="fa-solid ${PILL_ICONS[level]}" aria-hidden="true"></i> ${Handlebars.escapeExpression(text(`creatures.compatibility.${code}`))}</span>`), "the level also shows as an icon");
        assert(html.includes(`<div class="notice notice-${level}"><p role="${level === "error" ? "alert" : "status"}">${Handlebars.escapeExpression(status.step.text)}</p>`));
        assert(status.step.text.startsWith(text("creatures.compatibility.current").split("{")[0]));
        assert(html.includes(`<p>${Handlebars.escapeExpression(text("creatures.error.incompatibleSystem"))}</p>`), "the reason follows as the detail");
        assert.equal(status.step.action, undefined); assert(!html.includes('data-action="check"') && !html.includes('data-action="connections"'));
        assert(!html.includes("<img")); assert(!context.canGenerate); assert(!context.canCreate);
        assert.equal(bright(html).length, 1);
      }
      if (system?.title) assert((await panelWith(MonsterGeneratorPanel)._prepareContext()).status.step.text.includes("<img src=x>"), "escaped by the template, never by the context");
    }
    globalThis.game = base;
    assert.equal((await panelWith(MonsterGeneratorPanel)._prepareContext()).status, null, "a validated system shows nothing");
  });
});

test("each state of the status line gives its message and its action, and Configure connections only opens a blocked window", async () => {
  await inEnglish(async render => {
    const stage = async ({ access = granted, values = {}, prepare, Class = MonsterGeneratorPanel } = {}) => {
      creatureClient.access = access; Object.assign(game.values, { accountToken: "fixture-token", creaturesEnabled: true }, values);
      const panel = panelWith(Class); prepare?.(panel);
      const context = await panel._prepareContext(), html = render(context);
      assert.equal(html.match(/class="jn-status-line"/g)?.length ?? 0, context.status ? 1 : 0, "one status line at most");
      return { context, html, status: context.status };
    };
    const offer = action => action ? [action.name, action.label, action.icon] : null;
    const connections = ["connections", text("menu.label"), "fa-link"];
    // A connection blocks the generators: the message says which one, and the one action opens Connections.
    for (const [state, options, sentence, pill, role] of [
      ["disabled", { values: { creaturesEnabled: false } }, "notice.disabled", "panel.state.disabled", "status"],
      ["accountRequired", { values: { accountToken: "" } }, "notice.connectAccount", "panel.state.accountRequired", "status"],
      ["attention", { prepare: panel => { panel._loadError = "unauthorized"; } }, "notice.reconnectAccount", "panel.state.attention", "status"],
      ["attention", { prepare: panel => { panel._loadError = "wrongDeviceKind"; } }, "notice.reconnectAccount", "panel.state.attention", "status"],
      ["devicePermissionRequired", { access: { allowed: false, entitled: true, reason: "devicePermissionRequired" } }, "panel.step.devicePermission", "panel.state.permissionRequired", "status"],
      ["devicePermissionRequired", { prepare: panel => { panel._loadError = "devicePermissionRequired"; } }, "panel.step.devicePermission", "panel.state.permissionRequired", "status"],
    ]) {
      for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
        const { html, status } = await stage({ ...options, Class });
        assert.equal(status.state, state);
        assert.equal(status.pill.label, text(pill)); assert.equal(status.step.text, text(sentence)); assert.deepEqual(offer(status.step.action), connections);
        assert(html.includes(`<div class="jn-status-line" data-status="${state}">`));
        assert(html.includes(`<p role="${role}">${text(sentence)}</p>`));
        assert(html.includes(`<button type="button" data-action="connections"><i class="fa-solid fa-link" aria-hidden="true"></i> ${text("menu.label")}</button>`));
        assert.equal(html.match(/data-action="connections"/g).length, 1); assert(!html.includes("data-jdr-subscriptions"));
      }
    }
    // A subscription is required, whether the server said so on the access or on the options: the message and one link.
    for (const options of [{ access: { allowed: false, entitled: false, reason: "tierRequired" } }, { prepare: panel => { panel._loadError = "tierRequired"; } }]) {
      const { context, html, status } = await stage(options);
      assert.equal(status.state, "tierRequired"); assert.equal(status.pill.label, text("panel.state.subscriptionRequired"));
      assert.equal(status.step.text, text("creatures.error.tierRequired")); assert.equal(status.step.action, undefined);
      assert.deepEqual(status.step.link, { href: "https://www.jdr.ninja/abonnements", label: text("creatures.subscription"), kind: "creatures" });
      assert(html.includes(`<a href="https://www.jdr.ninja/abonnements" target="_blank" rel="noopener noreferrer" data-jdr-subscriptions="creatures">${text("creatures.subscription")}</a>`));
      assert.equal(html.match(/data-jdr-subscriptions/g).length, 1); assert(!html.includes('data-action="connections"')); assert(!context.showSubscriptionLink);
    }
    // The access or the options failed: the message that came back and a retry that reloads both.
    const retry = ["check", text("button.retry"), "fa-rotate"];
    for (const code of ["network", "apiUnavailable", "verificationUnavailable", "invalidResponse"]) {
      const { html, status } = await stage({ prepare: panel => { panel._loadError = code; } });
      assert.equal(status.state, "unavailable"); assert.equal(status.pill.label, text("panel.state.unavailable"));
      assert.equal(status.step.text, text(`creatures.error.${code}`)); assert.deepEqual(offer(status.step.action), retry);
      assert(html.includes(`<p role="alert">${Handlebars.escapeExpression(text(`creatures.error.${code}`))}</p>`));
      assert(html.includes('<button type="button" data-action="check"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Try again</button>'));
      assert(!html.includes('data-action="connections"')); assert(!html.includes("data-jdr-subscriptions"));
    }
    // An access nobody has checked yet, after a cancelled check for example: it says so and offers the check, which keeps
    // its own « Check connection » label and runs the window's own reload.
    const unchecked = await stage({ access: null });
    assert.equal(unchecked.status.state, "notChecked"); assert.equal(unchecked.status.pill.label, text("status.saved"));
    assert.equal(unchecked.status.step.text, ""); assert.deepEqual(offer(unchecked.status.step.action), ["check", text("button.check"), "fa-rotate"]);
    assert(unchecked.html.includes('<button type="button" data-action="check"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Check connection</button>'));
    assert(!unchecked.html.includes("<p role=")); assert(!unchecked.html.includes('data-action="connections"'));
    // Verification shows only while the access and the options load, and a window about to load does not flash another state.
    const pill = `<div class="jn-status-line" data-status="checking"><span class="jn-pill jn-pill--info" role="status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${text("panel.state.checking")}</span></div>`;
    for (const prepare of [panel => { panel._controller = new AbortController(); panel._loading = true; }, panel => { panel._initialized = false; }]) {
      const checking = await stage({ access: null, prepare });
      assert.equal(checking.status.state, "checking"); assert.equal(checking.status.step, null); assert(checking.html.includes(pill));
      assert(!checking.html.includes("notice-") && !checking.html.includes('data-action="check"'));
    }
    // A generation or a creation in progress is not a verification.
    const generating = await stage({ prepare: panel => { panel._controller = new AbortController(); } });
    assert.equal(generating.status, null); assert(generating.context.busy); assert(!generating.html.includes(text("panel.state.checking")));
  });
});

test("the access check and the options load report on the status line while a failed generation keeps its alert", async () => {
  await inEnglish(async render => {
    const saved = creatureClient.request, savedSanitize = creatureClient.sanitize;
    const data = options => options.path.endsWith("capabilities") ? capabilityFixture() : catalogFixture("monster");
    const fresh = () => { const panel = new MonsterGeneratorPanel(); panel._initialized = true; return panel; };
    try {
      // The access check fails: the retry sits on the status line and no alert repeats the message.
      creatureClient.access = null;
      creatureClient.request = async () => ({ ok: false, reason: "network" });
      const panel = fresh();
      await panel._load();
      assert.equal(panel._loadError, "network"); assert.equal(panel._error, "");
      let context = await panel._prepareContext(), html = render(context);
      assert.equal(context.status.state, "unavailable"); assert.equal(context.error, "");
      assert(html.includes('data-action="check"')); assert(!html.includes('class="notice notice-error" role="alert"'));
      assert.equal(html.split(text("creatures.error.network")).length - 1, 1);
      // The retry reloads the access and the options, and the line goes.
      creatureClient.request = async options => ({ ok: true, data: data(options) });
      await panel._load();
      assert.equal(panel._loadError, ""); context = await panel._prepareContext();
      assert.equal(context.status, null); assert(context.hasCatalog); assert(!render(context).includes("jn-status-line"));
      // The access is granted but the options fail: the failure still shows with its retry, though the grant is known.
      creatureClient.access = null;
      creatureClient.request = async options => options.path.endsWith("capabilities") ? { ok: true, data: capabilityFixture() } : { ok: false, reason: "network" };
      const options = fresh();
      await options._load();
      assert.equal(creatureClient.access.allowed, true); assert.equal(options._loadError, "network"); assert.equal(options._error, "");
      context = await options._prepareContext(); html = render(context);
      assert.equal(context.status.state, "unavailable"); assert.equal(context.status.step.action.name, "check"); assert(!context.hasCatalog);
      assert.equal(html.split(text("creatures.error.network")).length - 1, 1);
      options.invalidate(); assert.equal(options._loadError, "", "a new credential forgets the failure");
      // A failed generation keeps its alert, and the status line stays out of it.
      creatureClient.access = granted;
      creatureClient.request = async () => ({ ok: false, reason: "network" });
      const generation = panelWith(MonsterGeneratorPanel);
      await generation._generate();
      assert.equal(generation._error, "network"); assert.equal(generation._loadError, "");
      context = await generation._prepareContext(); html = render(context);
      assert.equal(context.status, null); assert(!html.includes("jn-status-line"));
      assert(html.includes('<p class="notice notice-error" role="alert">')); assert.equal(html.split(text("creatures.error.network")).length - 1, 1);
      // While the access and the options load the pill says so; the verification ends with the load.
      creatureClient.access = null;
      let open; const gate = new Promise(resolve => { open = resolve; });
      creatureClient.request = async request => { if (request.path.endsWith("capabilities")) await gate; return { ok: true, data: data(request) }; };
      const loading = fresh(), pending = loading._load();
      assert.equal(loading._loading, true);
      context = await loading._prepareContext(); html = render(context);
      assert.equal(context.status.state, "checking"); assert(html.includes(`${text("panel.state.checking")}</span>`));
      open(); await pending;
      assert.equal(loading._loading, false); assert.equal((await loading._prepareContext()).status, null);
      // While a generation runs the window is busy, and nothing claims to verify.
      creatureClient.access = granted; creatureClient.sanitize = identity;
      let finish; creatureClient.request = request => new Promise(resolve => { finish = () => resolve({ ok: true, data: resultFixture(request.body) }); });
      const running = panelWith(MonsterGeneratorPanel), run = running._generate();
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      assert(running._controller); assert.equal(running._loading, false);
      context = await running._prepareContext();
      assert.equal(context.status, null); assert(context.busy); assert(!render(context).includes(text("panel.state.checking")));
      finish(); await run;
      assert(running._preview); assert.equal(running._loading, false);
    } finally { creatureClient.request = saved; creatureClient.sanitize = savedSanitize; }
  });
});

test("a generation refused for the subscription, the permission or the connection is reported by the status line once, not as unchecked", async () => {
  await inEnglish(async render => {
    const saved = creatureClient.request, savedSanitize = creatureClient.sanitize;
    const refusal = code => ({ ok: false, http: 403, data: { contractVersion: 1, status: "error", error: { code } } });
    const message = code => Handlebars.escapeExpression(text(`creatures.error.${code}`));
    try {
      for (const [code, state, sentence, pill, action] of [
        ["tierRequired", "tierRequired", "creatures.error.tierRequired", "panel.state.subscriptionRequired", null],
        ["devicePermissionRequired", "devicePermissionRequired", "panel.step.devicePermission", "panel.state.permissionRequired", "connections"],
        ["unauthorized", "attention", "notice.reconnectAccount", "panel.state.attention", "connections"],
        ["wrongDeviceKind", "attention", "notice.reconnectAccount", "panel.state.attention", "connections"],
      ]) {
        for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
          creatureClient.access = granted; creatureClient.cooldownUntil = 0; creatureClient.request = async () => refusal(code);
          const panel = panelWith(Class);
          await panel._generate();
          assert.equal(panel._error, code); assert.equal(panel._loadError, ""); assert.equal(creatureClient.access, null, "the refusal withdraws the access");
          const context = await panel._prepareContext(), html = render(context), label = `${code} ${Class.KIND}`;
          assert.equal(context.status.state, state, label);
          assert.notEqual(context.status.pill.label, text("status.saved"), `${label}: not « needs verification »`);
          assert.equal(context.status.pill.label, text(pill), label); assert.equal(context.status.step.text, text(sentence), label);
          assert.equal(html.match(/class="jn-status-line"/g).length, 1, label);
          assert(html.includes(`<p role="status">${Handlebars.escapeExpression(text(sentence))}</p>`), label);
          // The line carries the failure: no alert repeats it, and the form cannot generate until the access is back.
          assert.equal(context.error, "", label); assert(!html.includes('role="alert"'), label); assert(!context.canGenerate, label);
          assert.equal(html.split(message(code)).length - 1, code === "tierRequired" ? 1 : 0, label);
          assert.equal(html.match(/data-action="connections"/g)?.length ?? 0, action ? 1 : 0, label);
          // At most one subscriptions link, and only for the subscription.
          assert.equal(html.match(/data-jdr-subscriptions/g)?.length ?? 0, code === "tierRequired" ? 1 : 0, label);
          assert.equal(context.showSubscriptionLink, false, label);
          // A grant seen afterwards (the Connections window checked again) wins over the refusal of the generation.
          creatureClient.access = granted;
          assert.equal((await panel._prepareContext()).status, null, label);
        }
      }
    } finally { creatureClient.request = saved; creatureClient.sanitize = savedSanitize; }
  });
});

test("the subscriptions link shows at most once: in the status line, or under the alert of a denied generation", async () => {
  await inEnglish(async render => {
    const links = html => html.match(/data-jdr-subscriptions="creatures"/g)?.length ?? 0;
    for (const [name, { access = granted, values = {}, prepare }, expected, placed] of [
      ["no account", { values: { accountToken: "" } }, 0],
      ["access not checked", { access: null }, 0],
      ["subscription denied on the access", { access: { allowed: false, entitled: false, reason: "tierRequired" } }, 1, "line"],
      ["subscription denied on the options", { prepare: panel => { panel._loadError = "tierRequired"; } }, 1, "line"],
      ["generation denied", { prepare: panel => { panel._error = "tierRequired"; } }, 1, "alert"],
      ["denied on both: the line offers it, the alert does not", { prepare: panel => { panel._loadError = "tierRequired"; panel._error = "tierRequired"; } }, 1, "line"],
      ["another failure of a generation", { prepare: panel => { panel._error = "unauthorized"; } }, 0],
      ["permission missing", { access: { allowed: false, entitled: true, reason: "devicePermissionRequired" } }, 0],
      ["access granted", {}, 0],
    ]) {
      for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
        creatureClient.access = access; Object.assign(game.values, { accountToken: "fixture-token", creaturesEnabled: true }, values);
        const panel = panelWith(Class); prepare?.(panel);
        const context = await panel._prepareContext(), html = render(context);
        assert.equal(links(html), expected, name);
        assert.equal(context.showSubscriptionLink, placed === "alert", name);
        assert.equal(Boolean(context.status?.step?.link), placed === "line", name);
        assert(!html.includes('data-action="subscription"'));
        if (expected) assert(html.includes('href="https://www.jdr.ninja/abonnements" target="_blank" rel="noopener noreferrer"'));
        if (placed === "alert") assert(html.indexOf('role="alert"') < html.indexOf("data-jdr-subscriptions"), "the link follows the alert it belongs to");
        assert(!JSON.stringify(context).includes("fixture-token"));
      }
    }
  });
});

test("the NPC generator has the masks icon, the monster generator the dragon, and both open at the generators width", () => {
  assert.equal(NpcGeneratorPanel.DEFAULT_OPTIONS.window.icon, "fa-solid fa-masks-theater");
  assert.equal(MonsterGeneratorPanel.DEFAULT_OPTIONS.window.icon, "fa-solid fa-dragon");
  for (const Class of [MonsterGeneratorPanel, NpcGeneratorPanel]) {
    assert.equal(Class.DEFAULT_OPTIONS.position.width, 760); assert.equal(Class.DEFAULT_OPTIONS.position.height, 760);
    assert.equal(typeof Class.DEFAULT_OPTIONS.actions.check, "function"); assert.equal(typeof Class.DEFAULT_OPTIONS.actions.connections, "function");
  }
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
