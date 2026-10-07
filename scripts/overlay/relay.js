import { MODULE_ID, I18N, SETTINGS, DEFAULT_ORIGIN } from "../constants.js";
import { requestJson } from "../auth/http.js";
import { buildOverlayPayload, tableFormulaIsMeshBacked } from "./payload.js";

export const LEGACY_OVERLAY_ID = "jdr-ninja-vtt-overlay";
export const CARD_HOLD_CLASS = "jdr-ninja-overlay-hold";
const DSN_FALLBACK_MS = 2000;
const POLL_INTERVAL_MS = 2500;
const MAX_BACKOFF_MS = 60000;
const L = key => game.i18n.localize(`${I18N}.overlay.${key}`);

/** Client-scoped relay. Atlas permissions and world credentials never enter this path. */
export class OverlayRelay {
  constructor({ request = requestJson, setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = id => globalThis.clearTimeout(id), now = Date.now,
    resolveUuid = uuid => (globalThis.fromUuid ?? foundry.utils.fromUuid)(uuid) } = {}) {
    Object.assign(this, { request, setTimer, clearTimer, now, resolveUuid });
    this.revision = 0;
    this.workRevision = 0;
    /** In-flight requests, each mapped to whether it is roll or command work (true) or a diagnostics read. */
    this.controllers = new Map();
    this.pendingDsn = new Map();
    this.settledDsn = new Map();
    this.holds = new Map();
    this.seen = new Set();
    this.pollTimer = null;
    this.pollInFlight = false;
    this.backoff = 0;
    this.lastSuccessWrittenAt = 0;
  }

  setting(key) { return game.settings.get(MODULE_ID, SETTINGS[key]); }
  enabled() { return this.setting("overlayEnabled") === true; }
  access({ requireEnabled = true, commands = false } = {}) {
    if (requireEnabled && !this.enabled()) return { ok: false, reason: "disabled" };
    if (game.modules?.get(LEGACY_OVERLAY_ID)?.active) return { ok: false, reason: "legacyActive" };
    if (!this.setting("accountToken")) return { ok: false, reason: "unconfigured" };
    if (commands && (game.user?.isGM !== true || this.setting("overlayTableCommandsEnabled") !== true)) {
      return { ok: false, reason: "commandsInactive" };
    }
    return { ok: true };
  }
  /** The account credential only: a diagnostics read stays valid while the local switches change. */
  credentialStamp() { return JSON.stringify([this.setting("accountOrigin"), this.setting("accountToken"), this.revision]); }
  stamp() { return JSON.stringify([this.setting("accountOrigin"), this.setting("accountToken"), this.revision, this.workRevision]); }
  current(stamp, options) { return stamp === this.stamp() && this.access(options).ok; }

