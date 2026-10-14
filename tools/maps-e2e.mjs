// Native acceptance of the map import on the shared Foundry V14 instance: imports a real exported map ZIP through the
// window, checks the Scene it makes (levels, walls, doors, regions, water's movement cost, images) and moves a
// player-owned token into a link's Region (the level change prompt) and into a drop's Region (the fall: new level, the
// floor's base elevation). Same lifecycle as creatures-e2e.mjs: it refuses to run when Foundry is already running,
// makes a disposable `zz-` world, links the module, and cleans up (world, link, uploaded images, and the Foundry it
// started, whatever became of its world) even when a check fails. The report is dist/maps-acceptance/<run id>/report.json.
//
//   node tools/maps-e2e.mjs --zip=<path to an exported map ZIP> [--canvas]
//
// The run links a bundled copy of the working tree, not the sources: the sources name the zip library as a package,
// which the browser cannot resolve, and the release build bundles it. `--canvas` draws the canvas (WebGL, software
// rendered); without it the run uses Foundry's no-canvas mode, as the other acceptance tools do.
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { readFile, writeFile, mkdir, realpath, lstat, rm, rmdir, readdir, cp } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readMapArchive } from "../scripts/maps/zip.js";
import { summarize } from "../scripts/maps/description.js";
import { uploadName } from "../scripts/maps/import.js";
import { paddingShift, cellRectangles, cellsToMap } from "../scripts/maps/translate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: { zip: { type: "string" }, canvas: { type: "boolean", default: false } } });
assert(args.zip, "Usage: node tools/maps-e2e.mjs --zip=<path to an exported map ZIP> [--canvas]");
const zipPath = resolve(args.zip);
const home = resolve(process.env.FOUNDRY_HOME ?? "C:/github/FoundryWorkshop/FoundryVTT-Portable-14.365");
const tool = resolve("C:/github/FoundryWorkshop/tools/foundry.mjs");
const port = Number(process.env.FOUNDRY_PORT ?? 30000);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const origin = `http://localhost:${port}`;
const env = { ...process.env, FOUNDRY_HOME: home, FOUNDRY_HOST: "localhost", FOUNDRY_PORT: String(port) };
const execute = promisify(execFile);
const manage = commandArgs => execute(process.execPath, [tool, ...commandArgs], { env, windowsHide: true, timeout: 60000, maxBuffer: 1048576 });
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const busy = () => new Promise(resolveBusy => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const finish = value => { socket.destroy(); resolveBusy(value); };
  socket.setTimeout(1500, () => finish(true)); socket.once("connect", () => finish(true));
  socket.once("error", error => finish(error.code !== "ECONNREFUSED"));
});
const runId = String(Date.now());
const worldId = `zz-jdr-maps-${runId}`;
const uploadFolderName = `zz-e2e-${runId}`, uploadFolder = `jdr-ninja/cartes/${uploadFolderName}`;
const worldPath = join(home, "Data/worlds", worldId), modulePath = join(home, "Data/modules/jdr-ninja");
const dataPath = join(home, "Data"), uploadsParent = join(dataPath, "jdr-ninja"), uploadsPath = join(dataPath, uploadFolder);
const reportDir = join(root, "dist/maps-acceptance", runId), reportPath = join(reportDir, "report.json"), stagePath = join(reportDir, "module");
const report = { runId, worldId, zip: zipPath, canvas: args.canvas, startedAtUtc: new Date().toISOString(), cases: [], cleanup: [],
  coverage: { foundry: "real", module: "bundled working tree", api: "none (a local file)" } };
