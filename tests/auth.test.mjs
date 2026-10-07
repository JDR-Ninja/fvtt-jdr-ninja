import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrigin, approvalUrl } from "../scripts/auth/origin.js";
import { requestJson } from "../scripts/auth/http.js";
import { pairDevice } from "../scripts/auth/device-flow.js";
import { Connections } from "../scripts/auth/connections.js";

const origin = "https://www.jdr.ninja";
const challenge = { deviceCode: "fixture-device", userCode: "ABCD-EFGH",
  verificationUriComplete: `${origin}/vtt-overlay/lier?code=ABCD-EFGH`,
  expiresInSeconds: 30, intervalSeconds: 5 };

test("origin validation accepts canonical HTTPS and loopback development only", () => {
  assert.equal(normalizeOrigin(" https://www.jdr.ninja/ "), origin);
  assert.equal(normalizeOrigin("http://localhost:7111"), "http://localhost:7111");
  assert.equal(normalizeOrigin("http://[::1]:7111"), "http://[::1]:7111");
  for (const url of ["http://jdr.ninja", "https://user:password@www.jdr.ninja", `${origin}/path`,
    `${origin}?token=fixture`, `${origin}#fragment`, "javascript:alert(1)", "https://www.jdr.ninja.evil.test/path"]) {
    assert.throws(() => normalizeOrigin(url));
  }
  assert.equal(approvalUrl(challenge.verificationUriComplete, origin), challenge.verificationUriComplete);
  for (const url of ["https://evil.test/vtt-overlay/lier", `${origin}/other`, `${origin}/vtt-overlay/lier#fragment`]) {
    assert.throws(() => approvalUrl(url, origin));
  }
});

test("HTTP sends the bearer without cookies and refuses redirects", async () => {
  let captured;
  const result = await requestJson({ origin, path: "/api/example", token: "fixture-token",
    fetchImpl: async (url, options) => {
      captured = { url, options }; return new Response(JSON.stringify({ ok: true }));
    } });
  assert.equal(result.ok, true);
  assert.equal(captured.url, `${origin}/api/example`);
  assert.equal(captured.options.headers.Authorization, "Bearer fixture-token");
  assert.equal(captured.options.credentials, "omit");
  assert.equal(captured.options.redirect, "error");
  assert.equal(captured.options.cache, "no-store");
});

