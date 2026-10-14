/**
 * Translates a validated map description (see description.js) into the data of one Foundry V14 Scene: its Levels,
 * Walls and Regions. Pure: no Foundry globals, so it runs in Node tests; the Foundry side (import.js) feeds it the
 * uploaded image paths, the world's scale and the padding shift.
 */
export const GRID_SIZE = 100;
export const SCENE_PADDING = 0.25;
const SQUARE_GRID = 1;
const NONE = 0, NORMAL = 20;
const REGION_VISIBILITY_LAYER = 0;
const DOOR = 1, SECRET_DOOR = 2;

/** How each wall type blocks movement, sight, light and sound (CONST.EDGE_SENSE_TYPES: 0 none, 20 normal). */
const WALLS = Object.freeze({
  wall: { door: 0, move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL },
  door: { door: DOOR, move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL },
  secretDoor: { door: SECRET_DOOR, move: NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL },
  window: { door: 0, move: NORMAL, sight: NONE, light: NONE, sound: NORMAL },
  railing: { door: 0, move: NORMAL, sight: NONE, light: NONE, sound: NONE },
});

const COLORS = Object.freeze({ link: "#7a5af8", water: "#3b82f6", ice: "#7dd3fc", squeeze: "#d97706", dropSource: "#dc2626", dropDestination: "#16a34a" });

/** Region names. The Foundry side passes localized ones; these are the fallback. A number follows each. */
export const DEFAULT_NAMES = Object.freeze({
  scene: "JDR Ninja map", level: "Level", link: "Passage between levels", stairs: "Stairs", ladder: "Ladder",
  lift: "Lift", hatch: "Hatch", ramp: "Ramp", water: "Water", ice: "Ice", squeeze: "Tight squeeze",
  dropSource: "Drop", dropDestination: "Drop landing",
});

const LINK_KINDS = Object.freeze(["stairs", "ladder", "lift", "hatch", "ramp"]);
/** The difficult ground that becomes a movement cost Region. Lava and pits stay on the image. */
const COST_AREAS = Object.freeze(["water", "ice", "squeeze"]);

/* ---------------------------------- ids ---------------------------------- */

/** A 128-bit string hash (four 32-bit lanes, after the public-domain cyrb128), enough to derive document ids. */
function hash128(text) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A 16-character alphanumeric Foundry id derived from the element's path in the description. */
export function idFromPath(path) {
  let id = "";
  for (const lane of hash128(String(path))) for (let shift = 0; shift < 32; shift += 8) id += ALPHABET[((lane >>> shift) & 255) % ALPHABET.length];
  return id;
}

/** Hands out ids and never repeats one within a scene (a collision, vanishingly rare, rehashes the path). */
class Ids {
  used = new Set();
  make(path) {
    let key = String(path), attempt = 0, id = idFromPath(key);
    while (this.used.has(id)) id = idFromPath(`${key}#${++attempt}`);
    this.used.add(id);
    return id;
  }
}

/* ------------------------------- geometry -------------------------------- */

/**
 * The offset Foundry draws the scene rectangle at: its square grid's `calculateDimensions` pads each side by
 * `ceil(padding * length / size)` whole grid spaces.
 */
export function paddingShift(width, height, size = GRID_SIZE, padding = SCENE_PADDING) {
  // Same expression order as Foundry's (`* (1 / size)`), so a rounding edge case cannot differ.
  return { x: Math.ceil((padding * width) * (1 / size)) * size, y: Math.ceil((padding * height) * (1 / size)) * size };
}

/**
 * Merges the row spans of a cell set into rectangles, in cells: spans touching in a row join first, then a span that
 * repeats the previous row's x and length grows that rectangle downwards. Sorted by (y, x).
 */
export function cellRectangles(map) {
  const rows = new Map();
  for (const row of map ?? []) {
    const spans = rows.get(row.y) ?? [];
    for (const span of row.spans) spans.push({ x: span.x, end: span.x + span.length });
    rows.set(row.y, spans);
  }
  const rectangles = [];
  let open = new Map();
  let previous = null;
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const merged = [];
    for (const span of rows.get(y).sort((a, b) => a.x - b.x || a.end - b.end)) {
      const last = merged.at(-1);
      if (last && span.x <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    const next = new Map();
    for (const span of merged) {
      const key = `${span.x}:${span.end}`;
      const rectangle = previous === y - 1 ? open.get(key) : undefined;
      if (rectangle) { rectangle.height++; next.set(key, rectangle); }
      else {
        const created = { x: span.x, y, width: span.end - span.x, height: 1 };
        rectangles.push(created); next.set(key, created);
      }
    }
    open = next; previous = y;
  }
  return rectangles.sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height);
}

