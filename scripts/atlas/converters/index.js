/**
 * Converter dispatch: one `buildSheet(actor)` per supported Foundry system id, keyed exactly like
 * SUPPORTED_SYSTEMS in constants.js. Adding a system = one entry in that table + one converter file
 * registered here; the guard (system-guard.js) and the payload (converter.js) read the same table, so
 * nothing else changes.
 */

import { SUPPORTED_SYSTEMS } from "../constants.js";
import { buildSheet as buildDnd5eSheet } from "./dnd5e.js";
import { buildSheet as buildPf2eSheet } from "./pf2e.js";
import { buildSheet as buildTor2eSheet } from "./tor2e.js";
import { buildSheet as buildWfrp4eSheet } from "./wfrp4e.js";

/** @type {Record<string, (actor: Actor) => object>} */
const CONVERTERS = {
  dnd5e: buildDnd5eSheet,
  // sf2e is a fork of the pf2e system with the same actor shape: one converter serves both, the
  // extra Starfinder skills flow through CONFIG.PF2E.skills at runtime.
  pf2e: buildPf2eSheet,
  sf2e: buildPf2eSheet,
  tor2e: buildTor2eSheet,
  wfrp4e: buildWfrp4eSheet,
};

/**
 * Resolves the converter for a Foundry system id. Throws when the id is not in SUPPORTED_SYSTEMS or
 * has no converter registered above: both are programming errors (the runtime guard disables every
 * sync entry point on an unsupported system), so fail loudly rather than send an empty sheet.
 */
export function converterFor(systemId) {
  if (!SUPPORTED_SYSTEMS[systemId]) {
    throw new Error(`unsupported game system "${systemId}" (supported: ${Object.keys(SUPPORTED_SYSTEMS).join(", ")})`);
  }
  const convert = CONVERTERS[systemId];
  if (typeof convert !== "function") {
    throw new Error(`no converter registered for "${systemId}" (SUPPORTED_SYSTEMS and converters/index.js disagree)`);
  }
  return convert;
}

/** Builds the flat Atlas sheet for an actor of the given system (default: the active system). */
export function buildSheet(actor, systemId = game.system.id) {
  return converterFor(systemId)(actor);
}
