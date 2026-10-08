import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, realpath, lstat, rm, readdir } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { capabilityFixture, catalogFixture, resultFixture } from "../tests/creatures-fixture.mjs";
import { uuid7 } from "../scripts/variables/schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.FOUNDRY_HOME ?? "C:/github/FoundryWorkshop/FoundryVTT-Portable-14.365");
const tool = resolve("C:/github/FoundryWorkshop/tools/foundry.mjs");
const source = resolve(process.env.JDR_CREATURE_MODULE_SOURCE ?? root);
const port = Number(process.env.FOUNDRY_PORT ?? 30000);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const origin = `http://localhost:${port}`;
const env = { ...process.env, FOUNDRY_HOME: home, FOUNDRY_HOST: "localhost", FOUNDRY_PORT: String(port) };
const execute = promisify(execFile);
const manage = args => execute(process.execPath, [tool, ...args], { env, windowsHide: true, timeout: 60000, maxBuffer: 1048576 });
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const busy = () => new Promise(resolveBusy => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const finish = value => { socket.destroy(); resolveBusy(value); };
  socket.setTimeout(1500, () => finish(true)); socket.once("connect", () => finish(true));
  socket.once("error", error => finish(error.code !== "ECONNREFUSED"));
});
const runId = String(Date.now());
const worldId = `zz-jdr-creatures-${runId}`;
const worldPath = join(home, "Data/worlds", worldId), modulePath = join(home, "Data/modules/jdr-ninja");
const reportPath = join(root, "dist/creature-acceptance", runId, "report.json");
const report = { runId, worldId, startedAtUtc: new Date().toISOString(), cases: [], cleanup: [],
  coverage: { foundry: "real", api: "contract fixture server", backendAuthorization: "not run", backendRateLimiter: "not run" } };
