import { MODULE_ID } from "../constants.js";
import { ControlError, requireValue } from "../stream-deck/protocol.js";
import { DOCUMENT_TYPES, LIMITS, SCOPES, copy, emptyStore, readStore, validateStore, validateValue,
  validateReference, reference, keys, operations, uuid7, bytes, preview, validateProjectionCapacity } from "./schema.js";
import { inspectExpression, evaluateExpression } from "./expressions.js";

export const STORE_KEYS = Object.freeze({ world: "variablesWorld", personal: "variablesPersonal" });
const RESOLUTION_CODES = new Set(["invalidParameters", "denied", "missingVariable", "missingList", "missingEntry", "missingDocument",
  "unsetValue", "wrongValueType", "wrongDocumentType", "outOfBounds", "capacity", "expressionCycle", "expressionLimit",
  "invalidExpression", "divisionByZero", "scopeMismatch", "staleState", "staleSelection", "ambiguousTarget", "unavailable"]);
const readable = (document, user) => document?.testUserPermission?.(user, "OBSERVER") && (!document.hidden || user.isGM === true);
export const VARIABLE_ACTIONS = Object.freeze(Object.fromEntries(["set", "select", "next", "previous", "increment", "decrement", "toggle", "reset"]
  .map(op => [`variable.${op}`, { advanced: true, inputs: { variable: { type: "variable" },
    ...(["set", "select"].includes(op) ? { value: { type: op === "select" ? "entry" : "value" } } : {}),
    ...(["increment", "decrement"].includes(op) ? { amount: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER } } : {}) } }])));
