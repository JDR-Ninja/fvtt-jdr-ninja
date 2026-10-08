import { MODULE_ID, SETTINGS } from "../constants.js";
import { STATUS } from "./constants.js";
import { atlasAccess } from "./availability.js";
import { AtlasApi, cancelAtlasRequests } from "./api.js";
import { AtlasSyncApp } from "./sync-app.js";
import { getLink } from "./flags.js";
import { pushActor, createActor, notify } from "./sync.js";

/** The Actors entry points exist only for a GM who can sync now; Connections explains every other state. */
function atlasReady() { return atlasAccess().ok && AtlasApi.hasToken(); }

/**
 * The module's Actors shortcuts share one compact row, `div.jn-directory-actions`. The first integration to render
 * creates it and the next one reuses it, so this finds the row before making one.
 */
function shortcutRow(host) {
  const existing = host.querySelector(".jn-directory-actions");
  if (existing) return existing;
  const row = document.createElement("div");
  row.className = "jn-directory-actions";
  return row;
}

/** The shortcut: an icon and a short label, with the window's full title as its tooltip and accessible name. */
function atlasButton() {
  const title = game.i18n.localize("JDRNINJA_ATLAS_SYNC.app.title");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "jdr-ninja-atlas-open jn-directory-button";
  button.setAttribute("data-tooltip", title);
  button.setAttribute("aria-label", title);
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-globe";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = game.i18n.localize("JDRNINJA_ATLAS_SYNC.app.openButton");
  button.append(icon, label);
  button.addEventListener("click", () => AtlasSyncApp.open());
  return button;
}

export function renderAtlasButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const stale = root.querySelector(".jdr-ninja-atlas-open");
  const staleRow = stale?.parentElement;
  stale?.remove();
  // A row this button was alone in would otherwise stay behind as an empty gap.
  if (staleRow?.classList?.contains("jn-directory-actions") && !staleRow.children.length) staleRow.remove();
  if (!atlasReady()) return;
  const header = root.querySelector(".header-actions") || root.querySelector(".directory-header");
  const host = header || root.querySelector(".directory-footer") || root;
  const row = shortcutRow(host);
  // First in the row whichever integration rendered first: Atlas, then the generators.
  row.prepend(atlasButton());
  // Foundry's header takes the row after its own buttons; the footer and the bare root keep it first.
  if (row.parentElement) return;
  if (header) host.append(row);
  else host.prepend(row);
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
    visible: li => atlasReady() && actorFromEntry(li)?.type === "character",
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
