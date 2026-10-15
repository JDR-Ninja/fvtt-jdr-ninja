import { deflateRawSync } from "node:zlib";

/** The UTF-8 bytes of a text. */
export const utf8 = text => new TextEncoder().encode(text);

/**
 * A small hand-written map description (version 1) that uses every kind of element: three levels with a negative
 * order, every wall type, a two-level and a three-level link, water, ice, a squeeze, lava and a pit (the last two
 * stay on the image), a void that sees the level below it and a drop. The grid is 16 by 11 cells with 2 padding
 * cells, so the scene is 2000 by 1500 pixels and Foundry shifts it by (500, 400).
 */
export function carteFixture() {
  const image = name => ({ file: `niveaux/${name}.webp`, width: 2000, height: 1500 });
  return {
    format: "jdr-ninja-map", version: 1, name: "Château des Brumes",
    grid: { columns: 16, rows: 11, paddingCells: 2 },
    scale: { feetPerCell: 5, metresPerCell: 1.5 },
    levels: [
      { id: "L-1", order: -1, label: "Sous-sol", elevation: -4, height: 4, seesThrough: [], voids: [],
        walls: [{ x1: 2, y1: 2, x2: 12, y2: 2, type: "wall" }],
        areas: [{ type: "ice", cells: [{ y: 4, spans: [{ x: 6, length: 4 }] }] }],
        image: image("carte-sous-sol-1") },
      { id: "L0", order: 0, label: "Rez-de-chaussée", elevation: 0, height: 4, seesThrough: [], voids: [],
        walls: [
          { x1: 0, y1: 0, x2: 8, y2: 0, type: "wall" },
          { x1: 8, y1: 0, x2: 9, y2: 0, type: "door" },
          { x1: 9, y1: 0, x2: 10, y2: 0, type: "secretDoor" },
          { x1: 0, y1: 2, x2: 0, y2: 4, type: "window" },
          { x1: 0, y1: 4, x2: 0, y2: 6, type: "railing" },
        ],
        areas: [
          { type: "water", cells: [{ y: 5, spans: [{ x: 1, length: 3 }] }, { y: 6, spans: [{ x: 1, length: 3 }] }] },
          { type: "lava", cells: [{ y: 8, spans: [{ x: 9, length: 2 }] }] },
          { type: "pit", cells: [{ y: 9, spans: [{ x: 9, length: 1 }] }] },
        ],
        image: image("carte-rez-de-chaussee") },
      { id: "L1", order: 1, label: "Étage", elevation: 4, height: 4, seesThrough: ["L0"],
        voids: [{ y: 3, spans: [{ x: 5, length: 2 }] }],
        walls: [{ x1: 4, y1: 4, x2: 4, y2: 9, type: "wall" }],
        areas: [{ type: "squeeze", cells: [{ y: 1, spans: [{ x: 2, length: 1 }] }] }],
        image: image("carte-etage-1") },
    ],
    links: [
      { type: "stairs", levels: ["L0", "L1"], cells: [{ x: 7, y: 7 }] },
      { type: "lift", levels: ["L-1", "L0", "L1"], cells: [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }] },
    ],
    drops: [{ from: "L1", to: "L0", cells: [{ y: 6, spans: [{ x: 8, length: 2 }] }] }],
  };
}

/** The first bytes of each kind of image, then filler: enough for the reader's signature check. */
export const IMAGE_BYTES = Object.freeze({
  webp: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3]),
  png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]),
});

/**
 * An image of `size` bytes: the signature of its kind, then filler that compresses but is not constant, so a deflated
 * entry of it comes out of the browser's decompression in several chunks.
 */
export function imageOf(kind = "webp", size = 4096) {
  const bytes = new Uint8Array(size);
  bytes.set(IMAGE_BYTES[kind]);
  for (let i = IMAGE_BYTES[kind].length, x = 12345; i < size; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; bytes[i] = (x >>> 16) & 0x3f; }
  return bytes;
}

/**
 * A ZIP of the description and one image per level, as a re-zip with a common tool leaves it: the description and the
 * readme deflated, the images stored. `extra` adds entries, or replaces one of the same name: the bytes, or
 * `[bytes, options]` (see `zipFile`).
 */
export function archiveFixture(carte = carteFixture(), { extra = {}, omit = [], description } = {}) {
  const files = new Map([["carte.json", [description ?? utf8(JSON.stringify(carte)), { method: 8 }]],
    ["LISEZMOI.txt", [utf8("Lisez-moi"), { method: 8 }]]]);
  for (const level of carte.levels ?? []) {
    if (level.image?.file && !omit.includes(level.image.file)) files.set(level.image.file, [IMAGE_BYTES.webp]);
  }
  for (const [name, content] of Object.entries(extra)) files.set(name, Array.isArray(content) ? content : [content]);
  return zipFile([...files].map(([name, content]) => [name, ...content]));
}

/* ---------------------- a ZIP written the way the website writes it ---------------------- */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** The CRC-32 of the bytes (the one a ZIP entry carries). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The DOS time stamp the website's ZIP entries carry: a fixed local time, two-second resolution. */
export const SITE_ZIP_STAMP = Object.freeze({ year: 2026, month: 10, day: 14, hour: 12, minute: 30, second: 10 });