// `startAttempted` is set only right after the port was seen free and right before `start`: it means this run started the
// Foundry that is listening, which is the only one it may stop.
let browser, page, player, playerAccount, worldOwned = false, linkOwned = false, startAttempted = false, uploadsExisted = {};
async function status() { return (await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(3000) })).json(); }
/** Throws when `path` or anything under it is a link: cleanup never follows one out of its folder. */
async function assertNoLinks(path) {
  const stat = await lstat(path); assert(!stat.isSymbolicLink(), `${path} is a link`);
  if (stat.isDirectory()) for (const file of await readdir(path)) await assertNoLinks(join(path, file));
}
async function removeWorld() {
  assert(!await busy(), "Foundry must be stopped before cleanup");
  const parent = await realpath(join(home, "Data/worlds")), target = resolve(parent, worldId), suffix = relative(parent, target);
  assert(suffix && !suffix.startsWith("..") && !isAbsolute(suffix) && /^zz-jdr-maps-\d+$/.test(worldId));
  assert.equal(resolve(worldPath).toLowerCase(), target.toLowerCase());
  await assertNoLinks(target); assert.equal((await realpath(target)).toLowerCase(), target.toLowerCase());
  assert.equal(JSON.parse(await readFile(join(target, "world.json"), "utf8")).id, worldId);
  await rm(target, { recursive: true, maxRetries: 8, retryDelay: 250 });
}
/** The images the run uploaded, and the folders it had to create for them when they did not exist before. */
async function removeUploads() {
  assert(!await busy(), "Foundry must be stopped before cleanup");
  assert(/^zz-e2e-\d+$/.test(uploadFolderName));
  if (await exists(uploadsPath)) {
    const data = await realpath(dataPath), target = resolve(data, uploadFolder), suffix = relative(data, target);
    assert(suffix && !suffix.startsWith("..") && !isAbsolute(suffix) && suffix.replaceAll("\\", "/") === uploadFolder);
    await assertNoLinks(target); assert.equal((await realpath(target)).toLowerCase(), target.toLowerCase());
    await rm(target, { recursive: true, maxRetries: 8, retryDelay: 250 });
  }
  // A folder this run made is removed once empty; one that was already there is left alone (rmdir refuses a full one).
  if (!uploadsExisted.cartes && await exists(join(uploadsParent, "cartes"))) await rmdir(join(uploadsParent, "cartes"));
  if (!uploadsExisted.parent && await exists(uploadsParent)) await rmdir(uploadsParent);
}
/** A bundled copy of the working tree: the module's scripts as the release build makes them, and its assets as they are. */
async function stageModule() {
  await mkdir(join(stagePath, "scripts"), { recursive: true });
  await build({ entryPoints: [join(root, "scripts/main.js")], outfile: join(stagePath, "scripts/main.js"), bundle: true,
    minify: false, format: "esm", platform: "browser", target: "es2022", legalComments: "none" });
  for (const asset of ["module.json", "styles", "templates", "lang"]) await cp(join(root, asset), join(stagePath, asset), { recursive: true });
}
async function removeStage() {
  const target = resolve(stagePath), parent = resolve(reportDir);
  assert.equal(dirname(target), parent); assert.equal(target.slice(parent.length + 1), "module");
  await assertNoLinks(target); await rm(target, { recursive: true, maxRetries: 8, retryDelay: 250 });
}
async function check(name, action) {
  console.log(`Checking ${name}`);
  const row = { name }; report.cases.push(row);
  try { const outcome = await action(); row.status = outcome === "skipped" ? "skipped" : "passed"; } catch (error) { row.status = "failed"; throw error; }
}
const close = (a, b) => Math.abs(a - b) < 1e-6;
// Foundry 14.369 replaced the join form's `username` text field with a `userId` select; both are handled.
const submitJoin = async (seat, name) => {
  await seat.locator('#join-game-form [name="username"], #join-game-form [name="userId"]').first().waitFor();
  await seat.evaluate(user => {
    const form = document.getElementById("join-game-form"), { username, userId, password } = form.elements;
    if (userId) {
      const option = [...userId.options].find(entry => entry.textContent.trim() === user);
      if (!option) throw new Error(`No user named ${user} on the join form`);
      userId.value = option.value;
    } else username.value = user;
    password.value = "";
    form.querySelector('button[type="submit"]').click();
  }, name);
};
const joinAs = async (context, name) => {
  const seat = await context.newPage(); seat.setDefaultTimeout(30000);
  await seat.goto(`${origin}/join`);
  await submitJoin(seat, name);
  await seat.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
  return seat;
};
const newContext = () => browser.newContext({ viewport: { width: 1440, height: 1000 } }).then(async context => {
  await context.addInitScript(canvas => {
    localStorage.setItem("core.noCanvas", String(!canvas)); localStorage.setItem("core.performanceMode", "0"); localStorage.setItem("core.maxFPS", "10");
  }, args.canvas);
  return context;
});

