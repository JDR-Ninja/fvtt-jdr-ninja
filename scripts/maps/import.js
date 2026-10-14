import { I18N } from "../constants.js";
import { MapError } from "./errors.js";
import { imageExtension } from "./description.js";
import { GRID_SIZE, SCENE_PADDING, absoluteRegionUuid, buildSceneData, normalizeFolder, paddingShift, sceneScale, teleportLinks } from "./translate.js";

/** Files go to the world's user data, the same source the file picker browses first. */
export const DATA_SOURCE = "data";
const REGION_NAMES = ["scene", "level", "link", "stairs", "ladder", "lift", "hatch", "ramp", "water", "ice", "squeeze", "dropSource", "dropDestination"];
const locks = new Set();

/** The localized names a Region or Level gets (`JDRNINJA.maps.region.<name>`). */
export function localizedNames(localize = key => game.i18n.localize(key)) {
  return Object.fromEntries(REGION_NAMES.map(name => [name, localize(`${I18N}.maps.region.${name}`)]));
}

/**
 * The movement actions a movement cost Region can set: those the game system does not derive from another one, the
 * same filter Foundry applies to the fields of that behavior (`modifyMovementCost`).
 */
export function movementCostActions(actions = globalThis.CONFIG?.Token?.movement?.actions ?? {}) {
  return Object.entries(actions).filter(([, config]) => config.terrainAction === undefined
    && config.deriveTerrainDifficulty === undefined).map(([action]) => action);
}

/**
 * The file permission the import lacks, as the code of its error, or null. Sending the images needs FILES_UPLOAD;
 * making the folder and listing it (to never overwrite a file) go through the file browser's socket, which needs
 * FILES_BROWSE.
 */
export function missingFilePermission(user) {
  if (!user.can("FILES_UPLOAD")) return "noUpload";
  if (!user.can("FILES_BROWSE")) return "noBrowse";
  return null;
}

/**
 * The names (decoded, lowercase) of the files and folders a `browse` listing reports. An upload of an image whose name is
 * in there would silently replace it, so they are the names a new image must not take.
 */
export function folderFileNames(listing) {
  const names = new Set();
  for (const entry of [...(listing?.files ?? []), ...(listing?.dirs ?? [])]) {
    let name = String(entry).split("/").pop();
    try { name = decodeURIComponent(name); } catch { /* keep the name as listed */ }
    names.add(name.toLowerCase());
  }
  return names;
}

/**
 * The name an image is uploaded under: the archive entry's file name made safe, and never one in `used` (the names
 * already in the destination folder, then the ones this import sent). Lowercase: two names that differ only by case
 * are one file on some hosts.
 */
