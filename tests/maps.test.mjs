import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { carteFixture, archiveFixture, siteArchiveFixture, siteZip, crc32, SITE_README, SITE_ZIP_STAMP, IMAGE_BYTES } from "./maps-fixture.mjs";
import { validateDescription, summarize, isSafeEntryName } from "../scripts/maps/description.js";
import { MapError, MAP_ERROR_CODES } from "../scripts/maps/errors.js";
import { buildSceneData, paddingShift, cellRectangles, cellsToMap, idFromPath, sceneScale, slugify, defaultFolder,
  normalizeFolder, teleportLinks, relativeRegionUuid, absoluteRegionUuid, DEFAULT_NAMES } from "../scripts/maps/translate.js";
import { readMapArchive, ARCHIVE_LIMITS, imageKind } from "../scripts/maps/zip.js";
import { importMap, ensureFolder, ensureTeleports, uploadName, folderFileNames, missingFilePermission, movementCostActions, localizedNames } from "../scripts/maps/import.js";

const IMAGES = { "L-1": "worlds/w/maps/sous-sol.webp", L0: "worlds/w/maps/rez.webp", L1: "worlds/w/maps/etage.webp" };
const ACTIONS = ["walk", "fly", "swim", "burrow"];
const build = (overrides = {}, carte = carteFixture()) => buildSceneData(carte,
  { distance: 5, units: "ft", images: IMAGES, paddingShift: { x: 500, y: 400 }, movementActions: ACTIONS, ...overrides });
const regionNamed = (data, name) => data.regions.find(region => region.name === name);
const failsWith = (code, check) => error => error instanceof MapError && error.code === code && (check?.(error) ?? true);

/* ------------------------------- the translator ------------------------------- */

test("the padding shift is Foundry's: whole grid spaces of padding on each side, rounded up", () => {
  assert.deepEqual(paddingShift(2000, 1500), { x: 500, y: 400 });
  assert.deepEqual(paddingShift(1400, 1200), { x: 400, y: 300 });
  assert.deepEqual(paddingShift(2000, 1500, 100, 0.5), { x: 1000, y: 800 });
  assert.deepEqual(paddingShift(2000, 1500, 100, 0), { x: 0, y: 0 });
  // The fixture's 16 by 11 grid with 2 padding cells is exactly that 2000 by 1500 scene.
  const data = build();
  assert.equal(data.width, 2000); assert.equal(data.height, 1500); assert.equal(data.padding, 0.25);
});

test("without a shift option the translator applies the same formula", () => {
  assert.deepEqual(buildSceneData(carteFixture(), { distance: 5, units: "ft", images: IMAGES }),
    build({ movementActions: undefined, paddingShift: undefined }));
});

test("the scene carries the scale, the vision settings and the first level to show", () => {
  const data = build();
  assert.equal(data.name, "Château des Brumes");
  assert.deepEqual(data.grid, { type: 1, size: 100, distance: 5, units: "ft" });
  assert.equal(data.tokenVision, true);
  assert.equal(data.environment.globalLight.enabled, true);
  assert.deepEqual(data.levels.map(level => [level.name, level.sort]), [["Sous-sol", -1], ["Rez-de-chaussée", 0], ["Étage", 1]]);
  assert.deepEqual(data.levels.map(level => level.background.src), [IMAGES["L-1"], IMAGES.L0, IMAGES.L1]);
  assert(data.levels.every(level => level.textures.fit === "fill"));
  assert.equal(data.initialLevel, data.levels[1]._id, "the level of order 0");
  const carte = carteFixture(); carte.levels[1].order = 5;
  assert.equal(build({}, carte).initialLevel, build({}, carte).levels[0]._id, "else the first level");
  assert.equal(Object.hasOwn(data, "tokens") || Object.hasOwn(data, "tiles") || Object.hasOwn(data, "flags"), false, "no tokens, tiles or flags");
});

test("each level's elevation band follows its order and height in the world's distance units", () => {
  assert.deepEqual(build().levels.map(level => level.elevation),
    [{ bottom: -20, top: 0 }, { bottom: 0, top: 20 }, { bottom: 20, top: 40 }]);
  const metric = build({ distance: 1.5, units: "m" });
  assert.deepEqual(metric.grid, { type: 1, size: 100, distance: 1.5, units: "m" });
  assert.deepEqual(metric.levels.map(level => level.elevation), [{ bottom: -6, top: 0 }, { bottom: 0, top: 6 }, { bottom: 6, top: 12 }]);
  assert(Object.is(metric.levels[0].elevation.top, 0), "never a negative zero");
});

test("the scale follows the world's system: metres for m, feet for anything else", () => {
  const carte = carteFixture();
  assert.deepEqual(sceneScale(carte, "m"), { distance: 1.5, units: "m" });
  assert.deepEqual(sceneScale(carte, " M "), { distance: 1.5, units: "m" });
  for (const units of ["ft", "", undefined, "yd", "km"]) assert.deepEqual(sceneScale(carte, units), { distance: 5, units: "ft" });
});

test("a void's levels are the ones its level sees through", () => {
  const data = build();
  assert.deepEqual(data.levels.map(level => level.visibility.levels), [[], [], [data.levels[1]._id]]);
});

test("every wall type maps to its blocking rules, on the level it belongs to, at the shifted position", () => {
  const data = build();
  const [sub, ground, upper] = data.levels.map(level => level._id);
  const walls = id => data.walls.filter(wall => wall.levels.length === 1 && wall.levels[0] === id);
  assert.equal(data.walls.length, 7);
  const rules = wall => ({ door: wall.door, ds: wall.ds, move: wall.move, sight: wall.sight, light: wall.light, sound: wall.sound });
  const [plain, door, secret, window, railing] = walls(ground);
  assert.deepEqual(plain.c, [700, 600, 1500, 600]);
  assert.deepEqual(rules(plain), { door: 0, ds: 0, move: 20, sight: 20, light: 20, sound: 20 });
  assert.deepEqual(door.c, [1500, 600, 1600, 600]);
  assert.deepEqual(rules(door), { door: 1, ds: 0, move: 20, sight: 20, light: 20, sound: 20 }, "a closed door");
  assert.deepEqual(secret.c, [1600, 600, 1700, 600]);
  assert.deepEqual(rules(secret), { door: 2, ds: 0, move: 20, sight: 20, light: 20, sound: 20 }, "a closed secret door");
  assert.deepEqual(window.c, [700, 800, 700, 1000]);
  assert.deepEqual(rules(window), { door: 0, ds: 0, move: 20, sight: 0, light: 0, sound: 20 }, "blocks movement and sound only");
  assert.deepEqual(railing.c, [700, 1000, 700, 1200]);
  assert.deepEqual(rules(railing), { door: 0, ds: 0, move: 20, sight: 0, light: 0, sound: 0 }, "blocks movement only");
  assert.deepEqual(walls(sub).map(wall => wall.c), [[900, 800, 1900, 800]]);
  assert.deepEqual(walls(upper).map(wall => wall.c), [[1100, 1000, 1100, 1500]]);
  for (const wall of data.walls) { assert(wall.c.every(Number.isInteger)); assert.equal(wall.dir, 0); }
});