/** The row spans of a list of `{x, y}` cells. */
export function cellsToMap(cells) {
  const rows = new Map();
  for (const { x, y } of cells ?? []) {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, xs]) => ({ y, spans: runs(xs) }));
}
function runs(xs) {
  const spans = [];
  for (const x of [...new Set(xs)].sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && last.x + last.length === x) last.length++;
    else spans.push({ x, length: 1 });
  }
  return spans;
}

/* ------------------------------- the scene ------------------------------- */

/** The scene's distance per grid space and its units, from the world's game system: metres or, otherwise, feet. */
export function sceneScale(carte, units) {
  return String(units ?? "").trim().toLowerCase() === "m"
    ? { distance: carte.scale.metresPerCell, units: "m" } : { distance: carte.scale.feetPerCell, units: "ft" };
}

/** Rounds away float noise (and a negative zero) from an elevation. */
const round = value => Math.round(value * 1e6) / 1e6 + 0;

/**
 * The creation data of the Scene, as `Scene.create(data, { keepId: true })` takes it.
 *
 * @param {object} carte               A description accepted by validateDescription.
 * @param {object} options
 * @param {number} options.distance    Distance of one grid space, in `units`.
 * @param {string} options.units       "m" or "ft".
 * @param {Record<string, string>} options.images  The uploaded image path of each level, by description level id.
 * @param {number} [options.gridSize=100]
 * @param {number} [options.padding=0.25]          The Scene padding.
 * @param {{x: number, y: number}} [options.paddingShift]  Foundry's own shift for that padding (see paddingShift).
 * @param {string} [options.sceneId]   The Scene's id; derived from the description when absent.
 * @param {string[]} [options.movementActions]     The movement actions a movement cost Region sets (squeeze: all).
 * @param {Partial<typeof DEFAULT_NAMES>} [options.names]  Localized names.
 */
