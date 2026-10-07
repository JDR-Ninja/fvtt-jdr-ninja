import { ControlError, requireValue } from "../stream-deck/protocol.js";
import { DOCUMENT_TYPES, LIMITS, keys, validateValue } from "./schema.js";

const numeric = new Set(["add", "subtract", "multiply", "divide", "min", "max", "clamp", "round", "floor", "ceil", "abs"]);
const unary = new Set(["round", "floor", "ceil", "abs", "not", "documentName", "documentUuid"]);
const comparison = new Set(["equal", "less", "greater", "lessEqual", "greaterEqual"]);
const binary = new Set(["add", "subtract", "multiply", "divide", ...comparison]);
const operatorText = { add: "+", subtract: "−", multiply: "×", divide: "/", equal: "==", less: "<", greater: ">", lessEqual: "<=", greaterEqual: ">=", and: "&&", or: "||" };

export function inspectExpression(expression, lookup, rootScope, seen = new Set()) {
  const budget = { nodes: 0, dependencies: new Set() };
  function visit(node, depth, scope, path) {
    requireValue(depth <= LIMITS.depth && ++budget.nodes <= LIMITS.nodes, "expressionLimit");
    keys(node, ["op", "type", "value", "scope", "id", "args"]);
    if (node.op === "literal") { keys(node, ["op", "type", "value"]); validateValue(node.value, node.type); return node.type; }
    if (node.op === "ref") {
      keys(node, ["op", "scope", "id"]); requireValue(["world", "personal"].includes(node.scope)
        && !(scope === "world" && node.scope === "personal"), "scopeMismatch");
      const key = `${node.scope}:${node.id}`; budget.dependencies.add(key);
      requireValue(budget.dependencies.size <= LIMITS.dependencies, "expressionLimit");
      requireValue(!path.has(key), "expressionCycle");
      const v = lookup(node.scope, node.id); requireValue(v, "missingVariable");
      if (v.kind === "computed") { const next = new Set(path); next.add(key);
        requireValue(visit(v.expression, depth + 1, node.scope, next) === v.type, "wrongValueType"); }
      return v.type;
    }
    keys(node, ["op", "args"]);
    requireValue(Array.isArray(node.args) && node.args.length > 0 && node.args.length <= 16);
    requireValue(numeric.has(node.op) || comparison.has(node.op) || ["and", "or", "not", "if", "concat", "documentName", "documentUuid"].includes(node.op));
    requireValue(!unary.has(node.op) || node.args.length === 1);
    requireValue(!binary.has(node.op) || node.args.length === 2);
    requireValue(!["if", "clamp"].includes(node.op) || node.args.length === 3);
    const types = node.args.map(arg => visit(arg, depth + 1, scope, path));
    if (numeric.has(node.op)) { requireValue(types.every(type => type === "number"), "wrongValueType"); return "number"; }
    if (["documentName", "documentUuid"].includes(node.op)) { requireValue(DOCUMENT_TYPES.includes(types[0]), "wrongValueType"); return "text"; }
    if (comparison.has(node.op)) { requireValue(types[0] === types[1]
      && (node.op === "equal" ? ["number", "boolean", "text"].includes(types[0]) : types[0] === "number"), "wrongValueType"); return "boolean"; }
    if (["and", "or", "not"].includes(node.op)) { requireValue(types.every(type => type === "boolean"), "wrongValueType"); return "boolean"; }
    if (node.op === "if") { requireValue(types[0] === "boolean" && types[1] === types[2], "wrongValueType"); return types[1]; }
    requireValue(types.every(type => ["text", "number", "boolean"].includes(type)), "wrongValueType"); return "text";
  }
  return { type: visit(expression, 0, rootScope, seen), dependencies: [...budget.dependencies] };
}