test("a two-level link is one region on both levels with the level change behavior", () => {
  const data = build();
  const [sub, ground, upper] = data.levels;
  const stairs = regionNamed(data, "Stairs 1");
  assert.deepEqual(stairs.levels, [ground._id, upper._id]);
  assert.deepEqual(stairs.elevation, { bottom: 0, top: 40 });
  assert.equal(stairs.visibility, 0);
  assert.deepEqual(stairs.shapes.map(({ type, x, y, width, height, rotation, hole }) => ({ type, x, y, width, height, rotation, hole })),
    [{ type: "rectangle", x: 1400, y: 1300, width: 100, height: 100, rotation: 0, hole: false }]);
  assert.deepEqual(stairs.behaviors.map(({ type, system }) => ({ type, system })), [{ type: "changeLevel", system: { movementActions: [] } }]);
  assert.notEqual(sub._id, stairs.levels[0]);
});

test("a three-level link lists every level it joins and spans from the lowest floor to the highest ceiling", () => {
  const data = build();
  const lift = regionNamed(data, "Lift 1");
  assert.deepEqual(lift.levels, data.levels.map(level => level._id));
  assert.deepEqual(lift.elevation, { bottom: -20, top: 40 });
  assert.deepEqual(lift.shapes.map(({ x, y, width, height }) => ({ x, y, width, height })), [{ x: 1000, y: 900, width: 200, height: 200 }],
    "four cells make one rectangle");
  assert.equal(lift.behaviors[0].type, "changeLevel");
});

test("water and ice cost double to walk, a squeeze doubles every action, lava and pits are image only", () => {
  const data = build();
  const [sub, ground, upper] = data.levels;
  const cost = region => region.behaviors.map(({ type, system }) => [type, system.difficulties]);
  const water = regionNamed(data, "Water 1"), ice = regionNamed(data, "Ice 1"), squeeze = regionNamed(data, "Tight squeeze 1");
  assert.deepEqual(cost(water), [["modifyMovementCost", { walk: 2 }]]);
  assert.deepEqual(water.levels, [ground._id]); assert.deepEqual(water.elevation, { bottom: 0, top: 20 });
  assert.deepEqual(water.shapes.map(({ x, y, width, height }) => ({ x, y, width, height })), [{ x: 800, y: 1100, width: 300, height: 200 }]);
  assert.deepEqual(cost(ice), [["modifyMovementCost", { walk: 2 }]]);
  assert.deepEqual(ice.levels, [sub._id]); assert.deepEqual(ice.elevation, { bottom: -20, top: 0 });
  assert.deepEqual(cost(squeeze), [["modifyMovementCost", { walk: 2, fly: 2, swim: 2, burrow: 2 }]]);
  assert.deepEqual(squeeze.levels, [upper._id]); assert.deepEqual(squeeze.elevation, { bottom: 20, top: 40 });
  assert.equal(data.regions.some(region => /lava|pit/i.test(region.name)), false);
  assert.equal(data.regions.length, 7, "two links, three difficult grounds and the two regions of a drop");
});

test("a drop is a landing region on the lower level and a teleporting region above that leads to it", () => {
  const data = build();
  const [, ground, upper] = data.levels;
  const landing = regionNamed(data, "Drop landing 1"), source = regionNamed(data, "Drop 1");
  // The landing Region is flat at the lower floor's base: Foundry clamps a teleported token's elevation into the
  // destination Region's range, so a Region as tall as the floor would leave the token near its ceiling.
  assert.deepEqual(landing.levels, [ground._id]); assert.deepEqual(landing.elevation, { bottom: 0, top: 0 });
  assert.equal(landing.elevation.bottom, ground.elevation.bottom, "at the base of the level it opens onto");
  assert(landing.elevation.bottom <= landing.elevation.top, "a zero-height band is valid: Foundry only refuses a top below the bottom");
  assert.deepEqual(landing.behaviors, []);
  assert.deepEqual(source.levels, [upper._id]); assert.deepEqual(source.elevation, { bottom: 20, top: 40 });
  assert.deepEqual(source.shapes, landing.shapes, "the same cells");
  assert.deepEqual(landing.shapes.map(({ x, y, width, height }) => ({ x, y, width, height })), [{ x: 1500, y: 1200, width: 200, height: 100 }]);
  const [teleport] = source.behaviors;
  assert.equal(teleport.type, "teleportToken");
  // The destination is a Region of the same Scene: Foundry stores it relative to the behavior, as `..<region id>`.
  assert.deepEqual(teleport.system.destinations, [`..${landing._id}`]);
  assert.equal(relativeRegionUuid(landing._id), `..${landing._id}`);
  assert.equal(absoluteRegionUuid("SceneId", landing._id), `Scene.SceneId.Region.${landing._id}`);
  assert.equal(teleport.system.placement, "relative");
  assert.deepEqual(teleportLinks(data), [{ regionId: source._id, behaviorId: teleport._id, destinationId: landing._id }]);
});

