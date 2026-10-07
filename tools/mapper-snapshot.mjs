import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const MAPPER_FILES = ["export.mjs", "schema.mjs", "defenses.mjs", "items.mjs", "spells.mjs", "record-fields.mjs", "version.mjs"];
export const normalize = content => content.replace(/\r\n/g, "\n");

export function mapperSnapshot(outputs) {
  return {
    algorithm: "sha256",
    files: Object.fromEntries(MAPPER_FILES.map(file => {
      const content = outputs.get(file);
      assert.equal(typeof content, "string", `Missing creature mapper: ${file}`);
      return [file, createHash("sha256").update(normalize(content)).digest("hex")];
    }))
  };
}

export function verifyMapperSnapshot(outputs, snapshot) {
  assert.deepEqual(mapperSnapshot(outputs), snapshot,
    "Creature mapper differs from its imported snapshot. Synchronize from an explicit canonical source.");
}
