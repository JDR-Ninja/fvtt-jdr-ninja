import { I18N } from "../constants.js";
import { creatureClient } from "./api.js";
import { CreaturePanel, MonsterGeneratorPanel, NpcGeneratorPanel } from "./panel.js";
import { removeShortcuts, shortcutRow, shortcutButton } from "../ui/directory.js";

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

const SHORTCUT_CLASS = "jdr-ninja-creature-open";
const SHORTCUTS = [["monster", MonsterGeneratorPanel, "fa-solid fa-dragon"], ["npc", NpcGeneratorPanel, "fa-solid fa-masks-theater"]];

export function renderCreatureButtons(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  removeShortcuts(root, `.${SHORTCUT_CLASS}`);
  if (creatureClient.local()) return;
  if (creatureClient.access?.allowed !== true) { verifyAccess(); return; }
  const row = shortcutRow(root);
  for (const [kind, panel, icon] of SHORTCUTS) {
    row.append(shortcutButton({ className: SHORTCUT_CLASS, icon,
      label: game.i18n.localize(`${I18N}.creatures.${kind}Shortcut`), title: game.i18n.localize(`${I18N}.creatures.${kind}`),
      onClick: () => panel.open() }));
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
