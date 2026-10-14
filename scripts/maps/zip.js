import { MapError } from "./errors.js";
import { DESCRIPTION_FILE, imageExtension, isSafeEntryName, validateDescription } from "./description.js";

/** What the reader accepts. The archive and every entry are measured from the zip directory before anything is inflated. */
export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024, entries: 256, descriptionBytes: 16 * 1024 * 1024,
  imageBytes: 64 * 1024 * 1024, totalBytes: 384 * 1024 * 1024,
});

const MIME = Object.freeze({ webp: "image/webp", png: "image/png", jpeg: "image/jpeg" });
const KIND_OF_EXTENSION = Object.freeze({ webp: "webp", png: "png", jpg: "jpeg", jpeg: "jpeg" });

/**
 * The zip library is loaded on first use. The release bundle inlines it; a source checkout loaded straight into
 * Foundry has no way to resolve the package, which is then reported instead of breaking the whole module.
 */
let library = null;
const loadLibrary = async () => library ??= await import("fflate");

/** The kind of image the first bytes announce, or null. */
export function imageKind(bytes) {
  const at = (...values) => values.every((value, i) => bytes[i] === value);
  if (bytes.length > 12 && at(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes.length > 8 && at(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (bytes.length > 3 && at(0xff, 0xd8, 0xff)) return "jpeg";
  return null;
}

/**
 * Reads a JDR Ninja map archive: `carte.json`, the level images it names and nothing else. Throws a MapError.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{ load?: () => Promise<{unzipSync: Function, strFromU8: Function}> }} [options]  Overrides the zip library.
 * @returns {Promise<{ carte: object, images: Map<string, {bytes: Uint8Array, type: string}> }>}
 *   `images` is keyed by the entry name the description gives.
 */
export async function readMapArchive(input, { load = loadLibrary } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > ARCHIVE_LIMITS.archiveBytes) throw new MapError("tooLarge");
  if (bytes.length < 22) throw new MapError("notZip");
  let reader;
  try { reader = await load(); }
  catch (error) { throw error instanceof MapError ? error : new MapError("readerUnavailable", {}, error); }
  const { unzipSync, strFromU8 } = reader;

  // The zip directory alone: the filter declines every entry, so nothing is inflated yet.
  const entries = new Map();
  let total = 0;
  try {
    unzipSync(bytes, { filter: ({ name, originalSize }) => {
      if (!isSafeEntryName(name) || entries.has(name)) throw new MapError("unsafeName", { name: String(name).slice(0, 80) });
      if (entries.size >= ARCHIVE_LIMITS.entries) throw new MapError("tooManyEntries");
      total += originalSize;
      entries.set(name, originalSize);
      return false;
    } });
  } catch (error) {
    throw error instanceof MapError ? error : new MapError("notZip", {}, error);
  }
  if (total > ARCHIVE_LIMITS.totalBytes) throw new MapError("tooLarge");

  // The description, validated before any image is read.
  if (!entries.has(DESCRIPTION_FILE)) throw new MapError("missingDescription");
  if (entries.get(DESCRIPTION_FILE) > ARCHIVE_LIMITS.descriptionBytes) throw new MapError("tooLarge");
  const raw = inflate(unzipSync, bytes, [DESCRIPTION_FILE]).get(DESCRIPTION_FILE);
  if (!raw || raw.length !== entries.get(DESCRIPTION_FILE)) throw new MapError("notZip");
  let carte;
  try { carte = JSON.parse(strFromU8(raw).replace(/^\uFEFF/, "")); }
  catch (error) { throw new MapError("badDescription", { detail: DESCRIPTION_FILE }, error); }
  validateDescription(carte);

  // Every image the levels name has to be there, of a bounded size and what its extension says.
  const wanted = new Set();
  for (const level of carte.levels) {
    const file = level.image.file;
    if (!entries.has(file)) throw new MapError("missingImage", { level: level.label || level.id, file });
    if (entries.get(file) > ARCHIVE_LIMITS.imageBytes) throw new MapError("tooLarge");
    wanted.add(file);
  }
  const files = inflate(unzipSync, bytes, [...wanted]);
  const images = new Map();
  for (const file of wanted) {
    const data = files.get(file);
    const kind = imageKind(data ?? new Uint8Array());
    if (!data || data.length !== entries.get(file) || !kind || kind !== KIND_OF_EXTENSION[imageExtension(file)]) {
      throw new MapError("badImage", { file });
    }
    images.set(file, { bytes: data, type: MIME[kind] });
  }
  return { carte, images };
}

/** Inflates only the named entries; a damaged stream is a bad archive. */
function inflate(unzipSync, bytes, names) {
  const wanted = new Set(names);
  try { return new Map(Object.entries(unzipSync(bytes, { filter: ({ name }) => wanted.has(name) }))); }
  catch (error) { throw new MapError("notZip", {}, error); }
}
