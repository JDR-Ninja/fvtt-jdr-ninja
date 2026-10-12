import { MODULE_ID, I18N, SETTINGS, SUBSCRIPTIONS_URL } from "./constants.js";
import { Connections } from "./auth/connections.js";
import { normalizeOrigin } from "./auth/origin.js";
import { AtlasSyncApp } from "./atlas/sync-app.js";
import { atlasEnabled, atlasAccess } from "./atlas/availability.js";
import { STATUS, localizeStatus } from "./atlas/constants.js";
import { OverlayPanel } from "./overlay/panel.js";
import { overlayRelay, LEGACY_OVERLAY_ID } from "./overlay/relay.js";
import { streamDeckBridge } from "./stream-deck/bridge.js";
import { StreamDeckPanel, streamDeckPill, paintStreamDeckPill } from "./stream-deck/panel.js";
import { creatureClient } from "./creatures/api.js";
import { compatibilityContext } from "./creatures/compatibility.js";
import { PILL_ICONS, CT, creatureMessage } from "./creatures/panel.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const text = (key) => game.i18n.localize(`${I18N}.${key}`);

/*
 * Every block of the window (the account banner, then one row per feature) derives a state, a pill and at most one step
 * from plain data here, so the template only renders what it receives and the tests need no rendering.
 * A step is one sentence with at most one button or link; a failure is an alert, anything else a status.
 */
const pill = (level, label, icon = PILL_ICONS[level]) => ({ level, icon, label });
const step = (level, sentence, extra = {}) => ({ level, role: level === "error" ? "alert" : "status", text: sentence, ...extra });
const control = (name, label, icon, variant = "") => ({ name, label, icon, variant });
const subscriptions = kind => ({ href: SUBSCRIPTIONS_URL, label: text("creatures.subscription"), kind });
const disabledState = () => ({ state: "disabled", pill: pill("neutral", text("panel.state.disabled")), step: null });
const checkingState = () => ({ state: "checking", pill: pill("info", text("panel.state.checking"), "fa-spinner fa-spin"), step: null });
const accountRequired = () => ({ state: "accountRequired", pill: pill("warning", text("panel.state.accountRequired")),
  step: step("warning", text("panel.step.connectAccount")) });

/** A refused token, or an answer that is not a Foundry account, needs a new connection; any other failure can be retried. */
const ACCOUNT_REJECTED = new Set(["unauthorized", "invalidResponse"]);
/**
 * What is known of the saved account credential: `none`, `checking`, `verified`, failed (`retry` or `reconnect`), or
 * `unchecked` while no answer describes it. The features that need the account follow this state.
 */
export function accountStatus({ configured, result = null, checking = false }) {
  if (checking) return "checking";
  if (!configured) return "none";
  if (result?.ok) return "verified";
  if (result && result.reason !== "unconfigured") return ACCOUNT_REJECTED.has(result.reason) ? "reconnect" : "retry";
  return "unchecked";
}

const ACCOUNT_PILLS = Object.freeze({ none: ["neutral", "status.disconnected"], verified: ["success", "status.connected"],
  retry: ["error", "panel.state.error"], reconnect: ["error", "panel.state.error"], unchecked: ["warning", "status.saved"] });
/**
 * The account banner: its pill, the account name once verified, the failure message and the actions of the state.
 * A pairing or pasted token that failed (`error`) is shown without changing what is known of the saved credential.
 */
