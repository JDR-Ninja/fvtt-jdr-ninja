import { MODULE_ID, SETTINGS, DEFAULT_API_BASE_URL, STATUS } from "./constants.js";
import { atlasAccess, invalidateAtlasWork } from "./availability.js";
import { writeBody } from "./converter.js";
import { requestJson } from "../auth/http.js";

const pending = new Set();
export function cancelAtlasRequests() {
  invalidateAtlasWork();
  for (const controller of pending) controller.abort();
}

/**
 * The status of a request that came back without the Atlas JSON envelope. Only a request that got no
 * usable answer at all (offline, timeout, an address that is not Atlas) is a network error; a refused
 * body (HTTP 413, e.g. the 3 MiB write cap) and any other HTTP failure (a proxy's HTML error page, a
 * crash) get their own status, so the GM is not told to check a connection that works.
 */
function statusWithoutEnvelope(result) {
  if (result.reason === "invalidClientHeader") return "INVALID_CLIENT_HEADER";
  if (result.reason === "cancelled") return STATUS.OPERATION_CANCELLED;
  if (result.reason === "unauthorized") return STATUS.INVALID_TOKEN;
  if (result.reason === "rateLimited") return STATUS.TOO_MANY_REQUESTS;
  if (result.http === 413) return STATUS.REQUEST_TOO_LARGE;
  if (result.reason === "server") return STATUS.SERVER_ERROR;
  return STATUS.NETWORK_ERROR;
}

async function request(path, body) {
  const access = atlasAccess();
  if (!access.ok) return access;
  const token = String(game.settings.get(MODULE_ID, SETTINGS.token) ?? "").trim();
  if (!token) return { ok: false, status: STATUS.INVALID_TOKEN, body: {} };
  const controller = new AbortController();
  pending.add(controller);
  try {
    const result = await requestJson({
      origin: game.settings.get(MODULE_ID, SETTINGS.apiBaseUrl) || DEFAULT_API_BASE_URL,
      path: `/api/foundry/v1/atlas${path}`, token, body, signal: controller.signal,
    });
    const payload = result.data ?? {};
    // The envelope's string status code wins on both successful and failed HTTP responses.
    // A generic error body's numeric `status` is an HTTP code, not an Atlas status code.
    const status = result.reason === "invalidClientHeader" ? "INVALID_CLIENT_HEADER"
      : typeof payload.status === "string" && payload.status && payload.status !== "error" ? payload.status : statusWithoutEnvelope(result);
    return { ok: result.ok && status === STATUS.OK, status, http: result.http ?? 200, body: payload };
  } finally { pending.delete(controller); }
}

export const AtlasApi = {
  hasToken() { return Boolean(game.settings.get(MODULE_ID, SETTINGS.token)); },
  whoami() { return request("/whoami"); },
  campaigns() { return request("/campaigns"); },
  characters(campaignId, { q = "", page = 1, pageSize = 50 } = {}) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) params.set("q", q);
    return request(`/campaigns/${encodeURIComponent(campaignId)}/characters?${params}`);
  },
  push(atlasCharacterId, payload) {
    return request(`/characters/${encodeURIComponent(atlasCharacterId)}`, writeBody(payload));
  },
  create(campaignId, payload) {
    return request(`/campaigns/${encodeURIComponent(campaignId)}/characters`, writeBody(payload));
  },
};
