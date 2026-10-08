// Showcase data for the README screenshots. Every response follows the public contracts the module validates;
// the creature, the Atlas campaign and the table are invented for illustration.
import { TARGET } from "../scripts/creatures/contract.js";

export const ACCOUNT_NAME = "Demo GM";
export const ATLAS_WORLD = "The Sunken Crown";
export const SYNCED_AT = "2026-10-08T19:30:00.000Z";
export const MONSTER_RESULT_ID = "019d9365-3c00-7000-8000-00000000a001";

export function capabilities() {
  return { contractVersion: 1, status: "ok", account: { displayName: ACCOUNT_NAME },
    features: { dndCreatures: { granted: true, entitled: true, allowed: true, reason: null } }, supportedTargets: [TARGET],
    generationPolicy: { scope: "user", sharedGenerators: ["monster", "npc"], maxConcurrent: 1,
      windows: [{ windowSeconds: 60, limit: 10 }, { windowSeconds: 3600, limit: 100 }] } };
}

const choice = (id, label, description = null) => ({ id, label, description });
const RATINGS = ["1/2", "1", "2", "3", "4", "5", "6", "8", "10"];
const FAMILIES = [choice("monstruosite", "Monstruosité"), choice("bete", "Bête"), choice("mort-vivant", "Mort-vivant")];
const ROLES = [choice("brute", "Brute", "Encaisse les coups et frappe fort au corps à corps."),
  choice("mobile", "Escarmoucheur", "Harcèle à distance et change souvent de position."),
  choice("controle", "Contrôleur", "Entrave les héros avec des zones et des états.")];
const ENVIRONMENTS = [choice("foret", "Forêt"), choice("marais", "Marais"), choice("souterrain", "Souterrain")];
const PROFILES = [choice("standard", "Standard", "Une créature seule ou en groupe, sans actions légendaires."),
  choice("legendary", "Légendaire"), choice("legendaryLair", "Légendaire avec antre")];

/** Monster labels stay in French, as the live catalog provides them; the generated sheet follows `language`. */
export function monsterCatalog(language = "en") {
  const combinations = [];
  for (const family of FAMILIES) for (const role of ROLES) for (const environment of ENVIRONMENTS) {
    combinations.push({ family: family.id, role: role.id, environment: environment.id, combatProfile: "standard", challengeRatings: RATINGS });
    for (const combatProfile of ["legendary", "legendaryLair"]) combinations.push({ family: family.id, role: role.id,
      environment: environment.id, combatProfile, challengeRatings: ["5", "6", "8", "10"] });
  }
  return { contractVersion: 1, status: "ok", generatorKind: "monster", catalogVersion: "monster-showcase-v1", labelLanguage: "fr",
    defaults: { challengeRating: "5", role: "brute", family: "monstruosite", environment: "foret", combatProfile: "standard",
      language, units: language === "fr" ? "metric" : "imperial" },
    choices: { challengeRating: RATINGS.map(id => choice(id, `FP ${id}`)), role: ROLES, family: FAMILIES, environment: ENVIRONMENTS,
      combatProfile: PROFILES, language: [choice("en", "Anglais"), choice("fr", "Français")],
      units: [choice("imperial", "Impériales (pieds)"), choice("metric", "Métriques (mètres)")] },
    constraints: { supportedCombinations: combinations } };
}