test("a drop's landing is flat at the base of the level below, whatever its elevation or the units; the region above keeps its whole floor", () => {
  const carte = carteFixture();
  carte.drops.push({ from: "L0", to: "L-1", cells: [{ y: 7, spans: [{ x: 1, length: 1 }] }] });
  validateDescription(carte);
  const data = build({ distance: 1.5, units: "m" }, carte);
  const bandOf = name => regionNamed(data, name).elevation;
  assert.deepEqual(bandOf("Drop landing 1"), { bottom: 0, top: 0 });
  assert.deepEqual(bandOf("Drop landing 2"), { bottom: -6, top: -6 }, "a level below ground, in metres");
  assert.deepEqual(bandOf("Drop 1"), { bottom: 6, top: 12 }, "a token walks into the region over the whole upper floor");
  assert.deepEqual(bandOf("Drop 2"), { bottom: 0, top: 6 });
});

test("ids are 16 alphanumeric characters, unique in the scene and derived from the description alone", () => {
  const data = build({ sceneId: "AbCdEfGhIjKlMnOp" });
  const ids = [data._id, ...data.levels.map(l => l._id), ...data.walls.map(w => w._id),
    ...data.regions.flatMap(r => [r._id, ...r.behaviors.map(b => b._id)])];
  assert.equal(data._id, "AbCdEfGhIjKlMnOp");
  assert(ids.every(id => /^[A-Za-z0-9]{16}$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  // The same file imported twice: the embedded ids repeat, only the scene's own id differs.
  const again = build({ sceneId: "ZyXwVuTsRqPoNmLk" });
  const embedded = scene => JSON.stringify({ ...scene, _id: null });
  assert.equal(embedded(again), embedded(data));
  assert.notEqual(again._id, data._id);
  // With no scene id, everything is derived, the scene's included.
  assert.deepEqual(build(), build());
  assert.match(build()._id, /^[A-Za-z0-9]{16}$/);
  assert.equal(idFromPath("levels/0"), idFromPath("levels/0"));
  assert.notEqual(idFromPath("levels/0"), idFromPath("levels/1"));
});

test("thousands of walls get distinct ids", () => {
  const carte = carteFixture();
  carte.levels = [carte.levels[1]]; carte.links = []; carte.drops = [];
  carte.levels[0].seesThrough = [];
  carte.levels[0].walls = Array.from({ length: 5000 }, (_, i) => ({ x1: i % 16, y1: 0, x2: i % 16, y2: 1 + (i % 10), type: "wall" }));
  const data = build({}, carte);
  assert.equal(new Set(data.walls.map(wall => wall._id)).size, 5000);
});

test("region and level names are the localized ones, numbered per kind; an unknown link kind gets the generic name", () => {
  const names = { scene: "Carte", level: "Niveau", link: "Passage", stairs: "Escalier", lift: "Monte-charge", water: "Eau",
    ice: "Glace", squeeze: "Passage étroit", dropSource: "Chute", dropDestination: "Arrivée" };
  const carte = carteFixture();
  delete carte.name; delete carte.levels[1].label;
  carte.links.push({ type: "stairs", levels: ["L0", "L1"], cells: [{ x: 9, y: 9 }] }, { type: "constructor", levels: ["L0", "L1"], cells: [{ x: 1, y: 1 }] });
  const data = build({ names }, carte);
  assert.equal(data.name, "Carte");
  assert.equal(data.levels[1].name, "Niveau 0");
  assert.deepEqual(data.regions.map(region => region.name),
    ["Escalier 1", "Monte-charge 1", "Escalier 2", "Passage 1", "Glace 1", "Eau 1", "Passage étroit 1", "Arrivée 1", "Chute 1"]);
  assert.deepEqual(build().regions.map(region => region.name).slice(0, 2), ["Stairs 1", "Lift 1"], "English fallback names");
});

test("the translator refuses a level with no uploaded image or a grid with no distance", () => {
  assert.throws(() => build({ images: { L0: "a.webp" } }), TypeError);
  assert.throws(() => build({ distance: 0 }), TypeError);
  assert.throws(() => build({ units: "" }), TypeError);
});

test("row spans merge into the fewest rectangles", () => {
  const rect = (x, y, width, height) => ({ x, y, width, height });
  assert.deepEqual(cellRectangles([{ y: 0, spans: [{ x: 0, length: 3 }] }, { y: 1, spans: [{ x: 0, length: 1 }] }, { y: 2, spans: [{ x: 0, length: 1 }] }]),
    [rect(0, 0, 3, 1), rect(0, 1, 1, 2)], "an L shape");
  assert.deepEqual(cellRectangles([{ y: 2, spans: [{ x: 0, length: 2 }, { x: 2, length: 3 }] }]), [rect(0, 2, 5, 1)], "touching spans join");
  assert.deepEqual(cellRectangles([{ y: 0, spans: [{ x: 0, length: 1 }, { x: 2, length: 1 }] }]), [rect(0, 0, 1, 1), rect(2, 0, 1, 1)], "a gap does not");
  assert.deepEqual(cellRectangles([{ y: 0, spans: [{ x: 1, length: 2 }] }, { y: 1, spans: [{ x: 1, length: 2 }] }, { y: 2, spans: [{ x: 1, length: 2 }] }]),
    [rect(1, 0, 2, 3)], "identical rows stack");
  assert.deepEqual(cellRectangles([{ y: 0, spans: [{ x: 1, length: 2 }] }, { y: 2, spans: [{ x: 1, length: 2 }] }]), [rect(1, 0, 2, 1), rect(1, 2, 2, 1)], "a missing row splits");
  assert.deepEqual(cellRectangles([{ y: 1, spans: [{ x: 0, length: 2 }] }, { y: 0, spans: [{ x: 0, length: 2 }] }]), [rect(0, 0, 2, 2)], "row order does not matter");
  assert.deepEqual(cellRectangles([{ y: 0, spans: [{ x: 0, length: 3 }, { x: 2, length: 3 }] }]), [rect(0, 0, 5, 1)], "overlapping spans join");
  assert.deepEqual(cellRectangles([]), []); assert.deepEqual(cellRectangles(undefined), []);
  assert.deepEqual(cellsToMap([{ x: 2, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 5, y: 0 }, { x: 5, y: 0 }]),
    [{ y: 0, spans: [{ x: 5, length: 1 }] }, { y: 1, spans: [{ x: 0, length: 3 }] }]);
});

test("the destination folder defaults to the map's name and the time, and only safe paths are accepted", () => {
  assert.equal(defaultFolder("Château des Brumes", new Date(2026, 9, 14, 9, 5, 7)), "jdr-ninja/cartes/chateau-des-brumes-20261014-090507");
  assert.equal(defaultFolder("", new Date(2026, 0, 2, 3, 4, 5)), "jdr-ninja/cartes/carte-20260102-030405");
  assert.equal(slugify("  --Ça va ?!  "), "ca-va");
  assert.equal(slugify("x".repeat(100)).length, 40);
  assert.equal(normalizeFolder(" jdr-ninja/cartes/a_b.1 "), "jdr-ninja/cartes/a_b.1");
  assert.equal(normalizeFolder("/a\\b/"), "a/b");
  for (const bad of ["", "   ", "../x", "a/../b", "a/./b", "a//b", "a b", "é", "a:b", "a".repeat(201), "a/b/c/d/e/f/g/h/i/j/k", null, undefined]) {
    assert.equal(normalizeFolder(bad), null, String(bad));
  }
});

/* ------------------------------- the description ------------------------------ */

test("the fixture is a valid description and summarizes to its counts", () => {
  const carte = carteFixture();
  validateDescription(carte);
  assert.deepEqual(summarize(carte), { name: "Château des Brumes", levels: 3, walls: 7, links: 2, areas: 3, drops: 1 });
});

test("a description that is not a version 1 map, or is malformed, is refused with the offending path", () => {
  const mutate = change => { const carte = carteFixture(); change(carte); return carte; };
  const rejects = (carte, code, detail) => assert.throws(() => validateDescription(carte),
    failsWith(code, error => detail === undefined || error.details.detail === detail), `${code} ${detail}`);
  rejects(null, "unsupportedFormat"); rejects([], "unsupportedFormat");
  rejects(mutate(c => { c.format = "other"; }), "unsupportedFormat");
  rejects(mutate(c => { c.version = 2; }), "unsupportedVersion");
  rejects(mutate(c => { delete c.version; }), "unsupportedVersion");
  rejects(mutate(c => { delete c.grid; }), "badDescription", "grid.columns");
  rejects(mutate(c => { c.grid.paddingCells = -1; }), "badDescription", "grid.paddingCells");
  rejects(mutate(c => { c.scale.metresPerCell = 0; }), "badDescription", "scale.metresPerCell");
  rejects(mutate(c => { c.name = "x".repeat(500); }), "badDescription", "name");
  rejects(mutate(c => { c.levels = []; }), "badDescription", "levels");
  rejects(mutate(c => { c.levels[2].id = "L0"; }), "badDescription", "levels[2].id");
  rejects(mutate(c => { c.levels[2].order = 0; }), "badDescription", "levels[2].order");
  rejects(mutate(c => { c.levels[2].height = 0; }), "badDescription", "levels[2].height");
  rejects(mutate(c => { c.levels[2].seesThrough = ["nope"]; }), "badDescription", "levels[2].seesThrough[0]");
  rejects(mutate(c => { c.levels[2].seesThrough = ["L1"]; }), "badDescription", "levels[2].seesThrough[0]");
  rejects(mutate(c => { c.levels[0].image.file = "../x.webp"; }), "badDescription", "levels[0].image.file");
  rejects(mutate(c => { c.levels[0].image.file = "niveaux/a.gif"; }), "badDescription", "levels[0].image.file");
  rejects(mutate(c => { delete c.levels[0].image; }), "badDescription", "levels[0].image.file");
  rejects(mutate(c => { c.levels[1].walls[0].y2 = 1; }), "badDescription", "levels[1].walls[0]");
  rejects(mutate(c => { c.levels[1].walls[0].x2 = 0; }), "badDescription", "levels[1].walls[0]");
  rejects(mutate(c => { c.levels[1].walls[0].x2 = 99; }), "badDescription", "levels[1].walls[0]");
  rejects(mutate(c => { c.levels[1].walls[1].type = "portcullis"; }), "badDescription", "levels[1].walls[1]");
  rejects(mutate(c => { c.levels[1].walls[1].x1 = 1.5; }), "badDescription", "levels[1].walls[1]");
  rejects(mutate(c => { c.levels[1].areas[0].type = "mud"; }), "badDescription", "levels[1].areas[0].type");
  rejects(mutate(c => { c.levels[1].areas[0].cells[0].spans[0].length = 0; }), "badDescription", "levels[1].areas[0].cells[0].spans[0]");
  rejects(mutate(c => { c.levels[2].voids[0].y = 500; }), "badDescription", "levels[2].voids[0].y");
  rejects(mutate(c => { c.links[0].levels = ["L0"]; }), "badDescription", "links[0].levels");
  rejects(mutate(c => { c.links[0].levels = ["L0", "L0"]; }), "badDescription", "links[0].levels");
  rejects(mutate(c => { c.links[1].cells[0].x = 99; }), "badDescription", "links[1].cells[0]");
  rejects(mutate(c => { c.drops[0].to = "L1"; }), "badDescription", "drops[0]");
});

test("archive entry names stay inside the archive", () => {
  for (const good of ["carte.json", "niveaux/a.webp", "niveaux/", "a/b/c.png"]) assert(isSafeEntryName(good), good);
  for (const bad of ["", "../x", "a/../b", "/abs", "C:/x", "a\\b", "a//b", "./x", "a/./b", `a${String.fromCharCode(0)}b`, "x".repeat(300), 5, null]) {
    assert(!isSafeEntryName(bad), String(bad));
  }
});

/* --------------------------------- the ZIP reader -------------------------------- */

test("a valid archive yields the description and exactly the images it names", async () => {
  const archive = archiveFixture(carteFixture(), { extra: { "niveaux/carte-etage-1.webp": [IMAGE_BYTES.webp, { level: 9 }] } });
  const { carte, images } = await readMapArchive(archive);
  assert.equal(carte.name, "Château des Brumes");
  assert.deepEqual([...images.keys()].sort(), ["niveaux/carte-etage-1.webp", "niveaux/carte-rez-de-chaussee.webp", "niveaux/carte-sous-sol-1.webp"]);
  for (const image of images.values()) { assert.equal(image.type, "image/webp"); assert.deepEqual([...image.bytes], [...IMAGE_BYTES.webp]); }
  const fromBuffer = await readMapArchive(archive.slice().buffer);
  assert.equal(fromBuffer.images.size, 3);
});

test("an archive written the way the website writes it is accepted: stored entries, UTF-8 names, no extra field, CRLF readme", async () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "the writer's checksum is the standard one");
  const zip = siteArchiveFixture();
  // What the hand-written writer promises, read straight from the bytes: the first entry's local header and the end record.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, "a local file header");
  assert.equal(view.getUint16(4, true), 20, "version needed to extract");
  assert.equal(view.getUint16(6, true), 0x0800, "the UTF-8 name flag, nothing else");
  assert.equal(view.getUint16(8, true), 0, "stored, not deflated");
  assert.equal(view.getUint16(28, true), 0, "no extra field");
  const date = ((SITE_ZIP_STAMP.year - 1980) << 9) | (SITE_ZIP_STAMP.month << 5) | SITE_ZIP_STAMP.day;
  assert.equal(view.getUint16(12, true), date); assert.equal(view.getUint16(10, true) >> 11, SITE_ZIP_STAMP.hour);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50, "an end of central directory record with no comment");
  assert.equal(view.getUint16(zip.length - 12, true), 5, "carte.json, three images and the readme");
  assert(SITE_README.includes("\r\n") && !/[^\r]\n/.test(SITE_README), "the readme has CRLF line ends only");

  const { carte, images } = await readMapArchive(zip);
  assert.equal(carte.name, "Château des Brumes");
  assert.deepEqual([...images.keys()].sort(), ["niveaux/carte-etage-1.webp", "niveaux/carte-rez-de-chaussee.webp", "niveaux/carte-sous-sol-1.webp"]);
  for (const image of images.values()) { assert.equal(image.type, "image/webp"); assert.deepEqual([...image.bytes], [...IMAGE_BYTES.webp]); }
  // The same through an ArrayBuffer, with PNG levels, and with an entry whose UTF-8 name is not ASCII.
  assert.equal((await readMapArchive(zip.slice().buffer)).images.size, 3);
  const png = carteFixture();
  for (const level of png.levels) level.image.file = level.image.file.replace(".webp", ".png");
  assert([...(await readMapArchive(siteArchiveFixture(png, IMAGE_BYTES.png))).images.values()].every(image => image.type === "image/png"));
  const encoder = new TextEncoder();
  const accented = siteZip([["carte.json", encoder.encode(JSON.stringify(carteFixture()))], ["notes/élévation.txt", encoder.encode("x")],
    ...carteFixture().levels.map(level => [level.image.file, IMAGE_BYTES.webp])]);
  assert.equal((await readMapArchive(accented)).images.size, 3);
});

