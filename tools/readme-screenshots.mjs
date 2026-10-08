// Reproducible README screenshots: a disposable dnd5e world on the local Foundry, the JDR Ninja API answered from
// showcase fixtures and a fake Stream Deck companion. No request leaves the machine.
// Usage: npm run screenshots -- [--lang=en|fr|es|de|it] [--theme=dark|light] [--out=<directory>]
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, realpath, lstat, rm, readdir } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { ACCOUNT_NAME, ATLAS_WORLD, HEROES, MACRO, atlas, capabilities, monsterCatalog, monsterResult,
  overlayDiagnostics, worldVariables } from "./readme-fixtures.mjs";

const { values: args } = parseArgs({ options: { lang: { type: "string", default: "en" }, theme: { type: "string", default: "dark" },
  out: { type: "string" } } });
const LANGUAGES = { en: "en-US", fr: "fr-FR", es: "es-ES", de: "de-DE", it: "it-IT" };
assert(Object.hasOwn(LANGUAGES, args.lang), `--lang must be one of ${Object.keys(LANGUAGES).join(", ")}`);
assert(["dark", "light"].includes(args.theme), "--theme must be one of dark, light");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Light captures go to their own folder so the dark README images are never overwritten.
const themeDir = args.theme === "light" ? "light" : "";
const outDir = resolve(args.out ?? join(root, "docs/images", args.lang === "en" ? "" : args.lang, themeDir));
const home = resolve(process.env.FOUNDRY_HOME ?? "C:/github/FoundryWorkshop/FoundryVTT-Portable-14.365");
const tool = resolve(process.env.FOUNDRY_TOOL ?? "C:/github/FoundryWorkshop/tools/foundry.mjs");
const port = Number(process.env.FOUNDRY_PORT ?? 30000);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const origin = `http://localhost:${port}`;
const env = { ...process.env, FOUNDRY_HOME: home, FOUNDRY_HOST: "localhost", FOUNDRY_PORT: String(port) };
const manage = cmd => promisify(execFile)(process.execPath, [tool, ...cmd], { env, windowsHide: true, timeout: 60000, maxBuffer: 1048576 });
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const busy = () => new Promise(resolveBusy => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const finish = value => { socket.destroy(); resolveBusy(value); };
  socket.setTimeout(1500, () => finish(true)); socket.once("connect", () => finish(true));
  socket.once("error", error => finish(error.code !== "ECONNREFUSED"));
});
const worldId = `zz-jdr-readme-${Date.now()}`;
const worldPath = join(home, "Data/worlds", worldId), modulePath = join(home, "Data/modules/jdr-ninja");
const status = async () => (await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(3000) })).json();
async function removeWorld() {
  assert(!await busy(), "Foundry must be stopped before cleanup");
  const parent = await realpath(join(home, "Data/worlds")), target = resolve(parent, worldId), suffix = relative(parent, target);
  assert(suffix && !suffix.startsWith("..") && !isAbsolute(suffix) && /^zz-jdr-readme-\d+$/.test(worldId));
  const checkLinks = async path => { const stat = await lstat(path); assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const file of await readdir(path)) await checkLinks(join(path, file)); };
  await checkLinks(target);
  assert.equal(JSON.parse(await readFile(join(target, "world.json"), "utf8")).id, worldId);
  await rm(target, { recursive: true, maxRetries: 8, retryDelay: 250 });
}