try {
  await mkdir(reportDir, { recursive: true });
  assert(await exists(zipPath), `${zipPath} does not exist`);
  // What the ZIP holds, read the way the module reads it: every check below compares the Scene with this.
  const { carte } = await readMapArchive(new Uint8Array(await readFile(zipPath)));
  const counts = summarize(carte);
  const wallsOf = type => carte.levels.reduce((total, level) => total + level.walls.filter(wall => wall.type === type).length, 0);
  const costAreas = carte.levels.flatMap(level => level.areas ?? []).filter(area => ["water", "ice", "squeeze"].includes(area.type));
  const expected = { levels: carte.levels.length, walls: counts.walls, doors: wallsOf("door"), secretDoors: wallsOf("secretDoor"),
    windows: wallsOf("window"), railings: wallsOf("railing"), links: counts.links, areas: costAreas.length, drops: counts.drops };
  expected.regions = expected.links + expected.areas + 2 * expected.drops;
  report.expected = expected;

  assert(!await busy(), "Shared Foundry is busy; leave its owner untouched");
  assert(!await exists(worldPath));
  assert(!await exists(modulePath), "Data/modules/jdr-ninja already exists: unlink it first, this run links its own bundled copy");
  uploadsExisted = { parent: await exists(uploadsParent), cartes: await exists(join(uploadsParent, "cartes")) };
  const core = JSON.parse(await readFile(join(home, "app/resources/app/package.json"), "utf8"));
  const system = JSON.parse(await readFile(join(home, "Data/systems/dnd5e/system.json"), "utf8"));
  report.versions = { core: core.version, system: system.version };
  assert.equal(core.version.split(".")[0], "14");
  await stageModule();
  await manage(["link", "--kind=module", `--source=${stagePath}`]); linkOwned = true;
  await manage(["create", `--world=${worldId}`, "--system=dnd5e"]); worldOwned = true;
  assert(!await busy(), "A Foundry started meanwhile; leave its owner untouched");
  startAttempted = true; await manage(["start", `--world=${worldId}`, "--wait=45"]);
  assert.equal((await status()).world, worldId);
  browser = await chromium.launch({ headless: true, args: args.canvas ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] : [] });
  const context = await newContext();
  page = await context.newPage(); page.setDefaultTimeout(30000);
  const runtimeErrors = [], consoleErrors = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500)); });
  await page.goto(`${origin}/join`);
  await submitJoin(page, "Gamemaster");
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
  await page.evaluate(async () => { await game.settings.set("core", "moduleConfiguration", { "jdr-ninja": true }); });
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready && game.modules.get("jdr-ninja")?.api?.openMapImport, null, { timeout: 60000 });
  report.system = await page.evaluate(() => ({ id: game.system.id, version: game.system.version, grid: game.system.grid }));

  const windowSelector = "#jdr-ninja-map-import";
  await check("the Scenes directory offers the import and the API opens the same single window", async () => {
    // A V14 sidebar starts collapsed in a fresh world: expand it so the directory (and the shortcut) is on screen.
    await page.evaluate(async () => { ui.sidebar.expand(); ui.sidebar.changeTab("scenes", "primary"); await ui.scenes.render({ force: true }); });
    const shortcut = page.locator(".jdr-ninja-map-open");
    await shortcut.first().waitFor();
    assert.equal(await shortcut.count(), 1);
    assert.equal((await shortcut.innerText()).trim(), await page.evaluate(() => game.i18n.localize("JDRNINJA.maps.shortcut")));
    await shortcut.click();
    await page.locator(windowSelector).waitFor();
    await page.evaluate(() => game.modules.get("jdr-ninja").api.openMapImport());
    assert.equal(await page.locator(windowSelector).count(), 1);
    assert.equal(await page.locator('[data-action="import"]').isDisabled(), true, "nothing to import before a file is chosen");
    await page.locator(windowSelector).screenshot({ path: join(reportDir, "empty.png") });
  });

  const panel = page.locator(windowSelector);
  await check("the ZIP is read when chosen: its counts are shown, a bad folder blocks the import", async () => {
    await panel.locator('input[name="archive"]').setInputFiles(zipPath);
    await panel.locator('input[name="folder"]').waitFor();
    const shown = await panel.locator(".jn-maps-counts dd").allInnerTexts();
    assert.deepEqual(shown.map(Number), [counts.levels, counts.walls, counts.links, counts.areas, counts.drops]);
    if (counts.name) assert.equal((await panel.locator("#jn-maps-name").innerText()).trim(), counts.name);
    const folder = panel.locator('input[name="folder"]');
    assert.match(await folder.inputValue(), /^jdr-ninja\/cartes\/[a-z0-9-]+-\d{8}-\d{6}$/);
    await folder.fill("../outside");
    assert.equal(await folder.getAttribute("aria-invalid"), "true");
    assert.equal(await panel.locator('[data-action="import"]').isDisabled(), true);
    await folder.fill(uploadFolder);
    assert.equal(await folder.getAttribute("aria-invalid"), "false");
    assert.equal(await panel.locator('[data-action="import"]').isDisabled(), false);
    await panel.screenshot({ path: join(reportDir, "loaded.png") });
  });

  let sceneId;
  await check("importing creates one Scene with one Level per floor, its walls, its regions and its images", async () => {
    await panel.locator('[data-action="import"]').click();
    await panel.locator('[data-action="view"]').waitFor({ timeout: 300000 });
    assert.equal(await panel.locator(".notice-error").count(), 0, "no failure shown");
    sceneId = await page.evaluate(() => foundry.applications.instances.get("jdr-ninja-map-import")._result.sceneId);
    const evidence = await page.evaluate(async id => {
      const scene = game.scenes.get(id);
      const behaviors = scene.regions.contents.flatMap(region => region.behaviors.contents.map(behavior => ({ region, behavior })));
      const teleports = behaviors.filter(({ behavior }) => behavior.type === "teleportToken").map(({ region, behavior }) => {
        const [stored] = [...behavior.system.destinations];
        const target = fromUuidSync(stored, { relative: behavior });
        return { stored, resolved: target?.documentName === "Region" && target.parent === scene, destinationLevels: [...(target?._source.levels ?? [])],
          fromLevels: [...region._source.levels],
          destinationBand: target ? { bottom: target.elevation.bottom, top: target.elevation.top } : null };
      });
      const images = await Promise.all(scene.levels.contents.map(async level => {
        const response = await fetch(level.background.src);
        return { id: level.id, ok: response.ok, type: response.headers.get("content-type") };
      }));
      return {
        scenes: game.scenes.contents.filter(s => s.name === scene.name).length, name: scene.name, size: scene.grid.size, distance: scene.grid.distance,
        units: scene.grid.units, width: scene.width, height: scene.height, padding: scene.padding, tokenVision: scene.tokenVision,
        globalLight: scene.environment.globalLight.enabled, sceneX: scene.dimensions.sceneX, sceneY: scene.dimensions.sceneY,
        initialLevel: scene.initialLevel?.id,
        levels: scene.levels.contents.map(level => ({ id: level.id, name: level.name, sort: level.sort, bottom: level.elevation.bottom, top: level.elevation.top,
          src: level.background.src, fit: level.textures.fit, sees: [...level.visibility.levels] })),
        walls: scene.walls.contents.map(wall => ({ c: [...wall.c], levels: [...wall._source.levels], door: wall.door, ds: wall.ds, move: wall.move, sight: wall.sight, light: wall.light, sound: wall.sound })),
        regions: scene.regions.contents.map(region => ({ name: region.name, levels: [...region._source.levels], bottom: region.elevation.bottom, top: region.elevation.top,
          shapes: region.shapes.length, rectangles: region.shapes.filter(shape => shape.type === "rectangle").map(shape => [shape.x, shape.y, shape.width, shape.height]),
          behaviors: region.behaviors.contents.map(behavior => ({ type: behavior.type,
            difficulties: behavior.type === "modifyMovementCost" ? { ...behavior._source.system.difficulties } : undefined })) })),
        teleports, images,
        invalid: { levels: scene.levels.invalidDocumentIds.size, walls: scene.walls.invalidDocumentIds.size, regions: scene.regions.invalidDocumentIds.size,
          behaviors: scene.regions.contents.reduce((total, region) => total + region.behaviors.invalidDocumentIds.size, 0) },
      };
    }, sceneId);
    report.cases.at(-1).native = { ...evidence, walls: evidence.walls.length, wallSamples: evidence.walls.slice(0, 5) };
    assert.equal(evidence.scenes, 1, "one Scene");
    assert.equal(evidence.levels.length, expected.levels, "one Level per floor");
    assert.deepEqual(evidence.invalid, { levels: 0, walls: 0, regions: 0, behaviors: 0 }, "no document Foundry rejected");
    // Scale and placement.
    assert.equal(evidence.size, 100); assert.equal(evidence.padding, 0.25);
    assert.equal(evidence.units, report.system.grid.units === "m" ? "m" : "ft");
    assert.equal(evidence.distance, evidence.units === "m" ? carte.scale.metresPerCell : carte.scale.feetPerCell);
    assert.equal(evidence.width, (carte.grid.columns + 2 * carte.grid.paddingCells) * 100);
    assert.equal(evidence.height, (carte.grid.rows + 2 * carte.grid.paddingCells) * 100);
    assert.equal(evidence.tokenVision, true); assert.equal(evidence.globalLight, true);
    const shift = paddingShift(evidence.width, evidence.height);
    assert.deepEqual([evidence.sceneX, evidence.sceneY], [shift.x, shift.y], "the module and Foundry shift the scene the same way");
    // Levels: the name, order, elevation band, image and what each sees through its voids.
    const used = new Set();
    for (const [index, source] of carte.levels.entries()) {
      const level = evidence.levels.find(candidate => candidate.sort === source.order);
      assert(level, `a Level of order ${source.order}`);
      if (source.label) assert.equal(level.name, source.label.trim());
      assert(close(level.bottom, source.elevation * evidence.distance) && close(level.top, (source.elevation + source.height) * evidence.distance), "the elevation band");
      assert.equal(level.fit, "fill");
      assert(level.src.startsWith(`${uploadFolder}/`) && level.src.endsWith(uploadName(source.image.file, used)), `${level.src} is the uploaded image of level ${index}`);
      assert.deepEqual([...level.sees].sort(), (source.seesThrough ?? []).map(id => evidence.levels.find(l => l.sort === carte.levels.find(c => c.id === id).order).id).sort());
      const image = evidence.images.find(candidate => candidate.id === level.id);
      assert(image.ok && /^image\//.test(image.type), `the image of level ${index} is served`);
    }
    const first = carte.levels.find(level => level.order === 0) ?? carte.levels[0];
    assert.equal(evidence.initialLevel, evidence.levels.find(level => level.sort === first.order).id, "the first floor is shown first");
    // Walls: counts per kind, and the first wall of the first level at the position the formula gives.
    const kind = wall => wall.door === 1 ? "door" : wall.door === 2 ? "secretDoor" : wall.sight === 0 && wall.sound === 20 ? "window" : wall.sight === 0 ? "railing" : "wall";
    const byKind = Object.groupBy(evidence.walls, kind);
    assert.equal(evidence.walls.length, expected.walls);
    assert.equal(byKind.door?.length ?? 0, expected.doors); assert.equal(byKind.secretDoor?.length ?? 0, expected.secretDoors);
    assert.equal(byKind.window?.length ?? 0, expected.windows); assert.equal(byKind.railing?.length ?? 0, expected.railings);
    assert(evidence.walls.every(wall => wall.ds === 0), "every door starts closed");
    // A description point (x, y) lands at the padding shift plus (x + padding cells) grid spaces.
    const pad = carte.grid.paddingCells;
    const spot = (x, y) => [shift.x + (x + pad) * 100, shift.y + (y + pad) * 100];
    const levelOf = source => evidence.levels.find(candidate => candidate.sort === source.order);
    const wallEnds = wall => [...spot(wall.x1, wall.y1), ...spot(wall.x2, wall.y2)].join();
    const wallFor = (source, wall) => evidence.walls.find(candidate => candidate.levels[0] === levelOf(source).id && candidate.c.join() === wallEnds(wall));
    const sample = carte.levels.find(level => level.walls.length);
    assert(wallFor(sample, sample.walls[0]), "a wall sits where the description puts it");
    // The first door and the first secret door: at their place, of the type Foundry reads, closed, blocking like a wall until opened.
    for (const [type, doorType] of [["door", 1], ["secretDoor", 2]]) {
      const holder = carte.levels.find(level => level.walls.some(candidate => candidate.type === type));
      if (!holder) continue;
      const door = wallFor(holder, holder.walls.find(candidate => candidate.type === type));
      assert(door, `the first ${type} sits where the description puts it`);
      assert.equal(door.door, doorType, `a ${type} has the door type ${doorType}`); assert.equal(door.ds, 0, `a ${type} starts closed`);
      assert([door.move, door.sight, door.light, door.sound].every(value => value === 20), `a closed ${type} blocks movement, sight, light and sound`);
    }
    // Regions: one per link and per difficult ground, two per drop, each with its behavior.
    const behaviorCount = type => evidence.regions.flatMap(region => region.behaviors).filter(behavior => behavior.type === type);
    assert.equal(evidence.regions.length, expected.regions);
    assert.equal(behaviorCount("changeLevel").length, expected.links);
    assert.equal(behaviorCount("modifyMovementCost").length, expected.areas);
    assert(behaviorCount("modifyMovementCost").every(behavior => behavior.difficulties.walk === 2), "difficult ground costs double to walk");
    assert.equal(behaviorCount("teleportToken").length, expected.drops);
    for (const link of evidence.regions.filter(region => region.behaviors.some(behavior => behavior.type === "changeLevel"))) assert(link.levels.length >= 2);
    const rectanglesOf = cells => cellRectangles(cells).map(rectangle => [...spot(rectangle.x, rectangle.y), rectangle.width * 100, rectangle.height * 100].join()).join("|");
    // The first water: a Region on its level, over its cells at the position the formula gives, where walking costs double.
    const water = carte.levels.flatMap(level => (level.areas ?? []).filter(area => area.type === "water").map(area => ({ level, area })))[0];
    if (water) {
      const region = evidence.regions.find(candidate => candidate.levels.join() === levelOf(water.level).id
        && candidate.behaviors.some(behavior => behavior.type === "modifyMovementCost") && candidate.rectangles.map(rectangle => rectangle.join()).join("|") === rectanglesOf(water.area.cells));
      assert(region, "the first water Region is on its level, over its cells, at the position the formula gives");
      assert.equal(region.behaviors.find(behavior => behavior.type === "modifyMovementCost").difficulties.walk, 2, "walking in water costs double");
    } else report.cases.at(-1).note = "the map has no water";
    // The first link: its Region joins its levels, over its cells, at the position the formula gives.
    const link = carte.links?.[0];
    if (link) {
      const region = evidence.regions.find(candidate => candidate.behaviors.some(behavior => behavior.type === "changeLevel")
        && candidate.rectangles.map(rectangle => rectangle.join()).join("|") === rectanglesOf(cellsToMap(link.cells)));
      assert(region, "the first link Region is over its cells, at the position the formula gives");
      assert.deepEqual([...region.levels].sort(), link.levels.map(id => levelOf(carte.levels.find(candidate => candidate.id === id)).id).sort(), "it joins the levels the description names");
    }
    for (const teleport of evidence.teleports) {
      assert(teleport.resolved, `the drop destination ${teleport.stored} resolves to a Region of the Scene`);
      assert.equal(teleport.destinationLevels.length, 1); assert.equal(teleport.fromLevels.length, 1);
      assert.notEqual(teleport.destinationLevels[0], teleport.fromLevels[0]);
      // Foundry clamps a teleported token's elevation into the landing Region: it is flat, at the lower floor's base.
      const lower = evidence.levels.find(candidate => candidate.id === teleport.destinationLevels[0]);
      assert.deepEqual(teleport.destinationBand, { bottom: lower.bottom, top: lower.bottom }, "the landing Region is flat at the base of the level below");
    }
    await panel.screenshot({ path: join(reportDir, "done.png") });
    if (args.canvas) {
      // With the canvas drawn: each level viewed with the walls layer on, to look at the walls over their background.
      await panel.evaluate(element => foundry.applications.instances.get(element.id)?.close(), await panel.elementHandle());
      for (const [index, level] of evidence.levels.entries()) {
        await page.evaluate(async ({ id, level }) => {
          const scene = game.scenes.get(id); await scene.view({ level });
          await new Promise(done => setTimeout(done, 1500)); canvas.walls.activate(); canvas.animatePan({ duration: 0, scale: 0.35 });
        }, { id: sceneId, level: level.id });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(reportDir, `canvas-${index}.png`) });
      }
    }
  });

  // One player seat for the steps below: a user and a character the player owns, and a second browser context joined as
  // that user. Created on first use; the browser closing at the end disconnects it.
  const ensurePlayer = async () => playerAccount ??= await page.evaluate(async () => {
    const user = await foundry.documents.User.create({ name: "Map acceptance player", role: 1 });
    const actor = await Actor.create({ name: "Map acceptance hero", type: "character", ownership: { default: 0, [user.id]: 3 } });
    return { user: user.name, actorId: actor.id };
  });
  const seat = async () => {
    if (player) return player;
    const account = await ensurePlayer();
    await page.evaluate(id => game.scenes.get(id).activate(), sceneId);
    player = await joinAs(await newContext(), account.user);
    player.on("pageerror", error => runtimeErrors.push(error.message));
    return player;
  };
  /** A player-owned token on the first region that has the behavior: on its level, at that level's base, one cell beside the region's first rectangle, on a cell no region covers. */
  const placeToken = async behaviorType => page.evaluate(async ({ id, behaviorType, actorId }) => {
    const scene = game.scenes.get(id);
    const region = scene.regions.find(candidate => candidate.behaviors.some(behavior => behavior.type === behaviorType));
    if (!region) return null;
    const size = scene.grid.size, rectangle = region.shapes.find(shape => shape.type === "rectangle");
    const from = scene.levels.get(region._source.levels[0]);
    const elevation = from.elevation.base;
    const start = [[rectangle.x - size, rectangle.y], [rectangle.x + rectangle.width, rectangle.y], [rectangle.x, rectangle.y - size], [rectangle.x, rectangle.y + rectangle.height]]
      .find(([x, y]) => !scene.regions.some(other => other.testPoint({ x: x + size / 2, y: y + size / 2, elevation })));
    if (!start) throw new Error(`No free cell next to the first ${behaviorType} region`);
    const [token] = await scene.createEmbeddedDocuments("Token", [{ name: "Map acceptance hero", actorId, actorLink: true, x: start[0], y: start[1],
      level: from.id, elevation, width: 1, height: 1 }]);
    return { regionId: region.id, tokenId: token.id, start, target: [rectangle.x, rectangle.y], elevation, fromId: from.id, levelIds: [...region._source.levels] };
  }, { id: sceneId, behaviorType, actorId: (await ensurePlayer()).actorId });

  await check("a player-owned token that enters a link's Region is offered the level change, and takes it", async () => {
    const placed = await placeToken("changeLevel");
    if (!placed) { report.cases.at(-1).note = "the map has no link"; return "skipped"; }
    const setup = await page.evaluate(({ id, placed }) => {
      const scene = game.scenes.get(id);
      const offered = placed.levelIds.filter(levelId => levelId !== placed.fromId).map(levelId => scene.levels.get(levelId)).sort((a, b) => b.index - a.index)
        .map(level => ({ id: level.id, name: level.name, base: level.elevation.base }));
      return { ...placed, offered };
    }, { id: sceneId, placed });
    setup.user = (await ensurePlayer()).user; report.cases.at(-1).native = setup;
    const seatPage = await seat();
    await seatPage.waitForFunction(({ id, tokenId }) => game.scenes.get(id)?.tokens.get(tokenId), { id: sceneId, tokenId: setup.tokenId });
    await seatPage.evaluate(({ id, tokenId, target }) => {
      const token = game.scenes.get(id).tokens.get(tokenId);
      // The movement pauses at the prompt, so its promise is not awaited here.
      globalThis.jdrMapMove = token.move({ x: target[0], y: target[1], action: "walk" }, { constrainOptions: { ignoreWalls: true, ignoreCost: true }, animate: false });
    }, { id: sceneId, tokenId: setup.tokenId, target: setup.target });
    const prompt = seatPage.locator('dialog[id^="dialog-"]');
    await prompt.waitFor({ state: "visible", timeout: 30000 });
    const text = await prompt.innerText();
    for (const level of setup.offered) assert(text.includes(level.name) || (await prompt.locator(`select[name="level"] option[value="${level.id}"]`).count()) === 1,
      `the prompt offers ${level.name}`);
    if (setup.offered.length > 1) {
      const options = await prompt.locator('select[name="level"] option').evaluateAll(list => list.map(option => option.value));
      assert.deepEqual(options, setup.offered.map(level => level.id), "every other floor the link joins, highest first");
    }
    await prompt.screenshot({ path: join(reportDir, "prompt.png") });
    await prompt.locator('button[data-action="yes"]').click();
    const destination = setup.offered[0];
    await seatPage.waitForFunction(({ id, tokenId, level }) => game.scenes.get(id).tokens.get(tokenId)._source.level === level, { id: sceneId, tokenId: setup.tokenId, level: destination.id });
    const moved = await seatPage.evaluate(({ id, tokenId }) => { const token = game.scenes.get(id).tokens.get(tokenId); return { level: token._source.level, elevation: token._source.elevation }; },
      { id: sceneId, tokenId: setup.tokenId });
    report.cases.at(-1).native.moved = moved;
    assert.equal(moved.elevation, destination.base, "the token stands at the destination's base elevation");
  });

  await check("a player-owned token that walks into a drop falls to the level below, standing at that floor's base elevation", async () => {
    const placed = await placeToken("teleportToken");
    if (!placed) { report.cases.at(-1).note = "the map has no drop"; return "skipped"; }
    const setup = await page.evaluate(({ id, placed }) => {
      const scene = game.scenes.get(id);
      const source = scene.regions.get(placed.regionId), behavior = source.behaviors.find(candidate => candidate.type === "teleportToken");
      const [stored] = [...behavior.system.destinations];
      const landing = fromUuidSync(stored, { relative: behavior });
      const to = scene.levels.get(landing._source.levels[0]);
      return { ...placed, landingId: landing.id, toId: to.id, toName: to.name, toBase: to.elevation.base, fromBase: scene.levels.get(placed.fromId).elevation.base,
        landingBand: { bottom: landing.elevation.bottom, top: landing.elevation.top } };
    }, { id: sceneId, placed });
    report.cases.at(-1).native = setup;
    assert.notEqual(setup.toId, setup.fromId, "the drop leads to another level");
    assert(setup.toBase < setup.fromBase, "and to a lower one");
    const seatPage = await seat();
    await seatPage.waitForFunction(({ id, tokenId }) => game.scenes.get(id)?.tokens.get(tokenId), { id: sceneId, tokenId: setup.tokenId });
    // No prompt: the drop teleports at once. The movement is not awaited here, its end is the token's new level.
    await seatPage.evaluate(({ id, tokenId, target }) => {
      const token = game.scenes.get(id).tokens.get(tokenId);
      globalThis.jdrDropMove = token.move({ x: target[0], y: target[1], action: "walk" }, { constrainOptions: { ignoreWalls: true, ignoreCost: true }, animate: false });
    }, { id: sceneId, tokenId: setup.tokenId, target: setup.target });
    await seatPage.waitForFunction(({ id, tokenId, level }) => game.scenes.get(id).tokens.get(tokenId)._source.level === level, { id: sceneId, tokenId: setup.tokenId, level: setup.toId },
      { timeout: 30000 });
    const landed = await seatPage.evaluate(({ id, tokenId, landingId }) => {
      const scene = game.scenes.get(id), token = scene.tokens.get(tokenId), size = scene.grid.size;
      return { level: token._source.level, elevation: token._source.elevation, x: token._source.x, y: token._source.y,
        inLanding: scene.regions.get(landingId).testPoint({ x: token._source.x + size / 2, y: token._source.y + size / 2, elevation: token._source.elevation }) };
    }, { id: sceneId, tokenId: setup.tokenId, landingId: setup.landingId });
    report.cases.at(-1).native.landed = landed;
    assert.equal(landed.level, setup.toId, `the token is on ${setup.toName}`);
    // A landing Region as tall as a floor would let Foundry clamp the elevation to near that floor's ceiling: flat, it stays at the base.
    assert.equal(landed.elevation, setup.toBase, "the token stands at the base elevation of the level it fell to");
    assert.deepEqual(setup.landingBand, { bottom: setup.toBase, top: setup.toBase }, "the landing Region is flat at that base");
    assert.equal(landed.inLanding, true, "the token is inside the landing Region");
  });

  assert.deepEqual(runtimeErrors, []);
  const rejected = consoleErrors.filter(text => /Failed to initialize|validation error|DataModelValidationError/i.test(text));
  report.consoleErrors = consoleErrors; assert.deepEqual(rejected, [], "Foundry rejected no document");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = String(error.message).slice(0, 2000); console.error(report.failure); process.exitCode = 1;
  if (page && !page.isClosed()) report.client = await page.evaluate(() => ({ ready: globalThis.game?.ready,
    windows: [...foundry.applications.instances.values()].map(app => ({ id: app.id, rendered: app.rendered, failure: app._failure })) })).catch(() => ({ unavailable: true }));
} finally {
  const cleanup = async (name, action) => { try { await action(); report.cleanup.push({ name, status: "passed" }); }
    catch (error) { report.cleanup.push({ name, status: "failed", reason: String(error.message) }); report.status = "failed"; process.exitCode = 1; } };
  if (browser) await cleanup("close browser", () => browser.close());
  // This run started the Foundry that listens (the port was free just before `start`), so it stops it even when its world
  // never loaded; it never stops one it did not start. Only a different world in it means the server changed hands.
  if (startAttempted) await cleanup("stop owned Foundry", async () => { if (await busy()) {
    const current = await status().catch(() => null);
    assert(!current?.world || current.world === worldId, "Shared server ownership changed"); await manage(["stop", "--wait=20"]);
  } assert(!await busy()); });
  if (worldOwned) await cleanup("remove owned disposable world", removeWorld);
  if (startAttempted) await cleanup("remove the uploaded images", removeUploads);
  if (linkOwned) await cleanup("unlink owned junction", async () => { assert(!await busy());
    assert.equal((await realpath(modulePath)).toLowerCase(), (await realpath(stagePath)).toLowerCase()); await manage(["unlink", "--kind=module", "--id=jdr-ninja"]); });
  if (await exists(stagePath)) await cleanup("remove the bundled copy", async () => { assert(!await exists(modulePath)); await removeStage(); });
  report.finishedAtUtc = new Date().toISOString();
  await mkdir(reportDir, { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${reportPath} (${report.status})`);
}
