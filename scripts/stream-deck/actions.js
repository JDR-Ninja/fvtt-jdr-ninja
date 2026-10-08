import { ControlError, requireValue } from "./protocol.js";
import { overlayRelay } from "../overlay/relay.js";
import { LIMITS, bytes, copy, plain } from "../variables/schema.js";

const documentInput = (...documents) => ({ type: "document", documents });
const booleanInput = { type: "boolean" };
const numberInput = (min, max) => ({ type: "number", min, max });
const enumInput = (...values) => ({ type: "enum", values });
const stringInput = max => ({ type: "string", max });
const optional = input => ({ ...input, optional: true });
const actorInput = documentInput("Actor", "Token");
const definition = (inputs, { gm = false } = {}) => ({ inputs, gm });

export const ACTIONS = Object.freeze({
  "actor.open": definition({ actor: actorInput }),
  "macro.execute": definition({ document: documentInput("Macro"), actor: optional(actorInput),
    token: optional(documentInput("Token")) }),
  "scene.view": definition({ document: documentInput("Scene") }),
  "scene.activate": definition({ document: documentInput("Scene") }, { gm: true }),
  "scene.preload": definition({ document: documentInput("Scene") }, { gm: true }),
  "scene.darkness": definition({ document: documentInput("Scene"), value: numberInput(0, 1) }, { gm: true }),
  "journal.open": definition({ document: documentInput("JournalEntry", "JournalEntryPage") }),
  "journal.show": definition({ document: documentInput("JournalEntry", "JournalEntryPage"),
    audience: enumInput("users", "players", "gms"), users: optional({ type: "users" }),
    reveal: optional(booleanInput) }, { gm: true }),
  "playlist.play": definition({ document: documentInput("PlaylistSound"), playing: booleanInput }, { gm: true }),
  "playlist.next": definition({ document: documentInput("Playlist"), direction: enumInput("next", "previous") }, { gm: true }),
  "playlist.stop": definition({ document: documentInput("Playlist") }, { gm: true }),
  "playlist.volume": definition({ document: documentInput("PlaylistSound"), value: numberInput(0, 1) }, { gm: true }),
  "game.pause": definition({ paused: booleanInput }, { gm: true }),
  "sidebar.tab": definition({ tab: stringInput(64) }),
  "canvas.tool": definition({ control: stringInput(64), tool: stringInput(64) }),
  "dice.roll": definition({ formula: stringInput(128), actor: optional(actorInput),
    mode: enumInput("public", "gm", "blind", "self") }),
  "table.draw": definition({ document: documentInput("RollTable"), mode: enumInput("public", "gm", "blind", "self") }),
  "chat.send": definition({ content: stringInput(2000) }),
  "token.control": definition({ token: documentInput("Token") }),
  "token.target": definition({ token: documentInput("Token"), targeted: booleanInput }),
  "token.hide": definition({ token: documentInput("Token"), hidden: booleanInput }, { gm: true }),
  "token.resource": definition({ token: documentInput("Token"), bar: enumInput("bar1", "bar2"),
    amount: numberInput(-10000, 10000) }),
  "actor.status": definition({ actor: actorInput, status: stringInput(128), active: booleanInput }),
  "combat.start": definition({ document: documentInput("Combat") }, { gm: true }),
  "combat.end": definition({ document: documentInput("Combat") }, { gm: true }),
  "combat.nextTurn": definition({ document: documentInput("Combat") }, { gm: true }),
  "combat.previousTurn": definition({ document: documentInput("Combat") }, { gm: true }),
  "combat.nextRound": definition({ document: documentInput("Combat") }, { gm: true }),
  "combat.rollInitiative": definition({ document: documentInput("Combat") }, { gm: true }),
  "overlay.test": definition({}),
  "document.update": definition({ document: { type: "anyDocument" }, changes: { type: "changes", max: 16 } }),
});

