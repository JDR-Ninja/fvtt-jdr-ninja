/**
 * TEMPORARY migration check for worlds moving from the standalone Atlas Character Sync module. Remove this
 * file, its two calls in main.js, the atlas `migrationImported` / `migrationEnable` locale keys and tests/atlas-migration.test.mjs
 * once those worlds have moved.
 *
 * At `ready`, the active GM imports the old module's world settings (token, origin, campaign, claimable
 * option) once, never over a unified token already saved, and is warned while the old module stays active.
 * Actor links need no import: flags.js reads the old link bag and promotes it on the first sync.
 */
import { MODULE_ID, SETTINGS } from "../constants.js";
import { normalizeOrigin, normalizeToken } from "../auth/origin.js";
import { LEGACY_MODULE_ID } from "./constants.js";

/** World marker: the time of the check that settled the import, so a token the GM later removes is not restored. */
export const MIGRATION_SETTING = "atlasLegacyMigration";

export function registerLegacyMigrationSetting() {
  game.settings.register(MODULE_ID, MIGRATION_SETTING, { scope: "world", config: false, type: String, default: "" });
}

/**
 * The stored value of an old world setting. The old module is usually disabled, so its settings are not
 * registered and `game.settings.get` would throw; the world's Setting documents still hold the parsed values.
 */
function legacyValue(key) {
  return game.settings.storage?.get("world")?.getSetting(`${LEGACY_MODULE_ID}.${key}`)?.value;
}

function legacyToken() {
  try { return normalizeToken(legacyValue("token")); } catch { return null; }
}

function legacyOrigin() {
  try { return normalizeOrigin(legacyValue("apiBaseUrl")); } catch { return null; }
}

/** Copies the old settings when the unified world has no Atlas token yet. Returns whether it imported. */
async function importLegacySettings() {
  const token = legacyToken();
  if (!token || game.settings.get(MODULE_ID, SETTINGS.atlasToken)) return false;
  const origin = legacyOrigin();
  if (origin) await game.settings.set(MODULE_ID, SETTINGS.atlasOrigin, origin);
  const campaignId = legacyValue("campaignId");
  if (typeof campaignId === "string" && campaignId.trim() && !game.settings.get(MODULE_ID, SETTINGS.atlasCampaignId)) {
    await game.settings.set(MODULE_ID, SETTINGS.atlasCampaignId, campaignId.trim());
  }
  if (legacyValue("markCreatedAsClaimable") === true) {
    await game.settings.set(MODULE_ID, SETTINGS.atlasMarkClaimable, true);
  }
  // The token goes last: it is what makes the connection usable, after its origin and campaign are in place.
  await game.settings.set(MODULE_ID, SETTINGS.atlasToken, token);
  return true;
}

/** Runs on one client per world: the active GM's, so two GMs loading at once never import twice. */
export async function checkLegacyMigration() {
  if (game.user?.isGM !== true || game.users?.activeGM?.id !== game.user.id) return;
  if (!game.settings.get(MODULE_ID, MIGRATION_SETTING)) {
    const imported = await importLegacySettings();
    await game.settings.set(MODULE_ID, MIGRATION_SETTING, new Date().toISOString());
    if (imported) {
      const parts = [game.i18n.localize("JDRNINJA.atlas.migrationImported")];
      if (game.settings.get(MODULE_ID, SETTINGS.atlasEnabled) !== true) {
        parts.push(game.i18n.localize("JDRNINJA.atlas.migrationEnable"));
      }
      ui.notifications.info(parts.join(" "), { permanent: true });
    }
  }
  if (game.modules?.get(LEGACY_MODULE_ID)?.active === true) {
    ui.notifications.warn(game.i18n.localize("JDRNINJA.atlas.status.LEGACY_MODULE_ACTIVE"), { permanent: true });
  }
}
