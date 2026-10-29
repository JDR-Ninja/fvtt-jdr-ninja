import { MODULE_ID, SETTINGS } from "../constants.js";
import { STATUS, isSyncableActor } from "./constants.js";
import { atlasAccess } from "./availability.js";
import { AtlasApi, cancelAtlasRequests } from "./api.js";
import { AtlasSyncApp } from "./sync-app.js";
import { getLink } from "./flags.js";
import { pushActor, createActor, notify } from "./sync.js";
import { removeShortcuts, shortcutRow, shortcutButton } from "../ui/directory.js";

/** The Actors entry points exist only for a GM who can sync now; Connections explains every other state. */
function atlasReady() { return atlasAccess().ok && AtlasApi.hasToken(); }

/** The Actors shortcut: an icon, the short label and the window's full title as tooltip, first in the shared row. */
export function renderAtlasButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  removeShortcuts(root, ".jdr-ninja-atlas-open");
  if (!atlasReady()) return;
  // First in the row whichever integration rendered first: Atlas, then the generators.
  shortcutRow(root).prepend(shortcutButton({
    className: "jdr-ninja-atlas-open", icon: "fa-solid fa-globe",
    title: game.i18n.localize("JDRNINJA.atlas.app.title"), label: game.i18n.localize("JDRNINJA.atlas.app.openButton"),
    onClick: () => AtlasSyncApp.open(),
  }));
}

function actorFromEntry(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  const id = el?.dataset?.entryId ?? el?.dataset?.documentId;
  return id ? game.actors.get(id) : null;
}

/**
 * Always adds the entry and decides its visibility each time the menu opens. V14's DocumentDirectory
 * collects its context entries once, at first render (`_onFirstRender` → `_createContextMenus`), and
 * a later `render({ force: true })` does not ask again: an entry left out while Atlas was disabled
 * would stay missing after a GM enables it, until Foundry reloads. V14 field names (`label`,
 * `visible`, `onClick`); `name`, `condition` and `callback` are deprecated since 14.
 */
export function atlasContextOptions(_app, items) {
  items.push({
    label: "JDRNINJA.atlas.context.sync", icon: "fa-solid fa-globe",
    visible: li => atlasReady() && isSyncableActor(actorFromEntry(li)),
    onClick: async (_event, li) => {
      const access = atlasAccess();
      if (!access.ok) { notify(access); return; }
      const actor = actorFromEntry(li);
      if (!isSyncableActor(actor)) return;
      try {
        if (getLink(actor)?.atlasCharacterId) { notify(await pushActor(actor)); return; }
        const campaignId = game.settings.get(MODULE_ID, SETTINGS.atlasCampaignId);
        if (!campaignId) {
          ui.notifications.warn(game.i18n.localize("JDRNINJA.atlas.notify.pickCampaign")); return;
        }
        notify(await createActor(actor, campaignId, game.settings.get(MODULE_ID, SETTINGS.atlasMarkClaimable)),
          "JDRNINJA.atlas.notify.created");
      } catch { notify({ ok: false, status: STATUS.VALIDATION_FAILED, body: {} }); }
    },
  });
}

export function registerAtlasIntegration() {
  Hooks.on("renderActorDirectory", renderAtlasButton);
  Hooks.on("getActorContextOptions", atlasContextOptions);
}

/** World switch/credential changes immediately invalidate the old sync surface on every client. */
export function refreshAtlasIntegration() {
  cancelAtlasRequests();
  if (AtlasSyncApp.instance?.rendered) {
    AtlasSyncApp.instance.close().catch(() => {});
  }
  if (ui.actors?.rendered) ui.actors.render({ force: true });
}
