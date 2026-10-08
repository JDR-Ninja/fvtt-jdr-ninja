import { I18N } from "../constants.js";
import { creatureClient } from "./api.js";
import { CreaturePanel, MonsterGeneratorPanel, NpcGeneratorPanel } from "./panel.js";

export function refreshCreatures() {
  creatureClient.invalidate();
  for (const panel of CreaturePanel.instances) panel.invalidate();
  if (ui.actors?.rendered) ui.actors.render({ force: true });
}

/**
 * The Actors shortcuts appear only once the server has granted this GM generation access. Unknown access is checked
 * once per credential revision; a failed check waits for a new revision or an explicit check from a generator window.
 */
let checkedRevision = null, checking = false;
function verifyAccess() {
  if (checking || creatureClient.local() || creatureClient.access || checkedRevision === creatureClient.revision) return;
  checking = true; checkedRevision = creatureClient.revision;
  creatureClient.check().catch(() => {}).finally(() => {
    checking = false;
    // A credential change during the check made its answer stale: verify the new revision.
    if (checkedRevision !== creatureClient.revision) verifyAccess();
  });
}

const SHORTCUTS = [["monster", MonsterGeneratorPanel, "fa-solid fa-dragon"], ["npc", NpcGeneratorPanel, "fa-solid fa-user"]];

/** The module's shortcuts share one compact row with the other integrations (Atlas): reuse it, create it only when absent. */
function shortcutRow(parent) {
  let row = parent.querySelector(".jn-directory-actions");
  if (!row) {
    row = document.createElement("div"); row.className = "jn-directory-actions";
    parent.append(row);
  }
  return row;
}

export function renderCreatureButtons(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelectorAll(".jdr-ninja-creature-open").forEach(button => button.remove());
  // Our buttons may have been the row's only content: leave no empty row behind.
  root.querySelectorAll(".jn-directory-actions").forEach(row => { if (!row.childElementCount) row.remove(); });
  if (creatureClient.local()) return;
  if (creatureClient.access?.allowed !== true) { verifyAccess(); return; }
  const row = shortcutRow(root.querySelector(".header-actions") || root.querySelector(".directory-footer") || root);
  for (const [kind, panel, icon] of SHORTCUTS) {
    const button = document.createElement("button"), glyph = document.createElement("i");
    button.type = "button"; button.className = "jdr-ninja-creature-open jn-directory-button";
    // The short label is visible; the full title is the native tooltip.
    button.dataset.tooltip = game.i18n.localize(`${I18N}.creatures.${kind}`);
    glyph.className = icon; glyph.setAttribute("aria-hidden", "true");
    button.append(glyph, game.i18n.localize(`${I18N}.creatures.${kind}Shortcut`));
    button.addEventListener("click", () => panel.open());
    row.append(button);
  }
}
export function registerCreatureIntegration() {
  Hooks.on("renderActorDirectory", renderCreatureButtons);
  creatureClient.onAccessChange(() => { if (ui.actors?.rendered) ui.actors.render(); });
  // Only the role decides GM access; a hotbar or character change must not hide the shortcuts and check again.
  Hooks.on("updateUser", (user, changes) => { if (user.id === game.user?.id && "role" in (changes ?? {})) refreshCreatures(); });
  Hooks.on("updateWorld", refreshCreatures);
  Hooks.on("shutdown", refreshCreatures);
}
