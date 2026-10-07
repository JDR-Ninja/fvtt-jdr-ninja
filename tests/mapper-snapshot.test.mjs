import assert from "node:assert/strict";
import test from "node:test";
import { MAPPER_FILES, mapperSnapshot, verifyMapperSnapshot } from "../tools/mapper-snapshot.mjs";

const outputs = () => new Map(MAPPER_FILES.map(file => [file, `// ${file}\nexport const value = 1;\n`]));

test("standalone mapper integrity tolerates Windows checkout line endings", () => {
  const lf = outputs();
  const crlf = new Map([...lf].map(([file, content]) => [file, content.replaceAll("\n", "\r\n")]));
  verifyMapperSnapshot(crlf, mapperSnapshot(lf));
});

test("mapper snapshot rejects changed, missing, or unlisted generated files", () => {
  const original = outputs();
  const snapshot = mapperSnapshot(original);
  const changed = outputs();
  changed.set("items.mjs", "export const broken = true;\n");
  assert.throws(() => verifyMapperSnapshot(changed, snapshot), /differs from its imported snapshot/);
  changed.delete("items.mjs");
  assert.throws(() => verifyMapperSnapshot(changed, snapshot), /Missing creature mapper/);
  const incomplete = structuredClone(snapshot);
  delete incomplete.files["version.mjs"];
  assert.throws(() => verifyMapperSnapshot(original, incomplete), /differs from its imported snapshot/);
});
