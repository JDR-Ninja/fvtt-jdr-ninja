// Unit tests for the module chrome around the converters: the system guard, the shared payload
// half and the user-facing result messages. Run from foundry/fvtt-jdr-ninja with:
//   node --test scripts/atlas/converters/__tests__/guard.test.mjs
//
// Pure Node: `globalThis.game` (system id + version, an i18n) and
// `globalThis.foundry.utils.isNewerVersion` are stubbed per test, so the guard's table logic and
// `buildPayload`'s two system fields are checked for every entry of SUPPORTED_SYSTEMS without
// Foundry. The portrait half runs against a stubbed `fetch` (Node's own `crypto.subtle` and `btoa`).
// The message tests read the real `lang/*.json`, so a string that goes missing fails here.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SUPPORTED_SYSTEMS, STATUS, VALIDATION_ERROR, MAX_WRITE_BODY_BYTES, WRITE_BODY_HEADROOM_BYTES, supportedSystemIds }
  from "../../constants.js";
import { systemGuard, guardMessage } from "../../system-guard.js";
import { buildPayload, buildPortrait, writeBody, writeBodyBytes, dropOversizedPortrait, portraitLimitMegabytes }
  from "../../converter.js";
import { resultMessage, portraitMessage } from "../../sync.js";
import { converterFor } from "../index.js";

const LANGUAGES = ["fr", "en", "es", "de", "it"];

function readLanguage(code) {
  return JSON.parse(readFileSync(new URL(`../../../../lang/${code}.json`, import.meta.url), "utf8"));
}

/** Dotted key → string, the way Foundry's Localization flattens a language file. */
function flatten(tree, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(tree)) {
    if (value && typeof value === "object") Object.assign(out, flatten(value, `${prefix}${key}.`));
    else out[`${prefix}${key}`] = value;
  }
  return out;
}

/** A `game.i18n` over one real language file: `localize` returns the key itself when it is missing, like Foundry. */
function i18nFor(code) {
  const strings = flatten(readLanguage(code));
  const localize = (key) => strings[key] ?? key;
  const format = (key, data = {}) => localize(key).replace(/\{(\w+)\}/g, (m, name) => (name in data ? String(data[name]) : m));
  return { localize, format };
}

/**
 * A faithful reduction of foundry.utils.isNewerVersion(v1, v0): true when v1 is newer than v0,
 * dotted parts compared numerically, a part v0 lacks making v1 newer ("9.6.4" vs "9.6").
 */
