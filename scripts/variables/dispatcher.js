import { MODULE_ID } from "../constants.js";
import { ACTIONS, FoundryActions } from "../stream-deck/actions.js";
import { ControlError, requireValue } from "../stream-deck/protocol.js";
import { keys, plain, validateValue, LIMITS, copy, reference } from "./schema.js";
import { variableService } from "./service.js";

// Only a row value that is itself a reference or a template is resolved; any other value is a literal copied as-is.
const resolvable = value => reference(value) || value?.source === "template";
const changeRows = command => command.action === "document.update" && Array.isArray(command.parameters?.changes) ? command.parameters.changes : [];

export function usesVariables(command) {
  if (command.action?.startsWith("variable.")) return true;
  const visit = value => value && typeof value === "object" && (value.source === "variable" || value.source === "template"
    || Array.isArray(value) && value.some(visit));
  return Object.hasOwn(command.parameters ?? {}, "arguments") || Object.values(command.parameters ?? {}).some(visit)
    || changeRows(command).some(row => resolvable(row?.value));
}

/** A companion may only send these once the `updates` extension is negotiated. */
export const usesUpdates = command => command.action === "document.update"
  || command.action === "variable.applyAndExecute" && command.parameters?.action?.action === "document.update";

export function validateMacroDeclaration(value) {
  keys(value, ["version", "arguments"]); requireValue(value.version === 1 && Array.isArray(value.arguments) && value.arguments.length <= 16);
  const names = new Set();
  for (const arg of value.arguments) {
    keys(arg, ["name", "type", "required", "default"]);
    requireValue(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(arg.name) && !["constructor", "prototype", "__proto__"].includes(arg.name)
      && !names.has(arg.name) && typeof arg.required === "boolean"); names.add(arg.name);
    if (arg.default !== undefined) validateValue(arg.default, arg.type);
    else requireValue(["number", "text", "boolean", "Actor", "Token", "Scene", "JournalEntry", "JournalEntryPage", "Macro", "Playlist", "PlaylistSound", "RollTable", "Combat"].includes(arg.type));
  }
  return value;
}
export class VariableActions {
  constructor({ native = new FoundryActions(), variables = variableService } = {}) { Object.assign(this, { native, variables }); }
  /** Rows keep their literals; a malformed list is left for the native validation to refuse. */
  async resolveChanges(rows, context) {
    if (!Array.isArray(rows) || rows.length > ACTIONS["document.update"].inputs.changes.max) return rows;
    const resolved = [];
    for (const row of rows) resolved.push(plain(row) && resolvable(row.value) ? { ...row, value: await this.variables.resolveInput(row.value, context) } : row);
    return resolved;
  }
  async prepare(command, op, context) {
    const parameters = {}; requireValue(plain(command.parameters));
    for (const [key, value] of Object.entries(command.parameters)) {
      if (key === "arguments" && command.action === "macro.execute") continue;
      if (key === "changes" && command.action === "document.update") { parameters[key] = await this.resolveChanges(value, op.context); continue; }
      parameters[key] = await this.variables.resolveInput(value, op.context, { formula: command.action === "dice.roll" && key === "formula" });
    }
    op.guard();
    const prepared = await this.native.prepare({ ...command, parameters }, { ...context, guard: op.guard });
    if (command.action === "macro.execute" && Object.hasOwn(command.parameters, "arguments")) {
      const macro = prepared.parameters.document;
      requireValue(macro.type === "script" && macro.canExecute === true, "incompatibleMacro");
      const declaration = validateMacroDeclaration(macro.getFlag(MODULE_ID, "arguments")), args = command.parameters.arguments;
      requireValue(plain(args) && Object.keys(args).every(key => declaration.arguments.some(arg => arg.name === key)));
      const resolved = {};
      for (const arg of declaration.arguments) {
        const input = Object.hasOwn(args, arg.name) ? args[arg.name] : arg.default;
        if (input === undefined) { requireValue(!arg.required, "invalidParameters"); continue; }
        const value = await this.variables.resolveInput(input, op.context); validateValue(value, arg.type);
        resolved[arg.name] = ["number", "text", "boolean"].includes(arg.type) ? value : (await op.context.document(value, arg.type)).uuid;
      }
      prepared.macro = { declaration: JSON.stringify(declaration), scope: { version: 1, arguments: copy(resolved) } };
    }
    op.guard(); return prepared;
  }
  async execute(command, context = {}) {
    requireValue(typeof command.action === "string" && plain(command.parameters));
    const extended = usesVariables(command);
    if (!this.variables.available()) { requireValue(!extended, "unsupportedExtension"); return this.native.execute(command, context); }
    if (!extended) {
      // Invalid/future variable data must not break existing literal keys.
      try { this.variables.stores(); } catch { return this.native.execute(command, context); }
    }
    return this.variables.run(async op => {
      if (command.action === "variable.applyAndExecute") {
        keys(command.parameters, ["mutations", "action"]);
        const { mutations, action } = command.parameters;
        requireValue(Array.isArray(mutations) && mutations.length > 0 && mutations.length <= LIMITS.batch && plain(action));
        keys(action, ["action", "parameters"]); requireValue(Object.hasOwn(ACTIONS, action.action), "unknownAction");
        const stores = copy(op.context.stores); let scope;
        for (const request of mutations) { const next = this.variables.mutateCandidate(stores, request);
          requireValue(scope === undefined || scope === next, "scopeMismatch"); scope = next; }
        this.variables.assertOwner(scope, op.context.stores);
        const candidateContext = this.variables.context(stores), original = op.context;
        // Candidate values are read without pretending they have already been persisted.
        candidateContext.check = original.check;
        op.context = candidateContext;
        let prepared;
        try { prepared = await this.prepare({ ...command, ...action }, op, context); }
        finally { op.context = original; }
        let commit;
        try { commit = await this.variables.persist(scope, stores[scope], op); }
        catch (error) { if (!error.details) throw error;
          return { code: error.code === "uncertain" ? "uncertain" : "partial", details: error.details }; }
        original.documents.push(...candidateContext.documents);
        for (const [key, entry] of candidateContext.reads) original.reads.set(key, entry);
        const details = { version: 1, revision: commit.revision, variableCommit: commit.changed ? "committed" : "unchanged", execution: "notStarted" };
        try { op.guard(); const result = await this.native.dispatch(prepared, { ...context, guard: op.guard });
          return { code: result.code, details: { ...details, execution: "completed" } }; }
        catch (error) { return { code: error.code === "uncertain" ? "uncertain" : "partial",
          details: { ...details, execution: !prepared.started ? "notStarted" : error.code === "uncertain" ? "unconfirmed" : error.code === "cancelled" ? "cancelled" : "failed" } }; }
      }
      if (command.action.startsWith("variable.")) {
        const operation = command.action.slice(9); keys(command.parameters, ["variable", "value", "amount"]);
        const stores = copy(op.context.stores), scope = this.variables.mutateCandidate(stores, { operation, ...command.parameters });
        this.variables.assertOwner(scope, op.context.stores);
        const result = await this.variables.persist(scope, stores[scope], op);
        return { code: "executed", details: { version: 1, revision: result.revision, variableCommit: result.changed ? "committed" : "unchanged", execution: "notStarted" } };
      }
      const prepared = await this.prepare(command, op, context);
      return this.native.dispatch(prepared, { ...context, guard: op.guard });
    }, { id: command.id, guard: context.guard });
  }
}
