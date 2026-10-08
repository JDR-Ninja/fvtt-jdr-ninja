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

export function renderCreatureButtons(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelectorAll(".jdr-ninja-creature-open").forEach(button => button.remove());
  if (creatureClient.local()) return;
  if (creatureClient.access?.allowed !== true) { verifyAccess(); return; }
  const parent = root.querySelector(".header-actions") || root.querySelector(".directory-footer") || root;
  for (const [kind, panel] of [["monster", MonsterGeneratorPanel], ["npc", NpcGeneratorPanel]]) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "jdr-ninja-creature-open";
    button.textContent = game.i18n.localize(`${I18N}.creatures.${kind}Shortcut`);
    button.title = game.i18n.localize(`${I18N}.creatures.${kind}`);
    button.addEventListener("click", () => panel.open());
    parent.append(button);
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