test("a PNG level image is read as a PNG", async () => {
  const carte = carteFixture();
  for (const level of carte.levels) level.image.file = level.image.file.replace(".webp", ".png");
  const files = { "carte.json": strToU8(JSON.stringify(carte)) };
  for (const level of carte.levels) files[level.image.file] = [IMAGE_BYTES.png, { level: 0 }];
  const { images } = await readMapArchive(zipSync(files));
  assert([...images.values()].every(image => image.type === "image/png"));
});

test("an image the description names but the archive lacks is refused, naming the level and the file", async () => {
  await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { omit: ["niveaux/carte-etage-1.webp"] })),
    failsWith("missingImage", error => error.details.level === "Étage" && error.details.file === "niveaux/carte-etage-1.webp"));
});

test("another format or version is refused before any image is read", async () => {
  const carte = carteFixture();
  await assert.rejects(readMapArchive(archiveFixture({ ...carte, format: "something-else" })), failsWith("unsupportedFormat"));
  await assert.rejects(readMapArchive(archiveFixture({ ...carte, version: 2 })), failsWith("unsupportedVersion", error => error.details.version === "2"));
  await assert.rejects(readMapArchive(archiveFixture(carte, { description: strToU8("{not json") })), failsWith("badDescription"));
  await assert.rejects(readMapArchive(archiveFixture(carte, { description: strToU8("[]") })), failsWith("unsupportedFormat"));
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...strToU8(JSON.stringify(carte))]);
  assert.equal((await readMapArchive(archiveFixture(carte, { description: bom }))).carte.version, 1, "a byte order mark is tolerated");
});