const mock = { mode: "available", calls: [], pending: null };
let browser, page, worldOwned = false, linkOwned = false, startAttempted = false, server;
async function status() { return (await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(3000) })).json(); }
async function removeWorld() {
  assert(!await busy(), "Foundry must be stopped before cleanup");
  const parent = await realpath(join(home, "Data/worlds")), target = resolve(parent, worldId), suffix = relative(parent, target);
  assert(suffix && !suffix.startsWith("..") && !isAbsolute(suffix) && /^zz-jdr-creatures-\d+$/.test(worldId));
  assert.equal(resolve(worldPath).toLowerCase(), target.toLowerCase());
  const checkLinks = async path => { const stat = await lstat(path); assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const file of await readdir(path)) await checkLinks(join(path, file)); };
  await checkLinks(target); assert.equal((await realpath(target)).toLowerCase(), target.toLowerCase());
  assert.equal(JSON.parse(await readFile(join(target, "world.json"), "utf8")).id, worldId);
  await rm(target, { recursive: true, maxRetries: 8, retryDelay: 250 });
}
async function mockApi(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Jdr-Ninja-Client");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "Retry-After");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") { response.end(); return; }
  const path = new URL(request.url, "http://localhost").pathname;
  const send = (data, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
  const error = (code, status, seconds = null) => {
    if (seconds) response.setHeader("Retry-After", String(seconds));
    send({ contractVersion: 1, status: "error", requestId: null, traceId: "fixture", error: { code, fieldErrors: [], retryAfterSeconds: seconds, details: {} } }, status);
  };
  let text = "";
  for await (const part of request) { text += part; if (text.length > 8192) { error("requestTooLarge", 413); return; } }
  const body = text ? JSON.parse(text) : null;
  mock.calls.push({ path, method: request.method, client: request.headers["x-jdr-ninja-client"],
    requestId: body?.requestId, options: body?.options, requestedCapabilities: body?.requestedCapabilities });
  if (path === "/api/foundry/v1/device/authorize") {
    const address = `http://localhost:${server.address().port}`;
    send({ deviceCode: "fixture-device", userCode: "ABCD-EFGH", verificationUriComplete: `${address}/vtt-overlay/lier?code=ABCD-EFGH`, expiresInSeconds: 30, intervalSeconds: 1 }); return;
  }
  if (path === "/api/foundry/v1/device/token") { send({ status: "approved", token: "fixture-token", grantedCapabilities: ["dnd-creatures"] }); return; }
  if (path === "/api/foundry/v1/overlay/diagnostics") { send({ ok: true, tokenKind: "foundry", account: "Fixture GM", entitled: false }); return; }
  if (request.headers["x-jdr-ninja-client"] !== "foundry-module") { error("invalidClientHeader", 403); return; }
  if (mock.mode === "apiUnavailable") { error("missing", 404); return; }
  if (path.endsWith("/capabilities")) { send(capabilityFixture(mock.mode !== "ungranted", mock.mode !== "free")); return; }
  const kind = path.includes("/npcs/") ? "npc" : "monster";
  if (path.endsWith("/options")) { send(catalogFixture(kind)); return; }
  if (!path.endsWith("/generate") || !body) { error("invalidRequest", 400); return; }

  if (mock.mode === "limited") { error("rateLimited", 429, 2); return; }
  const result = resultFixture(body, kind); result.resultId = uuid7();
  result.source.biography += '<script>globalThis.creatureUnsafe = true</script><p onclick="globalThis.creatureUnsafe=true">@Macro[unsafe] [[1d20]]</p>';
  if (mock.mode === "lost") { response.destroy(); return; }
  if (mock.mode === "pending") { mock.pending = () => send(result); return; }
  send(result);
}
async function check(name, action) {
  console.log(`Checking ${name}`);
  const row = { name }; report.cases.push(row);
  try { await action(); row.status = "passed"; } catch (error) { row.status = "failed"; throw error; }
}
try {
  await mkdir(dirname(reportPath), { recursive: true });
  assert(!await busy(), "Shared Foundry is busy; leave its owner untouched");
  assert(!await exists(worldPath));
  const core = JSON.parse(await readFile(join(home, "app/resources/app/package.json"), "utf8"));
  const system = JSON.parse(await readFile(join(home, "Data/systems/dnd5e/system.json"), "utf8"));
  report.versions = { core: core.version, system: system.version };
  assert.equal(core.version.split(".")[0], "14"); assert.equal(system.version, "5.3.3");
  if (await exists(modulePath)) assert.equal((await realpath(modulePath)).toLowerCase(), (await realpath(source)).toLowerCase(), "Existing package link belongs to another source");
  else { await manage(["link", "--kind=module", `--source=${source}`]); linkOwned = true; }
  await manage(["create", `--world=${worldId}`, "--system=dnd5e"]); worldOwned = true;
  startAttempted = true; await manage(["start", `--world=${worldId}`, "--wait=45"]);
  assert.equal((await status()).world, worldId);
  server = createServer((request, response) => { void mockApi(request, response).catch(() => { response.statusCode = 500; response.end('{}'); }); });
  await new Promise(resolveServer => server.listen(0, "localhost", resolveServer));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem("core.noCanvas", "true"); localStorage.setItem("core.performanceMode", "0"); localStorage.setItem("core.maxFPS", "10");
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  const runtimeErrors = []; page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.goto(`${origin}/join`);
  await page.locator('#join-game-form [name="username"]').waitFor();
  await page.evaluate(() => { const form = document.getElementById("join-game-form"); form.elements.username.value = "Gamemaster"; form.elements.password.value = ""; form.querySelector('button[type="submit"]').click(); });
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 45000 });
  await page.evaluate(async () => { await game.settings.set("core", "moduleConfiguration", { "jdr-ninja": true }); });
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready && game.modules.get("jdr-ninja")?.api?.openNpcGenerator, null, { timeout: 45000 });
  const apiOrigin = `http://localhost:${server.address().port}`;
  await check("explicit creature pairing requests permission without enabling integrations", async () => {
    await page.evaluate(() => game.modules.get("jdr-ninja").api.openConnections());
    const connections = page.locator("#jdr-ninja-connections");
    await connections.waitFor();
    // A browser without an account keeps one subscription link, in the account section only.
    assert.equal(await connections.locator('[data-jdr-subscriptions]').count(), 1);
    assert.equal(await connections.locator('[data-jdr-subscriptions="account"]').getAttribute('href'), 'https://www.jdr.ninja/abonnements');
    const compatibility = connections.locator('[data-compatibility="compatible"]');
    assert.equal(await compatibility.count(), 1);
    assert((await compatibility.innerText()).includes('5.3.3'));
    await connections.locator('input[name="accountOrigin"]').evaluate((element, value) => { element.value = value; }, apiOrigin);
    await connections.locator('[data-action="pairCreatures"]').click();
    await page.waitForFunction(() => Boolean(game.settings.get("jdr-ninja", "accountToken")));
    assert.deepEqual(mock.calls.find(call => call.path.endsWith("authorize")).requestedCapabilities, ["dnd-creatures"]);
    assert.equal(await page.evaluate(() => game.settings.get("jdr-ninja", "creaturesEnabled")), false);
    await page.waitForFunction(() => !document.querySelector('#jdr-ninja-connections [data-action="pairCreatures"]').disabled);
    await connections.locator('[name="creaturesEnabled"]').check();
    await page.evaluate(async () => { await foundry.applications.instances.get("jdr-ninja-connections").close(); });
  });
  const open = async kind => {
    await page.evaluate(kind => { game.modules.get("jdr-ninja").api[kind === "monster" ? "openMonsterGenerator" : "openNpcGenerator"](); }, kind);
    const window = page.locator(kind === "monster" ? "#jdr-ninja-monsters" : "#jdr-ninja-npcs");
    await window.waitFor(); return window;
  };
  await check("opening both native forms makes no generation request and marks advanced NPC options", async () => {
    await open("monster"); await open("npc");
    await page.locator('#jdr-ninja-monsters [name="challengeRating"]').waitFor();
    await page.locator('#jdr-ninja-npcs [name="presetId"]').waitFor();
    assert(!mock.calls.some(call => call.path.endsWith("generate")));
    assert.equal(await page.locator('#jdr-ninja-npcs details[data-creature-advanced]').count(), 1);
    assert.equal(await page.locator('#jdr-ninja-npcs [name="includeSecret"]').count(), 1);
    for (const kind of ['monsters', 'npcs']) assert.equal(await page.locator(`#jdr-ninja-${kind} [data-compatibility="compatible"]`).count(), 1);
  });
  for (const kind of ["monster", "npc"]) await check(`${kind}: generate, sanitized preview and one native actor with shared-resource references`, async () => {
    const window = await open(kind);
    await window.locator('[data-action="generate"]').click();
    await window.locator('[data-action="create"]:not([disabled])').waitFor();
    assert.equal(await window.locator("script").count(), 0);
    assert.equal(await window.locator('[onclick]').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.creatureUnsafe), undefined);
    assert(!await window.locator(".jn-creature-biography").textContent().then(text => text.includes("@Macro[") || text.includes("[[")));
    await window.locator('[name="importName"]').fill(`Creature acceptance ${kind}`);
    await window.locator('[data-action="create"]').click();
    await window.locator('[data-action="sheet"]').waitFor();
    const evidence = await page.evaluate(name => {
      const actor = game.actors.getName(name); const owner = actor.items.getName("venom1"), consumer = actor.items.getName("venom2");
      return { id: actor.id, type: actor.type, cr: actor.system.details.cr, hp: actor.system.attributes.hp.max,
        publicBiography: actor.system.details.biography.public, privateBiography: actor.system.details.biography.value.includes("Private secret"),
        ownership: actor.ownership.default, source: actor.getFlag("jdr-ninja", "creatureImport").resultId,
        reference: consumer.system.activities.contents[0].consumption.targets[0].target, owner: owner.id,
        duplicateNames: game.actors.filter(a => a.name === name).length };
    }, `Creature acceptance ${kind}`);
    assert.match(evidence.id, /^[a-f0-9]{16}$/); assert.equal(evidence.type, "npc"); assert.equal(evidence.hp, 27);
    assert.equal(evidence.publicBiography, ""); assert(evidence.privateBiography); assert.equal(evidence.ownership, 0);
    assert.equal(evidence.reference, evidence.owner); assert.equal(evidence.duplicateNames, 1);
    assert.equal(await window.locator('[data-action="create"]').isDisabled(), true);
    report.cases.at(-1).native = evidence;
    await window.screenshot({ path: join(dirname(reportPath), `${kind}.png`) });
  });
  await open("monster");
  const monster = page.locator("#jdr-ninja-monsters");
  await check("lost HTTP response requires an explicit new generation", async () => {
    mock.mode = "lost";
    await monster.locator('[data-action="generate"]').click();
    await page.waitForFunction(() => foundry.applications.instances.get("jdr-ninja-monsters")._error === "network"
      && !foundry.applications.instances.get("jdr-ninja-monsters")._controller);
    const first = mock.calls.filter(call => call.path.endsWith("generate")).at(-1);
    assert.equal(await monster.locator('[data-action="retry"]').count(), 0);
    mock.mode = "available";
    await monster.locator('[data-action="generate"]').click();
    await monster.locator('[data-action="create"]:not([disabled])').waitFor();
    const next = mock.calls.filter(call => call.path.endsWith("generate")).at(-1);
    assert.notEqual(first.requestId, next.requestId);
  });
  await check("429 retains preview and choices, honors Retry-After and creates no actor", async () => {
    mock.mode = "limited";
    const count = await page.evaluate(() => game.actors.size);
    await monster.locator('[data-action="generate"]').click();
    await page.waitForFunction(() => document.querySelector('#jdr-ninja-monsters [data-action="generate"]')?.disabled
      && !foundry.applications.instances.get("jdr-ninja-monsters")._controller);
    assert.equal(await monster.locator(".jn-creature-preview").count(), 1);
    assert.equal(await page.evaluate(() => game.actors.size), count);
    await monster.locator('[data-action="generate"]:not([disabled])').waitFor();
  });
  await check("disabling during generation discards the late preview and directory shortcuts", async () => {
    mock.mode = "pending"; await monster.locator('[data-action="generate"]').click();
    for (let i = 0; !mock.pending && i < 50; i++) await new Promise(resolveWait => setTimeout(resolveWait, 20));
    assert(mock.pending);
    await page.evaluate(async () => { await game.settings.set("jdr-ninja", "creaturesEnabled", false); });
    mock.pending(); mock.pending = null;
    await page.waitForFunction(() => !foundry.applications.instances.get("jdr-ninja-monsters")._preview);
    assert.equal(await page.locator(".jdr-ninja-creature-open").count(), 0);
  });
  await check("free and ungranted access remain visible without forms or generation", async () => {
    for (const mode of ["free", "ungranted", "apiUnavailable"]) {
      mock.mode = mode;
      await page.evaluate(async () => { await game.settings.set("jdr-ninja", "creaturesEnabled", true); });
      await monster.locator('[data-action="check"]:not([disabled])').waitFor();
      await monster.locator('[data-action="check"]').click();
      await page.waitForFunction(() => !foundry.applications.instances.get("jdr-ninja-monsters")._controller);
      assert.equal(await monster.locator("[data-creature-option]").count(), 0);
      assert.equal(await monster.locator(".fa-gem").count(), 0);
      const subscriptions = monster.locator('[data-jdr-subscriptions="creatures"]');
      // Only the server's subscription denial offers the link; a missing permission or API does not.
      assert.equal(await subscriptions.count(), mode === 'free' ? 1 : 0);
      if (mode === 'free') assert.equal(await subscriptions.getAttribute('href'), 'https://www.jdr.ninja/abonnements');
      assert.equal(await monster.locator('[data-action="subscription"]').count(), 0);
      await page.evaluate(async () => { await game.settings.set("jdr-ninja", "creaturesEnabled", false); });
    }
  });
  await check("Limited player cannot read the private biography or open the GM generators", async () => {
    const user = await page.evaluate(async () => {
      const user = await foundry.documents.User.create({ name: "Creature acceptance player", role: 1 });
      await game.actors.getName("Creature acceptance npc").update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED });
      return user.name;
    });
    const playerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await playerContext.addInitScript(() => {
      localStorage.setItem("core.noCanvas", "true"); localStorage.setItem("core.performanceMode", "0"); localStorage.setItem("core.maxFPS", "10");
    });
    try {
      const player = await playerContext.newPage(); player.on("pageerror", error => runtimeErrors.push(error.message));
      await player.goto(`${origin}/join`);
      await player.locator('#join-game-form [name="username"]').waitFor();
      await player.evaluate(name => { const form = document.getElementById("join-game-form"); form.elements.username.value = name;
        form.elements.password.value = ""; form.querySelector('button[type="submit"]').click(); }, user);
      await player.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 45000 });
      const evidence = await player.evaluate(async () => {
        const actor = game.actors.getName("Creature acceptance npc"); await actor.sheet.render({ force: true });
        return { limited: actor.limited, publicBiography: actor.system.details.biography.public,
          text: actor.sheet.element.textContent, canOpen: game.modules.get("jdr-ninja").api.openNpcGenerator() !== null };
      });
      assert(evidence.limited); assert.equal(evidence.publicBiography, ""); assert(!evidence.text.includes("Private secret")); assert(!evidence.canOpen);
    } finally { await playerContext.close(); }
  });
  assert(mock.calls.filter(call => call.path.startsWith("/api/foundry/v1/")).every(call => call.client === "foundry-module"));
  assert.deepEqual(runtimeErrors, []); report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = String(error.message).slice(0, 2000); console.error(report.failure); process.exitCode = 1;
  report.apiCalls = mock.calls;
  if (page && !page.isClosed()) report.client = await page.evaluate(() => ({ ready: globalThis.game?.ready,
    connections: foundry.applications.instances.get("jdr-ninja-connections")?._results,
    windows: [...foundry.applications.instances.values()].map(app => ({ id: app.id, rendered: app.rendered, error: app._error })) })).catch(() => ({ unavailable: true }));
} finally {
  const cleanup = async (name, action) => { try { await action(); report.cleanup.push({ name, status: "passed" }); }
    catch (error) { report.cleanup.push({ name, status: "failed", reason: String(error.message) }); report.status = "failed"; process.exitCode = 1; } };
  if (browser) await cleanup("close browser", () => browser.close());
  if (server) await cleanup("close fixture API", () => new Promise(resolveServer => server.close(resolveServer)));
  if (startAttempted) await cleanup("stop owned Foundry", async () => { if (await busy()) {
    assert.equal((await status()).world, worldId, "Shared server ownership changed"); await manage(["stop", "--wait=20"]);
  } assert(!await busy()); });
  if (worldOwned) await cleanup("remove owned disposable world", removeWorld);
  if (linkOwned) await cleanup("unlink owned junction", async () => { assert(!await busy());
    assert.equal((await realpath(modulePath)).toLowerCase(), (await realpath(source)).toLowerCase()); await manage(["unlink", "--kind=module", "--id=jdr-ninja"]); });
  report.finishedAtUtc = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${reportPath} (${report.status})`);
}
