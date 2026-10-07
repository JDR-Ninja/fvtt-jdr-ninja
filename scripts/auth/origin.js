/** An origin, never an arbitrary URL prefix. HTTP is limited to local development. */
export function normalizeOrigin(raw) {
  const url = new URL(String(raw).trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("INVALID_ORIGIN");
  }
  return url.origin;
}

/** Only the authorizing server may provide the approval link. Never follow another origin. */
export function approvalUrl(raw, origin) {
  const url = new URL(raw);
  if (url.origin !== normalizeOrigin(origin) || url.username || url.password
    || url.pathname !== "/vtt-overlay/lier" || url.hash) throw new TypeError("INVALID_RESPONSE");
  return url.href;
}

export function normalizeToken(raw) {
  const token = String(raw ?? "").trim();
  if (!token || token.length > 4096 || /\s/.test(token)) throw new TypeError("INVALID_TOKEN");
  return token;
}