export const values = collection => Array.from(collection?.contents ?? collection ?? []);
export const documentType = document => document?.documentName ?? document?.constructor?.documentName;
export const canObserve = (document, user) => Boolean(document?.testUserPermission?.(user, "OBSERVER"));
const owner = (document, user) => requireValue(document?.testUserPermission?.(user, "OWNER"), "denied");
const callable = value => requireValue(typeof value === "function", "unavailable");
const holdsDocument = input => input.type === "document" || input.type === "anyDocument";
const exactKeys = (value, ...names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** JSON-compatible data only, walked without recursion and bounded so a hostile depth or a cycle cannot exhaust the stack. */
function jsonValue(root) {
  const pending = [root];
  for (let nodes = 0; pending.length;) {
    requireValue(++nodes <= LIMITS.bytes, "capacity");
    const value = pending.pop();
    if (Array.isArray(value)) for (const entry of value) pending.push(entry);
    else if (plain(value)) { requireValue(!Object.hasOwn(value, "__proto__")); for (const entry of Object.values(value)) pending.push(entry); }
    else requireValue(value === null || typeof value === "boolean" || typeof value === "string" || Number.isFinite(value));
  }
}

/** Validated, detached copy of a `document.update` change list. Paths are unchecked beyond their shape: Foundry decides. */
function updateRows(rows, { max }) {
  requireValue(Array.isArray(rows) && rows.length > 0 && rows.length <= max);
  for (const row of rows) {
    requireValue(plain(row) && Object.keys(row).every(name => ["path", "operation", "value"].includes(name))
      && typeof row.path === "string" && row.path.length > 0 && row.path.length <= 256
      && row.path.split(".").every(segment => segment && !UNSAFE_SEGMENTS.has(segment))
      && ["set", "increment", "decrement", "toggle", "unset"].includes(row.operation));
    if (row.operation === "set") { requireValue(Object.hasOwn(row, "value")); jsonValue(row.value); }
    else if (row.operation === "increment" || row.operation === "decrement") requireValue(Number.isFinite(row.value));
    else requireValue(!Object.hasOwn(row, "value"));
  }
  // One row per field: a path may neither repeat nor contain another row's path.
  requireValue(rows.every((a, i) => rows.every((b, j) => i === j || b.path !== a.path && !b.path.startsWith(`${a.path}.`))));
  let size;
  try { size = bytes(rows); } catch { throw new ControlError("capacity"); }
  requireValue(size <= LIMITS.bytes, "capacity");
  return copy(rows);
}

export class FoundryActions {
  constructor({ game = () => globalThis.game, canvas = () => globalThis.canvas, ui = () => globalThis.ui,
    foundry = () => globalThis.foundry, config = () => globalThis.CONFIG,
    resolveUuid = uuid => (globalThis.fromUuid ?? globalThis.foundry.utils.fromUuid)(uuid), overlay = overlayRelay } = {}) {
    Object.assign(this, { game, canvas, ui, foundry, config, resolveUuid, overlay });
  }

  async resolve(input, specification, selectionRevision, currentSelectionRevision) {
    // An `anyDocument` input takes any document type and leaves permission to Foundry's update check.
    const any = specification.type === "anyDocument";
    if (any && typeof input === "string") input = { uuid: input };
    requireValue(input && typeof input === "object" && !Array.isArray(input));
    if (any) requireValue(exactKeys(input, ...(input.source === undefined ? ["uuid"] : input.source === "userCharacter" ? ["source", "userId"] : ["source"])));
    let document;
    if (input.source === "selectedToken" || any && input.source === "selectedTokenActor") {
      requireValue(selectionRevision === currentSelectionRevision(), "staleSelection");
      const selected = this.canvas()?.tokens?.controlled ?? [];
      requireValue(selected.length === 1, "ambiguousTarget");
      document = input.source === "selectedToken" ? selected[0].document : selected[0].document.actor;
    } else if (input.source === "userCharacter") {
      requireValue((any || specification.documents.includes("Actor")) && typeof input.userId === "string");
      document = this.game().users.get(input.userId)?.character;
    } else {
      requireValue(input.source === undefined && typeof input.uuid === "string" && input.uuid.length <= 512 && (!any || input.uuid.length > 0));
      document = await this.resolveUuid(input.uuid);
    }
    requireValue(document, "missingDocument");
    if (any) return document;
    requireValue(specification.documents.includes(documentType(document)), "wrongDocumentType");
    requireValue(canObserve(document, this.game().user), "denied");
    return document;
  }

  async prepare(command, { guard = () => {}, selectionRevision = () => 0 } = {}) {
    const specification = Object.hasOwn(ACTIONS, command.action) ? ACTIONS[command.action] : null;
    requireValue(specification, "unknownAction");
    requireValue(this.game()?.socket?.connected !== false, "wrongSession");
    guard();
    const executingUser = this.game().user;
    requireValue(!specification.gm || executingUser?.isGM === true, "denied");
    requireValue(Object.keys(command.parameters).every(key => Object.hasOwn(specification.inputs, key)));
    const parameters = {};
    for (const [key, input] of Object.entries(specification.inputs)) {
      const value = command.parameters[key];
      if (value === undefined && input.optional) continue;
      if (holdsDocument(input)) parameters[key] = await this.resolve(value, input,
        command.selectionRevision, selectionRevision);
      else if (input.type === "changes") parameters[key] = updateRows(value, input);
      else {
        requireValue(input.type === "boolean" ? typeof value === "boolean"
          : input.type === "number" ? Number.isFinite(value) && value >= input.min && value <= input.max
          : input.type === "enum" ? input.values.includes(value)
          : input.type === "users" ? Array.isArray(value) && value.length > 0 && value.length <= 100
            && value.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id))
          : typeof value === "string" && value.length > 0 && value.length <= input.max);
        parameters[key] = value;
      }
    }
    guard();
    requireValue(this.game().user === executingUser && (!specification.gm || executingUser.isGM), "wrongSession");
    // UUID resolution can yield: recheck all permissions and contextual selection before any operation.
    for (const [key, input] of Object.entries(specification.inputs)) {
      if (!holdsDocument(input) || !parameters[key]) continue;
      if (input.type === "document") requireValue(canObserve(parameters[key], executingUser), "denied");
      const binding = command.parameters[key];
      if (binding.source === "selectedToken") {
        requireValue(command.selectionRevision === selectionRevision(), "staleSelection");
        const selected = this.canvas()?.tokens?.controlled ?? [];
        requireValue(selected.length === 1 && selected[0].document === parameters[key], "staleSelection");
      }
      if (binding.source === "selectedTokenActor") {
        requireValue(command.selectionRevision === selectionRevision(), "staleSelection");
        const selected = this.canvas()?.tokens?.controlled ?? [];
        requireValue(selected.length === 1 && selected[0].document.actor === parameters[key], "staleSelection");
      }
      if (binding.source === "userCharacter") requireValue(
        this.game().users.get(binding.userId)?.character === parameters[key], "staleState");
    }
    const { document, token } = parameters;
    const actor = documentType(parameters.actor) === "Token" ? parameters.actor.actor : parameters.actor;
    if (actor) requireValue(canObserve(actor, executingUser), "denied");
    const prepared = { command, parameters, actor, executingUser };
    this.preflight(prepared);
    return prepared;
  }

  preflight({ command, parameters, actor, executingUser }) {
    const { document, token } = parameters, game = this.game(), canvas = this.canvas(), ui = this.ui();
    const type = documentType;
    switch (command.action) {
      case "actor.open": callable(actor?.sheet?.render); break;
      case "macro.execute": requireValue(document.canExecute === true, "denied");
        if (actor && token) requireValue(token.actor === actor, "ambiguousTarget"); callable(document.execute); break;
      case "scene.view": callable(document.view); break;
      case "scene.activate": callable(document.activate); break;
      case "scene.preload": callable(game.scenes.preload); break;
      case "scene.darkness": requireValue(!document.inCompendium, "unavailable"); callable(document.update); break;
      case "playlist.play": callable(document.parent?.[parameters.playing ? "playSound" : "stopSound"]); break;
      case "playlist.next": callable(document.playNext); break;
      case "playlist.stop": callable(document.stopAll); break;
      case "playlist.volume": callable(document.update); break;
      case "game.pause": callable(game.togglePause); break;
      case "table.draw": callable(document.draw); break;
      case "chat.send": callable(this.foundry().documents?.ChatMessage?.create); break;
      case "token.hide": callable(token.update); break;
      case "combat.start": callable(document.startCombat); break;
      case "combat.end": callable(document.delete);
        requireValue(document.canUserModify?.(executingUser, "delete") === true, "denied"); break;
      case "combat.nextTurn": callable(document.nextTurn); break;
      case "combat.previousTurn": callable(document.previousTurn); break;
      case "combat.nextRound": callable(document.nextRound); break;
      case "combat.rollInitiative": callable(document.rollAll); break;
      case "journal.open": callable((type(document) === "JournalEntryPage" ? document.parent : document)?.sheet?.render); break;
      case "journal.show": {
        owner(document, executingUser);
        const recipients = parameters.audience === "users" ? (parameters.users ?? []).map(id => game.users.get(id))
          : values(game.users).filter(user => user.active && (parameters.audience === "gms" ? user.isGM : !user.isGM));
        requireValue(recipients.length > 0 && recipients.every(user => user?.active === true), "noRecipients");
        if (!parameters.reveal) requireValue(recipients.every(user => canObserve(document, user)), "denied"); break;
      }
      case "sidebar.tab": requireValue(Object.hasOwn(ui.sidebar?.constructor?.TABS ?? {}, parameters.tab)
        && (!ui.sidebar.constructor.TABS[parameters.tab].gmOnly || executingUser.isGM), "unavailable"); break;
      case "canvas.tool": {
        const control = ui.controls?.controls?.[parameters.control], tool = control?.tools?.[parameters.tool];
        requireValue(control?.visible !== false && tool && tool.visible !== false && !tool.button && !tool.toggle, "unavailable"); break;
      }
      case "dice.roll": {
        const Roll = this.foundry().dice.Roll;
        requireValue(/^[\d\s.dD()+*/@A-Za-z_-]+$/.test(parameters.formula) && !parameters.formula.includes("**") && Roll.validate(parameters.formula));
        const roll = new Roll(parameters.formula, actor?.getRollData() ?? {});
        requireValue(/^[\d\s.dD()+*/-]+$/.test(roll.formula) && !roll.formula.includes("**"));
        const dice = [...roll.formula.matchAll(/(\d*)[dD](\d+)/g)];
        requireValue(dice.every(([, count, faces]) => Number(count || 1) > 0 && Number(count || 1) <= 100 && Number(faces) > 0 && Number(faces) <= 1000)
          && dice.reduce((sum, [, count]) => sum + Number(count || 1), 0) <= 100
          && roll.dice.every(die => Number.isInteger(die.number) && die.number > 0 && die.number <= 100 && die.faces <= 1000)
          && roll.dice.reduce((sum, die) => sum + die.number, 0) <= 100); break;
      }
      case "token.control": owner(token, executingUser); requireValue(token.object && token.parent === canvas?.scene, "unavailable"); break;
      case "token.target": requireValue(token.object?.visible && token.parent === canvas?.scene, "unavailable"); break;
      case "token.resource": owner(token.actor, executingUser); requireValue(!token.inCompendium && token.actor, "unavailable");
        requireValue(token.getBarAttribute(parameters.bar)?.editable === true && Number.isFinite(token.getBarAttribute(parameters.bar)?.value), "unavailable"); break;
      case "actor.status": owner(actor, executingUser);
        requireValue(!actor.inCompendium && values(this.config()?.statusEffects).some(effect => effect.id === parameters.status), "unavailable"); break;
      case "document.update": this.buildUpdate(document, parameters.changes, executingUser); break;
      default: break;
    }
  }

  /** Nested update for the change rows, read from the document's source data: Active Effects and derived values never leak in. */
  buildUpdate(document, rows, user) {
    callable(document.update);
    requireValue(document._source && typeof document._source === "object", "unavailable");
    const foundry = this.foundry(), { getProperty, setProperty } = foundry.utils ?? {}, update = {};
    callable(getProperty); callable(setProperty);
    for (const { path, operation, value } of rows) {
      const current = getProperty(document._source, path);
      let next;
      if (operation === "set") next = copy(value);
      else if (operation === "unset") { callable(foundry.data?.operators?.ForcedDeletion); next = new foundry.data.operators.ForcedDeletion(); }
      else if (operation === "toggle") { requireValue(typeof current === "boolean", "wrongValueType"); next = !current; }
      else {
        requireValue(Number.isFinite(current), "wrongValueType");
        next = operation === "increment" ? current + value : current - value;
        requireValue(Number.isFinite(next), "outOfBounds");
      }
      setProperty(update, path, next);
    }
    requireValue(document.canUserModify?.(user, "update", update) === true, "denied");
    return update;
  }

  async execute(command, context = {}) { return this.dispatch(await this.prepare(command, context), context); }

  /** Seat, user, permissions and contextual bindings, rechecked right before a native operation. */
  recheck({ command, parameters, actor, executingUser }, { selectionRevision = () => 0, confirmed = false } = {}) {
    requireValue(this.game()?.socket?.connected !== false, "wrongSession");
    requireValue(this.game().user === executingUser && (!ACTIONS[command.action].gm || executingUser.isGM), "wrongSession");
    for (const [key, input] of Object.entries(ACTIONS[command.action].inputs)) {
      if (!holdsDocument(input) || !parameters[key]) continue;
      if (input.type === "document") requireValue(canObserve(parameters[key], executingUser), "denied");
      const binding = command.parameters[key];
      // A confirmed operation still needs the same single selected token, whatever selection revision it reached.
      if (binding.source === "selectedToken") requireValue((confirmed || command.selectionRevision === selectionRevision())
        && this.canvas()?.tokens?.controlled?.length === 1 && this.canvas().tokens.controlled[0].document === parameters[key], "staleSelection");
      else if (binding.source === "selectedTokenActor") requireValue((confirmed || command.selectionRevision === selectionRevision())
        && this.canvas()?.tokens?.controlled?.length === 1 && this.canvas().tokens.controlled[0].document.actor === parameters[key], "staleSelection");
      else if (binding.source === "userCharacter") requireValue(this.game().users.get(binding.userId)?.character === parameters[key], "staleState");
    }
    if (actor) requireValue(canObserve(actor, executingUser), "denied");
  }

  /**
   * Rechecks an operation the user has just confirmed in Foundry's own dialog, after that dialog has closed.
   * The explicit answer supersedes the deck's snapshot: later table changes, the synchronized revision and the
   * command expiry no longer refuse it. The bridge session, the variable operation, the user and permissions,
   * and every document input (still the same document, still bound the same way) must hold.
   */
  async confirmed(prepared, guard) {
    const { command, parameters } = prepared;
    guard({ confirmed: true });
    for (const [key, input] of Object.entries(ACTIONS[command.action].inputs)) {
      if (!holdsDocument(input) || !parameters[key]) continue;
      const binding = command.parameters[key];
      let current;
      try { current = await this.resolveUuid(typeof binding === "string" ? binding : typeof binding.uuid === "string" ? binding.uuid : parameters[key].uuid); }
      catch { /* A removed or unloaded document is missing. */ }
      requireValue(current === parameters[key], "missingDocument");
    }
    // Resolution can yield: everything below runs synchronously, right before the native operation.
    guard({ confirmed: true });
    this.recheck(prepared, { confirmed: true });
    this.preflight(prepared);
  }

  async dispatch(prepared, { guard = () => {}, selectionRevision = () => 0 } = {}) {
    const { command, parameters, actor, executingUser } = prepared;
    guard();
    this.recheck(prepared, { selectionRevision });
    this.preflight(prepared);
    const { document, token } = parameters;
    const game = this.game(), canvas = this.canvas(), ui = this.ui(), foundry = this.foundry();
    prepared.started = true;
    switch (command.action) {
      case "actor.open":
        callable(actor?.sheet?.render); await actor.sheet.render({ force: true }); break;
      case "macro.execute": {
        requireValue(document.canExecute === true, "denied");
        if (actor && token) requireValue(token.actor === actor, "ambiguousTarget");
        const contextToken = token?.object ?? (documentType(parameters.actor) === "Token" ? parameters.actor.object : undefined);
        if (prepared.macro) requireValue(document.type === "script" && document.canExecute === true
          && JSON.stringify(document.getFlag("jdr-ninja", "arguments")) === prepared.macro.declaration, "staleState");
        const result = await document.execute({ actor: actor ?? token?.actor, token: contextToken,
          ...(prepared.macro ? { jdrNinja: prepared.macro.scope } : {}) });
        if (prepared.macro) requireValue(result?.jdrNinja?.version === 1 && result.jdrNinja.status === "executed", "uncertain"); break;
      }
      case "scene.view": await document.view(); break;
      case "scene.activate": await document.activate(); break;
      case "scene.preload": await game.scenes.preload(document.id, { broadcast: true }); break;
      case "scene.darkness":
        requireValue(!document.inCompendium, "unavailable");
        await document.update({ "environment.darknessLevel": parameters.value }); break;
      case "journal.open": {
        const page = documentType(document) === "JournalEntryPage" ? document : null;
        const sheet = (page?.parent ?? document).sheet;
        callable(sheet?.render);
        await sheet.render({ force: true, ...(page ? { pageId: page.id } : {}) }); break;
      }
      case "journal.show": {
        owner(document, executingUser);
        const recipients = parameters.audience === "users"
          ? (parameters.users ?? []).map(id => game.users.get(id))
          : values(game.users).filter(user => user.active && (parameters.audience === "gms" ? user.isGM : !user.isGM));
        requireValue(recipients.length > 0 && recipients.every(user => user?.active === true), "noRecipients");
        if (!parameters.reveal) requireValue(recipients.every(user => canObserve(document, user)), "denied");
        await foundry.documents.collections.Journal.show(document,
          { users: [...new Set(recipients.map(user => user.id))], force: parameters.reveal === true }); break;
      }
      case "playlist.play":
        await document.parent[parameters.playing ? "playSound" : "stopSound"](document); break;
      case "playlist.next": await document.playNext(undefined, { direction: parameters.direction === "next" ? 1 : -1 }); break;
      case "playlist.stop": await document.stopAll(); break;
      case "playlist.volume": await document.update({ volume: parameters.value }); break;
      case "game.pause": game.togglePause(parameters.paused, { broadcast: true }); break;
      case "sidebar.tab":
        requireValue(Object.hasOwn(ui.sidebar?.constructor?.TABS ?? {}, parameters.tab)
          && (!ui.sidebar.constructor.TABS[parameters.tab].gmOnly || executingUser.isGM), "unavailable");
        ui.sidebar.changeTab(parameters.tab, "primary"); break;
      case "canvas.tool": {
        const controls = ui.controls?.controls ?? {};
        requireValue(Object.hasOwn(controls, parameters.control), "unavailable");
        const control = controls[parameters.control];
        const tool = control?.tools?.[parameters.tool];
        requireValue(Object.hasOwn(control?.tools ?? {}, parameters.tool)
          && control?.visible !== false && tool && tool.visible !== false && !tool.button && !tool.toggle, "unavailable");
        await ui.controls.activate({ control: parameters.control, tool: parameters.tool }); break;
      }
      case "dice.roll": {
        const Roll = foundry.dice.Roll;
        // Basic formulas only; keep evaluation in Foundry and bound dice work, including actor data paths.
        requireValue(/^[\d\s.dD()+*/@A-Za-z_-]+$/.test(parameters.formula) && !parameters.formula.includes("**")
          && Roll.validate(parameters.formula));
        const roll = new Roll(parameters.formula, actor?.getRollData() ?? {});
        requireValue(/^[\d\s.dD()+*/-]+$/.test(roll.formula) && !roll.formula.includes("**"));
        const dice = [...roll.formula.matchAll(/(\d*)[dD](\d+)/g)];
        requireValue(dice.every(([, count, faces]) => Number(count || 1) > 0 && Number(count || 1) <= 100
          && Number(faces) > 0 && Number(faces) <= 1000)
          && dice.reduce((sum, [, count]) => sum + Number(count || 1), 0) <= 100);
        requireValue(roll.dice.every(die => Number.isInteger(die.number) && die.number <= 100
          && die.number > 0 && die.faces <= 1000) && roll.dice.reduce((sum, die) => sum + die.number, 0) <= 100);
        await roll.evaluate({ allowInteractive: false }); guard();
        requireValue(Number.isFinite(roll.total));
        await roll.toMessage({ speaker: foundry.documents.ChatMessage.getSpeaker({ actor }) }, { messageMode: parameters.mode }); break;
      }
      case "table.draw": await document.draw({ messageMode: parameters.mode }); break;
      case "chat.send":
        await foundry.documents.ChatMessage.create({ content: foundry.utils.escapeHTML(parameters.content),
          speaker: foundry.documents.ChatMessage.getSpeaker() }); break;
      case "token.control":
        owner(token, executingUser); requireValue(token.object && token.parent === canvas?.scene, "unavailable");
        token.object.control({ releaseOthers: true }); break;
      case "token.target":
        requireValue(token.object?.visible && token.parent === canvas?.scene, "unavailable");
        token.object.setTarget(parameters.targeted, { releaseOthers: true }); break;
      case "token.hide": await token.update({ hidden: parameters.hidden }); break;
      case "token.resource": {
        owner(token.actor, executingUser);
        requireValue(!token.inCompendium && token.actor, "unavailable");
        const bar = token.getBarAttribute(parameters.bar);
        requireValue(bar?.editable === true && Number.isFinite(bar.value), "unavailable");
        await token.actor.modifyTokenAttribute(bar.attribute, parameters.amount, true, bar.type === "bar"); break;
      }
      case "actor.status":
        owner(actor, executingUser);
        requireValue(!actor.inCompendium && values(this.config()?.statusEffects).some(effect => effect.id === parameters.status), "unavailable");
        await actor.toggleStatusEffect(parameters.status, { active: parameters.active }); break;
      case "document.update": await document.update(this.buildUpdate(document, parameters.changes, executingUser)); break;
      case "combat.start": await document.startCombat(); break;
      case "combat.end": {
        // V14 DialogV2 does not catch a throwing button callback: the dialog would stay open with every button
        // disabled and the bridge queue would wait behind it. Yes keeps the default callback (it returns true),
        // and the checks and the deletion run once the dialog has closed.
        const answer = await foundry.applications.api.DialogV2.confirm({ modal: true,
          window: { title: game.i18n.localize("COMBAT.EndTitle") },
          content: `<p>${foundry.utils.escapeHTML(game.i18n.localize("COMBAT.EndConfirmation"))}</p>`,
        });
        requireValue(answer === true, "cancelled");
        await this.confirmed(prepared, guard);
        await document.delete(); break;
      }
      case "combat.nextTurn": await document.nextTurn(); break;
      case "combat.previousTurn": await document.previousTurn(); break;
      case "combat.nextRound": await document.nextRound(); break;
      case "combat.rollInitiative": await document.rollAll(); break;
      case "overlay.test": {
        const result = await this.overlay.sendTestRoll();
        if (!result.ok) throw new ControlError(result.reason ?? "unavailable"); break;
      }
      default: throw new ControlError("unknownAction");
    }
    return { code: "executed" };
  }
}
