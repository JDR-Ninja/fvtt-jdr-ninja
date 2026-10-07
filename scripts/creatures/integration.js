import { I18N } from "../constants.js";
import { creatureClient } from "./api.js";
import { CreaturePanel, MonsterGeneratorPanel, NpcGeneratorPanel } from "./panel.js";

export function refreshCreatures() {
  creatureClient.invalidate();
  for (const panel of CreaturePanel.instances) panel.invalidate();
  if (ui.actors?.rendered) ui.actors.render({ force: true });
}
export function renderCreatureButtons(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  root.querySelectorAll(".jdr-ninja-creature-open").forEach(button => button.remove());
  if (game.user?.isGM !== true || !creatureClient.enabled()) return;
  const parent = root.querySelector(".header-actions") || root.querySelector(".directory-footer") || root;
  for (const [kind, panel] of [["monster", MonsterGeneratorPanel], ["npc", NpcGeneratorPanel]]) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "jdr-ninja-creature-open";
    const icon = document.createElement("i"); icon.className = "fa-solid fa-gem"; icon.setAttribute("aria-hidden", "true");
    button.append(icon, " ", game.i18n.localize(`${I18N}.creatures.${kind}Premium`));
    button.addEventListener("click", () => panel.open());
    parent.append(button);
  }
}
export function registerCreatureIntegration() {
  Hooks.on("renderActorDirectory", renderCreatureButtons);
  Hooks.on("updateUser", user => { if (user.id === game.user?.id) refreshCreatures(); });
  Hooks.on("updateWorld", refreshCreatures);
  Hooks.on("shutdown", refreshCreatures);
}