export function accountState({ configured, result = null, checking = false, pairing = false, error = "" }) {
  const status = accountStatus({ configured, result, checking }), state = pairing ? "pairing" : status;
  const actions = {
    none: [control("pair", text("account.connect"), "fa-link", "bright")], pairing: [], checking: [],
    verified: [control("pair", text("account.change"), "fa-link")], retry: [control("checkAccount", text("button.retry"), "fa-rotate")],
    reconnect: [control("pair", text("button.reconnect"), "fa-link")], unchecked: [control("checkAccount", text("button.check"), "fa-rotate")],
  }[state];
  // Disconnecting stays possible while a token is saved, failures included.
  if (configured && state !== "pairing") actions.push(control("disconnectAccount", text("button.disconnect"), "fa-link-slash", "jn-danger"));
  const [level, key] = ACCOUNT_PILLS[state] ?? [];
  return { state, status, actions, label: state === "verified" ? result.label : "",
    pill: state === "pairing" ? pill("info", text("panel.state.pending"), "fa-hourglass-half") : state === "checking" ? checkingState().pill : pill(level, text(key)),
    intro: state === "none" ? text("account.needed") : "", link: state === "none" ? subscriptions("account") : null,
    error: error || (state === "retry" || state === "reconnect" ? text(`error.${result.reason}`) : "") };
}

/** The Stream Deck row: the bridge's own pill, repainted live, and the one step a missing companion key needs. */
export function streamDeckState(bridgeState) {
  return { state: bridgeState, pill: streamDeckPill(bridgeState),
    step: bridgeState === "unconfigured" ? step("warning", text("panel.step.streamDeckKey")) : null };
}

/** The overlay sends this browser's public rolls with the account: it needs the account verified and a subscription. */
export function overlayState({ enabled, legacy = false, account, allowed = false }) {
  if (!enabled) return disabledState();
  if (legacy) return { state: "unavailable", pill: pill("error", text("panel.state.unavailable")), step: step("error", text("overlay.error.legacyActive")) };
  if (account === "none") return accountRequired();
  if (account === "checking") return checkingState();
  if (account === "verified") {
    return allowed ? { state: "active", pill: pill("success", text("panel.state.active")), step: null }
      : { state: "subscriptionRequired", pill: pill("warning", text("panel.state.subscriptionRequired")),
        step: step("warning", text("overlay.error.notEntitled"), { link: subscriptions("overlay") }) };
  }
  return { state: "attention", pill: pill("warning", text("panel.state.attention")),
    step: step("warning", text(account === "reconnect" ? "panel.step.reconnectAccount" : "panel.step.checkAccount")) };
}

/** Server answers that need the account reconnected rather than a new check. */
const CREATURE_RECONNECT = new Set(["unauthorized", "wrongDeviceKind"]);
/**
 * The creatures row. A system that cannot import comes first (another game system is an error, an untested version
 * warns), then the local switch and account, then the access the server reported. Only a missing device permission
 * offers `pairCreatures`; an available service has an information line and no button.
 */
export function creatureState({ compatibility, restriction = null, access = null, result = null, checking = false }) {
  if (compatibility?.compatible === false) {
    const level = compatibility.code === "dndRequired" ? "error" : "warning";
    return { state: "incompatible", pill: pill(level, compatibility.label),
      step: step(level, compatibility.current, { detail: CT("error.incompatibleSystem") }) };
  }
  if (restriction === "disabled" || restriction === "notGM") return disabledState();
  if (restriction === "connectionRequired") return accountRequired();
  if (checking) return checkingState();
  // A grant wins over an older failure of this window; a failure of this window wins over a refusal reported elsewhere.
  const reason = access?.allowed ? "available" : result?.ok === false ? result.reason
    : access ? access.reason || "verificationUnavailable" : "notChecked";
  if (reason === "available") return { state: reason, pill: pill("success", CT("status.available")), step: step("info", text("panel.step.creaturesAvailable")) };
  if (reason === "devicePermissionRequired") {
    return { state: reason, pill: pill("warning", text("panel.state.permissionRequired")),
      step: step("warning", text("panel.step.devicePermission"), { action: control("pairCreatures", text("creatures.authorize"), "fa-key") }) };
  }
  if (reason === "tierRequired") {
    return { state: reason, pill: pill("warning", text("panel.state.subscriptionRequired")),
      step: step("warning", creatureMessage(reason), { link: subscriptions("creatures") }) };
  }
  if (reason === "notChecked") {
    return { state: reason, pill: pill("neutral", CT("status.notChecked")),
      step: step("info", "", { action: control("checkCreatures", text("button.check"), "fa-rotate") }) };
  }
  if (CREATURE_RECONNECT.has(reason)) return { state: "attention", pill: pill("warning", text("panel.state.attention")), step: step("warning", text("panel.step.reconnectAccount")) };
  return { state: "unavailable", pill: pill("error", text("panel.state.unavailable")),
    step: step("error", creatureMessage(reason), { action: control("checkCreatures", text("button.retry"), "fa-rotate") }) };
}

