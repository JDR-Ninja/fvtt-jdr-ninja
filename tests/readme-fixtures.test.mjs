import test from "node:test";
import assert from "node:assert/strict";
import { capabilities, monsterCatalog, monsterResult, worldVariables, MACRO } from "../tools/readme-fixtures.mjs";
import { capabilities as readCapabilities, catalog, generation } from "../scripts/creatures/contract.js";
import { buildActor } from "../scripts/creatures/generated/dnd-foundry/export.mjs";
import { validateStore } from "../scripts/variables/schema.js";
import { validateMacroDeclaration } from "../scripts/variables/dispatcher.js";
import { formatExpression } from "../scripts/variables/expressions.js";
import { identity, requestId } from "./creatures-fixture.mjs";

test("README showcase responses satisfy the module contracts", () => {
  assert.equal(readCapabilities(capabilities()).features.dndCreatures.allowed, true);
  for (const language of ["en", "fr"]) {
    const data = catalog(monsterCatalog(language), "monster");
    const body = { requestId, catalogVersion: data.catalogVersion, options: data.defaults };
    const actor = buildActor(generation(monsterResult(body), body, "monster", identity).source);
    assert.equal(actor.system.details.cr, 5);
    assert.deepEqual(actor.items.map(item => Object.values(item.system.activities).map(activity => activity.type)),
      [["attack"], ["attack"], ["utility"], [], ["save"]]);
  }
  validateStore(worldVariables("gamemaster", "Actor.abcdefghijklmnop"));
  validateMacroDeclaration(MACRO.arguments);
});

test("README hero inspiration reads as a simple document field path", () => {
  const store = worldVariables("gamemaster", "Actor.abcdefghijklmnop");
  const variable = store.variables.find(v => v.id === "hero-inspiration");
  assert.equal(formatExpression(variable.expression, (scope, id) => store.variables.find(v => v.id === id).name),
    "@{Spotlight hero}.system.attributes.inspiration");
});
