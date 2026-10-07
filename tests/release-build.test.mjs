import assert from "node:assert/strict";
import test from "node:test";
import { releaseManifest } from "../tools/release-manifest.mjs";

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
