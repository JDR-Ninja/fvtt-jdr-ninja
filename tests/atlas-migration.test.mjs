// TEMPORARY: covers scripts/atlas/legacy-migration.js; delete with it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkLegacyMigration, MIGRATION_SETTING } from "../scripts/atlas/legacy-migration.js";

const copy = JSON.parse(await readFile(new URL("../lang/fr.json", import.meta.url), "utf8"));
const IMPORTED = copy["JDRNINJA.atlas.migrationImported"];
const ENABLE = copy["JDRNINJA.atlas.migrationEnable"];
const LEGACY_ACTIVE = copy["JDRNINJA_ATLAS_SYNC.status.LEGACY_MODULE_ACTIVE"];
let settings, legacy, writes, notices;

/** The old module's world settings, as Setting documents that no registration parses for us. */
function legacySettings(values) {
  legacy = new Map(Object.entries(values).map(([key, value]) => [`jdr-ninja-atlas-sync.${key}`, { value }]));
}

beforeEach(() => {
  settings = new Map([["atlasEnabled", false], ["atlasToken", ""], ["atlasOrigin", "https://www.jdr.ninja"],
    ["atlasCampaignId", ""], ["atlasMarkClaimable", false], [MIGRATION_SETTING, ""]]);
  legacySettings({ token: "legacy-world-token", apiBaseUrl: "https://www.jdr.ninja", campaignId: "campaign-7",
    markCreatedAsClaimable: true });
  writes = []; notices = [];
  const gm = { id: "gm-1", isGM: true };
  globalThis.game = {
    user: gm, users: { activeGM: gm }, modules: new Map(),
    settings: {
      get: (_module, key) => settings.get(key),
      set: async (_module, key, value) => { writes.push(key); settings.set(key, value); return value; },
      storage: new Map([["world", { getSetting: key => legacy.get(key) }]]),
    },
    i18n: { localize: key => copy[key] ?? key },
  };
  globalThis.ui = { notifications: {
    info: (message, options) => notices.push({ kind: "info", message, options }),
    warn: (message, options) => notices.push({ kind: "warn", message, options }),
  } };
});

test("the active GM imports the old token, origin, campaign and claimable option, token last", async () => {
  await checkLegacyMigration();
  assert.equal(settings.get("atlasToken"), "legacy-world-token");
  assert.equal(settings.get("atlasOrigin"), "https://www.jdr.ninja");
  assert.equal(settings.get("atlasCampaignId"), "campaign-7");
  assert.equal(settings.get("atlasMarkClaimable"), true);
  assert.equal(writes.at(-2), "atlasToken");
  assert.equal(writes.at(-1), MIGRATION_SETTING);
  assert.notEqual(settings.get(MIGRATION_SETTING), "");
  assert.deepEqual(notices, [{ kind: "info", message: `${IMPORTED} ${ENABLE}`, options: { permanent: true } }]);
});

test("the switch is never turned on, and the notice drops its advice once it already is", async () => {
  settings.set("atlasEnabled", true);
  await checkLegacyMigration();
  assert.equal(settings.get("atlasEnabled"), true);
  assert.deepEqual(notices.map(n => n.message), [IMPORTED]);
});

test("a unified token already saved is never overwritten, and the check is settled", async () => {
  settings.set("atlasToken", "unified-token");
  await checkLegacyMigration();
  assert.equal(settings.get("atlasToken"), "unified-token");
  assert.equal(settings.get("atlasCampaignId"), "");
  assert.deepEqual(writes, [MIGRATION_SETTING]);
  assert.deepEqual(notices, []);
});

test("the import runs once: a token the GM later disconnects is not restored", async () => {
  await checkLegacyMigration();
  settings.set("atlasToken", "");
  writes = []; notices = [];
  await checkLegacyMigration();
  assert.equal(settings.get("atlasToken"), "");
  assert.deepEqual(writes, []);
  assert.deepEqual(notices, []);
});

test("a world that never used the old module is settled without importing", async () => {
  legacySettings({});
  await checkLegacyMigration();
  assert.equal(settings.get("atlasToken"), "");
  assert.deepEqual(writes, [MIGRATION_SETTING]);
  assert.deepEqual(notices, []);
});

test("an unusable old origin keeps the default one; the token still comes over", async () => {
  legacySettings({ token: " legacy-world-token ", apiBaseUrl: "https://www.jdr.ninja/api", campaignId: "" });
  await checkLegacyMigration();
  assert.equal(settings.get("atlasOrigin"), "https://www.jdr.ninja");
  assert.equal(settings.get("atlasToken"), "legacy-world-token");
  assert.equal(settings.get("atlasCampaignId"), "");
  assert.equal(settings.get("atlasMarkClaimable"), false);
  assert(!writes.includes("atlasOrigin"));
});

test("a local development origin from the old module is kept", async () => {
  legacySettings({ token: "legacy-world-token", apiBaseUrl: "http://localhost:5000" });
  await checkLegacyMigration();
  assert.equal(settings.get("atlasOrigin"), "http://localhost:5000");
});

test("a campaign already chosen in the unified module is kept", async () => {
  settings.set("atlasCampaignId", "campaign-unified");
  await checkLegacyMigration();
  assert.equal(settings.get("atlasCampaignId"), "campaign-unified");
});

test("players and the other GMs do nothing", async () => {
  game.user = { id: "player", isGM: false };
  await checkLegacyMigration();
  game.user = { id: "gm-2", isGM: true };
  await checkLegacyMigration();
  assert.deepEqual(writes, []);
  assert.deepEqual(notices, []);
});

test("while the old module is active, the active GM is warned on every load", async () => {
  game.modules = new Map([["jdr-ninja-atlas-sync", { active: true }]]);
  await checkLegacyMigration();
  await checkLegacyMigration();
  assert.equal(settings.get("atlasToken"), "legacy-world-token");
  assert.deepEqual(notices.filter(n => n.kind === "warn"),
    [1, 2].map(() => ({ kind: "warn", message: LEGACY_ACTIVE, options: { permanent: true } })));
});

test("a failed write leaves the check unsettled, so the next load tries again", async () => {
  game.settings.set = async (_module, key) => { throw new Error(`refused ${key}`); };
  await assert.rejects(checkLegacyMigration(), /refused/);
  assert.equal(settings.get(MIGRATION_SETTING), "");
});
