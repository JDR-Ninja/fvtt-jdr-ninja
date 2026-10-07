import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { sourceFixture } from "../tests/creatures-fixture.mjs";
import { MAPPER_VERSION } from "../scripts/creatures/generated/dnd-foundry/version.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--source" || !args[1] || args[1].startsWith("--")) {
  throw new Error("Usage: npm run creatures:fixtures -- --source <website-mapper-directory>");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "tools/sync-creature-mapper.mjs"), "--check", "--source", args[1]],
  { stdio: "inherit", windowsHide: true });
const { buildActor } = await import(pathToFileURL(resolve(args[1], "export.mjs")).href);
const fixtures = {
  mapperVersion: MAPPER_VERSION,
  actors: Object.fromEntries(["monster", "npc"].map(kind => [kind, buildActor(sourceFixture(kind))]))
};
const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "creatures-native.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
console.log("Updated expected native actor outputs from the supplied canonical website mapper.");
