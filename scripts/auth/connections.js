import { MODULE_ID, SETTINGS, DEFAULT_ORIGIN, ENDPOINTS } from "../constants.js";
import { normalizeOrigin, normalizeToken } from "./origin.js";
import { requestJson } from "./http.js";
import { pairDevice } from "./device-flow.js";

/** Keep browser credentials separate from the Atlas world's credential and permissions. */
export class Connections {
  constructor({ settings = game.settings, isGM = () => game.user?.isGM === true,
    request = requestJson, pair = pairDevice } = {}) {
    this.settings = settings;
    this.isGM = isGM;
    this.request = request;
    this.pair = pair;
  }

  configuration(kind) {
    if (kind === "atlas" && !this.isGM()) return { origin: DEFAULT_ORIGIN, configured: false };
    return { origin: this.settings.get(MODULE_ID, SETTINGS[`${kind}Origin`]) || DEFAULT_ORIGIN,
      configured: Boolean(this.settings.get(MODULE_ID, SETTINGS[`${kind}Token`])) };
  }

  async check(kind, { origin, token, signal } = {}) {
    if (kind === "atlas" && !this.isGM()) return { ok: false, reason: "notGM" };
    const config = this.configuration(kind);
    origin ??= config.origin;
    token ??= this.settings.get(MODULE_ID, SETTINGS[`${kind}Token`]);
    if (!token) return { ok: false, reason: "unconfigured" };
    const result = await this.request({ origin, path: ENDPOINTS[kind], token, signal });
    if (!result.ok) return result;
    const data = result.data;
    if (kind === "account") {
      if (data.ok !== true || data.tokenKind !== "foundry" || typeof data.account !== "string"
        || typeof data.entitled !== "boolean") return { ok: false, reason: "invalidResponse" };
      return { ok: true, label: data.account, allowed: data.entitled };
    }
    if (data.contractVersion !== 1 || data.status !== "OK" || typeof data.world?.id !== "string"
      || typeof data.world?.name !== "string" || typeof data.tier?.allowed !== "boolean") {
      return { ok: false, reason: "invalidResponse" };
    }
    return { ok: true, label: data.world.name, allowed: data.tier.allowed };
  }

  async connect(kind, { origin, token, signal } = {}) {
    if (kind === "atlas" && !this.isGM()) return { ok: false, reason: "notGM" };
    try { origin = normalizeOrigin(origin); }
    catch { return { ok: false, reason: "invalidOrigin" }; }
    // An edited origin must never receive the old credential without an explicit new paste.
    if (!String(token ?? "").trim()) {
      if (origin !== this.configuration(kind).origin) return { ok: false, reason: "originChanged" };
      token = this.settings.get(MODULE_ID, SETTINGS[`${kind}Token`]);
    }
    try { token = normalizeToken(token); }
    catch { return { ok: false, reason: "invalidToken" }; }
    const result = await this.check(kind, { origin, token, signal });
    if (!result.ok || signal?.aborted) return signal?.aborted ? { ok: false, reason: "cancelled" } : result;
    await this.save(kind, origin, token);
    return result;
  }

  async pairAccount({ origin, deviceName, signal, onChallenge, requestedCapabilities = [] } = {}) {
    const result = await this.pair({ origin, deviceName, signal, onChallenge, requestedCapabilities, request: this.request });
    if (!result.ok || signal?.aborted) return signal?.aborted ? { ok: false, reason: "cancelled" } : result;
    return this.connect("account", { origin, token: result.token, signal });
  }

  async save(kind, origin, token) {
    // Clear first so a settings update cannot briefly send the old token to a new origin.
    await this.settings.set(MODULE_ID, SETTINGS[`${kind}Token`], "");
    await this.settings.set(MODULE_ID, SETTINGS[`${kind}Origin`], origin);
    await this.settings.set(MODULE_ID, SETTINGS[`${kind}Token`], token);
  }

  async disconnect(kind) {
    if (kind === "atlas" && !this.isGM()) return { ok: false, reason: "notGM" };
    await this.settings.set(MODULE_ID, SETTINGS[`${kind}Token`], "");
    return { ok: false, reason: "unconfigured" };
  }
}