export function buildSceneData(carte, options = {}) {
  const { distance, units, images = {} } = options;
  if (!(distance > 0) || !units) throw new TypeError("buildSceneData needs the distance and the units of a grid space");
  const size = options.gridSize ?? GRID_SIZE;
  const padding = options.padding ?? SCENE_PADDING;
  const names = { ...DEFAULT_NAMES, ...options.names };
  const movementActions = options.movementActions?.length ? options.movementActions : ["walk"];
  const { columns, rows, paddingCells: pad } = carte.grid;
  const width = (columns + 2 * pad) * size, height = (rows + 2 * pad) * size;
  const shift = options.paddingShift ?? paddingShift(width, height, size, padding);
  const px = x => shift.x + (x + pad) * size;
  const py = y => shift.y + (y + pad) * size;
  const ids = new Ids();

  const levels = [], walls = [], regions = [];
  const sceneId = options.sceneId ?? ids.make("scene");
  ids.used.add(sceneId);
  const byId = new Map();
  for (const [index, level] of carte.levels.entries()) {
    const band = { bottom: round(level.elevation * distance), top: round((level.elevation + level.height) * distance) };
    byId.set(level.id, { id: ids.make(`levels/${index}`), band });
  }
  for (const [index, level] of carte.levels.entries()) {
    const { id, band } = byId.get(level.id);
    const src = images[level.id];
    if (typeof src !== "string" || !src) throw new TypeError(`No uploaded image for the level ${level.id}`);
    levels.push({
      _id: id, name: level.label?.trim() || `${names.level} ${level.order}`, sort: level.order,
      elevation: { ...band }, background: { src }, textures: { fit: "fill" },
      visibility: { levels: (level.seesThrough ?? []).map(other => byId.get(other).id) },
    });
    for (const [i, wall] of level.walls.entries()) {
      walls.push({ _id: ids.make(`levels/${index}/walls/${i}`), c: [px(wall.x1), py(wall.y1), px(wall.x2), py(wall.y2)],
        levels: [id], ...WALLS[wall.type], ds: 0, dir: 0 });
    }
  }

  const shapes = map => cellRectangles(map).map(r => ({ type: "rectangle", hole: false, x: px(r.x), y: py(r.y),
    width: r.width * size, height: r.height * size, anchorX: 0, anchorY: 0, rotation: 0, gridBased: false }));
  const counters = {};
  const nameOf = (kind, base) => `${base} ${counters[kind] = (counters[kind] ?? 0) + 1}`;
  const region = (path, name, color, map, levelIds, band, behaviors = []) => {
    const shape = shapes(map);
    if (!shape.length) return null;
    return { _id: ids.make(`${path}/region`), name, color, shapes: shape, elevation: { ...band }, levels: levelIds,
      visibility: REGION_VISIBILITY_LAYER, behaviors };
  };
  const behavior = (path, type, system) => ({ _id: ids.make(`${path}/behavior`), name: "", type, system });

  // Links: one Region over the stair's cells, in every level it joins, that offers the level change.
  for (const [i, link] of (carte.links ?? []).entries()) {
    const joined = link.levels.map(id => byId.get(id));
    const band = { bottom: Math.min(...joined.map(l => l.band.bottom)), top: Math.max(...joined.map(l => l.band.top)) };
    const path = `links/${i}`, kind = LINK_KINDS.includes(link.type) ? link.type : "link";
    const made = region(path, nameOf(kind, names[kind]), COLORS.link, cellsToMap(link.cells),
      joined.map(l => l.id), band, [behavior(path, "changeLevel", { movementActions: [] })]);
    if (made) regions.push(made);
  }
  // Difficult ground: walking costs double; a tight squeeze doubles every movement action.
  for (const [index, level] of carte.levels.entries()) {
    const { id, band } = byId.get(level.id);
    for (const [i, area] of (level.areas ?? []).entries()) {
      if (!COST_AREAS.includes(area.type)) continue;
      const path = `levels/${index}/areas/${i}`;
      const difficulties = area.type === "squeeze" ? Object.fromEntries(movementActions.map(action => [action, 2])) : { walk: 2 };
      const made = region(path, nameOf(area.type, names[area.type]), COLORS[area.type], area.cells, [id], band,
        [behavior(path, "modifyMovementCost", { difficulties })]);
      if (made) regions.push(made);
    }
  }
  // Drops: a landing Region on the level below and a Region on the level above that teleports into it. The
  // destination is a Region of the same Scene, written as the relative UUID Foundry itself stores for one: `..<id>`.
  // The landing Region is flat, at the lower floor: Foundry clamps a teleported token's elevation into the
  // destination Region's range (`RegionDocument#clampElevation`, feet and head), so a Region as tall as the floor would
  // leave a falling token near that floor's ceiling. A Region whose bottom equals its top is valid and tests as
  // containing exactly that elevation, so the token lands at the floor's base.
  for (const [i, drop] of (carte.drops ?? []).entries()) {
    const from = byId.get(drop.from), to = byId.get(drop.to);
    const landing = region(`drops/${i}/to`, nameOf("dropDestination", names.dropDestination), COLORS.dropDestination,
      drop.cells, [to.id], { bottom: to.band.bottom, top: to.band.bottom });
    if (!landing) continue;
    const path = `drops/${i}/from`;
    const source = region(path, nameOf("dropSource", names.dropSource), COLORS.dropSource, drop.cells, [from.id], from.band,
      [behavior(path, "teleportToken", { destinations: [relativeRegionUuid(landing._id)], placement: "relative" })]);
    regions.push(landing, source);
  }

  const initial = carte.levels.find(level => level.order === 0) ?? carte.levels[0];
  return {
    _id: sceneId, name: carte.name?.trim() || names.scene,
    width, height, padding,
    grid: { type: SQUARE_GRID, size, distance, units },
    tokenVision: true, environment: { globalLight: { enabled: true } },
    initialLevel: byId.get(initial.id).id,
    levels, walls, regions,
  };
}

/** A Region of the same Scene, as a UUID relative to a behavior of another Region: up to the Scene, then the id. */
export const relativeRegionUuid = regionId => `..${regionId}`;
export const absoluteRegionUuid = (sceneId, regionId) => `Scene.${sceneId}.Region.${regionId}`;

/** The teleport behaviors of a Scene's data and the Region each one leads to. */
export function teleportLinks(sceneData) {
  return sceneData.regions.flatMap(region => region.behaviors.filter(b => b.type === "teleportToken").map(b => ({
    regionId: region._id, behaviorId: b._id, destinationId: b.system.destinations[0].replace(/^\.\./, ""),
  })));
}

/* ------------------------------ destination ------------------------------ */

/** Lowercase ASCII letters and digits of a map name, joined by hyphens, for a folder name. */
export function slugify(text, fallback = "carte") {
  const slug = String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug || fallback;
}

const two = value => String(value).padStart(2, "0");
/** `jdr-ninja/cartes/<slug>-<YYYYMMDD-HHmmss>`, the stamp in the browser's local time. */
export function defaultFolder(name, now = new Date()) {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `jdr-ninja/cartes/${slugify(name)}-${stamp}`;
}

/**
 * A destination folder in the `data` source: forward slashes, segments of letters, digits, dots, hyphens and
 * underscores only (no `.` or `..` segment), so the path means the same everywhere. Returns null when invalid.
 */
export function normalizeFolder(input) {
  const path = String(input ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = path.split("/");
  const valid = path.length > 0 && path.length <= 200 && segments.length <= 10
    && segments.every(segment => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..");
  return valid ? segments.join("/") : null;
}
