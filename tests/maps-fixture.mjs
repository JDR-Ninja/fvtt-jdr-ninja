import { strToU8, zipSync } from "fflate";

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

/** A ZIP of the description and one image per level (stored without compression, as the site writes them). */
export function archiveFixture(carte = carteFixture(), { extra = {}, omit = [], description } = {}) {
  const files = { "carte.json": description ?? strToU8(JSON.stringify(carte)), "LISEZMOI.txt": strToU8("Lisez-moi") };
  for (const level of carte.levels ?? []) {
    if (level.image?.file && !omit.includes(level.image.file)) files[level.image.file] = [IMAGE_BYTES.webp, { level: 0 }];
  }
  for (const [name, content] of Object.entries(extra)) files[name] = content;
  return zipSync(files);
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
 * A ZIP written by hand the way the website's export writes it, independently of the library the module reads it with:
 * every entry STORED (method 0, the images already are compressed), version needed 20, the general-purpose flag's UTF-8
 * bit (0x0800) set, no extra field, no comment, a DOS date and time, and the sizes and CRC-32 in the headers (no data
 * descriptor).
 *
 * @param {Array<[string, Uint8Array]>} entries  Entry name and content, written in this order.
 */
export function siteZip(entries, stamp = SITE_ZIP_STAMP) {
  const encoder = new TextEncoder();
  const time = (stamp.hour << 11) | (stamp.minute << 5) | (stamp.second >> 1);
  const date = ((stamp.year - 1980) << 9) | (stamp.month << 5) | stamp.day;
  const parts = [], directory = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = encoder.encode(name), crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true); central.setUint16(10, 0, true); central.setUint16(12, time, true); central.setUint16(14, date, true);
    central.setUint32(16, crc, true); central.setUint32(20, bytes.length, true); central.setUint32(24, bytes.length, true);
    central.setUint16(28, nameBytes.length, true); // extra field, comment, disk, internal and external attributes: all zero
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true); end.setUint32(16, offset, true);
  const chunks = [...parts, ...directory, new Uint8Array(end.buffer)];
  const zip = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { zip.set(chunk, at); at += chunk.length; }
  return zip;
}

/** The README the export writes: French, with CRLF line ends. */
export const SITE_README = ["Carte JDR Ninja pour Foundry VTT", "", "1. Dans Foundry, ouvrez l'onglet Scènes.",
  "2. Cliquez sur « Importer une carte JDR Ninja » et choisissez ce fichier ZIP.", "3. Vérifiez le dossier de destination, puis importez la carte.", ""].join("\r\n");

/** The export of the website for the fixture map: `carte.json`, one image per level under `niveaux/`, `LISEZMOI.txt`. */
export function siteArchiveFixture(carte = carteFixture(), image = IMAGE_BYTES.webp) {
  const encoder = new TextEncoder();
  return siteZip([["carte.json", encoder.encode(JSON.stringify(carte))],
    ...carte.levels.map(level => [level.image.file, image]), ["LISEZMOI.txt", encoder.encode(SITE_README)]]);
}