  async call(path, { body, signal, requireEnabled = true, commands = false } = {}) {
    const access = this.access({ requireEnabled, commands });
    if (!access.ok) return access;
    const work = requireEnabled || commands;
    const stampNow = () => work ? this.stamp() : this.credentialStamp();
    const stamp = stampNow();
    const controller = new AbortController();
    this.controllers.set(controller, work);
    try {
      const result = await this.request({ origin: this.setting("accountOrigin") || DEFAULT_ORIGIN,
        token: this.setting("accountToken"), path: `/api/foundry/v1/overlay/${path}`, body,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (controller.signal.aborted || signal?.aborted || stamp !== stampNow()
        || !this.access({ requireEnabled, commands }).ok) {
        return { ok: false, reason: "cancelled" };
      }
      return result;
    } catch {
      return { ok: false, reason: controller.signal.aborted || signal?.aborted ? "cancelled" : "network" };
    } finally { this.controllers.delete(controller); }
  }

  async postRoll(payload, { signal, test = false } = {}) {
    const stamp = this.stamp();
    let result = await this.call("rolls", { body: payload, signal });
    if (result.ok && !["rolled", "duplicate"].includes(result.data?.state)) {
      const state = result.data?.state;
      result = { ...result, ok: false,
        reason: ["notEntitled", "overlayDisabled", "invalidCommand", "ignored"].includes(state) ? state : "invalidResponse" };
    }
    if (!this.current(stamp) || result.reason === "cancelled") return result;
    if (result.ok) {
      const now = this.now();
      if (test || !this.lastSuccessWrittenAt || now - this.lastSuccessWrittenAt >= 60000) {
        this.lastSuccessWrittenAt = now;
        await game.settings.set(MODULE_ID, SETTINGS.overlayLastSuccessAt, now);
      }
    } else {
      await game.settings.set(MODULE_ID, SETTINGS.overlayLastError, this.errorText(result.reason));
      await game.settings.set(MODULE_ID, SETTINGS.overlayLastErrorAt, this.now());
    }
    return result;
  }

  errorText(reason) {
    const overlayReasons = ["disabled", "legacyActive", "unconfigured", "notEntitled", "overlayDisabled",
      "invalidCommand", "ignored", "commandsInactive"];
    return overlayReasons.includes(reason) ? L(`error.${reason}`)
      : game.i18n.localize(`${I18N}.error.${reason || "invalidResponse"}`);
  }

  diagnostics(signal) { return this.call("diagnostics", { requireEnabled: false, signal }); }
  sendTestRoll(signal) {
    return this.postRoll({ rollId: `test-${foundry.utils.randomID()}`, formula: "1d20", total: 20,
      dice: [{ faces: 20, results: [20] }], label: L("testLabel"), roller: L("testLabel") }, { signal, test: true });
  }

  onMessage(message) {
    if (!this.access().ok || message.blind || (message.whisper?.length ?? 0) > 0) return;
    if (this.setting("overlayForwardFilter") === "playersOnly" && message.author?.isGM === true) return;
    if (!message.id || this.seen.has(message.id)) return;
    const payload = buildOverlayPayload(message);
    if (!payload) return;
    this.seen.add(message.id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    this.holdCard(message.id);
    this.dispatch(message.id, payload);
  }

  dispatch(id, payload) {
    if (!this.access().ok) return;
    if (!game.dice3d || this.settledDsn.has(id)) {
      this.clearTimer(this.settledDsn.get(id));
      this.settledDsn.delete(id);
      void this.postRoll(payload);
      return;
    }
    const stamp = this.stamp();
    const timer = this.setTimer(() => {
      this.pendingDsn.delete(id);
      if (this.current(stamp)) void this.postRoll(payload);
    }, DSN_FALLBACK_MS);
    this.pendingDsn.set(id, { payload, timer, stamp });
  }

  settleDsn(id) {
    if (!id || !this.access().ok || this.settledDsn.has(id)) return;
    const pending = this.pendingDsn.get(id);
    if (pending) {
      this.clearTimer(pending.timer);
      this.pendingDsn.delete(id);
      if (this.current(pending.stamp)) void this.postRoll(pending.payload);
      return;
    }
    this.settledDsn.set(id, this.setTimer(() => this.settledDsn.delete(id), DSN_FALLBACK_MS));
  }

  holdCard(id) {
    const seconds = Number.parseInt(this.setting("overlayCardHoldSeconds"), 10);
    const duration = Math.min(10000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 0));
    if (!duration || this.holds.has(id)) return;
    const timer = this.setTimer(() => { this.holds.delete(id); this.revealCard(id); }, duration);
    this.holds.set(id, { until: this.now() + duration, timer });
  }
  renderCard(message, html) {
    if (this.access().ok && (this.holds.get(message.id)?.until ?? 0) > this.now()) html.classList.add(CARD_HOLD_CLASS);
  }
  revealCard(id) {
    for (const element of globalThis.document?.querySelectorAll(
      `.${CARD_HOLD_CLASS}[data-message-id="${CSS.escape(id)}"]`) ?? []) {
      element.classList.remove(CARD_HOLD_CLASS);
      if (element.closest("#chat-notifications")) element._lifeSpan = 0;
    }
  }

  async handleDrawCommand(uuid, stamp = this.stamp()) {
    const options = { commands: true };
    if (!this.current(stamp, options) || typeof uuid !== "string" || !uuid.trim()) return;
    try {
      const table = await this.resolveUuid(uuid.trim());
      if (!this.current(stamp, options)) return;
      if (table?.documentName !== "RollTable" || !tableFormulaIsMeshBacked(table.formula)) {
        console.warn(`${MODULE_ID} | overlay table draw skipped: missing table or unsupported formula`);
        return;
      }
      // Foundry V14 public mode. Its chat message returns through the ordinary relay hook.
      await table.draw({ messageMode: "public" });
    } catch { console.warn(`${MODULE_ID} | overlay table draw failed`); }
  }

  async pollOnce() {
    if (this.pollInFlight || !this.access({ commands: true }).ok) return;
    const stamp = this.stamp();
    this.pollInFlight = true;
    try {
      const result = await this.call("commands", { commands: true });
      if (!this.current(stamp, { commands: true })) return;
      if (!result.ok || !Array.isArray(result.data?.commands)) {
        this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff ? this.backoff * 2 : POLL_INTERVAL_MS * 2);
        return;
      }
      this.backoff = 0;
      for (const command of result.data.commands) {
        if (!this.current(stamp, { commands: true })) break;
        if (command?.kind === "drawTable") await this.handleDrawCommand(command.uuid, stamp);
      }
    } finally {
      this.pollInFlight = false;
      this.schedulePoll();
    }
  }
  schedulePoll() {
    if (this.pollTimer !== null || this.pollInFlight || !this.access({ commands: true }).ok) return;
    this.pollTimer = this.setTimer(async () => {
      this.pollTimer = null;
      await this.pollOnce();
    }, this.backoff || POLL_INTERVAL_MS);
  }

  /** A credential change cancels everything before using the new connection, diagnostics, DSN waits and draws included. */
  refresh() {
    this.revision++;
    this.reset(true);
  }

  /**
   * The relay and table-command switches end roll and command work and restart polling. A diagnostics read
   * describes the account, which neither switch changes, so it keeps running. The filter and the hold need
   * neither method: each roll reads them as it arrives.
   */
  restart() {
    this.workRevision++;
    this.reset(false);
  }

  reset(cancelDiagnostics) {
    for (const [controller, work] of this.controllers) if (work || cancelDiagnostics) controller.abort();
    for (const entry of this.pendingDsn.values()) this.clearTimer(entry.timer);
    for (const timer of this.settledDsn.values()) this.clearTimer(timer);
    for (const [id, entry] of this.holds) { this.clearTimer(entry.timer); this.revealCard(id); }
    this.pendingDsn.clear(); this.settledDsn.clear(); this.holds.clear(); this.seen.clear();
    this.clearTimer(this.pollTimer); this.pollTimer = null; this.backoff = 0;
    this.schedulePoll();
  }

  registerHooks() {
    Hooks.on("createChatMessage", message => {
      try { this.onMessage(message); }
      catch { console.warn(`${MODULE_ID} | overlay roll could not be read`); }
    });
    Hooks.on("diceSoNiceRollStart", id => this.settleDsn(id));
    Hooks.on("diceSoNiceMessageProcessed", (id, decision) => {
      if (decision?.willTrigger3DRoll === false && !game.dice3d?.messageHookDisabled) this.settleDsn(id);
    });
    Hooks.on("renderChatMessageHTML", (message, html) => this.renderCard(message, html));
  }
}

export const overlayRelay = new OverlayRelay();