function isNewerVersion(v1, v0) {
  const a = String(v1).split(".");
  const b = String(v0).split(".");
  for (let i = 0; i < a.length; i++) {
    if (b[i] === undefined) return true;
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

function stubWorld(id, version) {
  globalThis.game = {
    system: { id, version },
    // Pass-through i18n: the message tests check the key and the data, not a translation.
    i18n: { localize: (key) => key, format: (key, data) => `${key} ${JSON.stringify(data)}` },
  };
  globalThis.foundry = { utils: { isNewerVersion } };
}

/** The smallest prepared actor every converter accepts (no img: no portrait fetch). */
function bareActor() {
  return { name: "Stub", type: "character", system: {}, itemTypes: {} };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  stubWorld("dnd5e", "5.3.0");
});

afterEach(() => {
  delete globalThis.game;
  delete globalThis.foundry;
  delete globalThis.CONFIG;
  globalThis.fetch = originalFetch;
});

// ── the table ───────────────────────────────────────────────────────────────

test("SUPPORTED_SYSTEMS lists the five documented systems, each with a floor and an Atlas slug", () => {
  assert.deepEqual(Object.keys(SUPPORTED_SYSTEMS), ["dnd5e", "tor2e", "pf2e", "sf2e", "wfrp4e"]);
  for (const [id, entry] of Object.entries(SUPPORTED_SYSTEMS)) {
    assert.match(entry.min, /^\d+\.\d+\.\d+$/, `${id}.min`);
    assert.equal(entry.atlasSlug, `${id}-compatible`);
  }
  assert.equal(supportedSystemIds(), "dnd5e, tor2e, pf2e, sf2e, wfrp4e");
});

test("converterFor resolves a function for EVERY key of SUPPORTED_SYSTEMS (the table and the dispatch cannot drift apart)", () => {
  for (const id of Object.keys(SUPPORTED_SYSTEMS)) {
    assert.equal(typeof converterFor(id), "function", id);
  }
  // sf2e shares the pf2e converter; the other three are distinct.
  assert.equal(converterFor("sf2e"), converterFor("pf2e"));
  assert.notEqual(converterFor("dnd5e"), converterFor("pf2e"));
  assert.notEqual(converterFor("tor2e"), converterFor("wfrp4e"));
});

// ── the guard ───────────────────────────────────────────────────────────────

test("every supported system at its floor version passes the guard with its Atlas slug", () => {
  for (const [id, entry] of Object.entries(SUPPORTED_SYSTEMS)) {
    stubWorld(id, entry.min);
    assert.deepEqual(systemGuard(), { ok: true, id, version: entry.min, min: entry.min, atlasSlug: entry.atlasSlug });
    assert.equal(guardMessage(systemGuard()), "");
  }
});

test("newer versions pass: wfrp4e 9.6.4 ≥ 9.0.0, sf2e 1.5.0 ≥ 1.0.0, tor2e 6.2.1 ≥ 6.0.0, pf2e 8.5.0 ≥ 7.5.0, dnd5e 5.3.0 ≥ 3.0.0", () => {
  const cases = [["wfrp4e", "9.6.4"], ["sf2e", "1.5.0"], ["tor2e", "6.2.1"], ["pf2e", "8.5.0"], ["dnd5e", "5.3.0"]];
  for (const [id, version] of cases) {
    stubWorld(id, version);
    const guard = systemGuard();
    assert.equal(guard.ok, true, `${id} ${version}`);
    assert.equal(guard.atlasSlug, SUPPORTED_SYSTEMS[id].atlasSlug);
  }
});

test("a too-old version is refused with reason 'version' and the floor, and the message names all four", () => {
  const cases = [["dnd5e", "2.4.1"], ["tor2e", "5.9.9"], ["pf2e", "7.4.9"], ["wfrp4e", "8.7.0"], ["sf2e", "0.9.0"]];
  for (const [id, version] of cases) {
    stubWorld(id, version);
    const guard = systemGuard();
    assert.deepEqual(guard, { ok: false, reason: "version", id, version, min: SUPPORTED_SYSTEMS[id].min }, `${id} ${version}`);
    assert.equal(
      guardMessage(guard),
      `JDRNINJA_ATLAS_SYNC.guard.tooOld ${JSON.stringify({ system: id, version, min: SUPPORTED_SYSTEMS[id].min, supported: supportedSystemIds() })}`,
    );
  }
});

test("an unknown system id is refused with reason 'system', whatever its version", () => {
  stubWorld("swade", "4.4.0");
  const guard = systemGuard();
  assert.deepEqual(guard, { ok: false, reason: "system", id: "swade", version: "4.4.0" });
  assert.equal(
    guardMessage(guard),
    `JDRNINJA_ATLAS_SYNC.guard.wrongSystem ${JSON.stringify({ system: "swade", supported: supportedSystemIds() })}`,
  );
  assert.throws(() => converterFor("swade"), /unsupported game system "swade"/);
});

// ── the payload ─────────────────────────────────────────────────────────────

test("buildPayload names the system twice for every supported system: systemSlug from the table, sourceSystemId = game.system.id", async () => {
  for (const [id, entry] of Object.entries(SUPPORTED_SYSTEMS)) {
    stubWorld(id, entry.min);
    const payload = await buildPayload(bareActor());
    assert.deepEqual(Object.keys(payload), ["systemSlug", "sourceSystemId", "sourceSystemVersion", "rpgData"], id);
    assert.equal(payload.systemSlug, entry.atlasSlug);
    assert.equal(payload.sourceSystemId, id);
    assert.equal(payload.sourceSystemVersion, entry.min);
    assert.equal(typeof payload.rpgData, "object");
    assert.ok(Object.keys(payload.rpgData).length > 0, `${id}: an empty sheet`);
  }
});

test("buildPayload refuses an unknown system with a clear error instead of an empty sheet", async () => {
  stubWorld("swade", "4.4.0");
  await assert.rejects(() => buildPayload(bareActor()), /unsupported game system "swade"/);
});

test("portrait: skipped for a missing, data:, core-svg or non-raster image; included with hash/mime/base64 when it changed", async () => {
  for (const img of [undefined, "", "data:image/png;base64,AAAA", "icons/svg/mystery-man.svg", "tokens/hero.webm", "art/hero.svg"]) {
    assert.equal(await buildPortrait({ ...bareActor(), img }), null, String(img));
  }

  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(0) };
  };
  const actor = { ...bareActor(), img: "art/hero.PNG?v=3" };
  const portrait = await buildPortrait(actor);
  assert.deepEqual(requested, ["art/hero.PNG?v=3"]);
  assert.match(portrait.hash, /^[0-9a-f]{64}$/);
  assert.equal(portrait.mime, "image/png");
  assert.equal(portrait.base64, "iVBORw0KGgo=");

  // Changed vs the last synced hash: the three portrait fields ride along.
  const changed = await buildPayload(actor, { previousPortraitHash: null });
  assert.equal(changed.portraitHash, portrait.hash);
  assert.equal(changed.portraitMime, "image/png");
  assert.equal(changed.portraitBase64, portrait.base64);

  // Unchanged: module-side dedup leaves them out.
  const unchanged = await buildPayload(actor, { previousPortraitHash: portrait.hash });
  assert.equal("portraitHash" in unchanged, false);
  assert.equal("portraitBase64" in unchanged, false);
});

