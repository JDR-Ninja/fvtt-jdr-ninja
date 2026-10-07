import { ControlError, requireValue } from "../stream-deck/protocol.js";

export const VARIABLE_VERSION = 1;
export const LIMITS = Object.freeze({ variables: 64, lists: 32, entries: 128, bytes: 65536,
  text: 2000, nodes: 128, depth: 16, dependencies: 64, batch: 16, preview: 96 });
export const DOCUMENT_TYPES = Object.freeze(["Actor", "Token", "Scene", "JournalEntry", "JournalEntryPage",
  "Macro", "Playlist", "PlaylistSound", "RollTable", "Combat"]);
export const VALUE_TYPES = Object.freeze(["number", "boolean", "text", ...DOCUMENT_TYPES]);
export const SCOPES = Object.freeze(["world", "personal"]);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const copy = value => JSON.parse(JSON.stringify(value));
export function preview(value) {
  let text = ""; const original = String(value);
  for (const character of original) { if (new TextEncoder().encode(text + character).length > LIMITS.preview) break; text += character; }
  return { text, shortened: text !== original };
}
/** Bound metadata even if every computed value/document label grows to its runtime maximum. */
export function validateProjectionCapacity(store, scope) {
  const display = "x".repeat(LIMITS.preview);
  const projection = { variables: store.variables.map(v => ({ id: v.id, scope, name: preview(v.name).text, type: v.type,
    kind: v.kind, writable: true, operations: operations(v), ...(v.list ? { list: v.list } : {}) })),
    state: store.variables.map(v => ({ id: v.id, scope, status: "wrongDocumentType", preview: { text: display, shortened: true } })),
    lists: store.lists.map(l => ({ id: l.id, scope, name: preview(l.name).text, type: l.type,
      entries: l.entries.map(e => ({ id: e.id, label: preview(e.label).text })) })) };
  requireValue(bytes(projection) <= 62000, "capacity");
}
export const emptyStore = () => ({ version: VARIABLE_VERSION, revision: 0, controller: null, variables: [], lists: [] });
export const reference = value => Boolean(value && value.source === "variable");
export function plain(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
export function keys(value, allowed) {
  requireValue(plain(value) && Object.keys(value).every(key => !forbidden.has(key) && allowed.includes(key)), "invalidParameters");
}
export function id(value) { requireValue(typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)); return value; }
export function name(value) { requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= 80); return value; }
export function validateReference(value) { keys(value, ["source", "scope", "id"]); requireValue(reference(value) && SCOPES.includes(value.scope)); id(value.id); return value; }
export function validateValue(value, type, constraints = {}) {
  requireValue(VALUE_TYPES.includes(type));
  if (type === "number") requireValue(Number.isFinite(value)
    && (constraints.min === undefined || value >= constraints.min)
    && (constraints.max === undefined || value <= constraints.max), "outOfBounds");
  else if (type === "boolean") requireValue(typeof value === "boolean");
  else if (type === "text") requireValue(typeof value === "string" && value.length <= (constraints.maxLength ?? LIMITS.text));
  else {
    keys(value, ["uuid", "source", "userId"]);
    if (value.source === "selectedToken") requireValue(type === "Token" && !value.uuid && !value.userId);
    else if (value.source === "userCharacter") requireValue(type === "Actor" && !value.uuid
      && (value.userId === undefined || typeof id(value.userId) === "string"));
    else requireValue(value.source === undefined && value.userId === undefined && typeof value.uuid === "string"
      && value.uuid.length > 0 && value.uuid.length <= 512);
  }
  return value;
}
export function validateConstraints(c = {}) {
  keys(c, ["min", "max", "maxLength", "clamp"]);
  requireValue((c.min === undefined || Number.isFinite(c.min)) && (c.max === undefined || Number.isFinite(c.max))
    && (c.min === undefined || c.max === undefined || c.min <= c.max)
    && (c.maxLength === undefined || Number.isInteger(c.maxLength) && c.maxLength >= 1 && c.maxLength <= LIMITS.text)
    && (c.clamp === undefined || typeof c.clamp === "boolean"));
}
export function validateStore(store) {
  keys(store, ["version", "revision", "controller", "variables", "lists"]);
  if (store.version > VARIABLE_VERSION) throw new ControlError("futureSchema");
  requireValue(store.version === VARIABLE_VERSION && Number.isSafeInteger(store.revision) && store.revision >= 0,
    "invalidStore");
  requireValue(store.controller === null || typeof id(store.controller) === "string");
  requireValue(Array.isArray(store.variables) && store.variables.length <= LIMITS.variables
    && Array.isArray(store.lists) && store.lists.length <= LIMITS.lists, "capacity");
  const identities = new Set();
  const unique = value => { id(value); requireValue(!identities.has(value)); identities.add(value); };
  for (const list of store.lists) {
    keys(list, ["id", "name", "type", "entries"]); unique(list.id); name(list.name);
    requireValue(VALUE_TYPES.includes(list.type) && Array.isArray(list.entries) && list.entries.length <= LIMITS.entries, "capacity");
    for (const entry of list.entries) { keys(entry, ["id", "label", "value"]); unique(entry.id); name(entry.label); validateValue(entry.value, list.type); }
  }
  for (const variable of store.variables) {
    keys(variable, ["id", "name", "type", "kind", "constraints", "current", "default", "list", "expression", "wrap"]);
    unique(variable.id); name(variable.name); requireValue(VALUE_TYPES.includes(variable.type));
    validateConstraints(variable.constraints);
    if (variable.kind === "stored") {
      requireValue(variable.list === undefined && variable.expression === undefined && variable.wrap === undefined);
      for (const field of ["current", "default"]) if (variable[field] !== null) validateValue(variable[field], variable.type, variable.constraints);
    } else if (variable.kind === "list") {
      keys(variable.list, ["scope", "id"]); requireValue(SCOPES.includes(variable.list.scope)); id(variable.list.id);
      requireValue(variable.expression === undefined && typeof variable.wrap === "boolean");
      for (const field of ["current", "default"]) requireValue(variable[field] === null || typeof id(variable[field]) === "string");
    } else if (variable.kind === "computed") {
      requireValue(plain(variable.expression) && variable.current === undefined && variable.default === undefined
        && variable.list === undefined && variable.wrap === undefined);
      const pending = [{ node: variable.expression, depth: 0 }]; let count = 0;
      while (pending.length) {
        const { node, depth } = pending.pop(); requireValue(++count <= LIMITS.nodes && depth <= LIMITS.depth, "expressionLimit");
        keys(node, ["op", "type", "value", "scope", "id", "args"]); requireValue(typeof node.op === "string");
        if (node.op === "literal") { keys(node, ["op", "type", "value"]); validateValue(node.value, node.type); }
        else if (node.op === "ref") { keys(node, ["op", "scope", "id"]); requireValue(SCOPES.includes(node.scope)); id(node.id); }
        else { keys(node, ["op", "args"]); requireValue(["add", "subtract", "multiply", "divide", "min", "max", "clamp", "round", "floor", "ceil", "abs",
          "equal", "less", "greater", "lessEqual", "greaterEqual", "and", "or", "not", "if", "concat", "documentName", "documentUuid"].includes(node.op));
          requireValue(Array.isArray(node.args) && node.args.length > 0 && node.args.length <= 16);
          for (const child of node.args) pending.push({ node: child, depth: depth + 1 }); }
      }
    } else throw new ControlError("invalidParameters");
  }
  requireValue(bytes(store) <= LIMITS.bytes, "capacity"); return store;
}
export function readStore(raw) {
  if (raw === undefined || raw === null || raw === "") return emptyStore();
  try { return validateStore(copy(typeof raw === "string" ? JSON.parse(raw) : raw)); }
  catch (error) { throw new ControlError(error.code === "futureSchema" ? "futureSchema" : "invalidStore"); }
}
/** UUID v7: millisecond timestamp and cryptographically random RFC 9562 variant bits. */
export function uuid7(crypto = globalThis.crypto, now = Date.now()) {
  requireValue(crypto?.getRandomValues && Number.isSafeInteger(now) && now >= 0 && now < 2 ** 48, "unavailable");
  const data = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 5, timestamp = now; i >= 0; i--, timestamp = Math.floor(timestamp / 256)) data[i] = timestamp % 256;
  data[6] = (data[6] & 15) | 112; data[8] = (data[8] & 63) | 128;
  const hex = Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function operations(variable) {
  if (variable.kind === "computed") return [];
  return variable.kind === "list" ? ["select", "next", "previous", "reset"]
    : ["set", "reset", ...(variable.type === "number" ? ["increment", "decrement"] : variable.type === "boolean" ? ["toggle"] : [])];
}