const TEXT = {
  en: {
    name: "Mirewood Stalker",
    biography: "<p>A hulking, moss-backed predator that waits beneath the rotting canopy of old forests. "
      + "Spores drift from the cracks in its bark-like hide, and travellers who linger in its hunting grounds hear branches creak "
      + "where no branches should be.</p><p><strong>Tactics.</strong> The stalker opens with a spore burst to weaken a group, "
      + "then closes in to rend the most isolated target.</p>",
    entries: {
      rend: ["Rend", "<p><em>Melee Attack Roll:</em> +8, reach 10 ft. <em>Hit:</em> 14 (2d8 + 5) Slashing damage.</p>"],
      "thorn-volley": ["Thorn Volley", "<p><em>Ranged Attack Roll:</em> +5, range 30/120 ft. <em>Hit:</em> 9 (2d6 + 2) Piercing damage.</p>"],
      multiattack: ["Multiattack", "<p>The stalker makes two Rend attacks.</p>"],
      ambush: ["Ambusher", "<p>The stalker has Advantage on attack rolls against any creature that hasn't taken a turn yet in the combat.</p>"],
      "spore-burst": ["Spore Burst (Recharge 5–6)", "<p><em>Constitution Saving Throw:</em> DC 14, each creature in a 15-foot Cone. "
        + "<em>Failure:</em> 18 (4d8) Poison damage, and the target has the Poisoned condition until the end of its next turn. "
        + "<em>Success:</em> Half damage only.</p>"],
    },
  },
  fr: {
    name: "Traqueur de la Bourbesylve",
    biography: "<p>Un prédateur massif au dos couvert de mousse, tapi sous la canopée pourrissante "
      + "des vieilles forêts. Des spores s’échappent des fissures de sa peau d’écorce, et les voyageurs qui s’attardent sur son "
      + "territoire entendent craquer des branches là où il n’y en a pas.</p><p><strong>Tactique.</strong> Le traqueur affaiblit "
      + "d’abord un groupe avec ses spores, puis s’approche pour lacérer la cible la plus isolée.</p>",
    entries: {
      rend: ["Lacération", "<p><em>Jet d’attaque au corps à corps :</em> +8, allonge 3 m. <em>Touché :</em> 14 (2d8 + 5) dégâts tranchants.</p>"],
      "thorn-volley": ["Volée d’épines", "<p><em>Jet d’attaque à distance :</em> +5, portée 9/36 m. <em>Touché :</em> 9 (2d6 + 2) dégâts perforants.</p>"],
      multiattack: ["Attaques multiples", "<p>Le traqueur effectue deux attaques de Lacération.</p>"],
      ambush: ["Embusqué", "<p>Le traqueur a l’Avantage aux jets d’attaque contre toute créature qui n’a pas encore joué de tour pendant le combat.</p>"],
      "spore-burst": ["Explosion de spores (Recharge 5–6)", "<p><em>Jet de sauvegarde de Constitution :</em> DD 14, chaque créature dans "
        + "un cône de 4,50 m. <em>Échec :</em> 18 (4d8) dégâts de poison, et la cible subit l’état Empoisonné jusqu’à la fin de son "
        + "prochain tour. <em>Réussite :</em> moitié des dégâts seulement.</p>"],
    },
  },
};

export function monsterSource(language = "en") {
  const text = TEXT[language] ?? TEXT.en;
  const ability = (id, score, save) => ({ type: "ability", id, score, ...(save ? { save } : {}) });
  return { schema: "1", kind: "monster", edition: "2024", language: language === "fr" ? "fr" : "en", name: text.name,
    sourceUrl: "https://www.jdr.ninja/generateurs/monstres-dnd5e", biography: text.biography,
    records: [
      { type: "actor", id: "actor", cr: "5", pb: "3", size: "Large", "creature-type": "Monstrosity", alignment: "Unaligned",
        ac: "15", hp: "110", "hp-count": "13", "hp-sides": "10", "hp-modifier": "39", initiative: "2", "passive-perception": "14" },
      ability("Strength", "20"), ability("Dexterity", "14"), ability("Constitution", "17", "6"),
      ability("Intelligence", "5"), ability("Wisdom", "12", "4"), ability("Charisma", "7"),
      { type: "skill", id: "perception", ability: "Wisdom", multiplier: "1", bonus: "4" },
      { type: "skill", id: "stealth", ability: "Dexterity", multiplier: "1", bonus: "5" },
      { type: "movement", id: "walk", value: "40" }, { type: "movement", id: "climb", value: "30" },
      { type: "sense", id: "darkvision", value: "60" },
      { type: "defense", id: "poison", "defense-kind": "Resistance", "damage-type": "Poison", qualifier: "Unconditional" },
      { type: "condition-immunity", id: "Frightened" },
      { type: "attack", id: "rend", timing: "Action", ability: "Strength", bonus: "8", reach: "10" },
      { type: "damage", id: "rend-damage", "owner-id": "rend", count: "2", sides: "8", bonus: "5", "damage-type": "Slashing" },
      { type: "attack", id: "thorn-volley", timing: "Action", ability: "Dexterity", bonus: "5", range: "30", "long-range": "120" },
      { type: "damage", id: "thorn-volley-damage", "owner-id": "thorn-volley", count: "2", sides: "6", bonus: "2", "damage-type": "Piercing" },
      { type: "routine", id: "multiattack", timing: "Action" },
      { type: "routine-attack", id: "multiattack-rend", "owner-id": "multiattack", "attack-id": "rend", count: "2" },
      { type: "feature", id: "ambush", timing: "Trait" },
      { type: "feature", id: "spore-burst", timing: "Action", "source-type": "template", template: "cone-discharge",
        "save-ability": "Constitution", dc: "14", recharge: "5" },
      { type: "damage", id: "spore-burst-damage", "owner-id": "spore-burst", count: "4", sides: "8", bonus: "0", "damage-type": "Poison" },
    ],
    entries: Object.fromEntries(Object.entries(text.entries).map(([id, [name, description]]) => [id, { name, description, sourceUrl: "" }])) };
}

