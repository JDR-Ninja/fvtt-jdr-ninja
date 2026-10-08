import { MODULE_ID, SETTINGS, DEFAULT_ORIGIN } from "../constants.js";
import { normalizeOrigin } from "../auth/origin.js";
import { requestJson } from "../auth/http.js";
import { uuid7 } from "../variables/schema.js";
import { capabilities, catalog, generation, optionErrors, CreatureError, isTarget, compatibilityCode } from "./contract.js";

const ROOT = "/api/foundry/v1";
const paths = { monster: "monsters", npc: "npcs" };
const errors = new Set(["invalidRequest", "invalidOptions", "unauthorized", "wrongDeviceKind", "devicePermissionRequired",
  "tierRequired", "catalogChanged",
  "requestTooLarge", "unsupportedMediaType", "invalidClientHeader", "rateLimited", "generationBusy", "verificationUnavailable", "generationUnavailable"]);

export class CreatureClient {
  constructor({ getGame = () => game, request = requestJson, now = Date.now, sanitize, makeId = uuid7 } = {}) {
    Object.assign(this, { getGame, request, now, sanitize, makeId });
    this.revision = 0; this.controllers = new Set(); this.access = null; this.cooldownUntil = 0; this.listeners = new Set();
  }
  /** Called when a server answer grants or withdraws generation access; `invalidate()` callers redraw themselves. */
  onAccessChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setAccess(access) {
    const changed = (this.access?.allowed === true) !== (access?.allowed === true);
    this.access = access;
    if (changed) for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot break access checks. */ } }
  }
  enabled() { return this.getGame().settings.get(MODULE_ID, SETTINGS.creaturesEnabled) === true; }
  /** Only a server answer that this account lacks the subscription; a missing connection or permission needs another step. */
  needsSubscription(reason) { return reason === "tierRequired" || this.access?.entitled === false; }
  capture() {
    const current = this.getGame();
    return { revision: this.revision, world: current.world?.id, user: current.user?.id, gm: current.user?.isGM === true,
      enabled: this.enabled(), origin: current.settings.get(MODULE_ID, SETTINGS.accountOrigin) || DEFAULT_ORIGIN,
      token: current.settings.get(MODULE_ID, SETTINGS.accountToken), core: Number(current.release?.generation),
      system: current.system?.id, systemVersion: current.system?.version };
  }
  local() {
    const state = this.capture();
    if (!state.gm) return "notGM";
    if (!state.enabled) return "disabled";
    if (compatibilityCode(this.getGame()) !== "compatible") return "incompatibleSystem";
    if (!state.token) return "connectionRequired";
    return null;
  }
  assertCurrent(state) {
    const current = this.capture();
    if (Object.keys(state).some(key => current[key] !== state[key])) throw new CreatureError("staleState");
    const restriction = this.local();
    if (restriction) throw new CreatureError(restriction);
  }
  invalidate() {
    this.revision++; this.access = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
  remainingDelay() { return Math.max(0, this.cooldownUntil - this.now()); }
  async call(path, { body, signal, state = this.capture() } = {}) {
    this.assertCurrent(state);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.controllers.add(controller);
    try {
      const origin = normalizeOrigin(state.origin);
      const result = await this.request({ origin, path, token: state.token, body, signal: combined, maxResponseBytes: 1048576 });
      this.assertCurrent(state);
      if (combined.aborted) throw new CreatureError("cancelled");
      if (!result.ok) {
        const error = result.data?.contractVersion === 1 && result.data.status === "error" ? result.data.error : null;
        const code = errors.has(error?.code) ? error.code : result.http === 404 ? "apiUnavailable"
          : result.reason === "network" ? "network" : result.reason === "invalidResponse" ? "invalidResponse"
          : result.reason === "unauthorized" ? "unauthorized" : result.reason === "rateLimited" ? "rateLimited" : "verificationUnavailable";
        const jsonDelay = Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds > 0 ? Math.min(error.retryAfterSeconds, 86400) * 1000 : 0;
        const delay = Math.min(86400000, Math.max(jsonDelay, result.retryAfterMs || 0));
        if (["rateLimited", "generationBusy"].includes(code)) this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + (delay || 2000));
        if (["unauthorized", "devicePermissionRequired", "tierRequired", "wrongDeviceKind"].includes(code)) this.setAccess(null);
        const fields = Array.isArray(error?.fieldErrors) ? error.fieldErrors.slice(0, 32).map(f => String(f.field ?? "").replace(/^options\./, "")) : [];
        throw new CreatureError(code, fields, delay);
      }
      return result.data;
    } finally { this.controllers.delete(controller); }
  }
  async check(signal, state = this.capture()) {
    const data = capabilities(await this.call(`${ROOT}/capabilities`, { signal, state }));
    this.assertCurrent(state);
    const feature = data.features.dndCreatures;
    this.setAccess({ allowed: feature.allowed, entitled: feature.entitled, reason: feature.reason, label: data.account.displayName });
    if (!data.supportedTargets.some(isTarget)) throw new CreatureError("incompatibleSystem");
    if (!feature.allowed) throw new CreatureError(feature.reason);
    return data;
  }
  async options(kind, signal, state = this.capture()) {
    if (!paths[kind]) throw new CreatureError("invalidRequest");
    return catalog(await this.call(`${ROOT}/generators/dnd/${paths[kind]}/options`, { signal, state }), kind);
  }
  makeRequest(data, options, kind) {
    const fields = optionErrors(data, options, kind);
    if (fields.length) throw new CreatureError("invalidOptions", fields);
    return { requestId: this.makeId(), catalogVersion: data.catalogVersion, options: structuredClone(options) };
  }
  async generate(kind, body, { signal, state = this.capture() } = {}) {
    if (!paths[kind]) throw new CreatureError("invalidRequest");
    if (this.remainingDelay()) throw new CreatureError("rateLimited", [], this.remainingDelay());
    return generation(await this.call(`${ROOT}/generators/dnd/${paths[kind]}/generate`, { body, signal, state }), body, kind, this.sanitize);
  }
}
export const creatureClient = new CreatureClient();