test("portrait: a failed or empty fetch yields no portrait and never throws", async () => {
  const actor = { ...bareActor(), img: "art/hero.jpg" };
  globalThis.fetch = async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(await buildPortrait(actor), null);
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(await buildPortrait(actor), null);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    globalThis.fetch = async () => { throw new TypeError("offline"); };
    assert.equal(await buildPortrait(actor), null);
  } finally {
    console.warn = originalWarn;
  }
});

// ── the write cap ───────────────────────────────────────────────────────────

test("the request is measured as the UTF-8 JSON the API client posts, contract version included", () => {
  const payload = { name: "Éowyn « l'intrépide »", rpgData: { notes: "\u{1F409}" } };
  assert.deepEqual(writeBody(payload), { contractVersion: 1, ...payload });
  assert.equal(writeBodyBytes(payload), new TextEncoder().encode(JSON.stringify(writeBody(payload))).length);
  assert.ok(writeBodyBytes(payload) > JSON.stringify(writeBody(payload)).length, "multi-byte characters count as bytes");
});

test("a portrait is dropped only when the whole body would pass the cap minus its headroom", () => {
  const budget = MAX_WRITE_BODY_BYTES - WRITE_BODY_HEADROOM_BYTES;
  const base = { systemSlug: "dnd5e-compatible", rpgData: {}, portraitHash: "h", portraitMime: "image/png" };
  const fits = { ...base, portraitBase64: "" };
  fits.portraitBase64 = "A".repeat(budget - writeBodyBytes(fits));
  assert.equal(writeBodyBytes(fits), budget);
  assert.equal(dropOversizedPortrait(fits), false);
  assert.equal(fits.portraitBase64.length > 0, true);

  const over = { ...fits, portraitBase64: `${fits.portraitBase64}A` };
  assert.equal(dropOversizedPortrait(over), true);
  assert.deepEqual(Object.keys(over), ["systemSlug", "rpgData"]);

  // No portrait: nothing to drop, whatever the size.
  assert.equal(dropOversizedPortrait({ rpgData: { notes: "x".repeat(budget) } }), false);
  // The limit the GM reads: a 2 MiB image (base64 + a full sheet) always fits.
  assert.equal(portraitLimitMegabytes(), 2);
  assert.ok(Math.ceil(2 * 1024 * 1024 / 3) * 4 + 64 * 1024 <= budget);
});

test("the portrait warning shows only on a successful write that left the portrait out, in every language", () => {
  for (const code of LANGUAGES) {
    globalThis.game.i18n = i18nFor(code);
    const strings = flatten(readLanguage(code));
    const expected = strings["JDRNINJA_ATLAS_SYNC.notify.portraitTooLarge"].replace("{size}", "2");
    assert.equal(portraitMessage({ ok: true, status: "OK", body: {}, portraitNotice: "TOO_LARGE" }), expected, code);
    assert.ok(!expected.includes("{"), code);
  }
  assert.equal(portraitMessage({ ok: true, status: "OK", body: {} }), null);
  assert.equal(portraitMessage({ ok: false, status: "RATE_LIMITED", body: {}, portraitNotice: "TOO_LARGE" }), null);
});

// ── the messages ────────────────────────────────────────────────────────────

