import { ControlError, requireValue } from "../stream-deck/protocol.js";
import { DOCUMENT_TYPES, LIMITS, PATH_KEY, forbiddenKey, keys, validatePath, validateValue } from "./schema.js";

/** Static type of a document field: only its evaluation knows whether it holds a number, a boolean or text. */
export const UNKNOWN_TYPE = "unknown";
const PRIMITIVE_TYPES = ["number", "boolean", "text"];
const numeric = new Set(["add", "subtract", "multiply", "divide", "min", "max", "clamp", "round", "floor", "ceil", "abs"]);
const unary = new Set(["round", "floor", "ceil", "abs", "not", "documentName", "documentUuid"]);
const comparison = new Set(["equal", "less", "greater", "lessEqual", "greaterEqual"]);
const binary = new Set(["add", "subtract", "multiply", "divide", ...comparison]);
const FUNCTIONS = ["min", "max", "clamp", "round", "floor", "ceil", "abs", "if", "concat", "documentName", "documentUuid"];
const operatorText = { add: "+", subtract: "-", multiply: "*", divide: "/", equal: "==", less: "<", greater: ">", lessEqual: "<=", greaterEqual: ">=", and: "&&", or: "||" };
/** Binding strength shared by the parser and the formatter; binary operators associate to the left. */
const precedence = { or: 1, and: 2, equal: 3, less: 4, greater: 4, lessEqual: 4, greaterEqual: 4, add: 5, subtract: 5, multiply: 6, divide: 6 };
const UNARY = 7, PRIMARY = 8;
const strengthOf = op => Object.hasOwn(precedence, op) ? precedence[op] : 0;

/** Whether an inferred type may stand where `expected` is required. Field types are left to the evaluation. */
export const typeFits = (type, expected) => type === expected || (type === UNKNOWN_TYPE && PRIMITIVE_TYPES.includes(expected));
/** Expression type of a runtime value, or null for anything other than a number, a boolean or text. */
export const valueType = value => typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "string" ? "text" : null;
const typed = (value, type) => { requireValue(valueType(value) === type, "wrongValueType"); return value; };