export async function evaluateExpression(node, context, scope, depth = 0) {
  requireValue(depth <= LIMITS.depth && ++context.nodes <= LIMITS.nodes, "expressionLimit");
  if (node.op === "literal") { if (DOCUMENT_TYPES.includes(node.type)) await context.document(node.value, node.type); return node.value; }
  if (node.op === "ref") return context.resolve(node.scope, node.id, depth + 1);
  const run = arg => evaluateExpression(arg, context, scope, depth + 1);
  if (node.op === "if") return run(node.args[await run(node.args[0]) ? 1 : 2]);
  if (node.op === "and") { for (const arg of node.args) if (!await run(arg)) return false; return true; }
  if (node.op === "or") { for (const arg of node.args) if (await run(arg)) return true; return false; }
  const args = [];
  for (const arg of node.args) args.push(await run(arg));
  const [a, b, c] = args;
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

/** Parses a closed expression language. Variable labels are compiled to stable scope/IDs. */
export function parseExpression(text, resolveLabel) {
  requireValue(typeof text === "string" && text.length <= LIMITS.text, "expressionLimit");
  const tokens = []; let offset = 0;
  const pattern = /\s*(?:@\{([^{}]+)\}|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\["\\nrt])*")|(true|false)\b|([A-Za-z][A-Za-z]*)|(<=|>=|==|&&|\|\||[+\-−*×/<>!(),]))/y;
  while (offset < text.length && text.slice(offset).trim()) {
    pattern.lastIndex = offset; const match = pattern.exec(text); requireValue(match, "invalidExpression"); offset = pattern.lastIndex;
    if (match[1]) { const ref = resolveLabel(match[1]); requireValue(ref, "missingVariable"); tokens.push({ node: { op: "ref", scope: ref.scope, id: ref.id } }); }
    else if (match[2]) tokens.push({ node: { op: "literal", type: "number", value: Number(match[2]) } });
    else if (match[3]) { let value; try { value = JSON.parse(match[3]); } catch { throw new ControlError("invalidExpression"); }
      tokens.push({ node: { op: "literal", type: "text", value } }); }
    else if (match[4]) tokens.push({ node: { op: "literal", type: "boolean", value: match[4] === "true" } });
    else tokens.push({ token: match[5] ?? match[6] });
    requireValue(tokens.length <= LIMITS.nodes * 4, "expressionLimit");
  }
  let index = 0, depth = 0;
  const precedence = { "||": 1, "&&": 2, "==": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "−": 5, "*": 6, "×": 6, "/": 6 };
  const ops = { "||": "or", "&&": "and", "==": "equal", "<": "less", ">": "greater", "<=": "lessEqual", ">=": "greaterEqual", "+": "add", "-": "subtract", "−": "subtract", "*": "multiply", "×": "multiply", "/": "divide" };
  const accept = token => tokens[index]?.token === token && (++index, true);
  function parse(minimum = 0) {
    requireValue(++depth <= LIMITS.depth, "expressionLimit"); let left; const next = tokens[index++]; requireValue(next, "invalidExpression");
    if (next.node) left = next.node;
    else if (["-", "−", "!"].includes(next.token)) left = { op: next.token === "!" ? "not" : "subtract", args: next.token === "!" ? [parse(7)] : [{ op: "literal", type: "number", value: 0 }, parse(7)] };
    else if (next.token === "(") { left = parse(); requireValue(accept(")"), "invalidExpression"); }
    else {
      requireValue(["min", "max", "clamp", "round", "floor", "ceil", "abs", "if", "concat", "documentName", "documentUuid"].includes(next.token) && accept("("), "invalidExpression");
      const args = []; if (!accept(")")) { do { args.push(parse()); } while (accept(",")); requireValue(accept(")"), "invalidExpression"); }
      left = { op: next.token, args };
    }
    while (tokens[index]?.token && (precedence[tokens[index].token] ?? -1) >= minimum) {
      const token = tokens[index++].token; left = { op: ops[token], args: [left, parse(precedence[token] + 1)] };
    }
    depth--; return left;
  }
  const expression = parse(); requireValue(index === tokens.length, "invalidExpression"); return expression;
}
export function formatExpression(node, label) {
  if (node.op === "ref") return `@{${label(node.scope, node.id)}}`;
  if (node.op === "literal") return JSON.stringify(node.value);
  if (operatorText[node.op] && node.args.length === 2) return `(${node.args.map(arg => formatExpression(arg, label)).join(` ${operatorText[node.op]} `)})`;
  if (node.op === "not") return `!(${formatExpression(node.args[0], label)})`;
  return `${node.op}(${node.args.map(arg => formatExpression(arg, label)).join(", ")})`;
}
