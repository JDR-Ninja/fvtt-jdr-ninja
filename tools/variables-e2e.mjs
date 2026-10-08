import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../stream-deck/node_modules/playwright/index.mjs";
import { WebSocketServer } from "../../../stream-deck/node_modules/ws/wrapper.mjs";
import { proof, equalProof } from "../scripts/stream-deck/protocol.js";
import { management, portBusy, exists, status, launchedPid, processAlive, stopUnresponsiveOwnedProcess, removeOwnedWorld } from "../../../stream-deck/tools/e2e/lifecycle.mjs";
import { join as login, enableModule, fixtures, pair } from "../../../stream-deck/tools/e2e/foundry-client.mjs";
import { until } from "../../../stream-deck/tools/e2e/elgato-host.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.FOUNDRY_HOME ?? "C:/github/FoundryWorkshop/FoundryVTT-Portable-14.365");
const tool = resolve(process.env.SD_E2E_FOUNDRY_TOOL ?? "C:/github/FoundryWorkshop/tools/foundry.mjs");
const worldId = `zz-jdr-streamdeck-variables-${Date.now()}-${randomBytes(3).toString("hex")}`;
const hostname = process.env.FOUNDRY_HOST ?? "localhost", port = Number(process.env.FOUNDRY_PORT ?? 30000), origin = `http://${hostname}:${port}`;
assert(["localhost", "127.0.0.1"].includes(hostname)); assert(Number.isInteger(port) && port > 0 && port < 65536);
const env = { ...process.env, FOUNDRY_HOME: home, FOUNDRY_HOST: hostname, FOUNDRY_PORT: String(port) };
const worlds = join(home, "Data/worlds"), worldPath = join(worlds, worldId), modulePath = join(home, "Data/modules/jdr-ninja");
const output = join(source, "dist/acceptance", worldId);
const report = { worldId, startedAtUtc: new Date().toISOString(), coverage: "Real Foundry native windows/settings/module API, no companion or Elgato hardware", cases: [], cleanup: [], browserErrors: [] };
let browser, gm, wire, worldOwned = false, linkOwned = false, startAttempted = false, pid;
const cases = async (name, action) => { console.log(`Running ${name}`); const row = { name }; report.cases.push(row);
  try { row.evidence = await action(); row.status = "passed"; } catch (error) { row.status = "failed"; throw error; } };
