import { FIELDS } from "./generated/dnd-foundry/record-fields.mjs";
import { buildActor } from "./generated/dnd-foundry/export.mjs";

export const TARGET = Object.freeze({ foundryGeneration: 14, systemId: "dnd5e", systemVersion: "5.3.3", rules: "2024" });
export function compatibilityCode(current) {
  if (current.system?.id !== TARGET.systemId) return "dndRequired";
  if (Number(current.release?.generation) !== TARGET.foundryGeneration || current.system?.version !== TARGET.systemVersion) return "versionUnsupported";
  return "compatible";
}
export const OPTION_FIELDS = Object.freeze({
  monster: ["challengeRating", "role", "family", "environment", "combatProfile", "language", "units"],
  npc: ["presetId", "speciesId", "challengeRating", "variantId", "role", "nameGeneratorId", "gender", "age", "units", "includeSecret"],
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const badKeys = new Set(["__proto__", "prototype", "constructor"]);
export class CreatureError extends Error {
  constructor(code, fields = [], retryAfterMs = 0) { super(code); this.code = code; this.fields = fields; this.retryAfterMs = retryAfterMs; }
}
export function ensure(condition) { if (!condition) throw new CreatureError("invalidResponse"); }
export const object = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max;
const list = (value, max) => Array.isArray(value) && value.length <= max;
const bytes = value => new TextEncoder().encode(value).byteLength;
export function bounded(value, depth = 0) {
  ensure(depth <= 12);
  if (value && typeof value === "object") {
    ensure(Array.isArray(value) || object(value));
    for (const [key, item] of Object.entries(value)) { ensure(!badKeys.has(key)); bounded(item, depth + 1); }
  }
}
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export function isTarget(target) { return object(target) && Object.entries(TARGET).every(([key, value]) => target[key] === value); }

export function capabilities(data) {
  bounded(data);
  const feature = data?.features?.dndCreatures;
  ensure(data?.contractVersion === 1 && data.status === "ok" && string(data.account?.displayName, 256));
  ensure(object(feature) && typeof feature.granted === "boolean" && typeof feature.entitled === "boolean"
    && feature.allowed === (feature.granted && feature.entitled)
    && feature.reason === (!feature.granted ? "devicePermissionRequired" : !feature.entitled ? "tierRequired" : null));
  ensure(list(data.supportedTargets, 32) && data.supportedTargets.some(isTarget));
  const policy = data.generationPolicy;
  ensure(object(policy) && policy.scope === "user" && policy.maxConcurrent === 1 && list(policy.windows, 8)
    && policy.windows.length > 0 && policy.windows.every(w => Number.isSafeInteger(w.windowSeconds) && w.windowSeconds > 0
      && Number.isSafeInteger(w.limit) && w.limit > 0));
  return data;
}

export function catalog(data, kind) {
  bounded(data);
  ensure(data?.contractVersion === 1 && data.status === "ok" && data.generatorKind === kind
    && string(data.catalogVersion) && data.labelLanguage === "fr" && object(data.choices) && object(data.constraints));
  ensure(exact(data.defaults, OPTION_FIELDS[kind]) && OPTION_FIELDS[kind].every(field => Object.hasOwn(data.defaults, field)));
  for (const field of OPTION_FIELDS[kind].filter(field => field !== "includeSecret")) {
    const choices = data.choices[field];
    ensure(list(choices, 2048) && choices.length > 0);
    const ids = new Set();
    for (const choice of choices) {
      ensure(object(choice) && string(choice.id) && string(choice.label, 256)
        && (choice.description === null || typeof choice.description === "string" && choice.description.length <= 2048)
        && !ids.has(choice.id));
      ids.add(choice.id);
    }
  }
  if (kind === "monster") {
    ensure(list(data.constraints.supportedCombinations, 8192) && data.constraints.supportedCombinations.length > 0);
    for (const row of data.constraints.supportedCombinations) {
      ensure(object(row) && ["family", "role", "environment", "combatProfile"].every(field => data.choices[field].some(c => c.id === row[field]))
        && list(row.challengeRatings, 24) && row.challengeRatings.length > 0
        && row.challengeRatings.every(id => data.choices.challengeRating.some(c => c.id === id)));
    }
  } else {
    const constraints = data.constraints;
    ensure(list(constraints.presets, 2048) && list(constraints.randomPresets, 64)
      && list(constraints.namingBySpecies, 2048) && list(constraints.nameGenerators, 2048));
    for (const preset of constraints.presets) {
      ensure(string(preset.id) && data.choices.presetId.some(c => c.id === preset.id)
        && data.choices.challengeRating.some(c => c.id === preset.recommendedChallengeRating)
        && list(preset.variants, 128) && preset.variants.length > 0
        && preset.variants.every(v => string(v.id) && data.choices.variantId.some(c => c.id === v.id)
          && data.choices.role.some(c => c.id === v.role)));
    }
    for (const random of constraints.randomPresets) ensure(string(random.id) && data.choices.presetId.some(c => c.id === random.id)
      && list(random.candidatePresetIds, 2048) && random.candidatePresetIds.length > 0
      && random.candidatePresetIds.every(id => constraints.presets.some(p => p.id === id)));
    for (const naming of constraints.namingBySpecies) ensure(data.choices.speciesId.some(c => c.id === naming.speciesId)
      && data.choices.nameGeneratorId.some(c => c.id === naming.automaticNameGeneratorId));
    for (const naming of constraints.nameGenerators) ensure(data.choices.nameGeneratorId.some(c => c.id === naming.id)
      && typeof naming.supportsGender === "boolean" && list(naming.supportedGenders, 3)
      && naming.supportedGenders.every(id => ["Feminine", "Masculine", "Neutral"].includes(id)));
  }
  ensure(optionErrors(data, data.defaults, kind).length === 0);
  return data;
}

/** Both the native form and the send boundary use the server-owned catalog. Never substitute options. */
export function optionErrors(data, options, kind) {
  const fields = OPTION_FIELDS[kind];
  if (!exact(options, fields) || !fields.every(field => Object.hasOwn(options, field))) return fields;
  const errors = fields.filter(field => field === "includeSecret" ? typeof options[field] !== "boolean"
    : !data.choices[field]?.some(c => c.id === options[field]));
  if (errors.length) return errors;
  if (kind === "monster") {
    if (!data.constraints.supportedCombinations.some(row => ["family", "role", "environment", "combatProfile"].every(field => row[field] === options[field])
      && row.challengeRatings.includes(options.challengeRating))) return ["challengeRating", "role", "family", "environment", "combatProfile"];
  } else {
    const preset = data.constraints.presets.find(p => p.id === options.presetId);
    const random = data.constraints.randomPresets.find(p => p.id === options.presetId);
    if (!preset && !random) return ["presetId"];
    if (random && options.variantId !== "auto") return ["variantId"];
    const candidates = preset ? [preset] : data.constraints.presets.filter(p => random.candidatePresetIds.includes(p.id));
    const variants = candidates.flatMap(p => p.variants).filter(v => options.variantId === "auto" || v.id === options.variantId);
    if (!variants.length) return ["variantId"];
    if (options.role !== "auto" && !variants.some(v => v.role === options.role)) return ["role", "variantId"];
    const namingId = options.nameGeneratorId === "auto"
      ? data.constraints.namingBySpecies.find(n => n.speciesId === options.speciesId)?.automaticNameGeneratorId : options.nameGeneratorId;
    const naming = data.constraints.nameGenerators.find(n => n.id === namingId);
    if (!naming) return ["nameGeneratorId"];
    if (naming.supportsGender && options.gender !== "Random" && !naming.supportedGenders.includes(options.gender)) return ["gender", "nameGeneratorId"];
  }
  return [];
}

/** Strip active HTML and Foundry enrichment syntax before preview or native description storage. */
export function sanitizeHtml(value, document = globalThis.document) {
  ensure(typeof value === "string" && document?.createElement);
  const template = document.createElement("template");
  template.innerHTML = value;
  const allowed = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "H2", "H3", "H4", "H5", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "BLOCKQUOTE", "DIV", "SPAN", "HR", "A"]);
  const blocked = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "LINK", "META", "TEMPLATE"]);
  for (const node of [...template.content.querySelectorAll("*")]) {
    if (blocked.has(node.tagName)) { node.remove(); continue; }
    if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
    for (const attribute of [...node.attributes]) {
      if (attribute.name === "href" && node.tagName === "A" && publicUrl(attribute.value)) continue;
      node.removeAttribute(attribute.name);
    }
    if (node.tagName === "A") node.setAttribute("rel", "noopener noreferrer");
  }
  const walker = document.createTreeWalker(template.content, 4);
  while (walker.nextNode()) {
    walker.currentNode.textContent = walker.currentNode.textContent
      .replace(/@([\w-]+)\[([^\]]*)\](?:\{([^}]*)\})?/g, (_match, type, content, label) => label ?? `${type} (${content})`)
      .replace(/\[\[|\]\]/g, match => match === "[[" ? "(" : ")");
  }
  return template.innerHTML;
}
function publicUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && ["jdr.ninja", "www.jdr.ninja"].includes(url.hostname)
    && !url.username && !url.password && !url.searchParams.has("seed") ? url.href : ""; } catch { return ""; }
}