export function inspectExpression(expression, lookup, rootScope, seen = new Set()) {
  const budget = { nodes: 0, dependencies: new Set() };
  function visit(node, depth, scope, chain) {
    requireValue(depth <= LIMITS.depth && ++budget.nodes <= LIMITS.nodes, "expressionLimit");
    keys(node, ["op", "type", "value", "scope", "id", "args", "path"]);
    if (node.op === "literal") { keys(node, ["op", "type", "value"]); validateValue(node.value, node.type); return node.type; }
    if (node.op === "ref") {
      keys(node, ["op", "scope", "id"]); requireValue(["world", "personal"].includes(node.scope)
        && !(scope === "world" && node.scope === "personal"), "scopeMismatch");
      const key = `${node.scope}:${node.id}`; budget.dependencies.add(key);
      requireValue(budget.dependencies.size <= LIMITS.dependencies, "expressionLimit");
      requireValue(!chain.has(key), "expressionCycle");
      const v = lookup(node.scope, node.id); requireValue(v, "missingVariable");
      if (v.kind === "computed") { const next = new Set(chain); next.add(key);
        requireValue(typeFits(visit(v.expression, depth + 1, node.scope, next), v.type), "wrongValueType"); }
      return v.type;
    }
    if (node.op === "field") {
      // A document variable, then fixed keys or text/number variables naming one key each.
      keys(node, ["op", "args", "path"]); requireValue(Array.isArray(node.args) && node.args.length === 1 && node.args[0]?.op === "ref");
      validatePath(node.path);
      requireValue(DOCUMENT_TYPES.includes(visit(node.args[0], depth + 1, scope, chain)), "wrongValueType");
      for (const part of node.path) if (typeof part !== "string") requireValue(["text", "number"].includes(visit(part, depth + 1, scope, chain)), "wrongValueType");
      return UNKNOWN_TYPE;
    }
    keys(node, ["op", "args"]);
    requireValue(Array.isArray(node.args) && node.args.length > 0 && node.args.length <= 16);
    requireValue(numeric.has(node.op) || comparison.has(node.op) || ["and", "or", "not", "if", "concat", "documentName", "documentUuid"].includes(node.op));
    requireValue(!unary.has(node.op) || node.args.length === 1);
    requireValue(!binary.has(node.op) || node.args.length === 2);
    requireValue(!["if", "clamp"].includes(node.op) || node.args.length === 3);
    const types = node.args.map(arg => visit(arg, depth + 1, scope, chain));
    const all = expected => types.every(type => typeFits(type, expected));
    if (numeric.has(node.op)) { requireValue(all("number"), "wrongValueType"); return "number"; }
    if (["documentName", "documentUuid"].includes(node.op)) { requireValue(DOCUMENT_TYPES.includes(types[0]), "wrongValueType"); return "text"; }
    if (node.op === "equal") { const known = types.filter(type => type !== UNKNOWN_TYPE);
      requireValue(known.every(type => type === known[0] && PRIMITIVE_TYPES.includes(type)), "wrongValueType"); return "boolean"; }
    if (comparison.has(node.op)) { requireValue(all("number"), "wrongValueType"); return "boolean"; }
    if (["and", "or", "not"].includes(node.op)) { requireValue(all("boolean"), "wrongValueType"); return "boolean"; }
    if (node.op === "if") {
      // A field branch takes the type of the other branch; whatever consumes the result checks the actual value.
      const [condition, ...branches] = types, known = branches.filter(type => type !== UNKNOWN_TYPE);
      requireValue(typeFits(condition, "boolean") && known.every(type => type === known[0])
        && (known.length === branches.length || known.every(type => PRIMITIVE_TYPES.includes(type))), "wrongValueType");
      return known[0] ?? UNKNOWN_TYPE;
    }
    requireValue(types.every(type => type === UNKNOWN_TYPE || PRIMITIVE_TYPES.includes(type)), "wrongValueType"); return "text";
  }
  return { type: visit(expression, 0, rootScope, seen), dependencies: [...budget.dependencies] };
}

/** A variable path part replaces exactly one key: non-empty text without a dot, or a finite number. */
function segment(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  requireValue(typeof text === "string" && text.length > 0 && !text.includes(".") && !forbiddenKey(text), "wrongValueType");
  return text;
}

export async function evaluateExpression(node, context, scope, depth = 0) {
  requireValue(depth <= LIMITS.depth && ++context.nodes <= LIMITS.nodes, "expressionLimit");
  if (node.op === "literal") { if (DOCUMENT_TYPES.includes(node.type)) await context.document(node.value, node.type); return node.value; }
  if (node.op === "ref") return context.resolve(node.scope, node.id, depth + 1);
  const run = arg => evaluateExpression(arg, context, scope, depth + 1);
  if (node.op === "field") {
    const document = await run(node.args[0]), path = [];
    for (const part of node.path) path.push(typeof part === "string" ? part : segment(await run(part)));
    requireValue(path.join(".").length <= LIMITS.path, "capacity");
    return context.field(document, path);
  }
  // Static types cannot vouch for field values, so every operator checks its operands: nothing is coerced.
  if (node.op === "if") return run(node.args[typed(await run(node.args[0]), "boolean") ? 1 : 2]);
  if (node.op === "and") { for (const arg of node.args) if (!typed(await run(arg), "boolean")) return false; return true; }
  if (node.op === "or") { for (const arg of node.args) if (typed(await run(arg), "boolean")) return true; return false; }
  const args = [];
  for (const arg of node.args) args.push(await run(arg));
  const [a, b, c] = args, types = args.map(valueType);
  if (numeric.has(node.op) || comparison.has(node.op) && node.op !== "equal") requireValue(types.every(type => type === "number"), "wrongValueType");
  if (node.op === "equal") requireValue(types[0] !== null && types[0] === types[1], "wrongValueType");
  if (node.op === "not") requireValue(types[0] === "boolean", "wrongValueType");
  if (node.op === "concat") requireValue(types.every(type => type !== null), "wrongValueType");
  let result;
  switch (node.op) {
    case "add": result = a + b; break;
    case "subtract": result = a - b; break;
    case "multiply": result = a * b; break;
    case "divide": requireValue(b !== 0, "divisionByZero"); result = a / b; break;
    case "min": result = Math.min(...args); break;
    case "max": result = Math.max(...args); break;
    case "clamp": requireValue(b <= c, "outOfBounds"); result = Math.max(b, Math.min(c, a)); break;
    case "round": result = Math.round(a); break;
    case "floor": result = Math.floor(a); break;
    case "ceil": result = Math.ceil(a); break;
    case "abs": result = Math.abs(a); break;
    case "not": return !a;
    case "equal": return a === b;
    case "less": return a < b;
    case "greater": return a > b;
    case "lessEqual": return a <= b;
    case "greaterEqual": return a >= b;
    case "documentName": return context.documentText(a, "name");
    case "documentUuid": return context.documentText(a, "uuid");
    case "concat": result = args.map(String).join(""); break;
    default: throw new ControlError("invalidParameters");
  }
  requireValue(typeof result !== "number" || Number.isFinite(result), "outOfBounds");
  requireValue(typeof result !== "string" || result.length <= LIMITS.text, "capacity"); return result;
}

