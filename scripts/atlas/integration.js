import { MODULE_ID, SETTINGS } from "../constants.js";
import { STATUS, localizeStatus } from "./constants.js";
import { atlasAccess, atlasEnabled } from "./availability.js";
import { cancelAtlasRequests } from "./api.js";
import { AtlasSyncApp } from "./sync-app.js";
import { getLink } from "./flags.js";
import { pushActor, createActor, notify } from "./sync.js";

export function renderAtlasButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelector(".jdr-ninja-atlas-open")?.remove();
  if (game.user?.isGM !== true || !atlasEnabled()) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "jdr-ninja-atlas-open";
  button.textContent = game.i18n.localize("JDRNINJA_ATLAS_SYNC.app.title");
  const access = atlasAccess();
  button.disabled = !access.ok;
  if (!access.ok) button.title = localizeStatus(access.status);
  button.addEventListener("click", () => AtlasSyncApp.open());
  const header = root.querySelector(".header-actions") || root.querySelector(".directory-header");
  const footer = root.querySelector(".directory-footer");
  if (header) header.appendChild(button);
  else if (footer) footer.prepend(button);
  else root.prepend(button);
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
    label: "JDRNINJA_ATLAS_SYNC.context.sync", icon: "fa-solid fa-globe",
    visible: li => atlasAccess().ok && actorFromEntry(li)?.type === "character",
    onClick: async (_event, li) => {
      const access = atlasAccess();
      if (!access.ok) { notify(access); return; }
      const actor = actorFromEntry(li);
      if (actor?.type !== "character") return;
      try {
        if (getLink(actor)?.atlasCharacterId) { notify(await pushActor(actor)); return; }
        const campaignId = game.settings.get(MODULE_ID, SETTINGS.atlasCampaignId);
        if (!campaignId) {
          ui.notifications.warn(game.i18n.localize("JDRNINJA_ATLAS_SYNC.notify.pickCampaign")); return;
        }
        notify(await createActor(actor, campaignId, game.settings.get(MODULE_ID, SETTINGS.atlasMarkClaimable)),
          "JDRNINJA_ATLAS_SYNC.notify.created");
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
  if (AtlasSyncApp._instance?.rendered) {
    AtlasSyncApp._instance.close().catch(() => {});
  }
  if (ui.actors?.rendered) ui.actors.render({ force: true });
}