export function selectedSource(source, sanitize = sanitizeHtml) {
  bounded(source);
  ensure(exact(source, ["schema", "kind", "edition", "language", "name", "sourceUrl", "records", "entries", "biography"])
    && source.schema === "1" && ["monster", "npc"].includes(source.kind) && source.edition === "2024"
    && ["fr", "en"].includes(source.language) && (source.kind !== "npc" || source.language === "fr")
    && string(source.name, 256) && publicUrl(source.sourceUrl) && typeof source.biography === "string" && bytes(source.biography) <= 262144
    && list(source.records, 2048) && object(source.entries) && Object.keys(source.entries).length <= 512);
  const copy = structuredClone(source), identities = new Set();
  const ids = type => new Set(copy.records.filter(row => row.type === type).map(row => row.id));
  for (const row of copy.records) {
    ensure(object(row) && Object.hasOwn(FIELDS, row.type) && string(row.id) && !badKeys.has(row.id)
      && exact(row, ["type", "id", ...FIELDS[row.type]]) && Object.values(row).every(v => typeof v === "string" && v.length <= 2048)
      && !identities.has(`${row.type}:${row.id}`));
    identities.add(`${row.type}:${row.id}`);
  }
  const owners = new Set([...ids("attack"), ...ids("feature"), ...ids("spell")]);
  for (const row of copy.records) {
    if (["attack", "feature", "routine", "spell"].includes(row.type)) ensure(Object.hasOwn(copy.entries, row.id));
    if (row.type === "damage") ensure(owners.has(row["owner-id"]));
    if (row.type === "routine-attack") ensure(ids("routine").has(row["owner-id"]) && ids("attack").has(row["attack-id"]));
    if (row["attack-id"]) ensure(ids("attack").has(row["attack-id"]));
    if (row["resource-id"]) ensure(ids("resource").has(row["resource-id"]));
  }
  for (const [id, entry] of Object.entries(copy.entries)) {
    ensure(string(id) && exact(entry, ["name", "description", "sourceUrl"]) && string(entry.name, 256)
      && typeof entry.description === "string" && bytes(entry.description) <= 65536
      && typeof entry.sourceUrl === "string" && (!entry.sourceUrl || publicUrl(entry.sourceUrl)));
    entry.description = sanitize(entry.description);
  }
  copy.biography = sanitize(copy.biography);
  // The canonical mapper performs the numeric, enum and native shared-resource validation too.
  buildActor(copy);
  return copy;
}

