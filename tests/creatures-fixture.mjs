import { TARGET } from "../scripts/creatures/contract.js";
export const requestId = "019d9365-3c00-7000-8000-000000000001";
export const resultId = "019d9365-3c00-7000-8000-000000000002";
export const identity = html => html;
export function gameFixture() {
  const values = { creaturesEnabled: true, accountOrigin: "https://www.jdr.ninja", accountToken: "fixture-token" };
  return { values, release: { generation: 14 }, system: { id: "dnd5e", version: "5.3.3" }, world: { id: "world", title: "Test" },
    user: { id: "gm", isGM: true }, settings: { get: (_module, key) => values[key] }, actors: new Map(), folders: new Map() };
}
export function capabilityFixture(granted = true, entitled = true) {
  return { contractVersion: 1, status: "ok", account: { displayName: "Fixture GM" },
    features: { dndCreatures: { granted, entitled, allowed: granted && entitled,
      reason: !granted ? "devicePermissionRequired" : !entitled ? "tierRequired" : null } }, supportedTargets: [TARGET],
    generationPolicy: { scope: "user", sharedGenerators: ["monster", "npc"], maxConcurrent: 1,
      windows: [{ windowSeconds: 60, limit: 10 }, { windowSeconds: 3600, limit: 100 }] } };
}
export function catalogFixture(kind = "monster") {
  const defaults = kind === "monster" ? { challengeRating: "1/4", role: "brute", family: "monstruosite", environment: "foret",
    combatProfile: "standard", language: "fr", units: "imperial" } : { presetId: "random", speciesId: "human", challengeRating: "auto",
    variantId: "auto", role: "auto", nameGeneratorId: "auto", gender: "Random", age: "Random", units: "metric", includeSecret: false };
  const extra = kind === "monster" ? { challengeRating: ["0", "1/8", "1/2", "11", "15", "20"], role: ["mobile"], combatProfile: ["legendary", "legendaryLair"], units: ["metric"], language: ["en"] }
    : { presetId: ["guard"], challengeRating: ["0", "1/4", "15"], variantId: ["defender"], role: ["defense", "support"],
      nameGeneratorId: ["humains-fantasy"], gender: ["Feminine", "Masculine", "Neutral"], age: ["Adult"], units: ["imperial"] };
  const choices = Object.fromEntries(Object.entries(defaults).filter(([field]) => field !== "includeSecret")
    .map(([field, value]) => [field, [value, ...(extra[field] ?? [])].map(id => ({ id, label: id, description: null }))]));
  const constraints = kind === "monster" ? { supportedCombinations: [
    { family: "monstruosite", role: "brute", environment: "foret", combatProfile: "standard", challengeRatings: ["0", "1/8", "1/4", "1/2", "11", "15", "20"] },
    { family: "monstruosite", role: "brute", environment: "foret", combatProfile: "legendaryLair", challengeRatings: ["11", "15", "20"] },
  ] } : { presets: [{ id: "guard", recommendedChallengeRating: "1/4", variants: [{ id: "defender", role: "defense" }] }],
    randomPresets: [{ id: "random", candidatePresetIds: ["guard"] }], namingBySpecies: [{ speciesId: "human", automaticNameGeneratorId: "humains-fantasy" }],
    nameGenerators: [{ id: "humains-fantasy", supportsGender: true, supportedGenders: ["Feminine", "Masculine", "Neutral"] }] };
  return { contractVersion: 1, status: "ok", generatorKind: kind, catalogVersion: `${kind}-fixture-v1`, labelLanguage: "fr", defaults, choices, constraints };
}
export function sourceFixture(kind = "monster") {
  return { schema: "1", kind, edition: "2024", language: "fr", name: kind === "monster" ? "Fixture monster" : "Fixture NPC",
    sourceUrl: `https://www.jdr.ninja/generateurs/${kind === "monster" ? "monstres-dnd5e" : "pnj-dnd5e"}`,
    biography: "<h2>Fixture</h2><p>Private secret.</p>", records: [
      { type: "actor", id: "actor", cr: "0.25", pb: "2", size: "Medium", "creature-type": kind === "monster" ? "Monstrosity" : "Humanoid",
        ac: "14", hp: "27", "hp-count": "5", "hp-sides": "8", "hp-modifier": "5", initiative: "3" },
      ...["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"].map(id => ({ type: "ability", id, score: "12" })),
      { type: "movement", id: "walk", value: "30" },
      { type: "attack", id: "blade", timing: "Action", ability: "Strength", bonus: "3", reach: "5" },
      { type: "damage", id: "blade-damage-1", "owner-id": "blade", count: "1", sides: "6", bonus: "1", "damage-type": "Slashing" },
      { type: "resource", id: "venom", uses: "2", spent: "0" },
      { type: "feature", id: "venom1", timing: "BonusAction", "resource-id": "venom", uses: "2" },
      { type: "feature", id: "venom2", timing: "Reaction", "resource-id": "venom", uses: "2" },
    ], entries: Object.fromEntries(["blade", "venom1", "venom2"].map(id => [id, { name: id, description: `<p>${id}</p>`, sourceUrl: "" }])) };
}
export function resultFixture(body, kind = "monster") {
  const now = Date.now();
  const resolvedOptions = { ...body.options };
  if (kind === "npc") Object.assign(resolvedOptions, { presetId: "guard", challengeRating: body.options.challengeRating === "auto" ? "1/4" : body.options.challengeRating,
    variantId: "defender", role: "defense", nameGeneratorId: "humains-fantasy", gender: "Feminine", age: "Adult" });
  return { contractVersion: 1, status: "generated", requestId: body.requestId, resultId, generatorKind: kind, generatorVersion: "fixture-v1",
    catalogVersion: body.catalogVersion, target: TARGET, generatedAtUtc: new Date(now).toISOString(),
    requestedOptions: { ...body.options }, resolvedOptions, source: sourceFixture(kind) };
}
