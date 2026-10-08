import { MODULE_ID, I18N, SETTINGS, DEFAULT_ORIGIN } from "../constants.js";
import { normalizeOrigin } from "../auth/origin.js";
import { overlayRelay } from "./relay.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = key => game.i18n.localize(`${I18N}.overlay.${key}`);
const Fmt = (key, values) => game.i18n.format(`${I18N}.overlay.${key}`, values);

const PILLS = { ok: { level: "success", icon: "fa-circle-check" }, warning: { level: "warning", icon: "fa-triangle-exclamation" },
  error: { level: "error", icon: "fa-circle-xmark" } };

/**
 * The pill of each diagnostics line, from the account's answer alone. `ok` also picks the line's message. A missing
 * subscription or overlay stops rolls from reaching the stream (`error`); no OBS source or no recent command poll
 * leaves the rest working (`warning`). The account line is a plain value and gets no pill.
 */
export function diagnosticStatus(data) {
  const line = (ok, failure) => ({ ok, ...(ok ? PILLS.ok : PILLS[failure]) });
  return {
    subscription: line(Boolean(data?.entitled), "error"),
    overlay: line(Boolean(data?.overlay?.exists && data.overlay.enabled), "error"),
    obs: line(data?.overlay?.connectedClients > 0, "warning"),
    poll: line(Number.isFinite(data?.tableCommands?.secondsSinceLastPoll), "warning"),
  };
}

/** A moment in Foundry's language, short and without seconds. Null for a missing or unreadable one. */
export function formatMoment(value, locale, { timeZone } = {}) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const options = { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) };
  try { return new Intl.DateTimeFormat(locale, options).format(date); }
  catch { return new Intl.DateTimeFormat(undefined, options).format(date); }
}