/**
 * The Atlas row, shared by every GM of the world. The token field sits in the row while a token is missing or refused.
 * A pasted token that failed (`error`) replaces the sentence of the step without changing the state of the saved one.
 */
export function atlasState({ enabled, notice = "", configured, result = null, checking = false, error = "" }) {
  const row = notice ? { state: "unavailable", pill: pill("error", text("panel.state.unavailable")), step: step("error", notice) }
    : !enabled ? disabledState()
    : checking ? checkingState()
    : !configured ? { state: "tokenRequired", pill: pill("warning", text("panel.state.tokenRequired")), step: step("warning", "", { field: true }) }
    : result?.ok && result.allowed ? { state: "connected", pill: pill("success", text("status.connected")), step: null }
    : result?.ok ? { state: "subscriptionRequired", pill: pill("warning", text("panel.state.subscriptionRequired")),
      step: step("warning", text("atlas.limited"), { link: subscriptions("atlas") }) }
    : result?.reason === "unauthorized" ? { state: "rejected", pill: pill("error", text("panel.state.error")), step: step("error", text("error.unauthorized"), { field: true }) }
    : result && result.reason !== "unconfigured" ? { state: "failed", pill: pill("error", text("panel.state.error")),
      step: step("error", text(`error.${result.reason}`), { action: control("checkAtlas", text("button.retry"), "fa-rotate") }) }
    : { state: "unchecked", pill: pill("warning", text("status.saved")), step: step("info", "", { action: control("checkAtlas", text("button.check"), "fa-rotate") }) };
  if (error) row.step = { ...row.step, ...step("error", error) };
  return { ...row, label: result?.ok ? result.label : "" };
}

