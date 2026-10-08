import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { streamDeckBridge } from "../scripts/stream-deck/bridge.js";

class Application {
  rendered = true;
  async render() { return this; }
  async close() { this.rendered = false; return this; }
  _onRender() {}
}
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } } };
const { StreamDeckPanel, STREAM_DECK_LEVELS, streamDeckPill, paintStreamDeckPill } = await import("../scripts/stream-deck/panel.js");

/** A rendered status pill reduced to what the panel touches: its class, its icon and its text. */
const pillElement = () => ({ className: "", icon: { className: "" }, text: { textContent: "" },
  querySelector(selector) { return selector === "[data-pill-icon]" ? this.icon : this.text; } });

function fixture() {
  const settings = { streamDeckEnabled: true, streamDeckUrl: "ws://127.0.0.1:19114/jdr-ninja", streamDeckKey: "a".repeat(64) };
  const writes = [];
  globalThis.game = { user: { isGM: false }, i18n: { localize: key => key }, settings: {
    get: (_module, key) => settings[key], set: async (_module, key, value) => { writes.push([key, value]); settings[key] = value; },
  } };
  const panel = new StreamDeckPanel();
  const fields = { streamDeckUrl: { value: "wss://localhost:19114/jdr-ninja" }, streamDeckKey: { value: "b".repeat(64) },
    streamDeckEnabled: { addEventListener() {} }, status: pillElement(), error: {} };
  panel.element = { querySelector: selector => selector === "[data-stream-deck-status]" ? fields.status
    : selector === "[data-stream-deck-error]" ? fields.error
    : fields[/name="([^"]+)"/.exec(selector)?.[1]] };
  return { panel, fields, settings, writes };
}

test("saving bridge settings disables consent before changing the endpoint/key, even for a player", async () => {
  const f = fixture(); await f.panel._save();
  assert.deepEqual(f.writes, [["streamDeckEnabled", false], ["streamDeckKey", ""],
    ["streamDeckUrl", "wss://localhost:19114/jdr-ninja"], ["streamDeckKey", "b".repeat(64)]]);
  const context = await f.panel._prepareContext();
  assert.equal(context.enabled, false); assert.equal(context.configured, true);
  assert(!JSON.stringify(context).includes("b".repeat(64)));
});

test("invalid endpoint/key never changes saved configuration or consent", async () => {
  const f = fixture(); f.fields.streamDeckUrl.value = "wss://example.com/jdr-ninja";
  await f.panel._save(); assert.equal(f.writes.length, 0);
  assert.equal(f.panel._error, "JDRNINJA.streamDeck.error.invalidEndpoint");
  f.fields.streamDeckUrl.value = f.settings.streamDeckUrl; f.fields.streamDeckKey.value = "short";
  await f.panel._save(); assert.equal(f.writes.length, 0);
  assert.equal(f.panel._error, "JDRNINJA.streamDeck.error.invalidKey");
});

test("live status updates repaint the pill but do not erase unsaved endpoint/key edits, and closing unsubscribes", async () => {
  const f = fixture(); f.panel._onRender({}, {});
  streamDeckBridge.notify("synchronizing");
  assert.equal(f.fields.status.text.textContent, "JDRNINJA.streamDeck.state.synchronizing");
  assert.equal(f.fields.status.className, "jn-pill jn-pill--warning");
  assert.equal(f.fields.status.icon.className, "fa-solid fa-spinner fa-spin");
  assert.equal(f.fields.streamDeckKey.value, "b".repeat(64));
  assert.equal(f.fields.streamDeckUrl.value, "wss://localhost:19114/jdr-ninja");
  streamDeckBridge.notify("disconnected", "connectionFailed");
  assert.equal(f.fields.status.className, "jn-pill jn-pill--error");
  assert.equal(f.fields.error.textContent, "JDRNINJA.streamDeck.error.connectionFailed");
  assert.equal(f.fields.error.hidden, false);
  streamDeckBridge.notify("ready");
  assert.equal(f.fields.status.className, "jn-pill jn-pill--success");
  assert.equal(f.fields.error.hidden, true);
  await f.panel.close(); streamDeckBridge.notify("disabled");
  assert.equal(f.fields.status.text.textContent, "JDRNINJA.streamDeck.state.ready");
});

test("disconnect disables integration and removes the local key", async () => {
  const f = fixture(); f.panel._generated = "unsaved"; await f.panel._disconnect();
  assert.deepEqual(f.writes, [["streamDeckEnabled", false], ["streamDeckKey", ""]]);
  assert.equal(f.panel._generated, "");
});