export function uploadName(entry, used) {
  const base = String(entry).split("/").pop();
  const extension = imageExtension(base);
  let stem = base.slice(0, base.length - extension.length - 1).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "carte";
  stem = stem.slice(0, 80);
  let name = `${stem}.${extension}`, n = 1;
  while (used.has(name.toLowerCase())) name = `${stem}-${++n}.${extension}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Creates `folder` in the data source, one segment at a time. A segment that already exists is fine: Foundry reports
 * it as an error, which is told apart from a real failure by browsing the folder.
 */
export async function ensureFolder(files, folder, source = DATA_SOURCE) {
  let path = "";
  for (const segment of folder.split("/")) {
    path = path ? `${path}/${segment}` : segment;
    try { await files.createDirectory(source, path); }
    catch (error) {
      const exists = await files.browse(source, path).then(() => true, () => false);
      if (!exists) throw new MapError("folderFailed", { folder }, error);
    }
  }
}

/**
 * The Foundry services the import uses, resolved when it runs. Tests pass their own.
 * @returns {{ game: object, files: object, Scene: object, SquareGrid: Function, config: object, randomID: Function, resolve: Function }}
 */
export function foundryServices() {
  return {
    game, files: foundry.applications.apps.FilePicker.implementation, Scene: CONFIG.Scene.documentClass,
    SquareGrid: foundry.grid.SquareGrid, config: CONFIG, randomID: () => foundry.utils.randomID(16),
    resolve: (uuid, relative) => (foundry.utils.fromUuidSync ?? globalThis.fromUuidSync)(uuid, { relative }),
  };
}

/**
 * Checks that every teleport behavior of the created Scene reaches its destination Region. Foundry stores that
 * destination as a UUID relative to the behavior; if it does not resolve (or the behavior was dropped as invalid),
 * the absolute UUID is written with an update, or the behavior is created again. Returns the ids it could not fix.
 */
export async function ensureTeleports(scene, data, services) {
  const failed = [];
  for (const { regionId, behaviorId, destinationId } of teleportLinks(data)) {
    const absolute = absoluteRegionUuid(scene.id, destinationId);
    const region = scene.regions.get(regionId);
    const behavior = region?.behaviors.get(behaviorId);
    try {
      if (behavior) {
        const [uuid] = behavior.system.destinations ?? [];
        const target = uuid ? services.resolve(uuid, behavior) : null;
        if (target?.documentName === "Region" && target.id === destinationId) continue;
        await behavior.update({ "system.destinations": [absolute] });
      } else if (region) {
        const source = data.regions.find(r => r._id === regionId).behaviors.find(b => b._id === behaviorId);
        await region.createEmbeddedDocuments("RegionBehavior", [{ ...source, system: { ...source.system, destinations: [absolute] } }], { keepId: true });
      } else failed.push(behaviorId);
    } catch { failed.push(behaviorId); }
  }
  return failed;
}

/**
 * Imports a map archive (see readMapArchive): makes the folder, uploads each level image, builds the Scene and creates
 * it with its ids kept. GM only, with the permissions to upload files and to use the file browser. An image never takes
 * the name of a file the folder already holds, so an earlier import's images are never replaced. Nothing is created in
 * the world unless every image was uploaded; a failure after some uploads lists them in `error.details.uploaded`.
 *
 * @param {{ carte: object, images: Map<string, {bytes: Uint8Array, type: string}> }} archive
 * @param {{ folder: string, onProgress?: (state: {step: string, current?: number, total?: number, file?: string}) => void }} options
 * @returns {Promise<{ scene: object, folder: string, uploaded: string[], warnings: string[] }>}
 */
export async function importMap(archive, { folder, onProgress = () => {} } = {}, services = foundryServices()) {
  const { game: current, files, Scene } = services;
  if (!current.user?.isGM) throw new MapError("notGM");
  const missing = missingFilePermission(current.user);
  if (missing) throw new MapError(missing);
  const path = normalizeFolder(folder);
  if (!path) throw new MapError("invalidFolder");
  const lock = `${current.world?.id ?? ""}`;
  if (locks.has(lock)) throw new MapError("busy");
  locks.add(lock);
  const uploaded = [];
  try {
    const { carte } = archive;
    const { distance, units } = sceneScale(carte, current.system?.grid?.units);

    onProgress({ step: "folder" });
    await ensureFolder(files, path);

    // The server replaces a media file that has the name of an upload: the names to avoid are those already in the folder.
    let listing;
    try { listing = await files.browse(DATA_SOURCE, path); }
    catch (error) { throw new MapError("folderUnreadable", { folder: path }, error); }
    const used = folderFileNames(listing), images = {};
    for (const [index, level] of carte.levels.entries()) {
      const image = archive.images.get(level.image.file);
      const name = uploadName(level.image.file, used);
      onProgress({ step: "upload", current: index + 1, total: carte.levels.length, file: name });
      let response;
      try { response = await files.upload(DATA_SOURCE, path, new File([image.bytes], name, { type: image.type }), {}, { notify: false }); }
      catch (error) { throw new MapError("uploadFailed", { file: name, uploaded: [...uploaded] }, error); }
      if (!response?.path) throw new MapError("uploadFailed", { file: name, uploaded: [...uploaded] });
      images[level.id] = response.path;
      uploaded.push(response.path);
    }

    onProgress({ step: "scene" });
    const width = (carte.grid.columns + 2 * carte.grid.paddingCells) * GRID_SIZE;
    const height = (carte.grid.rows + 2 * carte.grid.paddingCells) * GRID_SIZE;
    // Foundry's own square grid decides how far it shifts the scene rectangle for its padding.
    const { x, y } = services.SquareGrid
      ? new services.SquareGrid({ size: GRID_SIZE, distance, units }).calculateDimensions(width, height, SCENE_PADDING)
      : paddingShift(width, height, GRID_SIZE, SCENE_PADDING);
    const data = buildSceneData(carte, {
      gridSize: GRID_SIZE, padding: SCENE_PADDING, distance, units, images, paddingShift: { x, y },
      sceneId: services.randomID(), names: localizedNames(key => current.i18n.localize(key)),
      movementActions: movementCostActions(services.config?.Token?.movement?.actions),
    });
    let scene;
    try { scene = await Scene.create(data, { keepId: true, keepEmbeddedIds: true, renderSheet: false }); }
    catch (error) { throw new MapError("sceneFailed", { uploaded: [...uploaded], folder: path }, error); }
    if (!scene) throw new MapError("sceneFailed", { uploaded: [...uploaded], folder: path });

    const warnings = [];
    if ((await ensureTeleports(scene, data, services)).length) warnings.push("drops");
    return { scene, folder: path, uploaded, warnings };
  } catch (error) {
    if (error instanceof MapError) {
      if (error.details.uploaded === undefined && uploaded.length) error.details.uploaded = [...uploaded];
      throw error;
    }
    throw new MapError("unknown", { uploaded: [...uploaded] }, error);
  } finally { locks.delete(lock); }
}
