import { MODULE_ID, I18N, SETTINGS, SUBSCRIPTIONS_URL } from "./constants.js";
import { Connections } from "./auth/connections.js";
import { normalizeOrigin } from "./auth/origin.js";
import { AtlasSyncApp } from "./atlas/sync-app.js";
import { atlasEnabled, atlasAccess } from "./atlas/availability.js";
import { STATUS, localizeStatus } from "./atlas/constants.js";
import { OverlayPanel } from "./overlay/panel.js";
import { overlayRelay } from "./overlay/relay.js";
import { streamDeckBridge } from "./stream-deck/bridge.js";
import { StreamDeckPanel, PILL_ICONS, streamDeckPill, paintStreamDeckPill } from "./stream-deck/panel.js";
import { VariablePanel } from "./variables/panel.js";
import { MacroArgumentsPanel } from "./variables/macro-panel.js";
import { creatureClient } from "./creatures/api.js";
import { compatibilityContext } from "./creatures/compatibility.js";
import { MonsterGeneratorPanel, NpcGeneratorPanel, CT, creatureMessage } from "./creatures/panel.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const text = (key) => game.i18n.localize(`${I18N}.${key}`);

/** The pill of a JDR Ninja or Atlas connection: a successful check, a failed one, a saved token never checked, or nothing. */
export function connectionPill({ configured, verified, failed }) {
  const level = verified ? "success" : failed ? "error" : configured ? "warning" : "neutral";
  return { level, icon: PILL_ICONS[level] };
}

/** The creature states that only need a step from the user. Anything else the server reports is an error. */
const CREATURE_LEVELS = Object.freeze({ available: "success", notChecked: "neutral", disabled: "neutral",
  connectionRequired: "warning", devicePermissionRequired: "warning", tierRequired: "warning", incompatibleSystem: "warning" });
const CREATURE_CLEAN = new Set(["available", "notChecked", "disabled"]);
/**
 * The pill of the creatures card. A system that cannot import comes first (another game system is an error, an untested
 * version warns), then the access state. The pill carries a short label; a state that asks for a step also gets a message.
 */
export function creaturePill(status, compatibility) {
  if (compatibility?.compatible === false) {
    const level = compatibility.code === "dndRequired" ? "error" : "warning";
    return { level, icon: PILL_ICONS[level], label: compatibility.label, message: "" };
  }
  const level = CREATURE_LEVELS[status] ?? "error";
  const label = status === "available" || status === "notChecked" ? CT(`status.${status}`)
    : status === "disabled" ? text("panel.state.disabled")
    : level === "warning" ? text("panel.state.attention") : text("panel.state.unavailable");
  return { level, icon: PILL_ICONS[level], label, message: CREATURE_CLEAN.has(status) ? "" : creatureMessage(status) };
}