test("the five language files carry identical key sets, and every STATUS and VALIDATION_ERROR code has its string", () => {
  const keySets = Object.fromEntries(LANGUAGES.map((code) => [code, Object.keys(flatten(readLanguage(code))).sort()]));
  for (const code of LANGUAGES) assert.deepEqual(keySets[code], keySets.en, `${code} vs en`);
  for (const status of Object.values(STATUS)) assert.ok(keySets.en.includes(`JDRNINJA_ATLAS_SYNC.status.${status}`), status);
  for (const error of Object.values(VALIDATION_ERROR)) assert.ok(keySets.en.includes(`JDRNINJA_ATLAS_SYNC.error.${error}`), error);
  // No em-dash anywhere; no « tu » in the French copy (vouvoiement). Letter boundaries are Unicode
  // ones: JS `\b` is ASCII-only and would read the « tes » of « requêtes » as a word.
  const tutoiement = /(?<!\p{L})(tu|ton|ta|tes)(?!\p{L})/iu;
  for (const code of LANGUAGES) {
    for (const [key, text] of Object.entries(flatten(readLanguage(code)))) {
      assert.ok(!text.includes("—"), `${code} ${key}: em-dash`);
      if (code === "fr") assert.ok(!tutoiement.test(text), `${code} ${key}: tutoiement`);
    }
  }
});

test("VALIDATION_FAILED with a SYSTEM_MISMATCH, TOO_LARGE or MALFORMED_BODY error shows that code's string, in every language", () => {
  for (const code of LANGUAGES) {
    globalThis.game.i18n = i18nFor(code);
    const strings = flatten(readLanguage(code));
    for (const [errorCode, path] of [["SYSTEM_MISMATCH", "systemSlug"], ["TOO_LARGE", "rpgData"], ["MALFORMED_BODY", "rpgData"]]) {
      const result = { ok: false, status: "VALIDATION_FAILED", http: 422, body: { status: "VALIDATION_FAILED", errors: [{ code: errorCode, path }] } };
      assert.equal(resultMessage(result), strings[`JDRNINJA_ATLAS_SYNC.error.${errorCode}`], `${code} ${errorCode}`);
      assert.notEqual(resultMessage(result), strings["JDRNINJA_ATLAS_SYNC.status.VALIDATION_FAILED"]);
    }
  }
});

test("VALIDATION_FAILED with any other code, no errors or no body keeps the generic string; only the first error counts", () => {
  globalThis.game.i18n = i18nFor("fr");
  const generic = flatten(readLanguage("fr"))["JDRNINJA_ATLAS_SYNC.status.VALIDATION_FAILED"];
  const failed = (body) => ({ ok: false, status: "VALIDATION_FAILED", http: 422, body });
  assert.equal(resultMessage(failed({ errors: [{ code: "VALIDATION_FAILED", path: "rpgData" }] })), generic);
  assert.equal(resultMessage(failed({ errors: [{ code: "REQUIRED", path: "name" }] })), generic);
  assert.equal(resultMessage(failed({ errors: [{ code: "SOMETHING_NEW", path: "x" }] })), generic);
  assert.equal(resultMessage(failed({ errors: [] })), generic);
  assert.equal(resultMessage(failed({})), generic);
  assert.equal(resultMessage({ ok: false, status: "VALIDATION_FAILED", http: 422 }), generic);
  // The first error names the cause; a specific code in second place does not override a generic first one.
  assert.equal(resultMessage(failed({ errors: [{ code: "REQUIRED", path: "name" }, { code: "TOO_LARGE", path: "rpgData" }] })), generic);
});

test("the other statuses are untouched: a rate limit says when to retry, a known code its string, an unknown code the fallback", () => {
  globalThis.game.i18n = i18nFor("en");
  assert.equal(resultMessage({ ok: false, status: "RATE_LIMITED", body: { retryAfterSeconds: 3900 } }), "Synced recently. You can sync again in 1 h 5 min.");
  assert.equal(resultMessage({ ok: false, status: "RATE_LIMITED", body: {} }), "Rate limited: this character was synced recently. Try again later.");
  assert.equal(resultMessage({ ok: false, status: "TIER_REQUIRED", body: {} }), "Foundry sync is not included in the world owner's plan.");
  // A validation error code on a non-validation status is ignored.
  assert.equal(resultMessage({ ok: false, status: "LIMIT_REACHED", body: { errors: [{ code: "TOO_LARGE", path: "rpgData" }] } }), "Character limit reached for this plan.");
  assert.equal(resultMessage({ ok: false, status: "BRAND_NEW", body: {} }), "Something went wrong.");
});