export class OverlayPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Set();
  static instance = null;
  static open() {
    const panel = this.instance ??= new this();
    if (!panel.rendered) panel.render({ force: true });
    else { if (panel.minimized) void panel.maximize(); panel.bringToFront(); }
    return panel;
  }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-overlay", classes: ["jdr-ninja", "jdr-ninja-overlay"], tag: "div",
    window: { title: `${I18N}.overlay.title`, icon: "fa-solid fa-dice-d20", resizable: true },
    position: { width: 620, height: "auto" },
    actions: {
      diagnostics: OverlayPanel.prototype._check,
      testRoll: OverlayPanel.prototype._test,
      connections: OverlayPanel.prototype._connections,
      commands: OverlayPanel.prototype._commands,
      subscription: OverlayPanel.prototype._subscription,
      cancel: OverlayPanel.prototype._cancel,
    },
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/overlay.hbs` } };
  _controller = null;
  _diagnostics = null;
  _error = "";

  /** A new account credential: the running check and the diagnostics belong to the old account. */
  static refreshAll() {
    for (const panel of this.instances) {
      panel._controller?.abort();
      panel._diagnostics = null;
      panel._error = "";
      if (panel.rendered) void panel.render();
    }
  }

  /** A local switch or preference: the diagnostics still describe the account, only the controls change. */
  static renderAll() {
    for (const panel of this.instances) if (panel.rendered) void panel.render();
  }

  async _prepareContext() {
    const relay = overlayRelay;
    const access = relay.access({ requireEnabled: false });
    const data = this._diagnostics;
    const rows = [];
    const push = (key, message, pill) => rows.push({ label: L(`diag.${key}`), message, level: pill?.level ?? null, icon: pill?.icon ?? null });
    if (data) {
      const status = diagnosticStatus(data);
      push("account", data.account);
      push("subscription", L(status.subscription.ok ? "diag.allowed" : "error.notEntitled"), status.subscription);
      push("overlay", L(status.overlay.ok ? "diag.overlayActive" : "error.overlayDisabled"), status.overlay);
      push("obs", status.obs.ok ? Fmt("diag.obsConnected", { count: data.overlay.connectedClients }) : L("diag.obsMissing"), status.obs);
      if (game.user?.isGM) push("poll", status.poll.ok
        ? Fmt("diag.pollRecent", { seconds: data.tableCommands.secondsSinceLastPoll }) : L("diag.pollMissing"), status.poll);
    }
    const choices = (values, current, label) => values.map(value => ({ value,
      label: L(label(value)), selected: value === current }));
    const success = Number(relay.setting("overlayLastSuccessAt")) || 0;
    const failure = Number(relay.setting("overlayLastErrorAt")) || 0;
    const when = formatMoment(success, game.i18n.lang);
    return { busy: this._controller !== null, enabled: relay.enabled(), isGM: game.user?.isGM === true,
      tableCommands: relay.setting("overlayTableCommandsEnabled") === true,
      canCheck: access.ok, canTest: relay.access().ok && data?.entitled !== false,
      notice: access.ok ? "" : relay.errorText(access.reason), error: this._error,
      filters: choices(["allPublic", "playersOnly"], relay.setting("overlayForwardFilter") ?? "allPublic", value => value),
      holds: choices(["0", "1", "2", "3", "5"], relay.setting("overlayCardHoldSeconds") ?? "0", value => `hold${value}`),
      rows, hasDiagnostics: rows.length > 0,
      // Offered only when the account's diagnostics report sending as not included.
      needsSubscription: data?.entitled === false,
      lastSuccess: when ? Fmt("lastSuccess", { when }) : "",
      lastError: failure > success ? String(relay.setting("overlayLastError") || "") : "",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    OverlayPanel.instances.add(this);
    for (const key of ["overlayEnabled", "overlayForwardFilter", "overlayCardHoldSeconds", "overlayTableCommandsEnabled"]) {
      this.element.querySelector(`[name="${key}"]`)?.addEventListener("change", event => this._change(key, event));
    }
  }
  async _change(key, event) {
    if (this._controller || (key === "overlayTableCommandsEnabled" && game.user?.isGM !== true)) return;
    const input = event.currentTarget;
    input.disabled = true;
    const value = input.type === "checkbox" ? input.checked : input.value;
    if (key === "overlayForwardFilter" && !["allPublic", "playersOnly"].includes(value)) return;
    if (key === "overlayCardHoldSeconds" && !["0", "1", "2", "3", "5"].includes(value)) return;
    try { await game.settings.set(MODULE_ID, SETTINGS[key], value); }
    catch { ui.notifications.error(game.i18n.localize(`${I18N}.error.saveFailed`)); }
    finally { if (this.rendered) await this.render(); }
  }
  async _run(action) {
    if (this._controller) return;
    const controller = this._controller = new AbortController();
    this._error = "";
    try {
      await this.render();
      if (!controller.signal.aborted) await action(controller.signal);
    } catch {
      if (!controller.signal.aborted) this._error = game.i18n.localize(`${I18N}.error.network`);
    } finally {
      this._controller = null;
      if (this.rendered) await this.render();
    }
  }
  async _loadDiagnostics(signal) {
    const result = await overlayRelay.diagnostics(signal);
    if (signal.aborted) return;
    const data = result.data;
    if (result.ok && data?.ok === true && data.tokenKind === "foundry"
      && typeof data.account === "string" && typeof data.entitled === "boolean") this._diagnostics = data;
    else { this._diagnostics = null; this._error = overlayRelay.errorText(result.ok ? "invalidResponse" : result.reason); }
  }
  _check() { return this._run(signal => this._loadDiagnostics(signal)); }
  _test() {
    return this._run(async signal => {
      const result = await overlayRelay.sendTestRoll(signal);
      // A relay switch flipped during the test ended it; the window redraws with the new state.
      if (signal.aborted || result.reason === "cancelled") return;
      if (result.ok) ui.notifications.info(L("testSent"));
      else { this._error = overlayRelay.errorText(result.reason); ui.notifications.warn(this._error); }
      await this._loadDiagnostics(signal);
    });
  }
  /** The module API opens the `ConnectionPanel.open()` singleton (an import would be circular). */
  _connections() { return game.modules.get(MODULE_ID)?.api?.openConnections(); }
  _commands() { this._open("/vtt-overlay/commandes"); }
  _subscription() { this._open("/vtt-overlay/abonnement"); }
  _open(path) {
    try { window.open(`${normalizeOrigin(overlayRelay.setting("accountOrigin") || DEFAULT_ORIGIN)}${path}`,
      "_blank", "noopener,noreferrer"); }
    catch { ui.notifications.error(game.i18n.localize(`${I18N}.error.invalidOrigin`)); }
  }
  _cancel() { this._controller?.abort(); }
  async close(options) {
    this._cancel();
    if (OverlayPanel.instance === this) OverlayPanel.instance = null;
    OverlayPanel.instances.delete(this);
    return super.close(options);
  }
}
