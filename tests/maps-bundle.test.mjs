import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../scripts/main.js", import.meta.url));

test("the release bundle is one self-contained module made of the module's own sources: no import left, no third-party code inlined", async () => {
  // The same options as tools/build.mjs, kept in memory.
  const { outputFiles, metafile } = await build({ entryPoints: [entry], write: false, outfile: "main.js", bundle: true, minify: true,
    format: "esm", platform: "browser", target: "es2022", legalComments: "none", metafile: true, logLevel: "silent" });
  const text = outputFiles[0].text;
  const [output] = Object.values(metafile.outputs);
  assert.deepEqual(output.imports, [], "an import of a package would fail in Foundry, which resolves none");
  assert(!/^\s*import[\s{*"']/m.test(text), "the bundle starts with no import: it is one self-contained module");
  assert.deepEqual(Object.keys(metafile.inputs).filter(path => path.includes("node_modules")), [], "no third-party code travels in the package");
  assert(text.includes("deflate-raw"), "the zip reader is part of the bundle");
});
