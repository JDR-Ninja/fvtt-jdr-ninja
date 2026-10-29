import { MODULE_ID, I18N, SETTINGS, DEFAULT_ORIGIN } from "../constants.js";
import { normalizeOrigin } from "../auth/origin.js";
import { overlayRelay, LEGACY_OVERLAY_ID } from "./relay.js";
import { dsnAppearanceStatus } from "./payload.js";
import { formatMoment } from "../ui/format.js";
import { PILL_ICONS, accountStatus, overlayState, windowState, control } from "../ui/states.js";
import { openSingleton, releaseSingleton } from "../ui/window.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = key => game.i18n.localize(`${I18N}.overlay.${key}`);
const Fmt = (key, values) => game.i18n.format(`${I18N}.overlay.${key}`, values);

const PILLS = { ok: { level: "success", icon: PILL_ICONS.success }, warning: { level: "warning", icon: PILL_ICONS.warning },
  error: { level: "error", icon: PILL_ICONS.error } };

/**
 * The pill of each diagnostics line, from the account's answer alone. `ok` also picks the line's message. A missing
 * subscription or overlay stops rolls from reaching the stream (`error`); no OBS source or no recent command poll
 * leaves the rest working (`warning`).
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

export { formatMoment } from "../ui/format.js";

export class OverlayPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Set();
  static instance = null;
  static open() { return openSingleton(this); }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-overlay", classes: ["jdr-ninja", "jdr-ninja-overlay"], tag: "div",
    window: { title: `${I18N}.overlay.title`, icon: "fa-solid fa-tower-broadcast", resizable: true },
    position: { width: 600, height: "auto" },
    actions: {
      diagnostics: OverlayPanel.prototype._check,
      testRoll: OverlayPanel.prototype._test,
      connections: OverlayPanel.prototype._connections,
      commands: OverlayPanel.prototype._commands,
      cancel: OverlayPanel.prototype._cancel,
    },
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/overlay.hbs` } };
  /** The explicit operation (check or test roll) in flight: it makes the window busy. */
  _controller = null;
  /** The automatic diagnostics read in flight. It never makes the window busy: only the pill shows « Checking ». */
  _auto = null;
  /** An explicit diagnostics read is the operation in flight. */
  _checking = false;
  _opened = false;
  /** The automatic read ended before the first render completed: `_onRender` draws its answer once. */
  _drawOnRender = false;
  /** The account's last answer, while it describes the saved credential, or why that answer failed. */
  _diagnostics = null;
  _failure = "";
  /** A failure of this window's own operations (a test roll), shown apart from the state of the account. */
  _error = "";

  /** A new account credential: the running reads and the diagnostics belong to the old account. */
  static refreshAll() {
    for (const panel of this.instances) {
      panel._controller?.abort();
      panel._stopAuto();
      panel._diagnostics = null;
      panel._failure = "";
      panel._error = "";
      if (!panel.rendered) continue;
      // A new credential is checked once, like a new opening: its state is unknown, not wrong.
      panel._opened = false;
      panel._checkOnOpen();
      void panel.render();
    }
  }

  /** A local switch or preference: the diagnostics still describe the account, only the controls change. */
  static renderAll() {
    for (const panel of this.instances) if (panel.rendered) void panel.render();
  }

  /**
   * The status line: the pill and the step the state needs, from the same state function as the Connections row. What
   * Connections does in place becomes « Configure the connections »; a failed read can be retried from here.
   */
  _status() {
    const relay = overlayRelay, data = this._diagnostics;
    const result = data ? { ok: true } : this._failure ? { ok: false, reason: this._failure } : null;
    const account = accountStatus({ configured: Boolean(relay.setting("accountToken")), result,
      checking: this._auto !== null || this._checking });
    const row = overlayState({ enabled: relay.enabled(), legacy: game.modules?.get(LEGACY_OVERLAY_ID)?.active === true,
      account, allowed: data?.entitled === true });
    return windowState(row, { retry: control("diagnostics", game.i18n.localize(`${I18N}.button.retry`), "fa-rotate"),
      message: this._failure ? relay.errorText(this._failure) : "" });
  }

  async _prepareContext(options) {
    // The first render starts the automatic diagnostics before reading the state: the window opens on « Checking ».
    if (options?.isFirstRender) this._checkOnOpen();
    const relay = overlayRelay;
    const access = relay.access({ requireEnabled: false });
    const data = this._diagnostics;
    const busy = this._controller !== null;
    const status = this._status();
    const rows = [];
    const push = (key, message, pill) => rows.push({ label: L(`diag.${key}`), message, level: pill?.level ?? null, icon: pill?.icon ?? null });
    if (data) {
      const lines = diagnosticStatus(data);
      push("subscription", L(lines.subscription.ok ? "diag.allowed" : "error.notEntitled"), lines.subscription);
      push("overlay", L(lines.overlay.ok ? "diag.overlayActive" : "error.overlayDisabled"), lines.overlay);
      push("obs", lines.obs.ok ? Fmt("diag.obsConnected", { count: data.overlay.connectedClients }) : L("diag.obsMissing"), lines.obs);
      // Local, not from the account: a Dice So Nice update can hide the roller's dice look from the module.
      const dice = dsnAppearanceStatus();
      if (dice !== "absent") push("dice", dice === "ok" ? L("diag.diceOk")
        : Fmt("diag.diceUnreadable", { version: game.modules?.get("dice-so-nice")?.version ?? "" }),
      dice === "ok" ? PILLS.ok : PILLS.warning);
      if (game.user?.isGM) push("poll", lines.poll.ok
        ? Fmt("diag.pollRecent", { seconds: data.tableCommands.secondsSinceLastPoll }) : L("diag.pollMissing"), lines.poll);
    }
    const choices = (values, current, label) => values.map(value => ({ value,
      label: L(label(value)), selected: value === current }));
    const success = Number(relay.setting("overlayLastSuccessAt")) || 0;
    const failure = Number(relay.setting("overlayLastErrorAt")) || 0;
    const when = formatMoment(success, game.i18n.lang);
    const lastSuccess = when ? Fmt("lastSuccess", { when }) : "";
    const lastError = failure > success ? String(relay.setting("overlayLastError") || "") : "";
    return { busy, status, isGM: game.user?.isGM === true,
      tableCommands: relay.setting("overlayTableCommandsEnabled") === true,
      canCheck: access.ok && !busy,
      // A test roll needs the overlay working: enabled, the account verified and the subscription granted.
      canTest: status.state === "active" && !busy,
      // The state's own message already says what a failed read or a refused roll reports.
      error: this._error && this._error !== status.step?.text ? this._error : "",
      filters: choices(["allPublic", "playersOnly"], relay.setting("overlayForwardFilter") ?? "allPublic", value => value),
      holds: choices(["0", "1", "2", "3", "5"], relay.setting("overlayCardHoldSeconds") ?? "0", value => `hold${value}`),
      rows, hasDiagnostics: rows.length > 0, lastSuccess, lastError,
      showDiagnostics: rows.length > 0 || Boolean(lastSuccess || lastError),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    OverlayPanel.instances.add(this);
    for (const key of ["overlayForwardFilter", "overlayCardHoldSeconds", "overlayTableCommandsEnabled"]) {
      this.element.querySelector(`[name="${key}"]`)?.addEventListener("change", event => this._change(key, event));
    }
    // An answer that came in before this first render finished (an immediate failure offline) is drawn now, once.
    if (this._drawOnRender) {
      this._drawOnRender = false;
      queueMicrotask(() => { if (this.rendered) void this.render(); });
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

  /**
   * Once per opening, on the first render: the saved account is checked in the background, as Connections does. The
   * window stays usable while it runs and a failure is never retried by itself. An explicit action or closing ends it.
   */
  _checkOnOpen() {
    if (this._opened) return;
    this._opened = true;
    if (!overlayRelay.access({ requireEnabled: false }).ok) return;
    const controller = this._auto = new AbortController();
    void this._loadDiagnostics(controller.signal).catch(() => {}).finally(() => {
      if (this._auto !== controller) return;
      this._auto = null;
      if (this.rendered) void this.render(); else this._drawOnRender = true;
    });
  }
  _stopAuto() {
    this._auto?.abort();
    this._auto = null;
  }

  /** One explicit operation at a time, with the busy footer. It replaces the automatic read. */
  async _run(action, { checks = false } = {}) {
    if (this._controller) return;
    const controller = this._controller = new AbortController();
    this._stopAuto();
    this._checking = checks;
    this._error = "";
    try {
      await this.render();
      if (!controller.signal.aborted) await action(controller.signal);
    } catch {
      if (!controller.signal.aborted) this._error = game.i18n.localize(`${I18N}.error.network`);
    } finally {
      this._controller = null;
      this._checking = false;
      if (this.rendered) await this.render();
    }
  }
  /** What the account answers describes the credential it was asked with: a cancelled or outdated answer describes nothing. */
  async _loadDiagnostics(signal) {
    const stamp = overlayRelay.credentialStamp();
    const result = await overlayRelay.diagnostics(signal);
    if (signal.aborted || result.reason === "cancelled" || stamp !== overlayRelay.credentialStamp()) return;
    const data = result.data;
    if (result.ok && data?.ok === true && data.tokenKind === "foundry"
      && typeof data.account === "string" && typeof data.entitled === "boolean") {
      this._diagnostics = data;
      this._failure = "";
    } else {
      this._diagnostics = null;
      this._failure = result.ok ? "invalidResponse" : result.reason || "invalidResponse";
    }
  }
  _check() { return this._run(signal => this._loadDiagnostics(signal), { checks: true }); }
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
  _open(path) {
    try { window.open(`${normalizeOrigin(overlayRelay.setting("accountOrigin") || DEFAULT_ORIGIN)}${path}`,
      "_blank", "noopener,noreferrer"); }
    catch { ui.notifications.error(game.i18n.localize(`${I18N}.error.invalidOrigin`)); }
  }
  _cancel() { this._controller?.abort(); }
  async close(options) {
    this._cancel();
    this._stopAuto();
    this._drawOnRender = false;
    releaseSingleton(this);
    OverlayPanel.instances.delete(this);
    return super.close(options);
  }
}