test("every state of the bridge maps to a pill level, with an icon and its translated name", async () => {
  fixture();
  const english = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
  const states = Object.keys(english).filter(key => key.startsWith("JDRNINJA.streamDeck.state.")).map(key => key.split(".").pop()).sort();
  // The states the bridge can enter are the states that have a name; each of them has a level.
  const bridge = await readFile(new URL("../scripts/stream-deck/bridge.js", import.meta.url), "utf8");
  const entered = new Set([...bridge.matchAll(/(?:notify|stop)\(\s*"(\w+)"/g)].map(match => match[1]));
  for (const state of ["disabled", "disconnected"]) entered.add(state);
  assert([...entered].every(state => states.includes(state)), `Unnamed bridge state: ${[...entered].filter(state => !states.includes(state))}`);
  assert.deepEqual(Object.keys(STREAM_DECK_LEVELS).sort(), states);
  assert.deepEqual({ ...STREAM_DECK_LEVELS }, { ready: "success",
    connecting: "warning", authenticating: "warning", awaitingAuthentication: "warning", synchronizing: "warning",
    disabled: "neutral", unconfigured: "error", disconnected: "error", unavailable: "error" });
  for (const state of states) {
    const pill = streamDeckPill(state);
    assert.equal(pill.level, STREAM_DECK_LEVELS[state], state);
    assert.equal(pill.label, `JDRNINJA.streamDeck.state.${state}`);
    assert(/^fa-[\w-]+( fa-[\w-]+)*$/.test(pill.icon), state);
  }
  // A state the module does not know is shown as neutral rather than breaking the window.
  assert.equal(streamDeckPill("somethingNew").level, "neutral");
  // The icon tells the level apart even without colour.
  assert.equal(new Set(["success", "warning", "error", "neutral"].map(level => streamDeckPill(
    Object.keys(STREAM_DECK_LEVELS).find(state => STREAM_DECK_LEVELS[state] === level)).icon)).size, 4);
});

test("painting a pill sets its level class, its icon and its text, and tolerates a missing pill", () => {
  fixture();
  const pill = pillElement();
  paintStreamDeckPill(pill, "ready");
  assert.deepEqual([pill.className, pill.icon.className, pill.text.textContent],
    ["jn-pill jn-pill--success", "fa-solid fa-circle-check", "JDRNINJA.streamDeck.state.ready"]);
  paintStreamDeckPill(pill, "disabled");
  assert.deepEqual([pill.className, pill.icon.className], ["jn-pill jn-pill--neutral", "fa-solid fa-circle-minus"]);
  assert.doesNotThrow(() => paintStreamDeckPill(null, "ready"));
});

test("the context carries the pill of the bridge state", async () => {
  const f = fixture();
  for (const [state, level] of [["ready", "success"], ["connecting", "warning"], ["disabled", "neutral"], ["unavailable", "error"]]) {
    streamDeckBridge.state = state;
    const context = await f.panel._prepareContext();
    assert.equal(context.pill.level, level, state);
  }
  streamDeckBridge.state = "disabled";
});

async function renderTemplate(locale, overrides = {}) {
  const copy = JSON.parse(await readFile(new URL(`../lang/${locale}.json`, import.meta.url), "utf8"));
  const renderer = Handlebars.create();
  renderer.registerHelper("localize", key => copy[key] ?? key);
  const f = fixture();
  game.i18n = { localize: key => copy[key] ?? key };
  streamDeckBridge.state = "ready";
  const context = { ...await f.panel._prepareContext(), ...overrides };
  streamDeckBridge.state = "disabled";
  return { html: renderer.compile(await readFile(new URL("../templates/stream-deck.hbs", import.meta.url), "utf8"))(context), copy, context };
}
const escaped = text => Handlebars.escapeExpression(text);

test("the Stream Deck window renders every locale with its hooks, one primary action and a fixed footer", async () => {
  for (const locale of ["en", "fr", "es", "de", "it"]) {
    const { html, copy } = await renderTemplate(locale);
    assert(!html.includes("JDRNINJA."), `${locale}: unresolved locale key`);
    for (const hook of ['name="streamDeckEnabled"', 'name="streamDeckUrl"', 'name="streamDeckKey"', "data-stream-deck-status", "data-stream-deck-error"]) assert(html.includes(hook), hook);
    // The window frame: content that scrolls, a footer that stays, no frame in a frame.
    assert(html.includes('class="standard-form jn-layout') && html.includes('<div class="jn-scroll">'));
    assert(!html.includes("<fieldset") && !html.includes("<legend") && !html.includes('class="badge'));
    const footer = html.slice(html.indexOf('<footer class="form-footer jn-footer">'), html.indexOf("</footer>"));
    assert(footer.length > 0, locale);
    for (const action of ["save", "reconnect", "disconnect"]) assert(footer.includes(`data-action="${action}"`), action);
    assert(!footer.includes('data-action="generate"'));
    for (const action of html.matchAll(/data-action="(\w+)"/g)) assert.equal(typeof StreamDeckPanel.DEFAULT_OPTIONS.actions[action[1]], "function", action[1]);
    // Save is the single primary action; disconnect is the destructive one; reconnect keeps the base style.
    assert.equal((html.match(/class="bright"/g) ?? []).length, 1);
    assert(html.includes('class="bright" data-action="save"'));
    assert(html.includes('class="jn-danger" data-action="disconnect"'));
    assert(/<button type="button" data-action="reconnect"/.test(html));
    assert.equal((html.match(/class="jn-danger"/g) ?? []).length, 1);
    // Generating a key is an icon button with its name and its tooltip, next to the key field.
    const generate = /<button type="button" class="jn-icon-button" data-action="generate"[^>]*>/.exec(html)?.[0] ?? "";
    assert(generate.includes(`aria-label="${escaped(copy["JDRNINJA.streamDeck.generate"])}"`), generate);
    assert(generate.includes(`data-tooltip="${escaped(copy["JDRNINJA.streamDeck.generate"])}"`), generate);
    assert(html.indexOf('name="streamDeckKey"') < html.indexOf('data-action="generate"') && html.indexOf('data-action="generate"') < html.indexOf("</section>"));
    // The state is a pill with an icon and its text, announced politely; the error keeps its alert role.
    assert(/aria-live="polite">\s*<span class="jn-pill jn-pill--success" data-stream-deck-status><i class="fa-solid fa-circle-check" aria-hidden="true" data-pill-icon><\/i><span data-pill-text>/.test(html), locale);
    assert(/<p class="notice notice-error" role="alert" data-stream-deck-error hidden>/.test(html));
    // The switch hint and the address detail are tooltips on focusable icons; the one note replaces the two paragraphs.
    for (const key of ["enableHint", "urlDetail"]) {
      const tooltip = escaped(copy[`JDRNINJA.streamDeck.${key}`]);
      assert(html.includes(`tabindex="0" role="img" aria-label="${tooltip}" data-tooltip="${tooltip}"`), key);
    }
    assert(!html.includes(`<p class="hint">${escaped(copy["JDRNINJA.streamDeck.enableHint"])}</p>`));
    assert.equal((html.match(/jdr-ninja__note/g) ?? []).length, 1);
    assert(html.includes(escaped(copy["JDRNINJA.streamDeck.note"])));
    assert(html.includes(escaped(copy["JDRNINJA.streamDeck.keyHint"])));
    // Every field is labelled and its hint is attached to it.
    for (const input of html.matchAll(/<input id="([\w-]+)"/g)) assert(html.includes(`for="${input[1]}"`), input[1]);
    for (const described of html.matchAll(/aria-describedby="([\w-]+)"/g)) assert(html.includes(`id="${described[1]}"`), described[1]);
  }
});

test("the new key shows only once generated, read-only and with its own label, and the footer follows the state", async () => {
  const idle = await renderTemplate("en");
  assert(!idle.html.includes("jdr-stream-deck-generated"));
  const shown = await renderTemplate("en", { generated: "g".repeat(64) });
  assert(/<input id="jdr-stream-deck-generated" type="text" value="g{64}" readonly/.test(shown.html));
  assert(shown.html.includes('for="jdr-stream-deck-generated"'));
  assert(shown.html.includes(escaped(shown.copy["JDRNINJA.streamDeck.generatedHint"])));
  const failed = await renderTemplate("en", { error: "Boom" });
  assert(/<p class="notice notice-error" role="alert" data-stream-deck-error >Boom<\/p>/.test(failed.html));
  // Nothing can be changed while an operation runs, and reconnecting needs the switch on, disconnecting a saved key.
  const busy = await renderTemplate("en", { busy: true });
  for (const action of ["save", "reconnect", "disconnect", "generate"]) assert(new RegExp(`data-action="${action}"[^>]*disabled`).test(busy.html), action);
  assert(/name="streamDeckEnabled" type="checkbox"[^>]*disabled/.test(busy.html));
  const off = await renderTemplate("en", { enabled: false, configured: false });
  assert(/data-action="reconnect" disabled/.test(off.html));
  assert(/data-action="disconnect" disabled/.test(off.html));
  assert(!/data-action="save"[^>]*disabled/.test(off.html));
  assert(!/name="streamDeckEnabled" type="checkbox" checked/.test(off.html));
});
