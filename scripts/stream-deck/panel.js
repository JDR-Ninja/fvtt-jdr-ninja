import { MODULE_ID, I18N, SETTINGS } from "../constants.js";
import { streamDeckBridge } from "./bridge.js";
import { normalizeBridgeUrl, normalizeBridgeKey, randomNonce } from "./protocol.js";
import { VariablePanel } from "../variables/panel.js";
import { MacroArgumentsPanel } from "../variables/macro-panel.js";
import { streamDeckPill, paintStreamDeckPill } from "../ui/states.js";
import { openSingleton, releaseSingleton } from "../ui/window.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const translate = key => game.i18n.localize(`${I18N}.streamDeck.${key}`);

export { STREAM_DECK_LEVELS, streamDeckPill, paintStreamDeckPill } from "../ui/states.js";

export class StreamDeckPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;
  static open() { return openSingleton(this); }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-stream-deck", classes: ["jdr-ninja"], tag: "div",
    window: { title: `${I18N}.streamDeck.title`, icon: "fa-solid fa-table-cells", resizable: true },
    position: { width: 600, height: "auto" },
    actions: { save: StreamDeckPanel.prototype._save, reconnect: StreamDeckPanel.prototype._reconnect,
      generate: StreamDeckPanel.prototype._generate, disconnect: StreamDeckPanel.prototype._disconnect,
      openVariables: StreamDeckPanel.prototype._openVariables, openMacroArguments: StreamDeckPanel.prototype._openMacroArguments },
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/stream-deck.hbs`, scrollable: [".jn-scroll"] } };
  _busy = false;
  _error = "";
  _generated = "";
  async _prepareContext() {
    const status = streamDeckBridge.status();
    return { busy: this._busy, enabled: streamDeckBridge.enabled(), configured: status.configured,
      url: game.settings.get(MODULE_ID, SETTINGS.streamDeckUrl), generated: this._generated,
      pill: streamDeckPill(status.state), session: status.sessionId, revision: status.revision,
      error: this._error || (status.error ? translate(`error.${status.error}`) : "") };
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    this._unsubscribe ??= streamDeckBridge.subscribe(status => {
      if (!this.rendered || this._busy) return;
      // Live game updates must not erase a pairing key or endpoint being edited.
      paintStreamDeckPill(this.element.querySelector("[data-stream-deck-status]"), status.state);
      const error = this.element.querySelector("[data-stream-deck-error]");
      if (error) {
        error.textContent = this._error || (status.error ? translate(`error.${status.error}`) : "");
        error.hidden = !error.textContent;
      }
    });
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
      // Saving is the explicit consent a new key needs: the same button also switches back on a Stream Deck turned off from Connections.
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckEnabled, true);
      this._generated = "";
    });
  }
  _generate() { this._generated = randomNonce(); return this.render(); }
  _reconnect() { streamDeckBridge.refresh(); }
  _openVariables() { return VariablePanel.open(); }
  _openMacroArguments() { return MacroArgumentsPanel.open(); }
  _disconnect() {
    return this._run(async () => {
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckEnabled, false);
      await game.settings.set(MODULE_ID, SETTINGS.streamDeckKey, ""); this._generated = "";
    });
  }
  async close(options) {
    this._unsubscribe?.(); this._unsubscribe = null; this._generated = "";
    releaseSingleton(this);
    return super.close(options);
  }
}
