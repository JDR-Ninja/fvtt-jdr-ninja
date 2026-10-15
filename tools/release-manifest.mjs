import { NOTICES_FILE } from "./third-party-notices.mjs";

export const REPOSITORY = "JDR-Ninja/fvtt-jdr-ninja";

/** What the package carries besides the bundled `scripts/main.js` and the release `module.json`: copied as they are. */
export const PACKAGED_ASSETS = Object.freeze(["styles", "templates", "lang", "README.md", "LICENSE"]);

/**
 * The assets of a package: `PACKAGED_ASSETS`, and the notices of the third-party software the bundle inlines when the
 * module has runtime dependencies (it has none today, so no notices file exists).
 */
export const packagedAssets = packageMetadata =>
  Object.keys(packageMetadata.dependencies ?? {}).length ? [...PACKAGED_ASSETS, NOTICES_FILE] : [...PACKAGED_ASSETS];

export function releaseManifest(manifest, packageMetadata, tag = `v${manifest.version}`) {
  if (manifest.id !== "jdr-ninja") throw new Error("Foundry package id must remain jdr-ninja.");
  // Stable SemVer or a prerelease with nonempty, valid identifiers.
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
  if (!version.test(manifest.version)) throw new Error(`Invalid module version: ${manifest.version}`);
  if (manifest.version !== packageMetadata.version) {
    throw new Error(`Version mismatch: module.json=${manifest.version}, package.json=${packageMetadata.version}`);
  }
  if (tag !== `v${manifest.version}`) {
    throw new Error(`Release tag ${tag} must match module version v${manifest.version}`);
  }
  return {
    ...manifest,
    url: `https://github.com/${REPOSITORY}`,
    manifest: `https://github.com/${REPOSITORY}/releases/latest/download/module.json`,
    download: `https://github.com/${REPOSITORY}/releases/download/${tag}/${manifest.id}.zip`
  };
}