test("entry names that climb out of the archive, start at a root or use backslashes are refused", async () => {
  for (const name of ["../evil.txt", "niveaux/../../evil.webp", "/absolute.txt", "C:/drive.txt", "dossier\\evil.txt", "a//b.txt"]) {
    await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { extra: { [name]: strToU8("x") } })),
      failsWith("unsafeName"), name);
  }
  // A description whose image path climbs out is refused as a malformed description.
  const carte = carteFixture(); carte.levels[0].image.file = "../escape.webp";
  await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { description: strToU8(JSON.stringify(carte)) })),
    failsWith("badDescription", error => error.details.detail === "levels[0].image.file"));
});

test("bytes that are not a zip, an archive without a description or a bad image are refused", async () => {
  await assert.rejects(readMapArchive(new Uint8Array(5)), failsWith("notZip"));
  await assert.rejects(readMapArchive(new Uint8Array(200).fill(7)), failsWith("notZip"));
  await assert.rejects(readMapArchive(zipSync({ "niveaux/a.webp": [IMAGE_BYTES.webp, { level: 0 }] })), failsWith("missingDescription"));
  const wrong = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
  await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { extra: { "niveaux/carte-etage-1.webp": [wrong, { level: 0 }] } })),
    failsWith("badImage", error => error.details.file === "niveaux/carte-etage-1.webp"));
  await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { extra: { "niveaux/carte-etage-1.webp": [IMAGE_BYTES.png, { level: 0 }] } })),
    failsWith("badImage"), "a PNG under a .webp name");
  assert.equal(imageKind(IMAGE_BYTES.webp), "webp"); assert.equal(imageKind(IMAGE_BYTES.png), "png");
  assert.equal(imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg"); assert.equal(imageKind(new Uint8Array(3)), null);
});

