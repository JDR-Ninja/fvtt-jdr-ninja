import { ACTIONS, values, documentType, canObserve } from "./actions.js";
import { MAX_MESSAGE_BYTES, requireValue } from "./protocol.js";
import { VARIABLE_ACTIONS } from "../variables/service.js";
import { validateMacroDeclaration } from "../variables/dispatcher.js";
import { MODULE_ID } from "../constants.js";

export const CATALOG_LIMIT = 64;
const label = value => String(value ?? "").slice(0, 128);
const finite = value => Number.isFinite(value) ? value : null;
const reference = document => ({ uuid: document.uuid, type: documentType(document), name: label(document.name) });

/** Explicit projection only: never serialize a Document, actor system data, journal body or settings. */
export function buildSnapshot({ game, canvas, ui, config, selectionRevision, overlay,
  capabilities = { overlay: { verification: "unchecked", entitled: null } }, variables, extensions = {} }) {
  const user = game.user;
  const allowed = document => canObserve(document, user) && (!document.hidden || user.isGM);
  const catalogs = {}, truncated = [];
  const add = (name, documents) => {
    const permitted = documents.filter(allowed);
    if (permitted.length > CATALOG_LIMIT) truncated.push(name);
    catalogs[name] = permitted.slice(0, CATALOG_LIMIT).map(reference);
  };
  add("actors", values(game.actors));
  add("macros", values(game.macros).filter(macro => macro.canExecute));
  add("scenes", values(game.scenes));
  add("tables", values(game.tables));
  add("playlists", values(game.playlists));
  add("sounds", values(game.playlists).filter(allowed).flatMap(playlist => values(playlist.sounds)));
  add("journals", values(game.journal));
  add("pages", values(game.journal).filter(allowed).flatMap(journal => values(journal.pages)));
  add("tokens", values(canvas?.scene?.tokens));
  add("combats", values(game.combats));
  catalogs.users = values(game.users).slice(0, CATALOG_LIMIT).map(recipient => ({
    id: recipient.id, name: label(recipient.name), active: recipient.active === true, isGM: recipient.isGM === true,
    characterUuid: recipient.character && allowed(recipient.character) ? recipient.character.uuid : null,
  }));
  catalogs.statuses = values(config?.statusEffects).slice(0, CATALOG_LIMIT)
    .map(effect => ({ id: effect.id, name: label(game.i18n.localize(effect.name ?? effect.label ?? effect.id)) }));
  catalogs.tabs = Object.entries(ui.sidebar?.constructor?.TABS ?? {}).filter(([, tab]) => !tab.gmOnly || user.isGM)
    .map(([id]) => ({ id }));
  catalogs.tools = Object.values(ui.controls?.controls ?? {}).filter(control => control.visible !== false)
    .flatMap(control => Object.values(control.tools ?? {}).filter(tool => tool.visible !== false && !tool.button && !tool.toggle)
      .map(tool => ({ control: control.name, tool: tool.name, name: label(game.i18n.localize(tool.title ?? tool.name)) })))
    .slice(0, CATALOG_LIMIT);
  const selected = (canvas?.tokens?.controlled ?? []).filter(token => allowed(token.document)).slice(0, 20)
    .map(token => {
      const doc = token.document;
      const actorVisible = doc.actor && allowed(doc.actor);
      return { ...reference(doc), actorUuid: actorVisible ? doc.actor.uuid : null,
        hidden: doc.hidden === true, targeted: token.isTargeted === true,
        statuses: actorVisible ? Array.from(doc.actor.statuses ?? [])
          .filter(id => typeof id === "string" && id.length <= 128).slice(0, 10) : [],
        statusesTruncated: actorVisible && (doc.actor.statuses?.size ?? 0) > 10,
        bars: actorVisible ? ["bar1", "bar2"].map(id => {
          const bar = doc.getBarAttribute(id);
          return { id, value: finite(bar?.value), max: finite(bar?.max), editable: bar?.editable === true };
        }) : [],
      };
    });
  const combat = game.combat;
  const encounter = combat && allowed(combat) ? { uuid: combat.uuid, round: combat.round, turn: combat.turn,
    combatants: values(combat.turns).filter(combatant => allowed(combatant)).slice(0, CATALOG_LIMIT)
      .map(combatant => ({ id: combatant.id, name: label(combatant.name), initiative: finite(combatant.initiative),
        current: combat.combatant?.id === combatant.id, defeated: combatant.defeated === true,
        tokenUuid: combatant.token && allowed(combatant.token) ? combatant.token.uuid : null })) } : null;
  const snapshot = {
    // Document updates exist only for a companion that negotiated them; everyone else gets today's list.
    actions: Object.entries(ACTIONS).filter(([id]) => id !== "document.update" || extensions.updates === 1)
      .map(([id, action]) => ({ id, ...(id === "document.update" ? { advanced: true } : {}), inputs: action.inputs,
        available: (!action.gm || user.isGM === true) && (id !== "overlay.test"
          || (overlay?.access().ok === true && capabilities.overlay?.verification === "verified" && capabilities.overlay.entitled === true)),
        authority: id === "overlay.test" ? "serverEntitlement" : "foundryPermissions" })),
    catalogs, truncated, capabilities,
    state: { selectionRevision, paused: game.paused === true, sceneUuid: canvas?.scene?.uuid ?? null,
      darkness: finite(canvas?.scene?.environment?.darknessLevel), selected, encounter,
      audio: values(game.playlists).filter(allowed).flatMap(playlist => values(playlist.sounds).filter(allowed)
        .map(sound => ({ uuid: sound.uuid, playing: sound.playing === true, volume: finite(sound.volume) }))).slice(0, CATALOG_LIMIT),
      overlay: { enabled: overlay?.enabled() === true, configured: overlay?.access({ requireEnabled: false }).ok === true },
    },
  };
  if (variables) {
    catalogs.variables = variables.variables; catalogs.variableLists = variables.lists;
    snapshot.state.variables = variables.state;
    snapshot.state.variableStores = { revisions: variables.revisions, controller: variables.controller, unavailable: variables.unavailable };
    snapshot.capabilities = { ...capabilities, variables: { version: 1, references: true, templates: true, computed: true, combined: true, results: 1 } };
    snapshot.actions.push(...Object.entries(VARIABLE_ACTIONS).map(([id, action]) => ({ id, ...action,
      available: !variables.unavailable && variables.variables.some(v => v.writable), authority: "foundryPermissions" })),
    { id: "variable.applyAndExecute", advanced: true, inputs: { mutations: { type: "mutations", max: 16 }, action: { type: "nativeAction" } }, available: !variables.unavailable, authority: "foundryPermissions" });
    for (const action of snapshot.actions.filter(action => Object.hasOwn(ACTIONS, action.id))) {
      action.inputs = Object.fromEntries(Object.entries(action.inputs).map(([name, input]) => [name, { ...input, variable: true,
        ...(["string", "anyDocument", "changes"].includes(input.type) ? { template: true } : {}) }]));
      if (action.id === "macro.execute") action.inputs.arguments = { type: "macroArguments", optional: true, advanced: true };
    }
    catalogs.macroArguments = values(game.macros).filter(m => allowed(m) && m.canExecute && m.type === "script").flatMap(m => {
      try { const flag = validateMacroDeclaration(m.getFlag(MODULE_ID, "arguments"));
        return [{ uuid: m.uuid, version: 1, arguments: flag.arguments.map(a => ({ name: a.name, type: a.type, required: a.required, hasDefault: a.default !== undefined })) }]; }
      catch { return []; }
    }).slice(0, CATALOG_LIMIT);
  }
  if (extensions.updates === 1) snapshot.capabilities = { ...snapshot.capabilities,
    updates: { version: 1, operations: ["set", "increment", "decrement", "toggle", "unset"], maxChanges: 16 } };
  // Bound the combined UTF-8 projection as well as each collection (long non-ASCII names cost more).
  const bytes = data => new TextEncoder().encode(JSON.stringify(data)).length;
  while (bytes(snapshot) > MAX_MESSAGE_BYTES - 2048) {
    const largest = Object.entries(catalogs).filter(([name, entries]) => entries.length && !["variables", "variableLists"].includes(name))
      .sort((a, b) => bytes(b[1]) - bytes(a[1]))[0];
    requireValue(largest, "snapshotTooLarge");
    const [name, entries] = largest;
    catalogs[name] = entries.slice(0, Math.floor(entries.length / 2));
    if (!truncated.includes(name)) truncated.push(name);
  }
  return snapshot;
}
