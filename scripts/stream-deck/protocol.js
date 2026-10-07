export const PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:19114/jdr-ninja";
export const MAX_COMMAND_AGE_MS = 30000;
export const MAX_MESSAGE_BYTES = 262144;

export class ControlError extends Error {
  constructor(code, details) { super(code); this.code = code; if (details) this.details = details; }
}
export function resultDetails(details) {
  if (!details || details.version !== 1 || !["committed", "unchanged", "unknown"].includes(details.variableCommit)
    || !["notStarted", "completed", "failed", "cancelled", "unconfirmed"].includes(details.execution)) return undefined;
  return { version: 1, variableCommit: details.variableCommit, execution: details.execution,
    ...(Number.isSafeInteger(details.revision) && details.revision >= 0 ? { revision: details.revision } : {}) };
}
export function requireValue(condition, code = "invalidParameters") {
  if (!condition) throw new ControlError(code);
}
export function normalizeBridgeUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new ControlError("invalidEndpoint"); }
  requireValue(["ws:", "wss:"].includes(url.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === "/jdr-ninja", "invalidEndpoint");
  return url.href;
}
export function normalizeBridgeKey(value) {
  const key = String(value ?? "").trim();
  requireValue(/^[A-Za-z0-9_-]{32,128}$/.test(key), "invalidKey");
  return key;
}
export function randomNonce(crypto = globalThis.crypto) {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function proof(key, role, sessionId, clientNonce, serverNonce, crypto = globalThis.crypto) {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", imported,
    new TextEncoder().encode(`${role}|${sessionId}|${clientNonce}|${serverNonce}`));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function equalProof(expected, received) {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  return difference === 0;
}
export function parseMessage(data) {
  requireValue(typeof data === "string" && new TextEncoder().encode(data).length <= MAX_MESSAGE_BYTES,
    "invalidMessage");
  const message = JSON.parse(data);
  requireValue(message && typeof message === "object" && !Array.isArray(message)
    && message.protocol === PROTOCOL_VERSION && typeof message.type === "string", "invalidMessage");
  return message;
}
export function validateCommand(command, sessionId, revision, now) {
  requireValue(command.sessionId === sessionId, "wrongSession");
  requireValue(Number.isInteger(command.revision) && command.revision === revision, "staleState");
  requireValue(typeof command.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(command.id), "invalidCommand");
  requireValue(Number.isFinite(command.expiresAt) && command.expiresAt > now
    && command.expiresAt <= now + MAX_COMMAND_AGE_MS, "expired");
  requireValue(typeof command.action === "string" && command.parameters
    && typeof command.parameters === "object" && !Array.isArray(command.parameters), "invalidCommand");
}
