import { test } from "node:test";
import assert from "node:assert/strict";
import { streamDeckBridge } from "../scripts/stream-deck/bridge.js";

class Application {
  rendered = true;
  async render() { return this; }
  async close() { this.rendered = false; return this; }
  _onRender() {}
}
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } } };
const { StreamDeckPanel } = await import("../scripts/stream-deck/panel.js");

function fixture() {
  const settings = { streamDeckEnabled: true, streamDeckUrl: "ws://127.0.0.1:19114/jdr-ninja", streamDeckKey: "a".repeat(64) };
  const writes = [];
  globalThis.game = { user: { isGM: false }, i18n: { localize: key => key }, settings: {
    get: (_module, key) => settings[key], set: async (_module, key, value) => { writes.push([key, value]); settings[key] = value; },
  } };
  const panel = new StreamDeckPanel();
  const fields = { streamDeckUrl: { value: "wss://localhost:19114/jdr-ninja" }, streamDeckKey: { value: "b".repeat(64) },
    streamDeckEnabled: { addEventListener() {} }, status: {}, error: {} };
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

test("live status updates do not erase unsaved endpoint/key edits, and closing unsubscribes", async () => {
  const f = fixture(); f.panel._onRender({}, {});
  streamDeckBridge.notify("synchronizing");
  assert.equal(f.fields.status.textContent, "JDRNINJA.streamDeck.state.synchronizing");
  assert.equal(f.fields.streamDeckKey.value, "b".repeat(64));
  assert.equal(f.fields.streamDeckUrl.value, "wss://localhost:19114/jdr-ninja");
  await f.panel.close(); streamDeckBridge.notify("ready");
  assert.equal(f.fields.status.textContent, "JDRNINJA.streamDeck.state.synchronizing");
});

test("disconnect disables integration and removes the local key", async () => {
  const f = fixture(); f.panel._generated = "unsaved"; await f.panel._disconnect();
  assert.deepEqual(f.writes, [["streamDeckEnabled", false], ["streamDeckKey", ""]]);
  assert.equal(f.panel._generated, "");
});
