import { MapError } from "./errors.js";

/**
 * The map description a JDR Ninja ZIP carries (`carte.json`, version 1) and its validation. Pure: no Foundry globals.
 *
 * Coordinates are grid cells, the origin at the grid's top-left corner, X east and Y south, the padding cells not
 * included. A cell set is a list of row spans: `[{ y: 4, spans: [{ x: 0, length: 11 }] }]`.
 */
export const MAP_FORMAT = "jdr-ninja-map";
export const MAP_VERSION = 1;
export const DESCRIPTION_FILE = "carte.json";
export const WALL_TYPES = Object.freeze(["wall", "door", "secretDoor", "window", "railing"]);
export const AREA_TYPES = Object.freeze(["water", "ice", "squeeze", "lava", "pit"]);
export const IMAGE_EXTENSIONS = Object.freeze(["webp", "png", "jpg", "jpeg"]);
export const LIMITS = Object.freeze({ levels: 32, columns: 2000, rows: 2000, padding: 50, items: 250000, text: 200, id: 64 });

const bad = detail => { throw new MapError("badDescription", { detail }); };
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isInt = value => Number.isSafeInteger(value);
const isNumber = value => typeof value === "number" && Number.isFinite(value);
const isText = (value, max = LIMITS.text) => typeof value === "string" && value.length <= max;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function list(value, path) {
  if (!Array.isArray(value)) bad(path);
  if (value.length > LIMITS.items) bad(`${path}: too many entries`);
  return value;
}

/**
 * Whether an archive entry name stays inside the archive: relative, forward slashes, no empty, `.` or `..` segment,
 * no drive letter and no control character. A trailing slash is allowed (a directory entry).
 */
export function isSafeEntryName(name) {
  if (typeof name !== "string" || !name || name.length > 240) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split("/");
  if (name.endsWith("/")) parts.pop();
  return parts.length > 0 && parts.every(part => part !== "" && part !== "." && part !== ".." && !part.includes(":"));
}

export const imageExtension = name => /\.([A-Za-z0-9]+)$/.exec(String(name))?.[1]?.toLowerCase() ?? "";

function rowSpans(map, path, bounds) {
  for (const [i, row] of list(map, path).entries()) {
    if (!isObject(row) || !isInt(row.y) || row.y < bounds.minY || row.y >= bounds.maxY) bad(`${path}[${i}].y`);
    for (const [j, span] of list(row.spans, `${path}[${i}].spans`).entries()) {
      if (!isObject(span) || !isInt(span.x) || !isInt(span.length) || span.length < 1
        || span.x < bounds.minX || span.x + span.length > bounds.maxX) bad(`${path}[${i}].spans[${j}]`);
    }
  }
}

/**
 * Checks a decoded `carte.json`. Throws a MapError: `unsupportedFormat` or `unsupportedVersion` for a file that is not
 * a version 1 map, `badDescription` (with the offending path as `detail`) for anything malformed.
 */