/**
 * Parses a closed expression language. `@{Name}` names a variable; `resolveName` compiles it to its stable
 * scope and ID, or throws. A document reference may be followed by a field path: `@{Hero}.system.abilities.@{Ability}.value`.
 */
export function parseExpression(text, resolveName) {
  requireValue(typeof text === "string" && text.length <= LIMITS.text, "expressionLimit");
  const tokens = []; let offset = 0;
  const pattern = /\s*(?:@\{([^{}]+)\}|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*")|(true|false)\b|([A-Za-z][A-Za-z]*)|(<=|>=|==|&&|\|\||[+\-−*×/<>!(),]))/y;
  const part = new RegExp(`\\.(?:@\\{([^{}]+)\\}|(${PATH_KEY}))`, "y");
  const reference = name => { const label = name.trim(); requireValue(label, "invalidExpression");
    const ref = resolveName(label); requireValue(ref, "missingVariable"); return { op: "ref", scope: ref.scope, id: ref.id }; };
  while (offset < text.length && text.slice(offset).trim()) {
    pattern.lastIndex = offset; const match = pattern.exec(text); requireValue(match, "invalidExpression"); offset = pattern.lastIndex;
    if (match[1]) {
      const root = reference(match[1]), path = [];
      // The path follows the reference directly: no space before a dot, each dot followed by exactly one part.
      while (text[offset] === ".") {
        part.lastIndex = offset; const step = part.exec(text); requireValue(step, "invalidExpression"); offset = part.lastIndex;
        if (step[1]) path.push(reference(step[1])); else { requireValue(!forbiddenKey(step[2]), "invalidExpression"); path.push(step[2]); }
        requireValue(path.length <= LIMITS.pathParts, "expressionLimit");
      }
      tokens.push({ node: path.length ? { op: "field", args: [root], path } : root });
    }
    else if (match[2]) tokens.push({ node: { op: "literal", type: "number", value: Number(match[2]) } });
    else if (match[3]) { let value; try { value = JSON.parse(match[3]); } catch { throw new ControlError("invalidExpression"); }
      tokens.push({ node: { op: "literal", type: "text", value } }); }
    else if (match[4]) tokens.push({ node: { op: "literal", type: "boolean", value: match[4] === "true" } });
    else tokens.push({ token: match[5] ?? match[6] });
    requireValue(tokens.length <= LIMITS.nodes * 4, "expressionLimit");
  }
  let index = 0, depth = 0;
  const ops = { "||": "or", "&&": "and", "==": "equal", "<": "less", ">": "greater", "<=": "lessEqual", ">=": "greaterEqual", "+": "add", "-": "subtract", "−": "subtract", "*": "multiply", "×": "multiply", "/": "divide" };
  const strength = token => Object.hasOwn(ops, token) ? strengthOf(ops[token]) : -1;
  const accept = token => tokens[index]?.token === token && (++index, true);
  function parse(minimum = 0) {
    requireValue(++depth <= LIMITS.depth, "expressionLimit"); let left; const next = tokens[index++]; requireValue(next, "invalidExpression");
    if (next.node) left = next.node;
    else if (["-", "−", "!"].includes(next.token)) left = { op: next.token === "!" ? "not" : "subtract", args: next.token === "!" ? [parse(UNARY)] : [{ op: "literal", type: "number", value: 0 }, parse(UNARY)] };
    else if (next.token === "(") { left = parse(); requireValue(accept(")"), "invalidExpression"); }
    else {
      requireValue(FUNCTIONS.includes(next.token) && accept("("), "invalidExpression");
      const args = []; if (!accept(")")) { do { args.push(parse()); } while (accept(",")); requireValue(accept(")"), "invalidExpression"); }
      left = { op: next.token, args };
    }
    while (tokens[index]?.token && strength(tokens[index].token) >= minimum) {
      const token = tokens[index++].token; left = { op: ops[token], args: [left, parse(strength(token) + 1)] };
    }
    depth--; return left;
  }
  const expression = parse(); requireValue(index === tokens.length, "invalidExpression"); return expression;
}

/** Formats an expression as a user would type it: names, ASCII operators, and parentheses only where precedence needs them. */
export function formatExpression(node, nameOf) {
  const name = ref => `@{${nameOf(ref.scope, ref.id)}}`;
  const wrap = (part, minimum) => part.precedence < minimum ? `(${part.text})` : part.text;
  function format(node) {
    if (node.op === "ref") return { text: name(node), precedence: PRIMARY };
    if (node.op === "field") return { text: name(node.args[0]) + node.path.map(part => `.${typeof part === "string" ? part : name(part)}`).join(""), precedence: PRIMARY };
    if (node.op === "literal") return { text: JSON.stringify(node.value), precedence: typeof node.value === "number" && node.value < 0 ? UNARY : PRIMARY };
    if (["documentName", "documentUuid"].includes(node.op) && node.args.length === 1 && node.args[0]?.op === "ref")
      return { text: `${name(node.args[0])}.${node.op === "documentName" ? "name" : "uuid"}`, precedence: PRIMARY };
    if (node.op === "not") return { text: `!${wrap(format(node.args[0]), UNARY)}`, precedence: UNARY };
    // The parser reads a unary minus as `0 - x`; show it the way it is typed.
    if (node.op === "subtract" && node.args[0]?.op === "literal" && node.args[0].type === "number" && node.args[0].value === 0)
      return { text: `-${wrap(format(node.args[1]), UNARY)}`, precedence: UNARY };
    const strength = strengthOf(node.op);
    if (strength && ["and", "or"].includes(node.op) && node.args.length === 1) return format(node.args[0]);
    if (strength && (node.args.length === 2 || ["and", "or"].includes(node.op)))
      return { text: node.args.map((arg, index) => wrap(format(arg), index === 0 ? strength : strength + 1)).join(` ${operatorText[node.op]} `), precedence: strength };
    return { text: `${node.op}(${node.args.map(arg => format(arg).text).join(", ")})`, precedence: PRIMARY };
  }
  return format(node).text;
}

/** Every variable reference in an expression tree, including those inside field paths, in reading order. */
export function expressionReferences(node) {
  const found = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (value.op === "ref") { found.push(value); return; }
    if (Array.isArray(value.args)) for (const arg of value.args) visit(arg);
    if (value.op === "field" && Array.isArray(value.path)) for (const part of value.path) visit(part);
  };
  visit(node); return found;
}