test("sizes are bounded before anything is inflated", async () => {
  const huge = new Uint8Array(8); Object.defineProperty(huge, "length", { value: ARCHIVE_LIMITS.archiveBytes + 1 });
  await assert.rejects(readMapArchive(huge), failsWith("tooLarge"));
  const description = new Uint8Array(ARCHIVE_LIMITS.descriptionBytes + 1).fill(32);
  await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { description })), failsWith("tooLarge"));
  const extra = Object.fromEntries(Array.from({ length: ARCHIVE_LIMITS.entries + 1 }, (_, i) => [`extra/${i}.txt`, strToU8("x")]));
  await assert.rejects(readMapArchive(archiveFixture(carteFixture(), { extra })), failsWith("tooManyEntries"));
});

test("a zip library that cannot be loaded is reported as such", async () => {
  await assert.rejects(readMapArchive(archiveFixture(), { load: async () => { throw new Error("no such package"); } }), failsWith("readerUnavailable"));
});

/* ---------------------------------- the import --------------------------------- */

const SCENE_ID = "SceneIdSceneId12";
let worlds = 0;
/** A Region collection of the created Scene, the way Foundry exposes it: regions by id, each with its behaviors by id. */
function fakeScene(data, calls) {
  const regions = new Map(data.regions.map(region => {
    const behaviors = new Map(region.behaviors.map(source => [source._id, {
      id: source._id, system: { destinations: new Set(source.system.destinations ?? []) },
      async update(changes) {
        if (calls.failUpdate) throw new Error("denied");
        calls.updates.push([source._id, changes]);
      },
    }]));
    return [region._id, { id: region._id, documentName: "Region", behaviors,
      async createEmbeddedDocuments(type, documents, options) { calls.embedded.push([region._id, type, documents, options]); } }];
  }));
  return { id: data._id, name: data.name, regions };
}
/** The Foundry services of an import, recorded: the user, the file picker, the Scene class and the square grid. */
function services({ gm = true, upload = true, browse = true, units = "ft", existing = new Set(), present = {}, failBrowse = "",
  failUpload = null, throwUpload = null, failCreate = false, failUpdate = false, world, gate } = {}) {
  const calls = { directories: [], browsed: [], uploads: [], created: [], updates: [], embedded: [], order: [], failUpdate };
  const game = { user: { isGM: gm, can: permission => (permission === "FILES_UPLOAD" && upload) || (permission === "FILES_BROWSE" && browse) },
    system: { grid: { units } }, world: { id: world ?? `world-${++worlds}` }, i18n: { localize: key => `loc:${key}` } };
  // The folders that exist (the given ones, then the ones the import makes) and the files `present` in each, by folder.
  const folders = new Set(existing);
  const files = {
    async createDirectory(source, path) { calls.directories.push([source, path]); if (folders.has(path)) throw new Error("EEXIST: already exists"); folders.add(path); },
    /** The listing Foundry's server sends: the client paths of the files, URL-encoded. */
    async browse(source, path) {
      calls.browsed.push(path); calls.order.push("browse");
      if (!folders.has(path) || failBrowse === path) throw new Error("ENOENT");
      return { target: path, dirs: [], files: (present[path] ?? []).map(name => `${path}/${encodeURIComponent(name)}`) };
    },
    async upload(source, path, file, body, options) {
      await gate;
      calls.order.push("upload");
      calls.uploads.push({ source, path, name: file.name, type: file.type, size: file.size, options });
      if (throwUpload === file.name) throw new Error("socket closed");
      return failUpload === file.name ? false : { path: `${path}/${file.name}` };
    },
  };
  class SquareGrid {
    constructor(config) { calls.grid = config; }
    calculateDimensions(width, height, padding) { calls.dimensions = [width, height, padding]; return { x: 500, y: 400 }; }
  }
  const Scene = { async create(data, options) {
    calls.created.push({ data, options });
    if (failCreate) throw new Error("rejected by the server");
    return calls.scene = fakeScene(data, calls);
  } };
  /** Foundry's `fromUuidSync` for a Region of the created Scene, relative (`..<id>`) or absolute. */
  const resolve = uuid => calls.scene?.regions.get(uuid.startsWith("..") ? uuid.slice(2) : uuid.split(".").at(-1)) ?? null;
  return { calls, game, files, Scene, SquareGrid, randomID: () => SCENE_ID, resolve,
    config: { Token: { movement: { actions: { walk: {}, fly: {}, swim: {}, burrow: {}, crawl: { terrainAction: "walk" }, climb: { terrainAction: "walk" },
      jump: { deriveTerrainDifficulty() {} }, blink: { terrainAction: null }, displace: { terrainAction: null } } } } } };
}
const FOLDER = "jdr-ninja/cartes/chateau-20261014-090507";
const archiveOf = async () => readMapArchive(archiveFixture());

test("an import creates the folder, uploads each image and creates the scene with its ids kept", async () => {
  const s = services(), progress = [];
  const result = await importMap(await archiveOf(), { folder: FOLDER, onProgress: state => progress.push(state) }, s);
  assert.deepEqual(s.calls.directories, [["data", "jdr-ninja"], ["data", "jdr-ninja/cartes"], ["data", FOLDER]]);
  assert.deepEqual(s.calls.uploads.map(u => [u.source, u.path, u.name, u.type, u.size, u.options]),
    ["carte-sous-sol-1.webp", "carte-rez-de-chaussee.webp", "carte-etage-1.webp"].map(name =>
      ["data", FOLDER, name, "image/webp", IMAGE_BYTES.webp.length, { notify: false }]));
  assert.equal(s.calls.created.length, 1);
  const { data, options } = s.calls.created[0];
  assert.equal(options.keepId, true);
  assert.equal(data._id, SCENE_ID);
  assert.deepEqual(data.levels.map(level => level.background.src), ["carte-sous-sol-1.webp", "carte-rez-de-chaussee.webp", "carte-etage-1.webp"].map(name => `${FOLDER}/${name}`));
  assert.deepEqual(s.calls.grid, { size: 100, distance: 5, units: "ft" });
  assert.deepEqual(s.calls.dimensions, [2000, 1500, 0.25], "Foundry's own grid computes the shift");
  assert.deepEqual(data.walls.find(wall => wall.door === 1).c, [1500, 600, 1600, 600], "from the shift it returned");
  assert.equal(data.levels[0].name, "Sous-sol");
  assert.equal(regionNamed(data, "loc:JDRNINJA.maps.region.stairs 1").levels.length, 2, "localized region names");
  assert.deepEqual(progress, [{ step: "folder" }, { step: "upload", current: 1, total: 3, file: "carte-sous-sol-1.webp" },
    { step: "upload", current: 2, total: 3, file: "carte-rez-de-chaussee.webp" }, { step: "upload", current: 3, total: 3, file: "carte-etage-1.webp" }, { step: "scene" }]);
  assert.equal(result.scene.id, SCENE_ID);
  assert.equal(result.folder, FOLDER);
  assert.deepEqual(result.uploaded, data.levels.map(level => level.background.src));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(s.calls.updates, [], "the teleport destination resolves as written");
  assert.deepEqual(s.calls.embedded, []);
});

