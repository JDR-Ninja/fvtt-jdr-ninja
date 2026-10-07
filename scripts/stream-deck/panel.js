import { MODULE_ID, I18N, SETTINGS } from "../constants.js";
import { streamDeckBridge } from "./bridge.js";
import { normalizeBridgeUrl, normalizeBridgeKey, randomNonce } from "./protocol.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const translate = key => game.i18n.localize(`${I18N}.streamDeck.${key}`);

export class StreamDeckPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;
  static open() {
    const panel = this.instance ??= new this();
    if (!panel.rendered) panel.render({ force: true });
    else { if (panel.minimized) void panel.maximize(); panel.bringToFront(); }
    return panel;
  }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-stream-deck", classes: ["jdr-ninja"], tag: "div",
    window: { title: `${I18N}.streamDeck.title`, icon: "fa-solid fa-table-cells", resizable: true },
    position: { width: 620, height: "auto" },
    actions: { save: StreamDeckPanel.prototype._save, reconnect: StreamDeckPanel.prototype._reconnect,
      generate: StreamDeckPanel.prototype._generate, disconnect: StreamDeckPanel.prototype._disconnect },
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/stream-deck.hbs` } };
  _busy = false;
  _error = "";
  _generated = "";
  async _prepareContext() {
    const status = streamDeckBridge.status();
    return { busy: this._busy, enabled: streamDeckBridge.enabled(), configured: status.configured,
      url: game.settings.get(MODULE_ID, SETTINGS.streamDeckUrl), generated: this._generated,
      status: translate(`state.${status.state}`), session: status.sessionId, revision: status.revision,
      error: this._error || (status.error ? translate(`error.${status.error}`) : "") };
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    this._unsubscribe ??= streamDeckBridge.subscribe(status => {
      if (!this.rendered || this._busy) return;
      // Live game updates must not erase a pairing key or endpoint being edited.
      const state = this.element.querySelector("[data-stream-deck-status]");
      if (state) state.textContent = translate(`state.${status.state}`);
      const error = this.element.querySelector("[data-stream-deck-error]");
      if (error) {
        error.textContent = this._error || (status.error ? translate(`error.${status.error}`) : "");
        error.hidden = !error.textContent;
      }
    });
    this.element.querySelector('[name="streamDeckEnabled"]')?.addEventListener("change", event =>
      this._run(() => game.settings.set(MODULE_ID, SETTINGS.streamDeckEnabled, event.currentTarget.checked)));
  }
  async _run(action) {
    if (this._busy) return;
    this._busy = true; this._error = "";
    try { await action(); }
    catch (error) { this._error = translate(`error.${error.code ?? "saveFailed"}`); }
    finally { this._busy = false; if (this.rendered) await this.render(); }
  }
  _save() {
    const url = this.element.querySelector('[name="streamDeckUrl"]')?.value;
    const entered = this.element.querySelector('[name="streamDeckKey"]')?.value?.trim();
    const token = entered || this._generated || game.settings.get(MODULE_ID, SETTINGS.streamDeckKey);
    return this._run(async () => {
      const endpoint = normalizeBridgeUrl(url), key = normalizeBridgeKey(token);
      // Avoid connecting between endpoint/key writes; changing either always invalidates the old session.
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckEnabled, false);
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckKey, "");
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckUrl, endpoint);
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckKey, key);
      this._generated = "";
    });
  }
  _generate() { this._generated = randomNonce(); return this.render(); }
  _reconnect() { streamDeckBridge.refresh(); }
  _disconnect() {
    return this._run(async () => {
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckEnabled, false);
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckKey, ""); this._generated = "";
    });
  }
  async close(options) {
    this._unsubscribe?.(); this._unsubscribe = null; this._generated = "";
    if (StreamDeckPanel.instance === this) StreamDeckPanel.instance = null;
    return super.close(options);
  }
}
