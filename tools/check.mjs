import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE_ID, I18N } from "../scripts/constants.js";
import { releaseManifest } from "./release-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "module.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedManifest = releaseManifest(manifest, packageMetadata);
for (const key of ["url", "manifest", "download"]) assert.equal(manifest[key], expectedManifest[key], key);
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
assert.equal(lock.version, manifest.version, "Lockfile version");
assert.equal(lock.packages[""].version, manifest.version, "Lockfile root package version");
assert.equal(manifest.id, MODULE_ID);
assert.equal(manifest.compatibility.minimum, "14");
assert.deepEqual(manifest.languages.map(l => l.lang).sort(), ["de", "en", "es", "fr", "it"]);
for (const path of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path)]) {
  await access(join(root, path));
}
const locales = await Promise.all(manifest.languages.map(async l =>
  JSON.parse(await readFile(join(root, l.path), "utf8"))));
const keys = Object.keys(locales[0]).sort();
for (const locale of locales) {
  assert.deepEqual(Object.keys(locale).sort(), keys);
  for (const [key, value] of Object.entries(locale)) {
    assert.equal(typeof value, "string", key);
    assert(!value.includes("—"), `${key}: sentence dash`);
    assert(!/\s-\s/.test(value), `${key}: sentence hyphen`);
  }
}
const french = JSON.parse(await readFile(join(root, "lang/fr.json"), "utf8"));
assert(!/(?<!\p{L})(tu|toi|ton|ta|tes)(?!\p{L})/iu.test(Object.values(french).join(" ")), "French must use vouvoiement");

async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async e => e.isDirectory() ? sources(join(dir, e.name))
    : /\.(js|hbs)$/.test(e.name) ? [await readFile(join(dir, e.name), "utf8")] : []));
  return files.flat();
}
for (const source of [...await sources(join(root, "scripts")), ...await sources(join(root, "templates"))]) {
  for (const match of source.matchAll(/JDRNINJA(?:_ATLAS_SYNC)?\.[\w.]+/g)) {
    if (!match[0].endsWith(".")) assert(keys.includes(match[0]), `Missing locale key: ${match[0]}`);
  }
  for (const match of source.matchAll(/text\("([\w.]+)"\)/g)) assert(keys.includes(`${I18N}.${match[1]}`));
  for (const match of source.matchAll(/VT\("([\w.]+)"\)/g)) assert(keys.includes(`${I18N}.variables.${match[1]}`));
  const prefix = source.includes("${I18N}.overlay.") ? `${I18N}.overlay` : "JDRNINJA_ATLAS_SYNC";
  for (const match of source.matchAll(/(?:L|Fmt)\("([\w.]+)"/g)) assert(keys.includes(`${prefix}.${match[1]}`), match[1]);
  assert(!/(?<![.\w])(?:(?:window|globalThis)\.)?(?:alert|confirm|prompt)\s*\(/.test(source), "Native browser dialog");
}
for (const reason of ["invalidOrigin", "invalidToken", "originChanged", "invalidResponse", "unauthorized",
  "rateLimited", "server", "network", "cancelled", "denied", "expired", "notGM", "saveFailed"]) {
  assert(keys.includes(`${I18N}.error.${reason}`), `Missing error: ${reason}`);
}
console.log(`Manifest and ${manifest.languages.length} locales checked (${keys.length} keys each).`);