test("in a world that measures in metres the scene is in metres", async () => {
  const s = services({ units: "m" });
  await importMap(await archiveOf(), { folder: FOLDER }, s);
  const { data } = s.calls.created[0];
  assert.deepEqual(data.grid, { type: 1, size: 100, distance: 1.5, units: "m" });
  assert.deepEqual(data.levels[2].elevation, { bottom: 6, top: 12 });
  assert.deepEqual(s.calls.grid, { size: 100, distance: 1.5, units: "m" });
});

test("a squeeze doubles the movement actions the game system lets a region set", async () => {
  const s = services();
  await importMap(await archiveOf(), { folder: FOLDER }, s);
  const squeeze = s.calls.created[0].data.regions.find(region => region.name === "loc:JDRNINJA.maps.region.squeeze 1");
  assert.deepEqual(squeeze.behaviors[0].system.difficulties, { walk: 2, fly: 2, swim: 2, burrow: 2 });
  assert.deepEqual(movementCostActions(s.config.Token.movement.actions), ACTIONS);
  assert.deepEqual(movementCostActions({}), []);
});

test("the import needs the permission to browse files as well as to upload them, and names the one that is missing", () => {
  const user = (upload, browse) => ({ can: permission => (permission === "FILES_UPLOAD" && upload) || (permission === "FILES_BROWSE" && browse) });
  assert.equal(missingFilePermission(user(true, true)), null);
  assert.equal(missingFilePermission(user(false, true)), "noUpload");
  assert.equal(missingFilePermission(user(true, false)), "noBrowse");
  assert.equal(missingFilePermission(user(false, false)), "noUpload");
});

test("only a GM who can upload files and browse them, with a valid folder, can import; nothing is uploaded otherwise", async () => {
  const archive = await archiveOf();
  for (const [name, options, code] of [["player", { gm: false }, "notGM"], ["no upload permission", { upload: false }, "noUpload"],
    ["no file browser permission", { browse: false }, "noBrowse"], ["neither: the upload is named first", { upload: false, browse: false }, "noUpload"]]) {
    const s = services(options);
    await assert.rejects(importMap(archive, { folder: FOLDER }, s), failsWith(code), name);
    assert.equal(s.calls.uploads.length + s.calls.directories.length + s.calls.created.length, 0, name);
  }
  for (const folder of ["", "../out", "a b", undefined]) {
    const s = services();
    await assert.rejects(importMap(archive, { folder }, s), failsWith("invalidFolder"), String(folder));
    assert.equal(s.calls.uploads.length, 0);
  }
});

test("an upload that fails stops the import, creates no scene and lists what was uploaded", async () => {
  for (const options of [{ failUpload: "carte-rez-de-chaussee.webp" }, { throwUpload: "carte-rez-de-chaussee.webp" }]) {
    const s = services(options);
    await assert.rejects(importMap(await archiveOf(), { folder: FOLDER }, s), failsWith("uploadFailed",
      error => error.details.file === "carte-rez-de-chaussee.webp" && JSON.stringify(error.details.uploaded) === JSON.stringify([`${FOLDER}/carte-sous-sol-1.webp`])));
    assert.equal(s.calls.created.length, 0);
    assert.equal(s.calls.uploads.length, 2, "the third image was never sent");
  }
});

test("an image never takes the name of a file the folder already holds: the server would replace that file", async () => {
  const taken = ["carte-sous-sol-1.webp", "Carte-Rez-De-Chaussee.WEBP", "carte-rez-de-chaussee-2.webp", "carte-etage-1.png", "notes.txt", "mon image.webp"];
  const s = services({ existing: new Set([FOLDER]), present: { [FOLDER]: taken } }), progress = [];
  const result = await importMap(await archiveOf(), { folder: FOLDER, onProgress: state => progress.push(state) }, s);
  const sent = s.calls.uploads.map(upload => upload.name);
  // The first free name, whatever the case: -2 is taken for the ground floor too, and a PNG does not hold a WebP's name.
  assert.deepEqual(sent, ["carte-sous-sol-1-2.webp", "carte-rez-de-chaussee-3.webp", "carte-etage-1.webp"]);
  const held = new Set(taken.map(name => name.toLowerCase()));
  assert(sent.every(name => !held.has(name.toLowerCase())), "no upload can replace an existing file");
  assert(s.calls.order.lastIndexOf("browse") < s.calls.order.indexOf("upload"), "the folder is read before anything is sent");
  assert.deepEqual(s.calls.created[0].data.levels.map(level => level.background.src), sent.map(name => `${FOLDER}/${name}`),
    "each level points at the file it was sent as");
  assert.deepEqual(result.uploaded, sent.map(name => `${FOLDER}/${name}`));
  assert.deepEqual(progress.filter(state => state.step === "upload").map(state => state.file), sent);
  // The same import again, into the folder it just filled: nothing of the first one is replaced.
  const again = services({ existing: new Set([FOLDER]), present: { [FOLDER]: [...taken, ...sent] } });
  await importMap(await archiveOf(), { folder: FOLDER }, again);
  assert.deepEqual(again.calls.uploads.map(upload => upload.name), ["carte-sous-sol-1-3.webp", "carte-rez-de-chaussee-4.webp", "carte-etage-1-2.webp"]);
});

test("a folder that cannot be listed stops the import before any file is sent", async () => {
  const s = services({ failBrowse: FOLDER });
  await assert.rejects(importMap(await archiveOf(), { folder: FOLDER }, s), failsWith("folderUnreadable",
    error => error.details.folder === FOLDER && error.cause?.message === "ENOENT"));
  assert.equal(s.calls.uploads.length, 0); assert.equal(s.calls.created.length, 0);
});