/** Pages that revoke a credential on the site, opened from the advanced options and from the disconnect confirmation. */
const MANAGE_PATHS = Object.freeze({ account: "/vtt-overlay/foundry", atlas: "/dojo/connexions-foundry" });
/** An aborted check, or one whose credential changed underneath it, answers nothing. */
const checkCreatureAccess = signal => creatureClient.check(signal).then(() => ({ ok: true }),
  error => ["cancelled", "staleState"].includes(error?.code) ? null : { ok: false, reason: error?.code ?? "verificationUnavailable" });

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
    position: { width: 600, height: "auto" },
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
      pairCreatures: ConnectionPanel.prototype._pairCreatures,
      checkCreatures: ConnectionPanel.prototype._checkCreatures,
    },
  };

  static PARTS = {
    // The content scrolls inside the window: its position survives the render that follows every action.
    body: { template: `modules/${MODULE_ID}/templates/connections.hbs`, scrollable: [".jn-scroll"] },
  };

  _connections = new Connections();
  /** The last answer about each connection, stamped with the credential it describes. */
  _results = { account: null, atlas: null, creatures: null };
  /** The message of the last failed pairing or pasted token, which leaves the saved credential as it was. */
  _errors = { account: "", atlas: "" };
  /** Automatic checks in flight. They never use `_operation`: the window stays usable while they run. */
  _checks = { account: null, atlas: null, creatures: null };
  _operation = null;
  _operationKind = null;
  _pairing = null;
  _challenge = null;
  _opened = false;
  _unsubscribe = null;

  async _prepareContext(options) {
    // The first render starts the automatic checks before reading the state: the window opens on « Checking ».
    if (options?.isFirstRender) this._checkOnOpen();
    const busy = this._operation !== null, isGM = game.user?.isGM === true;
    const checking = kind => Boolean(this._checks[kind]) || this._operationKind === kind && !this._pairing;
    const open = (name, label, icon, unavailable = false) => ({ name, label, icon, disabled: busy || unavailable });
    const accountConfig = this._connections.configuration("account"), atlasConfig = this._connections.configuration("atlas");
    const account = { ...accountState({ configured: accountConfig.configured, result: this._result("account"), checking: checking("account"),
      pairing: this._pairing !== null, error: this._errors.account }), origin: accountConfig.origin };
    const features = [
      { id: "stream-deck", icon: "fa-table-cells", name: text("streamDeck.title"), summary: text("panel.summary.streamDeck"),
        input: "streamDeckEnabled", enabled: streamDeckBridge.enabled(), live: true, info: text("streamDeck.enableHint"),
        open: open("openStreamDeck", text("streamDeck.open"), "fa-sliders"), ...streamDeckState(streamDeckBridge.status().state) },
      { id: "overlay", icon: "fa-tower-broadcast", name: text("overlay.title"), summary: text("panel.summary.overlay"),
        input: "overlayEnabled", enabled: overlayRelay.enabled(), open: open("openOverlay", text("overlay.open"), "fa-sliders"),
        ...overlayState({ enabled: overlayRelay.enabled(), legacy: game.modules?.get(LEGACY_OVERLAY_ID)?.active === true,
          account: account.status, allowed: this._result("account")?.allowed === true }) },
    ];
    const atlas = { configured: atlasConfig.configured, origin: atlasConfig.origin, tokenInAdvanced: false };
    if (isGM) {
      const compatibility = compatibilityContext();
      features.push({ id: "creatures", icon: "fa-dragon", name: text("creatures.heading"), summary: text("panel.summary.creatures"),
        input: "creaturesEnabled", enabled: creatureClient.enabled(), open: null, compatibility: compatibility.code,
        ...creatureState({ compatibility, restriction: creatureClient.local(), access: creatureClient.access,
          result: this._result("creatures"), checking: checking("creatures") }) });
      const access = atlasAccess();
      // A world switched off is the « Disabled » state, not a blocked integration.
      const notice = access.ok || [STATUS.GM_REQUIRED, STATUS.INTEGRATION_DISABLED].includes(access.status) ? "" : localizeStatus(access.status);
      const row = atlasState({ enabled: atlasEnabled(), notice, configured: atlasConfig.configured, result: this._result("atlas"),
        checking: checking("atlas"), error: this._errors.atlas });
      features.push({ id: "atlas", icon: "fa-globe", name: game.i18n.localize("JDRNINJA_ATLAS_SYNC.app.title"),
        summary: row.label ? game.i18n.format(`${I18N}.panel.summary.atlasWorld`, { name: row.label }) : text("panel.summary.atlas"),
        input: "atlasEnabled", enabled: atlasEnabled(), open: open("openAtlas", text("atlas.openSync"), "fa-arrows-rotate", !(access.ok && atlasConfig.configured)), ...row });
      // `_field()` reads the first field of a name: the token field is in the row or in the advanced options, never both.
      atlas.tokenInAdvanced = atlasConfig.configured && !row.step?.field;
    }
    return { busy, isGM, challenge: this._challenge, pairingCreatures: this._pairing?.creatures === true,
      deviceName: this._deviceName(), account, atlas, features };
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

  /** A redraw keeps what is being typed; an explicit operation, which has read its fields, starts from the saved state. */
  _replaceHTML(result, content, options) {
    const typed = options?.resetFields ? [] : [...content.querySelectorAll('input[name]:not([type="checkbox"])')]
      .filter(input => input.value !== input.defaultValue).map(input => [input.name, input.value]);
    super._replaceHTML?.(result, content, options);
    for (const [name, value] of typed) {
      const input = content.querySelector(`input[name="${name}"]`);
      if (input) input.value = value;
    }
  }

  async _toggleAtlas(event) {
    if (game.user?.isGM !== true || this._operation) return;
    const checkbox = event.currentTarget, enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      await game.settings.set(MODULE_ID, SETTINGS.atlasEnabled, enabled);
      // A saved world token is checked as the switch turns on, as it is when the window opens.
      if (enabled && this._connections.configuration("atlas").configured && !this._result("atlas")) this._autoCheck("atlas");
    } catch { ui.notifications.error(text("error.saveFailed")); }
    finally { if (this.rendered) await this.render(); }
  }

  _openAtlas() { return AtlasSyncApp.open(); }
  _openOverlay() { return OverlayPanel.open(); }
  _openStreamDeck() { return StreamDeckPanel.open(); }
  async _toggleCreatures(event) {
    if (game.user?.isGM !== true || this._operation) return;
    const checkbox = event.currentTarget, enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      await game.settings.set(MODULE_ID, SETTINGS.creaturesEnabled, enabled);
      if (enabled) this._checkCreatureAccess();
    } catch { ui.notifications.error(text("error.saveFailed")); }
    finally { if (this.rendered) await this.render(); }
  }
  _checkCreatures() { return this._run("creatures", checkCreatureAccess); }
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

  /** What a result is valid for: the saved origin and token of a connection, or the creature client's credential revision. */
  _stamp(kind) {
    if (kind === "creatures") return creatureClient.revision;
    const settings = this._connections.settings;
    return JSON.stringify([settings.get(MODULE_ID, SETTINGS[`${kind}Origin`]), settings.get(MODULE_ID, SETTINGS[`${kind}Token`])]);
  }
  /** The last answer about a connection, only while it still describes the saved credential. */
  _result(kind) {
    const result = this._results[kind];
    return result && result.stamp === this._stamp(kind) ? result : null;
  }

  /** Once per opening: the saved connections and an unknown creature access are checked in the background. */
  _checkOnOpen() {
    if (this._opened) return;
    this._opened = true;
    if (this._connections.configuration("account").configured) this._autoCheck("account");
    if (game.user?.isGM === true && atlasEnabled() && this._connections.configuration("atlas").configured) this._autoCheck("atlas");
    this._checkCreatureAccess();
  }
  /** Creature access is checked when nothing restricts it locally and neither the Actors directory nor this window knows it. */
  _checkCreatureAccess() {
    if (!creatureClient.local() && !creatureClient.access && !this._result("creatures")) this._autoCheck("creatures");
  }
  /**
   * A background check: no busy footer, the controls stay usable and only its own pill shows « Checking ». A failure is
   * never retried automatically, and an answer for a credential that changed meanwhile is dropped.
   */
  _autoCheck(kind) {
    if (this._checks[kind] || this._operationKind === kind) return;
    const controller = new AbortController(), stamp = this._stamp(kind);
    this._checks[kind] = controller;
    const check = kind === "creatures" ? checkCreatureAccess(controller.signal) : this._connections.check(kind, { signal: controller.signal });
    void check.then(result => {
      if (result && !controller.signal.aborted && stamp === this._stamp(kind)) this._results[kind] = { ...result, stamp };
    }).catch(() => {}).finally(() => {
      if (this._checks[kind] !== controller) return;
      this._checks[kind] = null;
      if (this.rendered) void this.render();
    });
  }
  _stopCheck(kind) {
    this._checks[kind]?.abort();
    this._checks[kind] = null;
  }

  /**
   * One explicit operation at a time, with the busy footer. It replaces the automatic check of the same connection.
   * A pairing or a pasted token (`attempt`) that fails leaves the saved credential and its state as they were.
   */
  async _run(kind, action, { attempt = false, pairing = null } = {}) {
    if (this._operation) return;
    const controller = new AbortController();
    this._stopCheck(kind);
    Object.assign(this, { _operation: controller, _operationKind: kind, _pairing: pairing });
    if (kind in this._errors) this._errors[kind] = "";
    try {
      await this.render({ resetFields: true });
      if (controller.signal.aborted) return;
      const result = await action(controller.signal);
      if (!controller.signal.aborted && result) this._settle(kind, result, attempt);
    } catch {
      if (!controller.signal.aborted) this._settle(kind, { ok: false, reason: "saveFailed" }, attempt);
    } finally {
      Object.assign(this, { _operation: null, _operationKind: null, _pairing: null, _challenge: null });
      if (this.rendered) await this.render({ resetFields: true });
    }
  }
  _settle(kind, result, attempt) {
    if (attempt && !result.ok) {
      if (result.reason !== "cancelled") this._errors[kind] = text(`error.${result.reason}`);
      return;
    }
    this._results[kind] = { ...result, stamp: this._stamp(kind) };
    // A newly connected account has its creature access checked at once; a check of the previous credential is obsolete.
    if (kind === "account" && result.ok) {
      if (attempt) this._stopCheck("creatures");
      this._checkCreatureAccess();
    }
  }

  _pair() {
    // A GM who enabled creatures asks for their permission in the same approval: the site shows it as a separate choice.
    return this._pairWithCapabilities(game.user?.isGM === true && creatureClient.enabled() ? ["dnd-creatures"] : []);
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
    }), { attempt: true, pairing: { creatures: requestedCapabilities.length > 0 } });
  }

  _cancel() { this._operation?.abort(); }
  _checkAccount() { return this._run("account", (signal) => this._connections.check("account", { signal })); }
  _checkAtlas() { return this._run("atlas", (signal) => this._connections.check("atlas", { signal })); }

  _saveAccount() { return this._save("account"); }
  _saveAtlas() { return this._save("atlas"); }

  _save(kind) {
    const origin = this._field(`${kind}Origin`);
    const token = this._field(`${kind}Token`);
    return this._run(kind, (signal) => this._connections.connect(kind, { origin, token, signal }), { attempt: true });
  }

  async _disconnectAccount() {
    if (await this._confirmDisconnect("account")) return this._run("account", () => this._connections.disconnect("account"));
  }
  async _disconnectAtlas() {
    if (await this._confirmDisconnect("atlas")) return this._run("atlas", () => this._connections.disconnect("atlas"));
  }
  /** Disconnecting only forgets the token here: the confirmation says so and links to the page that revokes it. */
  async _confirmDisconnect(kind) {
    if (this._operation) return false;
    const escape = foundry.utils.escapeHTML, url = this._manageUrl(kind);
    const paragraphs = kind === "atlas" ? [text("atlas.disconnectHint"), text("atlas.disconnectWorld")] : [text("account.disconnectHint")];
    const link = url ? `<p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(text(`${kind}.manage`))}</a></p>` : "";
    const answer = await foundry.applications.api.DialogV2.confirm({ modal: true, classes: ["jdr-ninja"],
      window: { title: text(`${kind}.disconnectTitle`), icon: "fa-solid fa-link-slash" },
      content: `${paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join("")}${link}`,
      yes: { label: text("button.disconnect"), icon: "fa-solid fa-link-slash", class: "jn-danger" },
      no: { label: text("button.cancel"), icon: "fa-solid fa-ban" } });
    return answer === true;
  }

  _manageAccount() { this._open("account"); }
  _manageAtlas() { this._open("atlas"); }

  /** The management page on the saved site, or nothing when the saved address is not a valid origin. */
  _manageUrl(kind) {
    try { return `${normalizeOrigin(this._connections.configuration(kind).origin)}${MANAGE_PATHS[kind]}`; }
    catch { return ""; }
  }
  _open(kind) {
    const url = this._manageUrl(kind);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else ui.notifications.error(text("error.invalidOrigin"));
  }

  async close(options) {
    this._operation?.abort();
    for (const kind of Object.keys(this._checks)) this._stopCheck(kind);
    this._unsubscribe?.(); this._unsubscribe = null;
    ConnectionPanel._instances.delete(this);
    if (ConnectionPanel.instance === this) ConnectionPanel.instance = null;
    return super.close(options);
  }
}