let interrupted = false;
const interrupt = () => { interrupted = true; void browser?.close().catch(() => {}); };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
await mkdir(output, { recursive: true });
try {
  assert.equal(await portBusy("127.0.0.1", port), false, "Peer owns Foundry port; preserve its instance");
  assert.equal(await exists(worldPath), false);
  browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  if (await exists(modulePath)) assert.equal((await realpath(modulePath)).toLowerCase(), (await realpath(source)).toLowerCase());
  else { await management(tool, ["link", "--kind=module", `--source=${source}`], env); linkOwned = true; }
  await management(tool, ["create", `--world=${worldId}`, "--system=dnd5e"], env); worldOwned = true;
  startAttempted = true;
  try { pid = launchedPid((await management(tool, ["start", `--world=${worldId}`, "--wait=45"], env)).stdout); }
  catch (error) { pid = launchedPid(error.stdout); throw error; }
  assert.equal((await status(origin)).world, worldId);
  async function seat(name) {
    console.log(`Joining ${name === "Gamemaster" ? "initial GM" : "fixture user"}`);
    assert(!interrupted);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { localStorage.setItem("core.noCanvas", "true"); localStorage.setItem("core.maxFPS", "10"); });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on("pageerror", error => report.browserErrors.push({ message: error.message.slice(0, 400), stack: error.stack?.slice(0, 2200) }));
    try { await login(page, origin, name); } catch (error) {
      report.startup = await page.evaluate(() => ({ path: location.pathname, ready: globalThis.game?.ready,
        version: globalThis.game?.version, release: globalThis.game?.data?.release,
        moduleActive: globalThis.game?.modules?.get("jdr-ninja")?.active })); throw error;
    } return page;
  }
  gm = await seat("Gamemaster"); await enableModule(gm);
  const native = await fixtures(gm, worldId); const other = await seat(native.gmBName), player = await seat(native.playerName);
  report.versions = await gm.evaluate(() => ({ foundry: game.version, system: game.system.version, module: game.modules.get("jdr-ninja").version }));
  await cases("advanced menus visible without enabling Stream Deck", async () => {
    await gm.evaluate(() => { game.modules.get("jdr-ninja").api.openConnections(); });
    const panel = gm.locator("#jdr-ninja-connections"); await panel.locator('[data-action="openVariables"]').waitFor();
    await panel.locator('[data-action="openVariables"]').click(); await gm.locator("#jdr-ninja-variables").waitFor();
    const evidence = await gm.evaluate(() => ({ consent: game.settings.get("jdr-ninja", "streamDeckEnabled"),
      scopes: ["variablesWorld", "variablesPersonal"].map(key => game.settings.settings.get(`jdr-ninja.${key}`).scope),
      controller: game.settings.get("jdr-ninja", "variablesWorld").controller === game.user.id }));
    assert.equal(evidence.consent, false); assert.deepEqual(evidence.scopes, ["world", "user"]); assert.equal(evidence.controller, true); return evidence;
  });
  const panel = gm.locator("#jdr-ninja-variables");
  let variableId;
  await cases("create stored variable through native window", async () => {
    await panel.locator('[data-action="scope"][data-value="world"]').click();
    await panel.locator('[data-action="create"]').click(); await panel.locator('[data-field="name"]').fill("Acceptance number");
    await panel.locator('[data-value-key="default"] [data-value-field="value"]').fill("2");
    await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").variables.some(v => v.name === "Acceptance number"));
    const state = await gm.evaluate(() => { const v = game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.name === "Acceptance number"); return { id: v.id, current: v.current, default: v.default }; });
    variableId = state.id; assert.equal(state.current, 0); assert.equal(state.default, 2); return state;
  });
  await cases("mutation and stale draft keep separate definition/default/current state", async () => {
    await panel.locator('[data-field="name"]').fill("Unsaved name");
    await gm.evaluate(async id => { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "set", variable: { source: "variable", scope: "world", id }, value: 7 }); }, variableId);
    await panel.locator("[data-stale]").waitFor({ state: "visible" });
    assert.equal(await panel.locator('[data-field="name"]').inputValue(), "Unsaved name");
    await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => document.querySelector('#jdr-ninja-variables [data-message]')?.textContent?.length > 0);
    const state = await gm.evaluate(id => { const v = game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.id === id); return { name: v.name, current: v.current, default: v.default }; }, variableId);
    assert.deepEqual(state, { name: "Acceptance number", current: 7, default: 2 });
    assert.equal(await panel.locator('[data-field="name"]').inputValue(), "Unsaved name");
    // Reload deliberately confirms abandoning this draft.
    const click = panel.locator('[data-action="reload"]').click();
    await gm.locator('dialog [data-action="yes"]').click(); await click;
    return state;
  });
  await cases("two GMs enforce assigned writer and explicit transfer", async () => {
    const result = await other.evaluate(async id => { try { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "set", variable: { source: "variable", scope: "world", id }, value: 9 }); return "unexpected"; } catch (error) { return error.code; } }, variableId);
    assert.equal(result, "notController");
    const userId = await other.evaluate(() => game.user.id);
    await panel.locator('[name="controller"]').selectOption(userId); await panel.locator('[data-action="controller"]').click();
    await other.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").controller === game.user.id);
    await other.evaluate(async id => { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "set", variable: { source: "variable", scope: "world", id }, value: 9 }); }, variableId);
    await gm.waitForFunction(id => game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.id === id)?.current === 9, variableId);
    // Transfer back through the second GM's native window.
    await other.evaluate(() => { game.modules.get("jdr-ninja").api.openVariables(); });
    const otherPanel = other.locator("#jdr-ninja-variables"); await otherPanel.locator('[name="controller"]').waitFor();
    await otherPanel.locator('[name="controller"]').selectOption(await gm.evaluate(() => game.user.id));
    await otherPanel.locator('[data-action="controller"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").controller === game.user.id);
    return { refused: result, transferredValue: 9, transferredBack: true };
  });
  await cases("player personal state persists independently and survives reload", async () => {
    await player.evaluate(() => { game.modules.get("jdr-ninja").api.openVariables(); }); const p = player.locator("#jdr-ninja-variables");
    await p.locator('[data-action="create"]').click(); await p.locator('[data-field="name"]').fill("Player counter"); await p.locator('[data-action="save"]').click();
    await player.waitForFunction(() => game.settings.get("jdr-ninja", "variablesPersonal").variables.length === 1);
    const id = await player.evaluate(() => game.settings.get("jdr-ninja", "variablesPersonal").variables[0].id);
    await player.evaluate(async id => { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "set", variable: { source: "variable", scope: "personal", id }, value: 3 }); }, id);
    await player.reload(); await player.waitForFunction(() => game.ready && game.modules.get("jdr-ninja").api);
    const result = await player.evaluate(async id => ({ value: await game.modules.get("jdr-ninja").api.variables.read({ source: "variable", scope: "personal", id }), user: game.user.id }), id);
    assert.equal(result.value, 3); assert.equal(await gm.evaluate(() => game.settings.get("jdr-ninja", "variablesPersonal").variables.length), 0); return result;
  });
  await cases("computed expression and combined native action use fresh values", async () => {
    // UI defaults and computation, then public dispatch into real native pause.
    await panel.locator('[data-action="create"]').click(); await panel.locator('[data-field="name"]').fill("Pause choice");
    await panel.locator('[data-field="type"]').selectOption("boolean"); await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").variables.some(v => v.name === "Pause choice"));
    const id = await gm.evaluate(() => game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.name === "Pause choice").id);
    await gm.evaluate(() => { game.togglePause(false, { broadcast: true }); });
    const result = await gm.evaluate(async id => game.modules.get("jdr-ninja").api.execute("variable.applyAndExecute", { mutations: [{ operation: "toggle", variable: { source: "variable", scope: "world", id } }], action: { action: "game.pause", parameters: { paused: { source: "variable", scope: "world", id } } } }), id);
    assert.equal(result.details.variableCommit, "committed"); assert.equal(result.details.execution, "completed"); assert.equal(await gm.evaluate(() => game.paused), true);
    await panel.locator('[data-action="create"]').click(); await panel.locator('[data-field="name"]').fill("Double number"); await panel.locator('[data-field="kind"]').selectOption("computed");
    const label = await gm.evaluate(id => game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.id === id).name, variableId);
    await panel.locator('[data-field="expression"]').fill(`@{${label}} * 2`); await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").variables.some(v => v.name === "Double number"));
    const derived = await gm.evaluate(async () => { const v = game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.name === "Double number"); return game.modules.get("jdr-ninja").api.variables.read({ source: "variable", scope: "world", id: v.id }); });
    assert.equal(derived, 18); return { ...result, derived, paused: true };
  });
  await cases("ordered list editor creates shared choices and selected entry identity survives reorder", async () => {
    await panel.locator('[data-action="switchTab"][data-value="lists"]').click(); await panel.locator('[data-action="create"]').click();
    await panel.locator('[data-field="name"]').fill("Choices"); await panel.locator('[data-action="entryAdd"]').click();
    await panel.locator('[data-value-field="label"]').fill("First"); await panel.locator('[data-value-field="value"]').fill("10");
    await panel.locator('[data-action="entryAdd"]').click();
    await panel.locator('[data-value-field="label"]').nth(1).fill("Second"); await panel.locator('[data-value-field="value"]').nth(1).fill("20"); await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").lists.length === 1);
    const list = await gm.evaluate(() => { const l = game.settings.get("jdr-ninja", "variablesWorld").lists[0]; return { id: l.id, entries: l.entries.map(e => e.id) }; });
    await panel.locator('[data-action="switchTab"][data-value="variables"]').click(); await panel.locator('[data-action="create"]').click();
    await panel.locator('[data-field="name"]').fill("Selected choice"); await panel.locator('[data-field="kind"]').selectOption("list");
    await panel.locator('[data-field="list"]').selectOption(`world:${list.id}`); await panel.locator('[data-field="default"]').selectOption(list.entries[0]); await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").variables.some(v => v.name === "Selected choice"));
    const id = await gm.evaluate(() => game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.name === "Selected choice").id);
    await gm.evaluate(async id => { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "reset", variable: { source: "variable", scope: "world", id } }); }, id);
    await panel.locator('[data-action="switchTab"][data-value="lists"]').click(); await panel.locator(`[data-action="select"][data-id="${list.id}"]`).click();
    await panel.locator('[data-action="entryDown"]').first().click(); await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(e => game.settings.get("jdr-ninja", "variablesWorld").lists[0].entries[1].id === e, list.entries[0]);
    const value = await gm.evaluate(async id => game.modules.get("jdr-ninja").api.variables.read({ source: "variable", scope: "world", id }), id); assert.equal(value, 10); return { list: list.id, value };
  });
  await cases("document variables resolve real UUIDs and reset their binding recipe", async () => {
    await panel.locator('[data-action="switchTab"][data-value="variables"]').click(); await panel.locator('[data-action="create"]').click();
    await panel.locator('[data-field="name"]').fill("Bound actor"); await panel.locator('[data-field="type"]').selectOption("Actor");
    for (const [field, uuid] of [["default", native.b], ["current", native.a]]) {
      await panel.locator(`[data-value-key="${field}"] [data-value-field="unset"]`).uncheck();
      await panel.locator(`[data-value-key="${field}"] [data-value-field="value"]`).fill(uuid);
    }
    await panel.locator('[data-action="save"]').click();
    await gm.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").variables.some(v => v.name === "Bound actor"));
    const id = await gm.evaluate(() => game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.name === "Bound actor").id);
    await gm.evaluate(async id => { await game.modules.get("jdr-ninja").api.execute("actor.open", { actor: { source: "variable", scope: "world", id } }); }, id);
    assert.equal(await gm.evaluate(id => game.actors.get(id).sheet.rendered, native.actorAId), true);
    await gm.evaluate(async id => { await game.actors.get(id).sheet.close(); }, native.actorAId);
    await gm.evaluate(async id => { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "reset", variable: { source: "variable", scope: "world", id } }); }, id);
    const recipe = await gm.evaluate(async id => game.modules.get("jdr-ninja").api.variables.read({ source: "variable", scope: "world", id }), id); assert.deepEqual(recipe, { uuid: native.b });
    return { openedActor: native.a, resetRecipe: recipe };
  });
  await cases("macro declaration UI and real script acknowledge typed arguments", async () => {
    const macroId = await gm.evaluate(async () => { const macro = await foundry.documents.Macro.create({ name: "Variable acceptance", type: "script", command: 'await game.user.setFlag("jdr-ninja", "acceptanceAmount", scope.jdrNinja.arguments.amount); return { jdrNinja: { version: 1, status: "executed" } };' }); return macro.id; });
    await gm.evaluate(() => { game.modules.get("jdr-ninja").api.openMacroArguments(); }); const macroPanel = gm.locator("#jdr-ninja-macro-arguments");
    await macroPanel.locator('[name="macro"]').selectOption(macroId); await macroPanel.locator('[data-action="load"]').click(); await macroPanel.locator('[data-action="add"]').click();
    await macroPanel.locator('[data-arg-field="name"]').fill("amount"); await macroPanel.locator('[data-arg-field="type"]').selectOption("number"); await macroPanel.locator('[data-action="save"]').click();
    await gm.waitForFunction(id => game.macros.get(id).getFlag("jdr-ninja", "arguments")?.arguments?.length === 1, macroId);
    const result = await gm.evaluate(async ({ macroId, variableId }) => game.modules.get("jdr-ninja").api.execute("macro.execute", { document: { uuid: `Macro.${macroId}` }, arguments: { amount: { source: "variable", scope: "world", id: variableId } } }), { macroId, variableId });
    assert.equal(result.code, "executed"); assert.equal(await gm.evaluate(() => game.user.getFlag("jdr-ninja", "acceptanceAmount")), 9); return { result: result.code, amount: 9 };
  });
  await cases("world persistence survives controller browser reload", async () => {
    await gm.reload(); await gm.waitForFunction(() => game.ready && game.modules.get("jdr-ninja").api);
    const value = await gm.evaluate(async id => game.modules.get("jdr-ninja").api.variables.read({ source: "variable", scope: "world", id }), variableId); assert.equal(value, 9);
    await gm.evaluate(() => { game.modules.get("jdr-ninja").api.openVariables(); }); await gm.locator("#jdr-ninja-variables").waitFor();
    await gm.locator('#jdr-ninja-variables [data-action="scope"][data-value="world"]').click({ noWaitAfter: true });
    await gm.locator('#jdr-ninja-variables [data-action="scope"][data-value="world"][aria-pressed="true"]').waitFor();
    await gm.locator(`#jdr-ninja-variables [data-action="select"][data-id="${variableId}"]`).click(); return { value };
  });
  await cases("French editor light/dark layouts and keyboard fields", async () => {
    await gm.evaluate(async () => { await game.i18n.setLanguage("fr"); await foundry.applications.instances.get("jdr-ninja-variables").render({ force: true }); });
    const layouts = [];
    for (const theme of ["light", "dark"]) {
      await gm.evaluate(async theme => { const config = foundry.utils.deepClone(game.settings.get("core", "uiConfig")); config.colorScheme.applications = theme; await game.settings.set("core", "uiConfig", config); }, theme);
      await gm.locator('#jdr-ninja-variables [data-field="name"]').focus();
      const state = await gm.evaluate(() => { const el = document.querySelector("#jdr-ninja-variables"), field = el.querySelector('[data-field="name"]');
        return { language: game.i18n.lang, focused: document.activeElement === field, overflow: el.scrollWidth > el.clientWidth, title: el.querySelector(".window-title").textContent }; });
      assert.equal(state.language, "fr"); assert.equal(state.focused, true); assert.equal(state.overflow, false);
      await gm.screenshot({ path: join(output, `variables-${theme}.png`) }); layouts.push({ theme, ...state });
    }
    await gm.setViewportSize({ width: 640, height: 1000 });
    await gm.evaluate(() => { foundry.applications.instances.get("jdr-ninja-variables").setPosition({ width: 600, left: 20, top: 40 }); });
    const columns = await gm.locator(".jn-variable-columns").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.equal(columns, 1); await gm.screenshot({ path: join(output, "variables-narrow.png") }); await gm.setViewportSize({ width: 1440, height: 1000 });
    return { layouts, narrowColumns: columns };
  });
  await cases("negotiated real Foundry WebSocket command commits once and retains detailed duplicate results", async () => {
    // This is an explicit companion contract simulator, not the shipped companion or plugin.
    const key = randomBytes(48).toString("base64url"), messages = []; let socket, sessionId, nonce, projection, wireFailure;
    wire = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 262144 });
    await new Promise((resolve, reject) => { wire.once("listening", resolve); wire.once("error", reject); });
    wire.on("connection", (ws, request) => {
      if (request.headers.origin !== origin) { wireFailure = new Error("Unexpected test origin"); ws.close(); return; } socket = ws;
      const send = message => ws.send(JSON.stringify({ protocol: 1, sessionId, ...message }));
      ws.on("message", async raw => {
        try {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") { sessionId = m.sessionId; nonce = randomBytes(32).toString("hex"); ws.clientNonce = m.nonce;
          send({ type: "challenge", nonce, proof: await proof(key, "bridge", sessionId, m.nonce, nonce) }); }
        else if (m.type === "authenticate") {
          assert(equalProof(await proof(key, "foundry", sessionId, ws.clientNonce, nonce), m.proof)); send({ type: "authenticated", extensions: { variables: 1 } });
        } else if (["snapshot", "update"].includes(m.type)) { projection = m; send({ type: "syncAck", revision: m.revision }); }
        else if (m.type === "ping") send({ type: "pong" });
        else if (m.type === "result") messages.push(m);
        } catch (error) { wireFailure = error; ws.close(); }
      });
    });
    await pair(gm, wire.address().port, key);
    assert.equal(projection.capabilities.variables.version, 1);
    const id = await gm.evaluate(() => game.settings.get("jdr-ninja", "variablesWorld").variables.find(v => v.name === "Pause choice").id);
    const before = await gm.evaluate(() => game.settings.get("jdr-ninja", "variablesWorld").revision);
    const request = { protocol: 1, type: "command", sessionId, id: randomBytes(16).toString("hex"), expiresAt: Date.now() + 20000,
      revision: projection.revision, selectionRevision: projection.state.selectionRevision, extensions: { variables: 1 }, action: "variable.applyAndExecute",
      parameters: { mutations: [{ operation: "toggle", variable: { source: "variable", scope: "world", id } }],
        action: { action: "game.pause", parameters: { paused: { source: "variable", scope: "world", id } } } } };
    socket.send(JSON.stringify(request)); const result = await until(() => { if (wireFailure) throw wireFailure; return messages[0]; });
    assert.equal(result.code, "executed"); assert.equal(result.details.variableCommit, "committed"); assert.equal(result.details.execution, "completed");
    socket.send(JSON.stringify(request)); const duplicate = await until(() => messages[1]); assert.deepEqual(duplicate, result);
    const after = await gm.evaluate(() => ({ revision: game.settings.get("jdr-ninja", "variablesWorld").revision, paused: game.paused }));
    assert.equal(after.revision, before + 1); assert.equal(after.paused, false);
    await gm.evaluate(async () => { await game.settings.set("jdr-ninja", "streamDeckEnabled", false); });
    return { bridge: "authenticated companion contract simulator", result: result.code, details: result.details, before, ...after, duplicateIdentical: true };
  });
  await cases("native disconnect refuses the old seat and offline controller recovery is explicit", async () => {
    const controller = await gm.evaluate(() => game.user.id);
    await gm.evaluate(() => { game.socket.disconnect(); });
    await other.waitForFunction(id => !game.users.get(id).active, controller);
    const refusal = await gm.evaluate(async id => {
      try { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "set", variable: { source: "variable", scope: "world", id }, value: 99 }); return "unexpected"; }
      catch (error) { return error.code; }
    }, variableId); assert.equal(refusal, "wrongSession");
    assert.equal(await other.evaluate(id => game.settings.get("jdr-ninja", "variablesWorld").controller === id, controller), true);
    await other.locator('#jdr-ninja-variables [name="controller"]').selectOption(await other.evaluate(() => game.user.id));
    await other.locator('#jdr-ninja-variables [data-action="controller"]').click();
    await other.waitForFunction(() => game.settings.get("jdr-ninja", "variablesWorld").controller === game.user.id);
    await other.evaluate(async id => { await game.modules.get("jdr-ninja").api.variables.mutate({ operation: "set", variable: { source: "variable", scope: "world", id }, value: 11 }); }, variableId);
    const value = await other.evaluate(async id => game.modules.get("jdr-ninja").api.variables.read({ source: "variable", scope: "world", id }), variableId); assert.equal(value, 11);
    return { refusal, automaticTransfer: false, recoveredValue: value };
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.failure = error.message.slice(0, 1600); console.error(report.failure); process.exitCode = 1;
  if (gm && !gm.isClosed()) { try { report.window = await gm.evaluate(() => ({ html: document.querySelector("#jdr-ninja-variables")?.outerHTML?.slice(0, 22000),
    notifications: [...document.querySelectorAll("#notifications li")].map(el => el.textContent) })); await gm.screenshot({ path: join(output, "failure.png") }); } catch { /* Keep original failure and teardown. */ } }
}
finally {
  async function cleanup(name, fn) { try { await fn(); report.cleanup.push({ name, status: "passed" }); }
    catch (error) { report.cleanup.push({ name, status: "failed", reason: error.message }); report.status = "failed"; process.exitCode = 1; } }
  if (browser) await cleanup("browser", () => browser.close());
  if (wire) await cleanup("companion contract simulator", async () => { for (const socket of wire.clients) socket.terminate(); await new Promise(resolve => wire.close(resolve)); });
  if (startAttempted) await cleanup("owned Foundry", async () => {
    if (await portBusy("127.0.0.1", port)) { assert.equal((await status(origin)).world, worldId); await management(tool, ["stop", "--wait=20"], env); }
    if (await processAlive(pid)) await stopUnresponsiveOwnedProcess(pid, { home, worldId, port });
    assert.equal(await portBusy("127.0.0.1", port), false);
  });
  if (worldOwned) await cleanup("owned world", async () => { assert.equal(await portBusy("127.0.0.1", port), false); assert.equal(await processAlive(pid), false); await removeOwnedWorld(worlds, worldId, worldPath); });
  if (linkOwned) await cleanup("owned module link", async () => { assert.equal(await portBusy("127.0.0.1", port), false); assert.equal((await realpath(modulePath)).toLowerCase(), source.toLowerCase()); await management(tool, ["unlink", "--kind=module", "--id=jdr-ninja"], env); });
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  report.finishedAtUtc = new Date().toISOString(); await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(`Report: ${join(output, "report.json")} (${report.status})`);
}
