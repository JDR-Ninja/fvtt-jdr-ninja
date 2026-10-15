import { MapError } from "./errors.js";
import { DESCRIPTION_FILE, imageExtension, isSafeEntryName, validateDescription } from "./description.js";

/** What the reader accepts. The archive and every entry are measured from the zip directory before anything is inflated. */
export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024, entries: 256, descriptionBytes: 16 * 1024 * 1024,
  imageBytes: 64 * 1024 * 1024, totalBytes: 384 * 1024 * 1024,
});

const MIME = Object.freeze({ webp: "image/webp", png: "image/png", jpeg: "image/jpeg" });
const KIND_OF_EXTENSION = Object.freeze({ webp: "webp", png: "png", jpg: "jpeg", jpeg: "jpeg" });

const END = 0x06054b50, ZIP64_LOCATOR = 0x07064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const STORED = 0, DEFLATED = 8, ENCRYPTED = 0x0001 | 0x0040 | 0x2000, MAX32 = 0xffffffff;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The kind of image the first bytes announce, or null. */
export function imageKind(bytes) {
  const at = (...values) => values.every((value, i) => bytes[i] === value);
  if (bytes.length > 12 && at(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes.length > 8 && at(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (bytes.length > 3 && at(0xff, 0xd8, 0xff)) return "jpeg";
  return null;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** The CRC-32 of the bytes: the checksum a zip entry carries. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A damaged or unsupported archive. The reason goes to the console, not to the window. */
const bad = (reason, cause) => new MapError("notZip", { detail: reason }, cause);

/**
 * Reads a JDR Ninja map archive: `carte.json`, the level images it names and nothing else. Throws a MapError.
 *
 * The zip reader is our own: the directory is parsed here and a deflated entry goes through the browser's
 * `DecompressionStream("deflate-raw")`. It reads what the website writes (stored entries) and what a re-zip with a
 * common tool writes (deflated entries, with or without a data descriptor), and refuses the rest as `notZip`: ZIP64,
 * encryption, several disks, a compression method other than stored or deflate, a directory, header or entry that lies
 * outside the archive or overlaps another, a name that differs between the two headers, a size or CRC-32 that does not
 * match what the entry holds. An entry that inflates past its declared size stops being read at once.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<{ carte: object, images: Map<string, {bytes: Uint8Array, type: string}> }>}
 *   `images` is keyed by the entry name the description gives. A stored entry's bytes are a view into `input`.
 */
export async function readMapArchive(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > ARCHIVE_LIMITS.archiveBytes) throw new MapError("tooLarge");
  if (bytes.length < 22) throw bad("shorter than an end record");
  const entries = readDirectory(bytes);

  // The description, validated before any image is read.
  const description = entries.get(DESCRIPTION_FILE);
  if (!description) throw new MapError("missingDescription");
  if (description.size > ARCHIVE_LIMITS.descriptionBytes) throw new MapError("tooLarge");
  const raw = await extract(description);
  let carte;
  try { carte = JSON.parse(new TextDecoder().decode(raw).replace(/^﻿/, "")); }
  catch (error) { throw new MapError("badDescription", { detail: DESCRIPTION_FILE }, error); }
  validateDescription(carte);

  // Every image the levels name has to be there, of a bounded size and what its extension says.
  const wanted = new Set();
  for (const level of carte.levels) {
    const file = level.image.file, entry = entries.get(file);
    if (!entry) throw new MapError("missingImage", { level: level.label || level.id, file });
    if (entry.size > ARCHIVE_LIMITS.imageBytes) throw new MapError("tooLarge");
    wanted.add(file);
  }
  const images = new Map();
  for (const file of wanted) {
    const data = await extract(entries.get(file));
    const kind = imageKind(data);
    if (!kind || kind !== KIND_OF_EXTENSION[imageExtension(file)]) throw new MapError("badImage", { file });
    images.set(file, { bytes: data, type: MIME[kind] });
  }
  return { carte, images };
}

/**
 * The entries of the zip directory by name, each `{ method, crc, size, data }` with `data` the packed bytes (a view into
 * `bytes`). Every header is checked against the buffer and nothing is inflated, so the sizes are known before any
 * entry is read.
 */
function readDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);

  // The end record is the last thing in the file, followed only by its comment (at most 65 535 bytes).
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === END && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw bad("no end record");
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  if (end >= 20 && u32(end - 20) === ZIP64_LOCATOR) throw bad("ZIP64");
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count) throw bad("several disks");
  if (count === 0xffff || size === MAX32 || start === MAX32) throw bad("ZIP64");
  if (count > ARCHIVE_LIMITS.entries) throw new MapError("tooManyEntries");
  if (start + size > end) throw bad("directory outside the archive");

  const entries = new Map(), spans = [];
  let at = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > start + size || u32(at) !== CENTRAL) throw bad("central header");
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), packed = u32(at + 20), unpacked = u32(at + 24);
    const nameLength = u16(at + 28), next = at + 46 + nameLength + u16(at + 30) + u16(at + 32), from = u32(at + 42);
    if (next > start + size) throw bad("central header");
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength), name = decodeName(nameBytes);
    if (!isSafeEntryName(name) || entries.has(name)) throw new MapError("unsafeName", { name: name.slice(0, 80) });
    if (packed === MAX32 || unpacked === MAX32 || from === MAX32) throw bad("ZIP64");
    if (flags & ENCRYPTED) throw bad("encrypted");
    if (u16(at + 34) !== 0) throw bad("several disks");
    if (method !== STORED && method !== DEFLATED) throw bad(`compression method ${method}`);
    if (method === STORED && packed !== unpacked) throw bad("stored entry of two sizes");

    // The local header gives where the data starts (its own name and extra field lengths, which are not the directory's).
    if (from + 30 > start || u32(from) !== LOCAL) throw bad("local header");
    const dataFrom = from + 30 + u16(from + 26) + u16(from + 28), dataTo = dataFrom + packed;
    if (dataTo > start || u16(from + 26) !== nameLength || !sameBytes(bytes.subarray(from + 30, from + 30 + nameLength), nameBytes)) {
      throw bad("local header outside the archive or not the directory's");
    }
    spans.push([from, dataTo]);
    total += unpacked;
    entries.set(name, { method, crc, size: unpacked, data: bytes.subarray(dataFrom, dataTo) });
    at = next;
  }
  if (at !== start + size) throw bad("directory of another size");
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some(([from], i) => i > 0 && from < spans[i - 1][1])) throw bad("overlapping entries");
  if (total > ARCHIVE_LIMITS.totalBytes) throw new MapError("tooLarge");
  return entries;
}

const sameBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/** UTF-8, or one character per byte when the bytes are not UTF-8 (a legacy code page): such a name is never a file the description names. */
function decodeName(bytes) {
  try { return UTF8.decode(bytes); } catch { return Array.from(bytes, byte => String.fromCharCode(byte)).join(""); }
}

/** The bytes of an entry, inflated if need be, and checked against the directory: size and CRC-32. */
async function extract(entry) {
  const data = entry.method === STORED ? entry.data : await inflate(entry.data, entry.size);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw bad("size or checksum of an entry");
  return data;
}

/** Inflates a raw deflate stream into exactly `size` bytes. A bomb lies about its size, so the stream is cancelled as soon as it would give more. */
async function inflate(packed, size) {
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const out = new Uint8Array(size);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > size) throw bad("entry inflates past its declared size");
      out.set(value, length);
      length += value.length;
    }
  } catch (error) {
    reader.cancel().catch(() => {}); // stops the inflation; its outcome is of no use
    throw error instanceof MapError ? error : bad("damaged deflate stream", error);
  }
  return out.subarray(0, length);
}