export function generation(data, request, kind, sanitize = sanitizeHtml) {
  bounded(data);
  ensure(data?.contractVersion === 1 && data.status === "generated" && data.generatorKind === kind
    && data.requestId === request.requestId && uuid.test(data.resultId) && data.catalogVersion === request.catalogVersion
    && string(data.generatorVersion) && isTarget(data.target) && object(data.requestedOptions) && object(data.resolvedOptions)
    && exact(data.requestedOptions, OPTION_FIELDS[kind]) && exact(data.resolvedOptions, OPTION_FIELDS[kind])
    && OPTION_FIELDS[kind].every(field => data.requestedOptions[field] === request.options[field]
      && typeof data.resolvedOptions[field] === typeof request.options[field])
    && typeof data.generatedAtUtc === "string" && data.generatedAtUtc.endsWith("Z") && Number.isFinite(Date.parse(data.generatedAtUtc)));
  const source = selectedSource(data.source, sanitize);
  ensure(source.kind === kind && source.language === (kind === "npc" ? "fr" : request.options.language));
  const rating = value => ({ "1/8": 0.125, "1/4": 0.25, "1/2": 0.5 })[value]
    ?? (/^(?:[0-9]|1[0-9]|20)$/.test(value) ? Number(value) : NaN);
  const actualRating = Number(source.records.find(row => row.type === "actor").cr);
  ensure(actualRating === rating(data.resolvedOptions.challengeRating));
  if (request.options.challengeRating !== "auto") ensure(data.resolvedOptions.challengeRating === request.options.challengeRating);
  for (const field of OPTION_FIELDS[kind]) {
    if (kind === "monster" || !["auto", "Random"].includes(request.options[field]) && field !== "presetId") ensure(data.resolvedOptions[field] === request.options[field]);
  }
  return { ...data, source };
}