test("HTTP distinguishes refused credentials, limits, bad payloads, and timeouts", async () => {
  for (const [http, reason] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rateLimited"], [502, "server"]]) {
    const result = await requestJson({ origin, path: "/api/example", fetchImpl: async () =>
      new Response("error", { status: http, headers: { "Retry-After": "12" } }) });
    assert.equal(result.reason, reason);
    if (http === 429) assert.equal(result.retryAfterMs, 12000);
  }
  for (const body of ["<html>proxy error</html>", "[]", "null"]) {
    assert.equal((await requestJson({ origin, path: "/api/example", fetchImpl: async () => new Response(body) })).reason,
      "invalidResponse");
  }
  const timeout = await requestJson({ origin, path: "/api/example", timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  assert.equal(timeout.reason, "network");
});

function flowFixture(responses, extra = {}) {
  let clock = 0;
  const waits = [];
  const calls = [];
  const options = { origin, deviceName: "Test world / GM", now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    request: async request => {
      calls.push(request); return calls.length === 1 ? { ok: true, data: { ...challenge } } : responses.shift();
    }, ...extra };
  return { options, waits, calls };
}

test("device pairing waits before polling, honors slow_down and reports safe challenge data", async () => {
  let shown;
  const fixture = flowFixture([{ ok: true, data: { status: "pending" } },
    { ok: true, data: { status: "slow_down" } }, { ok: true, data: { status: "approved", token: "fixture-token" } }],
  { onChallenge: data => { shown = data; } });
  const result = await pairDevice(fixture.options);
  assert.equal(result.token, "fixture-token");
  assert.deepEqual(fixture.waits, [5000, 5000, 10000]);
  assert.deepEqual(Object.keys(shown).sort(), ["userCode", "verificationUrl"]);
  assert.equal(fixture.calls[0].body.kind, "foundry");
  assert.equal(fixture.calls[1].body.deviceCode, challenge.deviceCode);
});

test("device pairing respects HTTP throttling and transient outages", async () => {
  const fixture = flowFixture([]);
  // Longer server expiry leaves room for the requested back-off.
  fixture.options.request = async request => {
    fixture.calls.push(request);
    if (fixture.calls.length === 1) return { ok: true, data: { ...challenge, expiresInSeconds: 60 } };
    return [{ ok: false, reason: "rateLimited", retryAfterMs: 12000 }, { ok: false, reason: "network" },
      { ok: true, data: { status: "approved", token: "fixture-token" } }][fixture.calls.length - 2];
  };
  assert.equal((await pairDevice(fixture.options)).ok, true);
  assert.deepEqual(fixture.waits, [5000, 12000, 12000]);
});

test("device pairing terminates on denial, malformed approval, and an expired deadline", async () => {
  for (const [data, reason] of [[{ status: "denied" }, "denied"], [{ status: "expired" }, "expired"],
    [{ status: "approved" }, "invalidResponse"], [{ status: "unknown" }, "invalidResponse"]]) {
    const fixture = flowFixture([{ ok: true, data }]);
    assert.equal((await pairDevice(fixture.options)).reason, reason);
    assert.equal(fixture.calls.length, 2);
  }
  const fixture = flowFixture(Array.from({ length: 8 }, () => ({ ok: true, data: { status: "pending" } })));
  assert.equal((await pairDevice(fixture.options)).reason, "expired");
  assert.equal(fixture.calls.length, 6); // No poll at or after the deadline.
});

test("device pairing rejects cross-origin approval links before displaying or polling", async () => {
  let shown = false;
  let calls = 0;
  const result = await pairDevice({ origin, request: async () => {
    calls++; return { ok: true, data: { ...challenge, verificationUriComplete: "https://evil.test/vtt-overlay/lier" } };
  }, onChallenge: () => { shown = true; } });
  assert.equal(result.reason, "invalidResponse");
  assert.equal(shown, false);
  assert.equal(calls, 1);
});

test("cancelling during the waiting interval prevents another token poll", async () => {
  const controller = new AbortController();
  const fixture = flowFixture([], { signal: controller.signal, wait: async () => {
    controller.abort(); throw controller.signal.reason;
  } });
  assert.equal((await pairDevice(fixture.options)).reason, "cancelled");
  assert.equal(fixture.calls.length, 1);
});

function connectionFixture({ gm = true, response, pair } = {}) {
  const values = new Map([["accountOrigin", origin], ["atlasOrigin", origin],
    ["accountToken", "old-account-token"], ["atlasToken", "old-atlas-token"]]);
  const calls = [];
  const writes = [];
  const settings = { get: (_module, key) => values.get(key),
    set: async (_module, key, value) => { writes.push([key, value]); values.set(key, value); } };
  const connections = new Connections({ settings, isGM: () => gm, pair,
    request: async request => { calls.push(request); return typeof response === "function" ? response(request) : response; } });
  return { connections, values, calls, writes };
}
const accountReply = { ok: true, data: { ok: true, account: "Test account", tokenKind: "foundry", entitled: false } };
const atlasReply = { ok: true, data: { status: "OK", contractVersion: 1,
  world: { id: "fixture-world", name: "Test Atlas world" }, tier: { allowed: false } } };

test("authentication succeeds without a paid entitlement and persists the correct credential", async () => {
  for (const [kind, response] of [["account", accountReply], ["atlas", atlasReply]]) {
    const fixture = connectionFixture({ response });
    const result = await fixture.connections.connect(kind, { origin, token: "new-fixture-token" });
    assert.equal(result.ok, true);
    assert.equal(result.allowed, false);
    assert.equal(fixture.values.get(`${kind}Token`), "new-fixture-token");
    assert.equal(fixture.calls[0].token, "new-fixture-token");
    assert.equal(fixture.writes[0][1], "");
  }
});

test("rejected or malformed credentials leave an existing connection intact", async () => {
  for (const response of [{ ok: false, reason: "unauthorized" }, { ok: true, data: { ok: true } }]) {
    const fixture = connectionFixture({ response });
    assert.equal((await fixture.connections.connect("account", { origin, token: "bad-fixture-token" })).ok, false);
    assert.equal(fixture.values.get("accountToken"), "old-account-token");
    assert.deepEqual(fixture.writes, []);
  }
});

test("changing the server without a new paste never sends the stored credential", async () => {
  const fixture = connectionFixture({ response: accountReply });
  assert.equal((await fixture.connections.connect("account", { origin: "https://other.test", token: "" })).reason,
    "originChanged");
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.writes, []);
});

test("players cannot inspect or change the Atlas connection", async () => {
  const fixture = connectionFixture({ gm: false, response: atlasReply });
  assert.equal(fixture.connections.configuration("atlas").configured, false);
  assert.equal((await fixture.connections.check("atlas")).reason, "notGM");
  assert.equal((await fixture.connections.connect("atlas", { origin, token: "fixture-token" })).reason, "notGM");
  assert.equal((await fixture.connections.disconnect("atlas")).reason, "notGM");
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.writes, []);
});

test("cancelling while verification is in flight prevents a late credential save", async () => {
  const controller = new AbortController();
  const fixture = connectionFixture({ response: () => { controller.abort(); return accountReply; } });
  assert.equal((await fixture.connections.connect("account", { origin, token: "fixture-token", signal: controller.signal })).reason,
    "cancelled");
  assert.deepEqual(fixture.writes, []);
});

test("account pairing verifies the issued credential before storing it", async () => {
  const fixture = connectionFixture({ response: accountReply, pair: async () => ({ ok: true, token: "paired-fixture-token" }) });
  assert.equal((await fixture.connections.pairAccount({ origin })).ok, true);
  assert.equal(fixture.calls[0].token, "paired-fixture-token");
  assert.equal(fixture.values.get("accountToken"), "paired-fixture-token");
});

test("local disconnect clears only the selected credential and performs no network request", async () => {
  const fixture = connectionFixture();
  await fixture.connections.disconnect("account");
  assert.equal(fixture.values.get("accountToken"), "");
  assert.equal(fixture.values.get("atlasToken"), "old-atlas-token");
  assert.deepEqual(fixture.calls, []);
});