export function validateDescription(carte) {
  if (!isObject(carte) || carte.format !== MAP_FORMAT) throw new MapError("unsupportedFormat");
  if (carte.version !== MAP_VERSION) throw new MapError("unsupportedVersion", { version: String(carte.version).slice(0, 20) });
  if (carte.name !== undefined && !isText(carte.name)) bad("name");

  const grid = carte.grid;
  if (!isObject(grid) || !isInt(grid.columns) || grid.columns < 1 || grid.columns > LIMITS.columns) bad("grid.columns");
  if (!isInt(grid.rows) || grid.rows < 1 || grid.rows > LIMITS.rows) bad("grid.rows");
  if (!isInt(grid.paddingCells) || grid.paddingCells < 0 || grid.paddingCells > LIMITS.padding) bad("grid.paddingCells");
  const scale = carte.scale;
  if (!isObject(scale) || !isNumber(scale.feetPerCell) || scale.feetPerCell <= 0) bad("scale.feetPerCell");
  if (!isNumber(scale.metresPerCell) || scale.metresPerCell <= 0) bad("scale.metresPerCell");
  const pad = grid.paddingCells;
  const bounds = { minX: -pad, maxX: grid.columns + pad, minY: -pad, maxY: grid.rows + pad };
  const point = (x, y) => isInt(x) && isInt(y) && x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;

  const levels = list(carte.levels, "levels");
  if (!levels.length || levels.length > LIMITS.levels) bad("levels");
  const ids = new Set(), orders = new Set();
  for (const [i, level] of levels.entries()) {
    const at = `levels[${i}]`;
    if (!isObject(level) || typeof level.id !== "string" || !ID.test(level.id) || ids.has(level.id)) bad(`${at}.id`);
    ids.add(level.id);
    if (!isInt(level.order) || orders.has(level.order)) bad(`${at}.order`);
    orders.add(level.order);
    if (level.label !== undefined && !isText(level.label)) bad(`${at}.label`);
    if (!isNumber(level.elevation)) bad(`${at}.elevation`);
    if (!isNumber(level.height) || level.height <= 0) bad(`${at}.height`);
    if (!isObject(level.image) || !isText(level.image.file, 240) || !isSafeEntryName(level.image.file)
      || level.image.file.endsWith("/") || !IMAGE_EXTENSIONS.includes(imageExtension(level.image.file))) bad(`${at}.image.file`);
    if (!isInt(level.image.width) || level.image.width < 1 || !isInt(level.image.height) || level.image.height < 1) bad(`${at}.image`);
  }
  for (const [i, level] of levels.entries()) {
    const at = `levels[${i}]`;
    for (const [j, id] of list(level.seesThrough ?? [], `${at}.seesThrough`).entries()) {
      if (!ids.has(id) || id === level.id) bad(`${at}.seesThrough[${j}]`);
    }
    rowSpans(level.voids ?? [], `${at}.voids`, bounds);
    for (const [j, wall] of list(level.walls, `${at}.walls`).entries()) {
      const valid = isObject(wall) && WALL_TYPES.includes(wall.type) && point(wall.x1, wall.y1) && point(wall.x2, wall.y2)
        && wall.x1 <= wall.x2 && wall.y1 <= wall.y2 && ((wall.x1 === wall.x2) !== (wall.y1 === wall.y2));
      if (!valid) bad(`${at}.walls[${j}]`);
    }
    for (const [j, area] of list(level.areas ?? [], `${at}.areas`).entries()) {
      if (!isObject(area) || !AREA_TYPES.includes(area.type)) bad(`${at}.areas[${j}].type`);
      rowSpans(area.cells, `${at}.areas[${j}].cells`, bounds);
    }
  }
  for (const [i, link] of list(carte.links ?? [], "links").entries()) {
    if (!isObject(link) || typeof link.type !== "string" || !/^[A-Za-z]{1,32}$/.test(link.type)) bad(`links[${i}].type`);
    const joined = list(link.levels, `links[${i}].levels`);
    if (joined.length < 2 || new Set(joined).size !== joined.length || !joined.every(id => ids.has(id))) bad(`links[${i}].levels`);
    for (const [j, cell] of list(link.cells, `links[${i}].cells`).entries()) {
      if (!isObject(cell) || !point(cell.x, cell.y) || cell.x >= bounds.maxX || cell.y >= bounds.maxY) bad(`links[${i}].cells[${j}]`);
    }
  }
  for (const [i, drop] of list(carte.drops ?? [], "drops").entries()) {
    if (!isObject(drop) || !ids.has(drop.from) || !ids.has(drop.to) || drop.from === drop.to) bad(`drops[${i}]`);
    rowSpans(drop.cells, `drops[${i}].cells`, bounds);
  }
}

/** Counts the window shows before the import: levels, walls (doors included), links, difficult ground and drops. */
export function summarize(carte) {
  const levels = carte.levels ?? [];
  const areas = levels.flatMap(level => level.areas ?? []);
  return {
    name: typeof carte.name === "string" ? carte.name.trim() : "",
    levels: levels.length,
    walls: levels.reduce((total, level) => total + (level.walls?.length ?? 0), 0),
    links: (carte.links ?? []).length,
    areas: areas.filter(area => ["water", "ice", "squeeze"].includes(area.type)).length,
    drops: (carte.drops ?? []).length,
  };
}
