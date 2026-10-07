import { ENDPOINTS } from "../constants.js";
import { approvalUrl, normalizeOrigin, normalizeToken } from "./origin.js";
import { requestJson, waitFor } from "./http.js";

/** Existing Foundry device grant. This credential currently belongs to the overlay API. */
export async function pairDevice({ origin, deviceName, signal, onChallenge = () => {},
  request = requestJson, wait = waitFor, now = Date.now, requestedCapabilities = [] }) {
  try { origin = normalizeOrigin(origin); }
  catch { return { ok: false, reason: "invalidOrigin" }; }
  try {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    const startedAt = now();
    const auth = await request({ origin, path: ENDPOINTS.authorize,
      body: { kind: "foundry", deviceName,
        ...(requestedCapabilities.length ? { requestedCapabilities } : {}) }, signal });
    if (!auth.ok) return auth;
    const data = auth.data;
    if (typeof data.deviceCode !== "string" || !data.deviceCode
      || typeof data.userCode !== "string" || !data.userCode
      || !Number.isFinite(data.expiresInSeconds) || data.expiresInSeconds <= 0
      || !Number.isFinite(data.intervalSeconds) || data.intervalSeconds <= 0) {
      return { ok: false, reason: "invalidResponse" };
    }
    let verificationUrl;
    try { verificationUrl = approvalUrl(data.verificationUriComplete || data.verificationUri, origin); }
    catch { return { ok: false, reason: "invalidResponse" }; }
    const deadline = startedAt + Math.min(data.expiresInSeconds, 900) * 1000;
    let interval = Math.max(1, data.intervalSeconds) * 1000;
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    await onChallenge({ userCode: data.userCode, verificationUrl });
    while (now() < deadline) {
      await wait(Math.min(interval, deadline - now()), signal);
      if (signal?.aborted) return { ok: false, reason: "cancelled" };
      if (now() >= deadline) break;
      const result = await request({ origin, path: ENDPOINTS.poll,
        body: { deviceCode: data.deviceCode }, signal,
        timeoutMs: Math.min(15000, deadline - now()) });
      if (signal?.aborted) return { ok: false, reason: "cancelled" };
      if (now() >= deadline) break;
      if (!result.ok) {
        if (result.reason === "rateLimited") interval = Math.max(interval + 5000, result.retryAfterMs || 0);
        else if (result.reason !== "network") return result;
        continue;
      }
      switch (result.data.status) {
        case "approved":
          try { return { ok: true, token: normalizeToken(result.data.token) }; }
          catch { return { ok: false, reason: "invalidResponse" }; }
        case "pending": break;
        case "slow_down": interval += 5000; break;
        case "denied": return { ok: false, reason: "denied" };
        case "expired": return { ok: false, reason: "expired" };
        default: return { ok: false, reason: "invalidResponse" };
      }
    }
    return { ok: false, reason: "expired" };
  } catch {
    return { ok: false, reason: signal?.aborted ? "cancelled" : "invalidResponse" };
  }
}
