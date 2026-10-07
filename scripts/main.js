import { MODULE_ID } from "./constants.js";
import { ConnectionPanel } from "./connection-panel.js";
import { registerSettings } from "./settings.js";
import { registerAtlasIntegration, refreshAtlasIntegration } from "./atlas/integration.js";
import { AtlasSyncApp } from "./atlas/sync-app.js";
import { overlayRelay } from "./overlay/relay.js";
import { OverlayPanel } from "./overlay/panel.js";
import { streamDeckBridge } from "./stream-deck/bridge.js";
import { StreamDeckPanel } from "./stream-deck/panel.js";
import { VariablePanel, variableError } from "./variables/panel.js";
import { MacroArgumentsPanel } from "./variables/macro-panel.js";
import { variableService } from "./variables/service.js";
import { VariableActions } from "./variables/dispatcher.js";
import { uuid7 } from "./variables/schema.js";
import { registerCreatureIntegration, refreshCreatures } from "./creatures/integration.js";
import { MonsterGeneratorPanel, NpcGeneratorPanel } from "./creatures/panel.js";

Hooks.once("init", () => {
  registerSettings({
    menus: { connections: ConnectionPanel, monster: MonsterGeneratorPanel, npc: NpcGeneratorPanel,
      variables: VariablePanel, macroArguments: MacroArgumentsPanel },
    onAtlasChange: () => {
      refreshAtlasIntegration();
      ConnectionPanel.refreshAll();
    },
    // A new account credential invalidates everything bound to the old one, generated creatures included.
    onAccountChange: () => {
      refreshCreatures();
      overlayRelay.refresh();
      OverlayPanel.refreshAll();
      ConnectionPanel.refreshAll();
      streamDeckBridge.refreshCapabilities();
    },
    // The relay and table-command switches restart roll and poll work. The account, its creature session and the
    // overlay diagnostics stay valid; the Stream Deck snapshot carries the relay state and the test action.
    onOverlaySwitch: () => {
      overlayRelay.restart();
      OverlayPanel.renderAll();
      ConnectionPanel.refreshAll();
      streamDeckBridge.changed();
    },
    // The filter and the hold are read as each roll arrives: only the overlay window shows them.
    onOverlayPreference: () => OverlayPanel.renderAll(),
    onStreamDeckChange: () => {
      streamDeckBridge.refresh();
      ConnectionPanel.refreshAll();
    },
    onCreaturesChange: () => { refreshCreatures(); ConnectionPanel.refreshAll(); },
  });
  registerAtlasIntegration();
  registerCreatureIntegration();
  overlayRelay.registerHooks();
  streamDeckBridge.registerHooks();
});
Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  overlayRelay.schedulePoll();
  streamDeckBridge.refresh();
  void variableService.initialize().catch(error => ui.notifications.warn(variableError(error)));
  const actions = new VariableActions();
  module.api = Object.freeze({
    openConnections() { return ConnectionPanel.open(); },
    openAtlasSync() { return AtlasSyncApp.open(); },
    openMonsterGenerator() { return MonsterGeneratorPanel.open(); },
    openNpcGenerator() { return NpcGeneratorPanel.open(); },
    openOverlay() { return OverlayPanel.open(); },
    openStreamDeck() { return StreamDeckPanel.open(); },
    openVariables() { return VariablePanel.open(); },
    openMacroArguments() { return MacroArgumentsPanel.open(); },
    variables: Object.freeze({ read: ref => variableService.read(ref), mutate: request => variableService.mutate(request) }),
    execute: (action, parameters) => actions.execute({ id: uuid7(), action, parameters, selectionRevision: streamDeckBridge.selectionRevision },
      { selectionRevision: () => streamDeckBridge.selectionRevision }),
    streamDeck: Object.freeze({ status: () => streamDeckBridge.status(), reconnect: () => streamDeckBridge.refresh() }),
  });
});
