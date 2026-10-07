import { build } from "esbuild";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseManifest } from "./release-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--tag" || !args[1])) {
  throw new Error("Usage: npm run build -- [--tag vX.Y.Z]");
}
const manifest = releaseManifest(
  JSON.parse(await readFile(join(root, "module.json"), "utf8")),
  JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  args[1]
);
const dist = resolve(root, "dist");
if (dirname(dist) !== root) throw new Error("Build directory must be inside the module source directory.");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({ entryPoints: [join(root, "scripts/main.js")], outfile: join(dist, "scripts/main.js"),
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022", legalComments: "none" });
for (const asset of ["styles", "templates", "lang", "README.md", "LICENSE"]) {
  await cp(join(root, asset), join(dist, asset), { recursive: true });
}
await writeFile(join(dist, "module.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await new Promise((resolveArchive, reject) => {
  const out = createWriteStream(join(root, "module.zip"));
  const archive = archiver("zip", { zlib: { level: 9 } });
  out.on("close", resolveArchive);
  out.on("error", reject);
  archive.on("warning", reject);
  archive.on("error", reject);
  archive.pipe(out);
  archive.directory(dist, false);
  archive.finalize().catch(reject);
});
console.log("Built dist/ and module.zip. Install the staged files as Data/modules/jdr-ninja/.");
