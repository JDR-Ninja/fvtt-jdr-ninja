import { MODULE_ID, I18N, DEFAULT_ORIGIN, SETTINGS } from "./constants.js";
import { registerOverlaySettings } from "./overlay/settings.js";
import { registerStreamDeckSettings } from "./stream-deck/settings.js";
import { registerVariableSettings } from "./variables/settings.js";
import { registerCreatureSettings } from "./creatures/settings.js";

const noop = () => {};

/**
 * V14 opens a settings menu with `new menu.type()` then `render(true)` (`SettingsConfig#onOpenSubmenu`), and
 * `ApplicationV2#_insertElement` replaces a page element that has the same id. Registered directly, a window class
 * would strand the open window: still marked rendered and subscribed, but out of the page. Each menu registers this
 * launcher instead; it is never rendered and forwards to the window's own singleton `open()`.
 */
export function menuLauncher(panel) {
  return class extends foundry.applications.api.ApplicationV2 {
    static panel = panel;
    async render() { return panel.open(); }
  };
}

/**
 * `menus` holds the window classes (each with a static `open()`). The account credential, the overlay switches
 * and the overlay preferences have separate callbacks, so a local preference never resets account-bound state.
 */
export function registerSettings({ menus = {}, onAtlasChange = noop, onAccountChange = noop, onOverlaySwitch = noop,
  onOverlayPreference = noop, onStreamDeckChange = noop, onCreaturesChange = noop } = {}) {
  const launcher = panel => panel ? menuLauncher(panel) : undefined;
  for (const kind of ["account", "atlas"]) {
    const scope = kind === "atlas" ? "world" : "client";
    const onChange = kind === "atlas" ? onAtlasChange : onAccountChange;
    game.settings.register(MODULE_ID, SETTINGS[`${kind}Origin`], {
      scope, config: false, type: String, default: DEFAULT_ORIGIN, onChange,
    });
    game.settings.register(MODULE_ID, SETTINGS[`${kind}Token`], {
      scope, config: false, type: String, default: "", onChange,
    });
  }
  game.settings.register(MODULE_ID, SETTINGS.atlasEnabled, {
    name: `${I18N}.atlas.enable`, hint: `${I18N}.atlas.enableHint`,
    scope: "world", config: true, type: Boolean, default: false, onChange: onAtlasChange,
  });
  game.settings.register(MODULE_ID, SETTINGS.atlasCampaignId, {
    scope: "world", config: false, type: String, default: "",
  });
  game.settings.register(MODULE_ID, SETTINGS.atlasMarkClaimable, {
    scope: "world", config: false, type: Boolean, default: false,
  });
  registerCreatureSettings(onCreaturesChange, launcher(menus.monster), launcher(menus.npc));
  if (menus.connections) game.settings.registerMenu(MODULE_ID, "connections", {
    name: `${I18N}.menu.name`, label: `${I18N}.menu.label`, hint: `${I18N}.menu.hint`,
    icon: "fa-solid fa-link", type: launcher(menus.connections), restricted: false,
  });
  registerOverlaySettings({ onSwitch: onOverlaySwitch, onPreference: onOverlayPreference });
  registerStreamDeckSettings(onStreamDeckChange);
  registerVariableSettings(launcher(menus.variables), launcher(menus.macroArguments));
}