export class VariableService {
  constructor({ game = () => globalThis.game, canvas = () => globalThis.canvas,
    resolveUuid = uuid => globalThis.fromUuid(uuid), resolveSync = uuid => globalThis.fromUuidSync(uuid), crypto = globalThis.crypto } = {}) {
    Object.assign(this, { game, canvas, resolveUuid, resolveSync, crypto });
    this.listeners = new Set(); this.epoch = 0; this.operation = null; this.uncertain = new Set();
  }
  available() { return Boolean(this.game()?.settings?.settings?.has?.(`${MODULE_ID}.${STORE_KEYS.world}`)); }
  identity() { const g = this.game(); return `${g?.world?.id}|${g?.user?.id}|${g?.user?.role}`; }
  stores() { return Object.fromEntries(SCOPES.map(scope => [scope, readStore(this.game().settings.get(MODULE_ID, STORE_KEYS[scope]))])); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify(event = {}) { for (const fn of this.listeners) { try { fn(event); } catch { /* Observers cannot authorize or abort writes. */ } } }
  invalidate(scope) {
    let ownOperation;
    if (scope && this.expected?.scope === scope) {
      try { if (JSON.stringify(this.stores()[scope]) === this.expected.json) ownOperation = this.operation?.id; } catch { /* Invalid store stays unavailable. */ }
    }
    if (!ownOperation) this.epoch++;
    this.notify({ scope, ownOperation });
  }
  fullGM(user = this.game()?.user) { return user?.isGM === true && user.role === 4; }
  candidate() {
    const users = this.game()?.users;
    return users?.getDesignatedUser?.(user => user.active && this.fullGM(user))
      ?? Array.from(users?.contents ?? []).filter(user => user.active && this.fullGM(user)).sort((a, b) => a.id.localeCompare(b.id))[0];
  }
  canWrite(scope, stores = this.stores()) {
    const g = this.game(), user = g?.user;
    if (!user || g.ready === false || user.active === false || g.socket?.connected === false || this.uncertain.has(scope)) return false;
    return scope === "personal" || scope === "world" && this.fullGM(user)
      && (typeof user.can !== "function" || user.can("SETTINGS_MODIFY")) && stores.world.controller === user.id;
  }
  assertOwner(scope, stores) { requireValue(SCOPES.includes(scope)); requireValue(!this.uncertain.has(scope), "uncertain");
    requireValue(this.canWrite(scope, stores), "notController"); }
  async initialize() {
    if (!this.available()) return;
    const stores = this.stores();
    if (!stores.world.controller && this.fullGM() && this.candidate()?.id === this.game().user.id) {
      await this.assignController(this.game().user.id, stores.world.revision);
    }
  }
  async run(fn, { id = uuid7(this.crypto), guard = () => {} } = {}) {
    requireValue(!this.operation, "busy"); const identity = this.identity(), epoch = this.epoch;
    requireValue(this.game()?.ready !== false && this.game()?.user?.active !== false && this.game()?.socket?.connected !== false, "wrongSession");
    const context = this.context();
    const op = this.operation = { id, identity, epoch, context };
    // `confirmed`: the user has just answered Yes in Foundry's own confirmation for this operation. That answer
    // supersedes later table changes (the epoch), but the operation, its seat and its bindings must still hold.
    op.guard = ({ confirmed = false } = {}) => { requireValue(this.operation === op && this.identity() === identity
      && this.game()?.ready !== false && this.game()?.user?.active !== false && this.game()?.socket?.connected !== false, "wrongSession");
      if (!confirmed) requireValue(this.epoch === epoch, "staleState");
      context.check({ confirmed }); guard({ ownOperation: op.committed ? id : null, confirmed }); };
    try { op.guard(); return await fn(op); }
    finally { if (this.operation === op) { this.operation = null; this.expected = null; this.notify({ idle: true }); } }
  }
  context(stores = this.stores()) {
    const identity = this.identity(), epoch = this.epoch, cache = new Map(), documents = [], reads = new Map();
    // Every variable and list definition a resolution read, so a confirmed check can prove its bindings unchanged.
    const read = (scope, collection, item) => reads.set(`${scope}|${collection}|${item.id}`,
      { scope, collection, id: item.id, json: JSON.stringify(item) });
    const context = { stores, nodes: 0, documents, reads,
      check: ({ confirmed = false } = {}) => {
        requireValue(this.identity() === identity && (confirmed || this.epoch === epoch) && this.game()?.socket?.connected !== false, "staleState");
        const current = this.stores();
        // A confirmed operation ignores unrelated store edits; only the definitions its inputs came from must be unchanged.
        if (confirmed) for (const entry of reads.values()) requireValue(JSON.stringify(current[entry.scope][entry.collection]
          .find(item => item.id === entry.id)) === entry.json, "staleState");
        else for (const scope of SCOPES) requireValue(JSON.stringify(current[scope]) === JSON.stringify(stores[scope]), "staleState");
        for (const pin of documents) {
          requireValue(readable(pin.document, this.game().user), "denied");
          if (pin.binding.source === "selectedToken") requireValue(this.canvas()?.tokens?.controlled?.length === 1
            && this.canvas().tokens.controlled[0].document === pin.document, "staleSelection");
          else if (pin.binding.source === "userCharacter") requireValue(this.game().users.get(pin.binding.userId ?? this.game().user.id)?.character === pin.document, "staleState");
          else { let currentDoc; try { currentDoc = this.resolveSync(pin.binding.uuid); } catch { /* Removed/unloaded document. */ }
            requireValue(currentDoc === pin.document, "missingDocument"); }
        }
      },
      resolve: async (scope, id, depth = 0) => {
        requireValue(SCOPES.includes(scope)); const key = `${scope}:${id}`;
        if (cache.has(key)) return cache.get(key);
        const v = stores[scope].variables.find(v => v.id === id); requireValue(v, "missingVariable"); read(scope, "variables", v);
        let value;
        if (v.kind === "computed") {
          requireValue(inspectExpression(v.expression, (s, i) => stores[s]?.variables.find(v => v.id === i), scope,
            new Set([key])).type === v.type, "wrongValueType");
          value = await evaluateExpression(v.expression, context, scope, depth);
        } else if (v.kind === "list") {
          requireValue(!(scope === "world" && v.list.scope === "personal"), "scopeMismatch");
          const list = stores[v.list.scope].lists.find(list => list.id === v.list.id);
          requireValue(list && list.type === v.type, "missingList"); read(v.list.scope, "lists", list);
          const entry = list.entries.find(entry => entry.id === v.current); requireValue(entry, "missingEntry"); value = copy(entry.value);
        } else { requireValue(v.current !== null, "unsetValue"); value = copy(v.current); }
        validateValue(value, v.type, v.constraints);
        if (DOCUMENT_TYPES.includes(v.type)) await context.document(value, v.type);
        cache.set(key, value); return value;
      },
      document: async (binding, type) => {
        let document;
        if (binding.source === "selectedToken") { const selected = this.canvas()?.tokens?.controlled ?? [];
          requireValue(selected.length === 1, "ambiguousTarget"); document = selected[0].document; }
        else if (binding.source === "userCharacter") document = this.game().users.get(binding.userId ?? this.game().user.id)?.character;
        else document = await this.resolveUuid(binding.uuid);
        requireValue(document, "missingDocument"); requireValue((document.documentName ?? document.constructor?.documentName) === type, "wrongDocumentType");
        requireValue(readable(document, this.game().user), "denied");
        documents.push({ document, binding: copy(binding) }); return document;
      },
      documentText: async (binding, field) => { const pin = documents.find(pin => JSON.stringify(pin.binding) === JSON.stringify(binding));
        requireValue(pin && readable(pin.document, this.game().user), "denied");
        const value = String(pin.document[field] ?? ""); requireValue(value.length <= LIMITS.text, "capacity"); return value; },
    };
    return context;
  }
  async read(ref) { validateReference(ref); const ctx = this.context(); const value = await ctx.resolve(ref.scope, ref.id); ctx.check(); return copy(value); }
  async resolveInput(value, context, { formula = false } = {}) {
    if (reference(value)) { validateReference(value); const result = await context.resolve(value.scope, value.id);
      return result?.source === "userCharacter" && !result.userId ? { ...result, userId: this.game().user.id } : result; }
    if (value?.source === "template") {
      keys(value, ["source", "segments"]); requireValue(Array.isArray(value.segments) && value.segments.length <= LIMITS.nodes);
      let result = "";
      for (const segment of value.segments) {
        keys(segment, ["text", "variable", "format"]);
        if (segment.text !== undefined) { requireValue(typeof segment.text === "string" && !segment.variable && segment.format === undefined); result += segment.text; }
        else {
          validateReference(segment.variable); let resolved = await context.resolve(segment.variable.scope, segment.variable.id);
          if (formula) requireValue(typeof resolved === "number" && Number.isFinite(resolved), "wrongValueType");
          if (["name", "uuid"].includes(segment.format)) { requireValue(!formula, "wrongValueType"); resolved = await context.documentText(resolved, segment.format); }
          else { requireValue(segment.format === undefined || segment.format === "value"); requireValue(["number", "boolean", "string"].includes(typeof resolved), "wrongValueType"); }
          result += String(resolved);
        }
        requireValue(result.length <= LIMITS.text, "capacity");
      }
      return result;
    }
    if (Array.isArray(value)) { requireValue(value.length <= 100 && value.every(entry => !Array.isArray(entry))); const values = [];
      for (const entry of value) values.push(await this.resolveInput(entry, context)); return values; }
    return value;
  }
  validateDefinitions(stores, scope, definitionId) {
    validateStore(stores[scope]);
    validateProjectionCapacity(stores[scope], scope);
    for (const s of SCOPES) for (const v of stores[s].variables) {
      if (v.kind === "list") {
        requireValue(!(s === "world" && v.list.scope === "personal"), "scopeMismatch");
        const list = stores[v.list.scope].lists.find(l => l.id === v.list.id);
        if (list) { requireValue(list.type === v.type, "wrongValueType");
          for (const entry of list.entries) validateValue(entry.value, v.type, v.constraints); }
        else requireValue(s !== scope || v.id !== definitionId, "missingList");
      }
      if (v.kind === "computed") {
        try { requireValue(inspectExpression(v.expression, (s, i) => stores[s]?.variables.find(v => v.id === i), s,
          new Set([`${s}:${v.id}`])).type === v.type, "wrongValueType"); }
        catch (error) { if (s === scope && v.id === definitionId || !["missingVariable", "missingList"].includes(error.code)) throw error; }
      }
    }
  }
  async persist(scope, candidate, op, { controller = false } = {}) {
    const before = op.context.stores[scope]; validateStore(candidate); op.guard();
    if (!controller) this.assertOwner(scope, op.context.stores);
    if (JSON.stringify(before) === JSON.stringify(candidate)) return { changed: false, revision: before.revision };
    candidate.revision = before.revision + 1; validateStore(candidate);
    this.expected = { scope, json: JSON.stringify(candidate) };
    try { await this.game().settings.set(MODULE_ID, STORE_KEYS[scope], copy(candidate)); }
    catch (error) { this.uncertain.add(scope); throw new ControlError("uncertain", { version: 1, variableCommit: "unknown", execution: "notStarted" }); }
    const confirmed = this.stores()[scope];
    if (JSON.stringify(confirmed) !== this.expected.json) { this.uncertain.add(scope); throw new ControlError("uncertain", { version: 1, variableCommit: "unknown", execution: "notStarted" }); }
    op.context.stores[scope] = copy(confirmed); op.committed = true; this.expected = null;
    this.notify({ scope, ownOperation: op.id });
    try { op.guard(); } catch (error) { error.details = { version: 1, revision: confirmed.revision, variableCommit: "committed", execution: "notStarted" }; throw error; }
    return { changed: true, revision: confirmed.revision };
  }
  async reconcile(scope) {
    requireValue(!this.operation, "busy"); requireValue(SCOPES.includes(scope));
    const key = `${MODULE_ID}.${STORE_KEYS[scope]}`;
    const Setting = globalThis.foundry?.documents?.Setting;
    requireValue(Setting?.database?.get, "unavailable");
    const identity = this.identity();
    const data = await Setting.database.get(Setting, { query: { key, user: scope === "personal" ? this.game().user.id : null } }, this.game().user);
    const document = data.find(doc => doc.key === key && (doc.user ?? null) === (scope === "personal" ? this.game().user.id : null));
    requireValue(this.identity() === identity, "wrongSession"); const confirmed = document ? readStore(document.value) : emptyStore();
    requireValue(JSON.stringify(confirmed) === JSON.stringify(this.stores()[scope]), "reloadRequired");
    this.uncertain.delete(scope); this.invalidate(scope); return { code: "executed", revision: confirmed.revision };
  }
  async assignController(userId, baseRevision) {
    return this.run(async op => {
      requireValue(this.fullGM() && (typeof this.game().user.can !== "function" || this.game().user.can("SETTINGS_MODIFY")), "denied");
      const before = op.context.stores.world; requireValue(before.revision === baseRevision, "conflict");
      const current = this.game().users.get(before.controller), target = this.game().users.get(userId);
      requireValue(target?.active && this.fullGM(target), "notController");
      const bootstrap = !before.controller, own = before.controller === this.game().user.id;
      requireValue(own || (!current?.active && this.candidate()?.id === this.game().user.id), "notController");
      requireValue(!bootstrap || userId === this.game().user.id && this.candidate()?.id === userId, "notController");
      const candidate = copy(before); candidate.controller = userId;
      return this.persist("world", candidate, op, { controller: true });
    });
  }
  async configure(scope, baseRevision, edit, definitionId) {
    return this.run(async op => {
      this.assertOwner(scope, op.context.stores); const before = op.context.stores[scope];
      requireValue(before.revision === baseRevision, "conflict"); const candidate = copy(before); edit(candidate);
      const stores = { ...op.context.stores, [scope]: candidate }; this.validateDefinitions(stores, scope, definitionId);
      return this.persist(scope, candidate, op);
    });
  }
  saveVariable(scope, variable, baseRevision, { convert = false } = {}) {
    return this.configure(scope, baseRevision, store => { const index = store.variables.findIndex(v => v.id === variable.id);
      if (index < 0) store.variables.push(copy(variable)); else {
        const before = store.variables[index];
        requireValue(before.type === variable.type && (before.kind === variable.kind || convert), "incompatibleChange");
        store.variables[index] = { ...copy(variable), ...(before.kind === variable.kind && before.kind !== "computed" ? { current: before.current } : {}) };
      }
    }, variable.id);
  }
  saveList(scope, list, baseRevision) {
    return this.configure(scope, baseRevision, store => { const index = store.lists.findIndex(v => v.id === list.id);
      if (index < 0) store.lists.push(copy(list)); else { requireValue(store.lists[index].type === list.type, "incompatibleChange"); store.lists[index] = copy(list); }
    });
  }
  remove(scope, collection, id, baseRevision) {
    requireValue(["variables", "lists"].includes(collection));
    return this.configure(scope, baseRevision, store => { const index = store[collection].findIndex(v => v.id === id);
      requireValue(index >= 0, "missingVariable"); store[collection].splice(index, 1); });
  }
  mutateCandidate(stores, request) {
    keys(request, ["operation", "variable", "value", "amount"]); validateReference(request.variable);
    requireValue(["set", "select"].includes(request.operation) ? request.amount === undefined && Object.hasOwn(request, "value")
      : ["increment", "decrement"].includes(request.operation) ? request.value === undefined && Object.hasOwn(request, "amount")
      : request.amount === undefined && request.value === undefined);
    const { scope, id } = request.variable, v = stores[scope].variables.find(v => v.id === id);
    requireValue(v, "missingVariable"); requireValue(operations(v).includes(request.operation), "readOnly");
    if (request.operation === "set") validateValue(request.value, v.type, v.constraints), v.current = copy(request.value);
    else if (["select", "next", "previous", "reset"].includes(request.operation) && v.kind === "list") {
      const list = stores[v.list.scope].lists.find(l => l.id === v.list.id); requireValue(list, "missingList");
      if (["select", "reset"].includes(request.operation)) { const entry = list.entries.find(e => e.id === (request.operation === "reset" ? v.default : request.value));
        requireValue(entry, "missingEntry"); validateValue(entry.value, v.type, v.constraints); v.current = entry.id; }
      else { const index = list.entries.findIndex(e => e.id === v.current); requireValue(index >= 0, "missingEntry");
        let target = index + (request.operation === "next" ? 1 : -1);
        if (v.wrap) target = (target + list.entries.length) % list.entries.length;
        if (target >= 0 && target < list.entries.length) { validateValue(list.entries[target].value, v.type, v.constraints); v.current = list.entries[target].id; } }
    } else if (request.operation === "reset") { requireValue(v.default !== null, "unsetValue"); validateValue(v.default, v.type, v.constraints); v.current = copy(v.default); }
    else if (request.operation === "toggle") { validateValue(v.current, "boolean"); v.current = !v.current; }
    else { requireValue(Number.isFinite(request.amount) && request.amount >= 0 && request.amount <= Number.MAX_SAFE_INTEGER); validateValue(v.current, "number", v.constraints);
      let value = v.current + request.amount * (request.operation === "increment" ? 1 : -1);
      if (v.constraints?.clamp) value = Math.max(v.constraints.min ?? -Infinity, Math.min(v.constraints.max ?? Infinity, value));
      validateValue(value, "number", v.constraints); v.current = value; }
    return scope;
  }
  async mutate(request) {
    return this.run(async op => { const stores = copy(op.context.stores), scope = this.mutateCandidate(stores, request);
      this.assertOwner(scope, op.context.stores); const result = await this.persist(scope, stores[scope], op);
      return { code: "executed", ...result }; });
  }
  async projection() {
    const stores = this.stores(), ctx = this.context(stores), variables = [], lists = [], state = [];
    const shorten = preview;
    for (const scope of SCOPES) {
      for (const v of stores[scope].variables) {
        let status = "available", preview = null;
        try { const value = await ctx.resolve(scope, v.id); preview = shorten(DOCUMENT_TYPES.includes(v.type) ? await ctx.documentText(value, "name") : value); }
        catch (error) { status = RESOLUTION_CODES.has(error.code) ? error.code : "unavailable"; }
        variables.push({ id: v.id, scope, name: shorten(v.name).text, type: v.type, kind: v.kind,
          writable: this.canWrite(scope, stores) && v.kind !== "computed", operations: this.canWrite(scope, stores) ? operations(v) : [],
          ...(v.kind === "list" ? { list: v.list } : {}) });
        state.push({ id: v.id, scope, status, preview });
        ctx.nodes = 0;
      }
      for (const list of stores[scope].lists) {
        const entries = [];
        for (const entry of list.entries) {
          try { if (DOCUMENT_TYPES.includes(list.type)) await ctx.document(entry.value, list.type);
            entries.push({ id: entry.id, label: shorten(entry.label).text }); }
          catch { /* Inaccessible document entries expose neither ID, label nor UUID. */ }
        }
        lists.push({ id: list.id, scope, name: shorten(list.name).text, type: list.type, entries });
      }
    }
    ctx.check(); const result = { variables, lists, state, revisions: Object.fromEntries(SCOPES.map(s => [s, stores[s].revision])), controller: stores.world.controller };
    requireValue(bytes(result) <= 131072, "capacity"); return result;
  }
}
export const variableService = new VariableService();
