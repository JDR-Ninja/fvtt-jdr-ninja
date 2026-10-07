import { normalizeOrigin, normalizeToken } from "./origin.js";

/** No cookies, redirects, response caching, or logging of bearer credentials. */
export async function requestJson({ origin, path, token, body, signal, timeoutMs = 15000,
  fetchImpl = globalThis.fetch, maxResponseBytes = 1048576 }) {
  let base;
  try { base = normalizeOrigin(origin); } catch { return { ok: false, reason: "invalidOrigin" }; }
  if (!path.startsWith("/api/") || path.startsWith("//")) {
    return { ok: false, reason: "invalidResponse" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers = { Accept: "application/json" };
    if (path.startsWith("/api/foundry/v1/")) {
      headers["X-Jdr-Ninja-Client"] = "foundry-module";
    }
    if (token !== undefined) headers.Authorization = `Bearer ${normalizeToken(token)}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      signal: combined,
    });
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? "unauthorized"
        : response.status === 429 ? "rateLimited" : "server";
      const retrySeconds = Number(response.headers.get("Retry-After"));
      let data = {};
      try {
        const payload = await boundedJson(response, maxResponseBytes);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) data = payload;
      } catch { /* A proxy may return HTML instead of the API's error envelope. */ }
      return { ok: false, reason: data.error?.code === "invalidClientHeader" ? "invalidClientHeader" : reason, http: response.status, data,
        retryAfterMs: Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : 0 };
    }
    let data;
    try { data = await boundedJson(response, maxResponseBytes); } catch {
      return { ok: false, reason: combined.aborted ? (signal?.aborted ? "cancelled" : "network") : "invalidResponse" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, reason: "invalidResponse" };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: signal?.aborted ? "cancelled" : "network" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Bound streamed, decompressed JSON before parsing it. Test transports may expose json() only. */
async function boundedJson(response, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid response limit");
  if (!response.body?.getReader) {
    const data = await response.json();
    if (new TextEncoder().encode(JSON.stringify(data)).length > limit) throw new Error("Response too large");
    return data;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Response too large"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