test("the names a folder listing reports are decoded and lowercased, folders included", () => {
  assert.deepEqual([...folderFileNames({ files: ["a/B%20c.webp", "a/%C3%A9.png", "a/%ZZ.webp"], dirs: ["a/Sub"] })].sort(), ["%zz.webp", "b c.webp", "sub", "é.png"]);
  assert.equal(folderFileNames(undefined).size, 0); assert.equal(folderFileNames({}).size, 0);
});

test("a scene that cannot be created reports every image already uploaded", async () => {
  const s = services({ failCreate: true });
  await assert.rejects(importMap(await archiveOf(), { folder: FOLDER }, s), failsWith("sceneFailed",
    error => error.details.uploaded.length === 3 && error.details.folder === FOLDER && error.cause?.message === "rejected by the server"));
});

test("a folder that exists is fine, one that cannot be made is reported", async () => {
  const s = services({ existing: new Set(["jdr-ninja", "jdr-ninja/cartes"]) });
  await ensureFolder(s.files, FOLDER);
  assert.deepEqual(s.calls.directories.map(([, path]) => path), ["jdr-ninja", "jdr-ninja/cartes", FOLDER]);
  assert.deepEqual(s.calls.browsed, ["jdr-ninja", "jdr-ninja/cartes"], "each failure is told apart by browsing the folder");
  const broken = services();
  broken.files.createDirectory = async () => { throw new Error("permission denied"); };
  await assert.rejects(importMap(await archiveOf(), { folder: FOLDER }, broken), failsWith("folderFailed", error => error.details.folder === FOLDER));
  assert.equal(broken.calls.uploads.length, 0);
});

test("a second import in the same world waits for the first to finish", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = services({ world: "shared", gate }), second = services({ world: "shared" });
  const archive = await archiveOf();
  const running = importMap(archive, { folder: FOLDER }, first);
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(importMap(archive, { folder: FOLDER }, second), failsWith("busy"));
  release();
  await running;
  await importMap(archive, { folder: FOLDER }, second);
  assert.equal(second.calls.created.length, 1, "the lock is released");
});

test("a teleport destination that does not resolve is rewritten as an absolute UUID, a missing behavior is created again", async () => {
  const data = build({ sceneId: SCENE_ID });
  const [link] = teleportLinks(data);
  const behaviorOf = scene => scene.regions.get(link.regionId).behaviors.get(link.behaviorId);
  const absolute = absoluteRegionUuid(SCENE_ID, link.destinationId);
  const make = () => { const calls = { updates: [], embedded: [] }; return { calls, scene: fakeScene(data, calls) }; };
  const withResolver = resolve => ({ resolve });

  let { calls, scene } = make();
  assert.deepEqual(await ensureTeleports(scene, data, withResolver(uuid => scene.regions.get(uuid.slice(2)))), []);
  assert.deepEqual(calls.updates, [], "a destination that resolves is left alone");

  ({ calls, scene } = make());
  assert.deepEqual(await ensureTeleports(scene, data, withResolver(() => null)), []);
  assert.deepEqual(calls.updates, [[link.behaviorId, { "system.destinations": [absolute] }]]);

  ({ calls, scene } = make());
  scene.regions.get(link.regionId).behaviors.delete(link.behaviorId);
  assert.deepEqual(await ensureTeleports(scene, data, withResolver(() => null)), []);
  const [[regionId, type, documents, options]] = calls.embedded;
  assert.deepEqual([regionId, type, options], [link.regionId, "RegionBehavior", { keepId: true }]);
  assert.equal(documents[0]._id, link.behaviorId); assert.equal(documents[0].type, "teleportToken");
  assert.deepEqual(documents[0].system.destinations, [absolute]);

  ({ calls, scene } = make());
  scene.regions.delete(link.regionId);
  assert.deepEqual(await ensureTeleports(scene, data, withResolver(() => null)), [link.behaviorId]);

  ({ calls, scene } = make());
  behaviorOf(scene).update = async () => { throw new Error("denied"); };
  assert.deepEqual(await ensureTeleports(scene, data, withResolver(() => null)), [link.behaviorId]);
});

test("an unresolved teleport is repaired after the import, and only one that cannot be repaired is a warning", async () => {
  const repaired = services();
  repaired.resolve = () => null;
  assert.deepEqual((await importMap(await archiveOf(), { folder: FOLDER }, repaired)).warnings, []);
  assert.equal(repaired.calls.updates.length, 1);
  const refused = services({ failUpdate: true });
  refused.resolve = () => null;
  const result = await importMap(await archiveOf(), { folder: FOLDER }, refused);
  assert.deepEqual(result.warnings, ["drops"]);
  assert.equal(result.scene.id, SCENE_ID, "the scene exists all the same");
});

test("uploaded file names are the entries' safe names, and never repeat", () => {
  const used = new Set();
  assert.equal(uploadName("niveaux/carte-rez-de-chaussée.webp", used), "carte-rez-de-chaussee.webp");
  assert.equal(uploadName("autre/carte-rez-de-chaussee.webp", used), "carte-rez-de-chaussee-2.webp");
  assert.equal(uploadName("niveaux/Carte Sous Sol (1).PNG", used), "Carte-Sous-Sol-1.png");
  assert.equal(uploadName("niveaux/---.webp", used), "carte.webp");
  // Names already in the destination folder count as used, whatever their case.
  const held = new Set(["carte-rez-de-chaussee.webp", "carte-rez-de-chaussee-2.webp"]);
  assert.equal(uploadName("niveaux/Carte-Rez-de-Chaussee.webp", held), "Carte-Rez-de-Chaussee-3.webp");
  assert(held.has("carte-rez-de-chaussee-3.webp"));
  assert.equal(uploadName("niveaux/autre.webp", held), "autre.webp", "a free name is kept");
});

test("localized names ask for every region name and every error has a code", () => {
  const asked = [];
  const names = localizedNames(key => { asked.push(key); return key.toUpperCase(); });
  assert.deepEqual(Object.keys(names).sort(), Object.keys(DEFAULT_NAMES).sort());
  assert(asked.every(key => key.startsWith("JDRNINJA.maps.region.")));
  assert.equal(new Set(MAP_ERROR_CODES).size, MAP_ERROR_CODES.length);
});
