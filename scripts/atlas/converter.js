/**
 * Shared, system-agnostic half of the conversion: the optional portrait payload and the full request
 * body. The per-system sheet projection lives in scripts/atlas/converters/<systemId>.js and is dispatched by
 * scripts/atlas/converters/index.js on `game.system.id`; `buildSheet` is re-exported from here so callers
 * keep one import surface.
 */

import { MODULE_ID, SUPPORTED_SYSTEMS, CONTRACT_VERSION, MAX_WRITE_BODY_BYTES, WRITE_BODY_HEADROOM_BYTES }
  from "./constants.js";
import { buildSheet } from "./converters/index.js";

export { buildSheet };

const RASTER_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reads actor.img and returns { hash, mime, base64 } for a raster portrait, or null when there is no
 * usable image (missing, a video/svg/data url, or a fetch failure). The caller decides whether the
 * hash changed vs the actor flag before including it.
 */
export async function buildPortrait(actor, { signal, timeoutMs = 15000 } = {}) {
  const img = actor.img;
  if (!img || img.startsWith("data:") || img.startsWith("icons/svg/")) return null;

  const ext = img.split("?")[0].split(".").pop()?.toLowerCase();
  const mime = RASTER_MIME[ext];
  if (!mime) return null; // not a raster image we can process

  try {
    const deadline = AbortSignal.timeout(timeoutMs);
    const res = await fetch(img, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    const hash = await sha256Hex(buffer);
    return { hash, mime, base64: arrayBufferToBase64(buffer) };
  } catch {
    if (!signal?.aborted) console.warn(`${MODULE_ID} | could not read portrait for ${actor.name}`);
    return null;
  }
}

/**
 * Builds the full request body for a push/create. The body names its system twice: `systemSlug` is
 * the Atlas RPG module the sheet targets (from SUPPORTED_SYSTEMS) and `sourceSystemId` the Foundry
 * `game.system.id` it was read from; the server rejects a pair that does not match its registry
 * (VALIDATION_FAILED / SYSTEM_MISMATCH). Includes portrait* fields ONLY when the portrait changed vs
 * `previousPortraitHash` (module-side dedup, layer 1).
 */
export async function buildPayload(actor, { previousPortraitHash = null, signal } = {}) {
  const systemId = game.system.id;
  const system = SUPPORTED_SYSTEMS[systemId];
  if (!system) {
    // Unreachable behind the runtime guard; a clear error beats a TypeError on `.atlasSlug`.
    throw new Error(`${MODULE_ID} | unsupported game system "${systemId}"`);
  }

  const payload = {
    systemSlug: system.atlasSlug,
    sourceSystemId: systemId,
    sourceSystemVersion: game.system.version,
    rpgData: buildSheet(actor, systemId),
  };

  const portrait = await buildPortrait(actor, { signal });
  if (portrait && portrait.hash !== previousPortraitHash) {
    payload.portraitHash = portrait.hash;
    payload.portraitMime = portrait.mime;
    payload.portraitBase64 = portrait.base64;
  }

  return payload;
}

/** The exact object api.js posts for a push/create payload. */
export function writeBody(payload) {
  return { contractVersion: CONTRACT_VERSION, ...payload };
}

/** UTF-8 size of the JSON the API client sends for this payload (same object, same serializer). */
export function writeBodyBytes(payload) {
  return new TextEncoder().encode(JSON.stringify(writeBody(payload))).length;
}

/** The largest portrait image, in whole MiB, that always fits under the cap (base64 grows it by 4/3). */
export function portraitLimitMegabytes() {
  return Math.floor((MAX_WRITE_BODY_BYTES - WRITE_BODY_HEADROOM_BYTES) * 3 / 4 / (1024 * 1024));
}

/**
 * Removes the portrait from a finished push/create payload (name and claimable flag included) when
 * the request would exceed the server's body cap, measured on the real JSON body with headroom. Over
 * the cap the server refuses the whole request without its envelope, so the sheet would not sync
 * either. The caller tells the GM and keeps the previous portrait hash, so a lighter image is sent on
 * a later sync. Returns true when the portrait was removed.
 */
export function dropOversizedPortrait(payload) {
  if (!payload.portraitBase64) return false;
  if (writeBodyBytes(payload) <= MAX_WRITE_BODY_BYTES - WRITE_BODY_HEADROOM_BYTES) return false;
  delete payload.portraitHash;
  delete payload.portraitMime;
  delete payload.portraitBase64;
  return true;
}