/**
 * A ZIP written by hand, independently of the module's reader and of any library. An entry is `[name, bytes, options]`;
 * with no options it is what the website writes: STORED (method 0, the images already are compressed), version needed 20,
 * the general-purpose flag's UTF-8 bit (0x0800) set, no extra field, a DOS date and time, and the sizes and CRC-32 in the
 * headers (no data descriptor). The options write what other tools do, or what a damaged or hostile file holds:
 *
 * - `method`: 8 deflates the bytes with `node:zlib` (what Windows and 7-Zip write).
 * - `descriptor`: the CRC-32 and sizes follow the data in a data descriptor (flag bit 3) and the local header holds zeros.
 * - `utf8`: false leaves the UTF-8 name flag unset (Windows does, for ASCII names). `flags`: more flag bits (1 = encrypted).
 * - `localExtra`, `centralExtra`: bytes of the extra field of the local or the central header (they differ in real files).
 * - `crc`, `size`, `packed`, `methodCode`, `localOffset`, `localName`: what the headers claim instead of the truth.
 * - `damage`: a byte in the middle of the data is flipped once the CRC-32 has been taken. `rawName`: the bytes of the name
 *   in both headers, as they are (a legacy code page, say), instead of the UTF-8 of `name`.
 *
 * The archive's own options: `stamp` (the DOS date and time), `comment` (bytes after the end record), `zip64Locator`
 * (a ZIP64 end of central directory locator before the end record) and `end` (`disk`, `startDisk`, `onDisk`, `entries`,
 * `size`, `offset`: the end record's fields instead of the truth).
 *
 * @param {Array<[string, Uint8Array, object?]>} entries  Written in this order.
 */
export function zipFile(entries, { stamp = SITE_ZIP_STAMP, comment = new Uint8Array(0), zip64Locator = false, end = {} } = {}) {
  const time = (stamp.hour << 11) | (stamp.minute << 5) | (stamp.second >> 1);
  const date = ((stamp.year - 1980) << 9) | (stamp.month << 5) | stamp.day;
  const none = new Uint8Array(0);
  const parts = [], directory = [];
  let offset = 0;
  for (const [name, bytes, o = {}] of entries) {
    const nameBytes = o.rawName ?? utf8(name), localName = o.localName === undefined ? nameBytes : utf8(o.localName);
    let data = o.method === 8 ? deflateRawSync(bytes) : bytes;
    if (o.damage) { data = Uint8Array.from(data); data[data.length >> 1] ^= 0xff; }
    const crc = o.crc ?? crc32(bytes), size = o.size ?? bytes.length, packed = o.packed ?? data.length;
    const flags = (o.utf8 === false ? 0 : 0x0800) | (o.descriptor ? 8 : 0) | (o.flags ?? 0), method = o.methodCode ?? o.method ?? 0;
    const localExtra = o.localExtra ?? none, centralExtra = o.centralExtra ?? none;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, flags, true); local.setUint16(8, method, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true);
    if (!o.descriptor) { local.setUint32(14, crc, true); local.setUint32(18, packed, true); local.setUint32(22, size, true); }
    local.setUint16(26, localName.length, true); local.setUint16(28, localExtra.length, true);
    parts.push(new Uint8Array(local.buffer), localName, localExtra, data);
    let length = 30 + localName.length + localExtra.length + data.length;
    if (o.descriptor) {
      const descriptor = new DataView(new ArrayBuffer(16));
      descriptor.setUint32(0, 0x08074b50, true); descriptor.setUint32(4, crc, true);
      descriptor.setUint32(8, packed, true); descriptor.setUint32(12, size, true);
      parts.push(new Uint8Array(descriptor.buffer)); length += 16;
    }
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, flags, true); central.setUint16(10, method, true); central.setUint16(12, time, true); central.setUint16(14, date, true);
    central.setUint32(16, crc, true); central.setUint32(20, packed, true); central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true); central.setUint16(30, centralExtra.length, true);
    central.setUint32(42, o.localOffset ?? offset, true); // file comment, disk, internal and external attributes: all zero
    directory.push(new Uint8Array(central.buffer), nameBytes, centralExtra);
    offset += length;
  }
  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const locator = new DataView(new ArrayBuffer(zip64Locator ? 20 : 0));
  if (zip64Locator) { locator.setUint32(0, 0x07064b50, true); locator.setUint32(8, offset + directorySize, true); locator.setUint32(16, 1, true); }
  const record = new DataView(new ArrayBuffer(22));
  record.setUint32(0, 0x06054b50, true); record.setUint16(4, end.disk ?? 0, true); record.setUint16(6, end.startDisk ?? 0, true);
  record.setUint16(8, end.onDisk ?? entries.length, true); record.setUint16(10, end.entries ?? entries.length, true);
  record.setUint32(12, end.size ?? directorySize, true); record.setUint32(16, end.offset ?? offset, true); record.setUint16(20, comment.length, true);
  const chunks = [...parts, ...directory, new Uint8Array(locator.buffer), new Uint8Array(record.buffer), comment];
  const zip = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { zip.set(chunk, at); at += chunk.length; }
  return zip;
}

/** A ZIP written the way the website's export writes it: every entry stored, see `zipFile`. */
export const siteZip = (entries, stamp = SITE_ZIP_STAMP) => zipFile(entries, { stamp });

/** The README the export writes: French, with CRLF line ends. */
export const SITE_README = ["Carte JDR Ninja pour Foundry VTT", "", "1. Dans Foundry, ouvrez l'onglet Scènes.",
  "2. Cliquez sur « Importer une carte JDR Ninja » et choisissez ce fichier ZIP.", "3. Vérifiez le dossier de destination, puis importez la carte.", ""].join("\r\n");

/** The export of the website for the fixture map: `carte.json`, one image per level under `niveaux/`, `LISEZMOI.txt`. */
export function siteArchiveFixture(carte = carteFixture(), image = IMAGE_BYTES.webp) {
  return siteZip([["carte.json", utf8(JSON.stringify(carte))],
    ...carte.levels.map(level => [level.image.file, image]), ["LISEZMOI.txt", utf8(SITE_README)]]);
}
