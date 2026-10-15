import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGED_ASSETS, packagedAssets, releaseManifest } from "../tools/release-manifest.mjs";
import { NOTICES_FILE, noticeProblems } from "../tools/third-party-notices.mjs";

const manifest = { id: "jdr-ninja", version: "0.1.0", compatibility: { minimum: "14" }, esmodules: ["scripts/main.js"] };
const metadata = { version: "0.1.0" };

test("release links use the Foundry package id and exact version tag", () => {
  const result = releaseManifest(manifest, metadata, "v0.1.0");
  assert.equal(result.manifest, "https://github.com/JDR-Ninja/fvtt-jdr-ninja/releases/latest/download/module.json");
  assert.equal(result.download, "https://github.com/JDR-Ninja/fvtt-jdr-ninja/releases/download/v0.1.0/jdr-ninja.zip");
  assert.deepEqual(result.compatibility, { minimum: "14" });
  assert.deepEqual(result.esmodules, ["scripts/main.js"]);
  assert.equal(manifest.download, undefined, "Source manifest is not mutated");
});

test("local build uses the module version and supports prerelease tags", () => {
  assert.equal(releaseManifest(manifest, metadata).download.endsWith("/v0.1.0/jdr-ninja.zip"), true);
  const result = releaseManifest({ ...manifest, version: "0.2.0-beta.1" }, { version: "0.2.0-beta.1" }, "v0.2.0-beta.1");
  assert.equal(result.download.endsWith("/v0.2.0-beta.1/jdr-ninja.zip"), true);
});

test("release refuses inconsistent versions, tags, identities, and invalid versions", () => {
  assert.throws(() => releaseManifest(manifest, { version: "0.2.0" }), /Version mismatch/);
  for (const tag of ["v0.2.0", "0.1.0", "", "v0.1.0/invalid"]) {
    assert.throws(() => releaseManifest(manifest, metadata, tag), /Release tag/);
  }
  assert.throws(() => releaseManifest({ ...manifest, id: "fvtt-jdr-ninja" }, metadata), /package id/);
  for (const version of ["latest", "01.1.0", "1.0", "1.0.0-01", "1.0.0-beta..1"]) {
    assert.throws(() => releaseManifest({ ...manifest, version }, { version }), /Invalid module version/);
  }
});

/* ------------------------- third-party notices of the package ------------------------- */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the package carries the licence of the module, and no notices file while the module has no runtime dependency", async () => {
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(metadata.dependencies ?? {}, {}, "everything the bundle inlines is the module's own code");
  for (const asset of ["LICENSE", "README.md"]) assert(PACKAGED_ASSETS.includes(asset), asset);
  assert(!PACKAGED_ASSETS.includes(NOTICES_FILE));
  assert.deepEqual(packagedAssets(metadata), [...PACKAGED_ASSETS]);
  for (const asset of packagedAssets(metadata)) await access(join(root, asset));
  assert.deepEqual(await noticeProblems(root), []);
});

test("a runtime dependency is a package asset of its own: the notices file travels with the module", () => {
  assert.deepEqual(packagedAssets({ dependencies: { lib: "^1.0.0" } }), [...PACKAGED_ASSETS, NOTICES_FILE]);
  assert.deepEqual(packagedAssets({ dependencies: {} }), [...PACKAGED_ASSETS]);
  assert.deepEqual(packagedAssets({}), [...PACKAGED_ASSETS]);
});

test("the notices check names a dependency, its installed version and its licence text, and notices what is missing or altered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jdr-notices-"));
  try {
    const write = async (path, content) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), content); };
    const licence = "MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge.\n";
    // No runtime dependency, nothing to give notice of: no notices file is needed.
    await write("package.json", JSON.stringify({ devDependencies: { tool: "^1.0.0" } }));
    assert.deepEqual(await noticeProblems(directory), []);
    await write("package.json", JSON.stringify({ dependencies: {} }));
    assert.deepEqual(await noticeProblems(directory), []);
    // The first runtime dependency demands the file.
    await write("package.json", JSON.stringify({ dependencies: { lib: "^1.0.0" } }));
    assert.deepEqual(await noticeProblems(directory), [`${NOTICES_FILE} is missing`]);
    await write(NOTICES_FILE, "# Third-party notices\n");
    assert.deepEqual(await noticeProblems(directory), ["lib is not installed (run npm ci)"]);
    await write("node_modules/lib/package.json", JSON.stringify({ name: "lib", version: "1.2.3" }));
    assert.deepEqual(await noticeProblems(directory), [`${NOTICES_FILE} does not name lib 1.2.3`, "lib 1.2.3 publishes no licence file to reproduce"]);
    await write("node_modules/lib/LICENSE", licence);
    assert.deepEqual(await noticeProblems(directory), [`${NOTICES_FILE} does not name lib 1.2.3`, `${NOTICES_FILE} does not carry the licence text of lib 1.2.3`]);
    // Line breaks and indentation do not matter, the words do.
    await write(NOTICES_FILE, `## lib 1.2.3\n\n${licence.replace(/\n/g, "\r\n  ")}`);
    assert.deepEqual(await noticeProblems(directory), []);
    await write(NOTICES_FILE, `## lib 1.2.3\n\n${licence.replace("free of charge", "for a fee")}`);
    assert.deepEqual(await noticeProblems(directory), [`${NOTICES_FILE} does not carry the licence text of lib 1.2.3`]);
    await write(NOTICES_FILE, `## lib 1.2.2\n\n${licence}`);
    assert.deepEqual(await noticeProblems(directory), [`${NOTICES_FILE} does not name lib 1.2.3`], "a dependency upgrade needs its notice updated");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
