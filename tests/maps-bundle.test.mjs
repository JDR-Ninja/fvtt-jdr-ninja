import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../scripts/main.js", import.meta.url));

test("the release bundle carries the zip reader: no import of the package is left for the browser to resolve", async () => {
  // The same options as tools/build.mjs, kept in memory.
  const { outputFiles } = await build({ entryPoints: [entry], write: false, outfile: "main.js", bundle: true, minify: true,
    format: "esm", platform: "browser", target: "es2022", legalComments: "none", logLevel: "silent" });
  const text = outputFiles[0].text;
  assert(!/from\s*["']fflate["']|import\(\s*["']fflate["']\s*\)/.test(text), "a bare import of the zip package would fail in Foundry");
  assert(!/^\s*import[\s{*"']/m.test(text), "the bundle starts with no import: it is one self-contained module");
  assert(text.includes("invalid zip data"), "the zip library is inlined");
});