export function monsterResult(body) {
  return { contractVersion: 1, status: "generated", requestId: body.requestId, resultId: MONSTER_RESULT_ID, generatorKind: "monster",
    generatorVersion: "showcase-v1", catalogVersion: body.catalogVersion, target: TARGET, generatedAtUtc: SYNCED_AT,
    requestedOptions: { ...body.options }, resolvedOptions: { ...body.options }, source: monsterSource(body.options.language) };
}

/** Player characters of the Atlas campaign. `linked` actors are linked before "Sync all" runs. */
export const HEROES = [
  { name: "Aldric Venn", img: "icons/svg/sword.svg", linked: "atlas-aldric" },
  { name: "Mira Thornfield", img: "icons/svg/mage-shield.svg", linked: "atlas-mira" },
  { name: "Brother Osk", img: "icons/svg/holy-shield.svg", linked: "atlas-osk" },
  { name: "Sefa Dunmore", img: "icons/svg/cowled.svg", linked: null },
];

export const atlas = {
  whoami: () => ({ contractVersion: 1, status: "OK", world: { id: "sunken-crown", name: ATLAS_WORLD }, tier: { allowed: true } }),
  campaigns: () => ({ contractVersion: 1, status: "OK", items: [
    { id: "sunken-crown", name: ATLAS_WORLD, characterCount: 4 },
    { id: "ashen-road", name: "One-shot: The Ashen Road", characterCount: 2 }] }),
  push: () => ({ contractVersion: 1, status: "OK", syncedAtUtc: SYNCED_AT }),
};

export function overlayDiagnostics() {
  return { ok: true, tokenKind: "foundry", account: ACCOUNT_NAME, entitled: true,
    overlay: { exists: true, enabled: true, connectedClients: 1 }, tableCommands: { secondsSinceLastPoll: 3 } };
}

const literal = (type, value) => ({ op: "literal", type, value });
const ref = id => ({ op: "ref", scope: "world", id });

/** World variables, assigned to the Gamemaster. `heroUuid` is a character created for the screenshots. */
export function worldVariables(controller, heroUuid) {
  return { version: 1, revision: 1, controller,
    lists: [{ id: "weather", name: "Weather", type: "text", entries: [
      { id: "clear", label: "Clear skies", value: "Clear skies" },
      { id: "rain", label: "Heavy rain", value: "Heavy rain" },
      { id: "fog", label: "Thick fog", value: "Thick fog" }] }],
    variables: [
      { id: "inspiration", name: "Party inspiration", type: "number", kind: "stored", constraints: { min: 0, max: 5, clamp: true }, current: 3, default: 0 },
      { id: "alarm", name: "Castle alarm raised", type: "boolean", kind: "stored", constraints: {}, current: false, default: false },
      { id: "weather-now", name: "Current weather", type: "text", kind: "list", constraints: {}, list: { scope: "world", id: "weather" },
        current: "fog", default: "clear", wrap: true },
      { id: "spotlight", name: "Spotlight hero", type: "Actor", kind: "stored", constraints: {}, current: { uuid: heroUuid }, default: null },
      { id: "stream-title", name: "Stream title", type: "text", kind: "computed", constraints: {},
        expression: { op: "concat", args: [literal("text", "Inspiration "), ref("inspiration"), literal("text", " · "), ref("weather-now")] } },
    ] };
}

export const MACRO = {
  name: "Deal damage",
  command: "const { target, amount, damageType } = scope.jdrNinja.arguments;\n"
    + "const token = await fromUuid(target);\n"
    + "await token.actor.applyDamage([{ value: amount, type: damageType }]);\n"
    + "return { jdrNinja: { version: 1, status: \"executed\" } };",
  arguments: { version: 1, arguments: [
    { name: "target", type: "Token", required: true },
    { name: "amount", type: "number", required: true, default: 5 },
    { name: "damageType", type: "text", required: false, default: "fire" }] },
};