export class ConnectionPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instances = new Set();
  static instance = null;
  static refreshAll() {
    for (const panel of this._instances) if (panel.rendered) panel.render();
  }
  /** The one entry point: the settings menu, the other windows and the module API all reuse the open window. */
  static open() {
    const panel = this.instance ??= new this();
    if (!panel.rendered) panel.render({ force: true });
    else { if (panel.minimized) void panel.maximize(); panel.bringToFront(); }
    return panel;
  }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-connections", classes: ["jdr-ninja"], tag: "div",
    window: { title: `${I18N}.panel.title`, icon: "fa-solid fa-link", resizable: true },
    position: { width: 680, height: "auto" },
    actions: {
      pair: ConnectionPanel.prototype._pair,
      cancel: ConnectionPanel.prototype._cancel,
      checkAccount: ConnectionPanel.prototype._checkAccount,
      saveAccount: ConnectionPanel.prototype._saveAccount,
      disconnectAccount: ConnectionPanel.prototype._disconnectAccount,
      saveAtlas: ConnectionPanel.prototype._saveAtlas,
      checkAtlas: ConnectionPanel.prototype._checkAtlas,
      disconnectAtlas: ConnectionPanel.prototype._disconnectAtlas,
      manageAccount: ConnectionPanel.prototype._manageAccount,
      manageAtlas: ConnectionPanel.prototype._manageAtlas,
      openAtlas: ConnectionPanel.prototype._openAtlas,
      openOverlay: ConnectionPanel.prototype._openOverlay,
      openStreamDeck: ConnectionPanel.prototype._openStreamDeck,
      openVariables: ConnectionPanel.prototype._openVariables,
      openMacroArguments: ConnectionPanel.prototype._openMacroArguments,
      openMonster: ConnectionPanel.prototype._openMonster,
      openNpc: ConnectionPanel.prototype._openNpc,
      pairCreatures: ConnectionPanel.prototype._pairCreatures,
      checkCreatures: ConnectionPanel.prototype._checkCreatures,
    },
  };

  static PARTS = {
    // The content scrolls inside the window: its position survives the render that follows every action.
    body: { template: `modules/${MODULE_ID}/templates/connections.hbs`, scrollable: [".jn-scroll"] },
  };

  _connections = new Connections();
  _results = { account: null, atlas: null };
  _operation = null;
  _challenge = null;
  _unsubscribe = null;

  async _prepareContext() {
    const context = { busy: this._operation !== null, challenge: this._challenge,
      isGM: game.user?.isGM === true, deviceName: this._deviceName(), subscriptionsUrl: SUBSCRIPTIONS_URL };
    for (const kind of ["account", "atlas"]) {
      const config = this._connections.configuration(kind);
      const result = this._results[kind];
      const failed = result !== null && result !== undefined && !result.ok && result.reason !== "unconfigured";
      context[kind] = { ...config, label: result?.ok ? result.label : "",
        status: text(result?.ok ? "status.connected" : config.configured ? "status.saved" : "status.disconnected"),
        pill: connectionPill({ configured: config.configured, verified: result?.ok === true, failed }),
        error: failed ? text(`error.${result.reason}`) : "",
        limited: result?.ok && result.allowed === false,
        // The one link for a browser without an account; otherwise only once a check finds no overlay access.
        showSubscriptionLink: kind === "account" && (!config.configured || result?.ok === true && result.allowed === false),
      };
    }
    context.atlas.enabled = context.isGM && atlasEnabled();
    const access = atlasAccess();
    context.atlas.canSync = access.ok && context.atlas.configured;
    context.atlas.integrationNotice = context.isGM && !access.ok
      && access.status !== STATUS.GM_REQUIRED ? localizeStatus(access.status) : "";
    context.overlay = { enabled: overlayRelay.enabled(),
      notice: game.modules?.get("jdr-ninja-vtt-overlay")?.active ? text("overlay.error.legacyActive") : "" };
    context.streamDeck = { enabled: streamDeckBridge.enabled(), pill: streamDeckPill(streamDeckBridge.status().state) };
    const creatureStatus = creatureClient.local() ?? creatureClient.access?.reason ?? (creatureClient.access?.allowed ? "available" : "notChecked");
    const compatibility = compatibilityContext();
    const pill = creaturePill(creatureStatus, compatibility);
    const failure = this._results.creatures && !this._results.creatures.ok ? creatureMessage(this._results.creatures.reason) : "";
    context.creatures = { enabled: creatureClient.enabled(), compatibility, pill,
      // The last failed check has its own alert: the same sentence never shows twice.
      message: pill.message === failure ? "" : pill.message,
      showSubscriptionLink: creatureClient.needsSubscription(this._results.creatures?.reason),
      status: ["available", "notChecked"].includes(creatureStatus) ? CT(`status.${creatureStatus}`) : creatureMessage(creatureStatus),
      error: failure };
    return context;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    ConnectionPanel._instances.add(this);
    this.element.querySelector('[name="atlasEnabled"]')?.addEventListener("change", event => this._toggleAtlas(event));
    this.element.querySelector('[name="overlayEnabled"]')?.addEventListener("change", event => this._toggleOverlay(event));
    this.element.querySelector('[name="streamDeckEnabled"]')?.addEventListener("change", event => this._toggleStreamDeck(event));
    this.element.querySelector('[name="creaturesEnabled"]')?.addEventListener("change", event => this._toggleCreatures(event));
    // The Stream Deck bridge connects after its switch is set: the pill follows it without a new render.
    this._unsubscribe ??= streamDeckBridge.subscribe(status => {
      if (this.rendered) paintStreamDeckPill(this.element?.querySelector("[data-stream-deck-status]"), status.state);
    });
  }

  async _toggleAtlas(event) {
    if (game.user?.isGM !== true || this._operation) return;
    const checkbox = event.currentTarget;
    checkbox.disabled = true;
    try { await game.settings.set(MODULE_ID, SETTINGS.atlasEnabled, checkbox.checked); }
    catch { ui.notifications.error(text("error.saveFailed")); }
    finally { if (this.rendered) await this.render(); }
  }

  _openAtlas() { return AtlasSyncApp.open(); }
  _openOverlay() { return OverlayPanel.open(); }
  _openStreamDeck() { return StreamDeckPanel.open(); }
  _openVariables() { return VariablePanel.open(); }
  _openMacroArguments() { return MacroArgumentsPanel.open(); }
  _openMonster() { return MonsterGeneratorPanel.open(); }
  _openNpc() { return NpcGeneratorPanel.open(); }
  async _toggleCreatures(event) {
    if (game.user?.isGM !== true || this._operation) return;
    event.currentTarget.disabled = true;
    try { await game.settings.set(MODULE_ID, SETTINGS.creaturesEnabled, event.currentTarget.checked); }
    catch { ui.notifications.error(text("error.saveFailed")); }
    finally { if (this.rendered) await this.render(); }
  }
  _checkCreatures() {
    return this._run("creatures", async signal => {
      try { await creatureClient.check(signal); return { ok: true }; }
      catch (error) { return { ok: false, reason: error.code ?? "verificationUnavailable" }; }
    });
  }
  async _toggleStreamDeck(event) {
    if (this._operation) return;
    event.currentTarget.disabled = true;
    try { await game.settings.set(MODULE_ID, SETTINGS.streamDeckEnabled, event.currentTarget.checked); }
    catch { ui.notifications.error(text("error.saveFailed")); }
    finally { if (this.rendered) await this.render(); }
  }
  async _toggleOverlay(event) {
    if (this._operation) return;
    const checkbox = event.currentTarget;
    checkbox.disabled = true;
    try { await game.settings.set(MODULE_ID, SETTINGS.overlayEnabled, checkbox.checked); }
    catch { ui.notifications.error(text("error.saveFailed")); }
    finally { if (this.rendered) await this.render(); }
  }

  _deviceName() {
    return [game.world?.title || "Foundry VTT", game.user?.name || ""].filter(Boolean).join(" / ").slice(0, 100);
  }

  _field(name) { return String(this.element?.querySelector(`[name="${name}"]`)?.value ?? "").trim(); }

  async _run(kind, action) {
    if (this._operation) return;
    const controller = new AbortController();
    this._operation = controller;
    try {
      await this.render();
      if (controller.signal.aborted) return;
      const result = await action(controller.signal);
      if (!controller.signal.aborted) this._results[kind] = result;
    } catch {
      if (!controller.signal.aborted) this._results[kind] = { ok: false, reason: "saveFailed" };
    } finally {
      this._operation = null;
      this._challenge = null;
      if (this.rendered) await this.render();
    }
  }

  async _pair() {
    return this._pairWithCapabilities([]);
  }
  _pairCreatures() {
    if (game.user?.isGM !== true) return;
    return this._pairWithCapabilities(["dnd-creatures"]);
  }
  async _pairWithCapabilities(requestedCapabilities) {
    const origin = this._field("accountOrigin");
    const deviceName = this._field("deviceName") || this._deviceName();
    return this._run("account", (signal) => this._connections.pairAccount({ origin, deviceName, signal, requestedCapabilities,
      onChallenge: async (challenge) => {
        if (signal.aborted) return;
        this._challenge = challenge;
        if (this.rendered) await this.render();
      },
    }));
  }

  _cancel() { this._operation?.abort(); }
  _checkAccount() { return this._run("account", (signal) => this._connections.check("account", { signal })); }
  _checkAtlas() { return this._run("atlas", (signal) => this._connections.check("atlas", { signal })); }

  _saveAccount() { return this._save("account"); }
  _saveAtlas() { return this._save("atlas"); }

  _save(kind) {
    const origin = this._field(`${kind}Origin`);
    const token = this._field(`${kind}Token`);
    return this._run(kind, (signal) => this._connections.connect(kind, { origin, token, signal }));
  }

  _disconnectAccount() { return this._run("account", () => this._connections.disconnect("account")); }
  _disconnectAtlas() { return this._run("atlas", () => this._connections.disconnect("atlas")); }

  _manageAccount() { this._open("account", "/vtt-overlay/foundry"); }
  _manageAtlas() { this._open("atlas", "/dojo/connexions-foundry"); }

  _open(kind, path) {
    try {
      const origin = normalizeOrigin(this._connections.configuration(kind).origin);
      window.open(`${origin}${path}`, "_blank", "noopener,noreferrer");
    } catch { ui.notifications.error(text("error.invalidOrigin")); }
  }

  async close(options) {
    this._operation?.abort();
    this._unsubscribe?.(); this._unsubscribe = null;
    ConnectionPanel._instances.delete(this);
    if (ConnectionPanel.instance === this) ConnectionPanel.instance = null;
    return super.close(options);
  }
}