// The fake JDR Ninja API. Paths, headers and bodies follow the contracts the module validates.
const TOKENS = { account: "showcase-account-token", atlas: "showcase-atlas-token" };
const unexpected = [];
async function api(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  const send = (body, code = 200) => route.fulfill({ status: code, contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  const body = request.postData() ? JSON.parse(request.postData()) : null;
  if (!["www.jdr.ninja", "jdr.ninja"].includes(url.hostname) || !path.startsWith("/api/foundry/v1/")) {
    unexpected.push(request.url()); return route.abort();
  }
  if (path === "/api/foundry/v1/device/authorize") return send({ deviceCode: "showcase-device", userCode: "NJA-7Q4K",
    verificationUriComplete: "https://www.jdr.ninja/vtt-overlay/lier?code=NJA-7Q4K", expiresInSeconds: 600, intervalSeconds: 1 });
  if (path === "/api/foundry/v1/device/token") return send({ status: "approved", token: TOKENS.account,
    grantedCapabilities: body?.deviceCode === "showcase-device" ? ["dnd-creatures"] : [] });
  const headers = request.headers();
  const expected = path.startsWith("/api/foundry/v1/atlas/") ? TOKENS.atlas : TOKENS.account;
  if (headers["x-jdr-ninja-client"] !== "foundry-module" || headers.authorization !== `Bearer ${expected}`) {
    unexpected.push(`${request.method()} ${path} (credentials)`);
    return send({ contractVersion: 1, status: "error", error: { code: "unauthorized", fieldErrors: [] } }, 401);
  }
  const routes = {
    "GET /api/foundry/v1/overlay/diagnostics": overlayDiagnostics,
    "GET /api/foundry/v1/overlay/commands": () => ({ commands: [] }),
    "POST /api/foundry/v1/overlay/rolls": () => ({ state: "rolled" }),
    "GET /api/foundry/v1/capabilities": capabilities,
    "GET /api/foundry/v1/generators/dnd/monsters/options": () => monsterCatalog(args.lang === "fr" ? "fr" : "en"),
    "POST /api/foundry/v1/generators/dnd/monsters/generate": () => monsterResult(body),
    "GET /api/foundry/v1/atlas/whoami": atlas.whoami,
    "GET /api/foundry/v1/atlas/campaigns": atlas.campaigns,
  };
  const key = `${request.method()} ${path}`;
  if (routes[key]) return send(routes[key]());
  if (request.method() === "POST" && /^\/api\/foundry\/v1\/atlas\/characters\/[\w-]+$/.test(path)) return send(atlas.push());
  unexpected.push(key);
  return send({ contractVersion: 1, status: "error", error: { code: "missing", fieldErrors: [] } }, 404);
}

// The fake local companion: the HMAC handshake, then an acknowledgement for every snapshot.
const companion = { key: null, ready: false };
function streamDeckCompanion(ws) {
  let session = null, clientNonce = null, serverNonce = null;
  const sign = role => createHmac("sha256", companion.key).update(`${role}|${session}|${clientNonce}|${serverNonce}`).digest("hex");
  const send = message => ws.send(JSON.stringify({ protocol: 1, sessionId: session, ...message }));
  ws.onMessage(data => {
    const message = JSON.parse(String(data));
    if (message.type === "hello") {
      session = message.session.id; clientNonce = message.nonce; serverNonce = randomBytes(32).toString("hex");
      send({ type: "challenge", nonce: serverNonce, proof: sign("bridge") });
    } else if (message.type === "authenticate") {
      if (message.proof !== sign("foundry")) { ws.close(); return; }
      send({ type: "authenticated", extensions: { variables: 1 } });
    } else if (["snapshot", "update"].includes(message.type)) send({ type: "syncAck", revision: message.revision });
    else if (message.type === "ping") send({ type: "pong" });
  });
}

let browser, page, worldOwned = false, linkOwned = false, startAttempted = false;
const shots = [];
const app = id => page.locator(`[id="${id}"]`);
const idle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
async function closeWindows(keep = []) {
  await page.evaluate(async keep => {
    for (const application of [...foundry.applications.instances.values()]) {
      const sheet = application instanceof foundry.applications.api.DocumentSheetV2;
      if (!keep.includes(application.id) && (application.id.startsWith("jdr-ninja") || sheet) && application.rendered) await application.close();
    }
  }, keep);
}
/** Brings one window to a fixed place, alone on screen, and saves it. `height` "auto" fits the content. */
async function capture(id, name, { height } = {}) {
  await closeWindows([id]);
  await page.evaluate(({ id, height }) => {
    const application = foundry.applications.instances.get(id);
    application.setPosition({ left: 32, top: 24, ...(height ? { height } : {}) });
    application.bringToFront();
    // An "auto" height can still leave an inner scroll area overflowing: grow the window by what remains hidden.
    const elements = () => [application.element, ...application.element.querySelectorAll("*")];
    if (height === "auto") {
      const hidden = Math.max(0, ...elements().map(element => element.scrollHeight - element.clientHeight));
      if (hidden) application.setPosition({ height: application.position.height + hidden });
    }
    // Earlier clicks may have scrolled the window; the capture always starts at its top.
    for (const element of elements()) if (element.scrollTop) element.scrollTop = 0;
    // Windows are translucent: hide the interface behind them.
    document.body.classList.add("jn-window-capture");
  }, { id, height });
  await idle();
  const path = join(outDir, `${name}.png`);
  await app(id).screenshot({ path, animations: "disabled" });
  await page.evaluate(() => document.body.classList.remove("jn-window-capture"));
  shots.push(path); console.log(`Saved ${relative(root, path)}`);
}
async function click(id, selector) { await app(id).locator(selector).click(); }

try {
  assert(!await busy(), "Port in use: another Foundry is running; leave its owner untouched");
  assert(!await exists(worldPath));
  const core = JSON.parse(await readFile(join(home, "app/resources/app/package.json"), "utf8"));
  const system = JSON.parse(await readFile(join(home, "Data/systems/dnd5e/system.json"), "utf8"));
  assert.equal(core.version.split(".")[0], "14"); assert.equal(system.version, "5.3.3");
  if (await exists(modulePath)) assert.equal((await realpath(modulePath)).toLowerCase(), (await realpath(root)).toLowerCase(),
    "Existing jdr-ninja package link belongs to another source");
  else { await manage(["link", "--kind=module", `--source=${root}`]); linkOwned = true; }
  await manage(["create", `--world=${worldId}`, "--system=dnd5e", `--title=${ATLAS_WORLD}`]); worldOwned = true;
  startAttempted = true; await manage(["start", `--world=${worldId}`, "--wait=45"]);
  assert.equal((await status()).world, worldId);
  await mkdir(outDir, { recursive: true });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1800 }, deviceScaleFactor: 1,
    locale: LANGUAGES[args.lang], timezoneId: "UTC", colorScheme: args.theme });
  await context.addInitScript(language => {
    // The welcome tour pans a canvas that noCanvas never creates; marking it started keeps it closed.
    for (const [key, value] of [["core.noCanvas", true], ["core.performanceMode", 0], ["core.maxFPS", 10], ["core.language", language],
      ["core.tourProgress", { core: { welcome: 999 } }]]) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }, args.lang);
  // A regular expression: Playwright's "https://**" glob lets every request through.
  await context.route(/^https:\/\//, api);
  await context.routeWebSocket("ws://127.0.0.1:19114/jdr-ninja", streamDeckCompanion);
  page = await context.newPage(); page.setDefaultTimeout(20000);
  const runtimeErrors = []; page.on("pageerror", error => runtimeErrors.push(String(error.stack ?? error.message).split("\n").slice(0, 4).join(" | ")));

  await page.goto(`${origin}/join`);
  // Prove the interception before any module request: this probe must be stopped by the fake API, not the network.
  const probe = "https://interception-check.invalid/";
  await page.evaluate(url => fetch(url).catch(() => null), probe);
  assert(unexpected.includes(probe), "HTTPS requests are not intercepted; refusing to contact the live site");
  unexpected.splice(unexpected.indexOf(probe), 1);
  await page.locator('#join-game-form [name="username"]').waitFor();
  await page.evaluate(() => { const form = document.getElementById("join-game-form"); form.elements.username.value = "Gamemaster";
    form.elements.password.value = ""; form.querySelector('button[type="submit"]').click(); });
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 45000 });
  await page.evaluate(async () => { await game.settings.set("core", "moduleConfiguration", { "jdr-ninja": true }); });
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready && game.modules.get("jdr-ninja")?.api?.openConnections, null, { timeout: 45000 });
  assert.equal(await page.evaluate(() => game.i18n.lang), args.lang);

  // A plain backdrop matching the theme, no pause banner and no toasts over the windows.
  const backdrop = args.theme === "light" ? "#e9e6df" : "#17161c";
  await page.addStyleTag({ content: `body { background: ${backdrop} !important; } #notifications, #pause { display: none !important; }`
    + " body.jn-window-capture #interface { visibility: hidden; }" });
  const seeded = await page.evaluate(async ({ heroes, macro }) => {
    if (game.paused) game.togglePause(false, { broadcast: true });
    await Folder.create({ name: "Bestiary", type: "Actor" });
    const actors = await Actor.createDocuments(heroes.map(hero => ({ name: hero.name, type: "character", img: hero.img,
      ...(hero.inspired ? { system: { attributes: { inspiration: true } } } : {}),
      ...(hero.linked ? { flags: { "jdr-ninja": { atlasLink: { atlasCharacterId: hero.linked, syncedAtUtc: null, portraitHash: null } } } } : {}) })));
    await Macro.create({ name: macro.name, type: "script", command: macro.command, img: "icons/svg/fire.svg",
      flags: { "jdr-ninja": { arguments: macro.arguments } } });
    return { user: game.user.id, hero: actors[0].uuid, actors: game.actors.size };
  }, { heroes: HEROES, macro: MACRO });
  assert.equal(seeded.actors, HEROES.length);
  await page.evaluate(store => game.settings.set("jdr-ninja", "variablesWorld", store), worldVariables(seeded.user, seeded.hero));
  // The Gamemaster's color scheme. core.uiConfig applies live (its onChange calls game.configureUI), so no reload is needed.
  await page.evaluate(async theme => {
    const ui = game.settings.get("core", "uiConfig");
    await game.settings.set("core", "uiConfig", { ...ui, colorScheme: { ...ui.colorScheme, applications: theme, interface: theme } });
  }, args.theme);

  // Connections: pair the account with the creature permission, then enable each integration through its own control.
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openConnections());
  const connections = "jdr-ninja-connections";
  await click(connections, '[data-action="pairCreatures"]');
  await page.waitForFunction(token => game.settings.get("jdr-ninja", "accountToken") === token, TOKENS.account);
  await app(connections).locator('[data-action="pairCreatures"]:not([disabled])').waitFor();
  for (const name of ["creaturesEnabled", "overlayEnabled", "atlasEnabled"]) {
    await app(connections).locator(`[name="${name}"]`).check();
    await app(connections).locator(`[name="${name}"]:not([disabled])`).waitFor();
  }
  await app(connections).locator('[name="atlasToken"]').fill(TOKENS.atlas);
  await click(connections, '[data-action="saveAtlas"]');
  await app(connections).locator(".jdr-ninja__status strong", { hasText: ATLAS_WORLD }).waitFor();
  await click(connections, '[data-action="checkCreatures"]');
  await page.waitForFunction(() => {
    const panel = foundry.applications.instances.get("jdr-ninja-connections");
    return panel._operation === null && panel._results.creatures?.ok === true;
  });
  await app(connections).locator(".jdr-ninja__status strong", { hasText: ACCOUNT_NAME }).waitFor();

  // Stream Deck: generate and save a pairing key, then enable the bridge; the fake companion answers the handshake.
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openStreamDeck());
  const streamDeck = "jdr-ninja-stream-deck";
  await click(streamDeck, '[data-action="generate"]');
  await click(streamDeck, '[data-action="save"]');
  await page.waitForFunction(() => Boolean(game.settings.get("jdr-ninja", "streamDeckKey")));
  companion.key = await page.evaluate(() => game.settings.get("jdr-ninja", "streamDeckKey"));
  await app(streamDeck).locator('[name="streamDeckEnabled"]:not([disabled])').check();
  await page.waitForFunction(() => game.modules.get("jdr-ninja").api.streamDeck.status().state === "ready");
  await page.evaluate(() => foundry.applications.instances.get("jdr-ninja-connections").render());
  // The account, creature and Atlas sections; the window keeps the rest scrollable.
  await capture(connections, "connections", { height: "auto" });
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openStreamDeck());
  await capture(streamDeck, "stream-deck");

  // Atlas: choose the campaign and synchronize the three linked heroes; the fourth can still be created or linked.
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openAtlasSync());
  const atlasId = "jdr-ninja-atlas-sync";
  await app(atlasId).locator('[data-control="campaign"]:not([disabled])').selectOption("sunken-crown");
  await app(atlasId).locator('[data-action="syncAll"]:not([disabled])').click();
  await page.waitForFunction(count => game.actors.filter(a => a.getFlag("jdr-ninja", "atlasLink")?.syncedAtUtc).length === count,
    HEROES.filter(hero => hero.linked).length);
  await app(atlasId).locator('[data-action="syncAll"]:not([disabled])').waitFor();
  await capture(atlasId, "atlas-sync", { height: "auto" });

  // VTT Overlay: table commands on, a test roll, then the account diagnostics.
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openOverlay());
  const overlay = "jdr-ninja-overlay";
  await app(overlay).locator('[name="overlayTableCommandsEnabled"]').check();
  await app(overlay).locator('[data-action="testRoll"]:not([disabled])').click();
  await app(overlay).locator(".jdr-ninja__diagnostics").waitFor();
  await app(overlay).locator('[data-action="testRoll"]:not([disabled])').waitFor();
  await capture(overlay, "overlay");

  // Monster generator: generate, preview and create the native actor in the Bestiary folder.
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openMonsterGenerator());
  const monsters = "jdr-ninja-monsters";
  await click(monsters, '[data-action="generate"]:not([disabled])');
  await app(monsters).locator('[data-action="create"]:not([disabled])').waitFor();
  const folder = await page.evaluate(() => game.folders.getName("Bestiary").id);
  await app(monsters).locator('[name="importFolder"]').selectOption(folder);
  await click(monsters, '[data-action="create"]');
  await app(monsters).locator('[data-action="sheet"]').waitFor();
  await capture(monsters, "monster-generator", { height: "auto" });
  const sheet = await page.evaluate(async () => {
    const actor = game.actors.find(a => a.getFlag("jdr-ninja", "creatureImport"));
    await actor.sheet.render({ force: true }); return actor.sheet.id;
  });
  await app(sheet).waitFor();
  await capture(sheet, "monster-sheet");

  // Actors directory: the Atlas and generator shortcuts next to the synchronized heroes and the imported monster.
  await closeWindows();
  await page.evaluate(async () => {
    ui.sidebar.expand(); ui.sidebar.changeTab("actors", "primary");
    await ui.actors.render({ force: true });
  });
  await page.locator("#actors .jdr-ninja-atlas-open").waitFor();
  assert.equal(await page.locator("#actors .jdr-ninja-creature-open").count(), 2);
  const bestiary = page.locator("#actors .folder").first();
  if (!await bestiary.evaluate(folder => folder.classList.contains("expanded"))) await bestiary.locator(".folder-header").click();
  await bestiary.locator(".directory-item").first().waitFor();
  // Wait for the sidebar's expand transition to settle before measuring it.
  await page.waitForFunction(() => new Promise(done => {
    const width = () => document.getElementById("sidebar").getBoundingClientRect().width;
    const before = width(); setTimeout(() => done(before > 250 && width() === before), 300);
  }));
  await idle();
  const directory = await page.evaluate(() => {
    const sidebar = document.getElementById("sidebar").getBoundingClientRect();
    const last = [...document.querySelectorAll("#actors .directory-item")].at(-1).getBoundingClientRect();
    return { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: Math.min(sidebar.height, last.bottom - sidebar.y + 24) };
  });
  const sidebarPath = join(outDir, "actors-directory.png");
  await page.screenshot({ path: sidebarPath, clip: directory, animations: "disabled" });
  shots.push(sidebarPath); console.log(`Saved ${relative(root, sidebarPath)}`);

  // Advanced controls: the world variables with the computed hero inspiration open, then a macro's typed arguments.
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openVariables());
  const variables = "jdr-ninja-variables";
  await click(variables, '[data-action="scope"][data-value="world"]');
  await click(variables, '[data-action="select"][data-id="hero-inspiration"]');
  await app(variables).locator('[data-field="expression"]').waitFor();
  await capture(variables, "variables", { height: "auto" });
  await page.evaluate(() => game.modules.get("jdr-ninja").api.openMacroArguments());
  const macros = "jdr-ninja-macro-arguments";
  await app(macros).locator('[name="macro"]').selectOption({ label: MACRO.name });
  await click(macros, '[data-action="load"]');
  await app(macros).locator("[data-argument]").first().waitFor();
  await capture(macros, "macro-arguments", { height: "auto" });

  assert.deepEqual(unexpected, [], "Unexpected API or external requests");
  assert.deepEqual(runtimeErrors, [], "Page errors");
  console.log(`${shots.length} screenshots in ${relative(root, outDir) || "."}`);
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  if (unexpected.length) console.error("Unexpected requests:", unexpected);
  if (page && !page.isClosed()) {
    const failure = join(outDir, "failure.png");
    await page.screenshot({ path: failure }).then(() => console.error(`Failure screenshot: ${failure}`)).catch(() => {});
  }
} finally {
  const cleanup = async (name, action) => { try { await action(); }
    catch (error) { process.exitCode = 1; console.error(`Cleanup failed (${name}): ${error.message}`); } };
  if (browser) await cleanup("close browser", () => browser.close());
  if (startAttempted) await cleanup("stop Foundry", async () => { if (await busy()) {
    assert.equal((await status()).world, worldId, "Shared server ownership changed"); await manage(["stop", "--wait=20"]);
  } assert(!await busy()); });
  if (worldOwned) await cleanup("remove disposable world", removeWorld);
  if (linkOwned) await cleanup("unlink package", async () => { assert(!await busy());
    assert.equal((await realpath(modulePath)).toLowerCase(), (await realpath(root)).toLowerCase());
    await manage(["unlink", "--kind=module", "--id=jdr-ninja"]); });
}
