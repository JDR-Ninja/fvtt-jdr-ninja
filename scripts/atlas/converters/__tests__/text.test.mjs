// Unit tests for the shared bounded-text helper. Run from the module root with:
//   node --test scripts/atlas/converters/__tests__/text.test.mjs
//
// The Atlas server trims names with its own notion of white space before it compares them, and
// that set differs from JavaScript's `trim()` in U+0085 (next line); cutText has to agree with the
// server or two names it reads as one leave here as two and the whole sheet is refused.

import { test } from "node:test";
import assert from "node:assert/strict";

import { cutText } from "../text.js";

test("cutText trims, cuts to the limit in UTF-16 code units and trims again after the cut", () => {
  assert.equal(cutText("  Fusilier  ", 60), "Fusilier");
  assert.equal(cutText("abcdef ghij", 7), "abcdef");
  assert.equal(cutText("x".repeat(80), 60), "x".repeat(60));
  assert.equal(cutText(null, 60), "");
  assert.equal(cutText(undefined, 60), "");
  assert.equal(cutText(12, 60), "12");
});

test("cutText never ends on a lone high surrogate", () => {
  assert.equal(cutText(`${"o".repeat(59)}\u{1F680}`, 60), "o".repeat(59));
  assert.equal(cutText(`${"o".repeat(58)} \u{1F680}`, 60), "o".repeat(58));
});

test("cutText strips U+0085 (next line) at both ends, which String.prototype.trim keeps", () => {
  assert.equal("Fusilier\u0085".trim(), "Fusilier\u0085");
  assert.equal(cutText("Fusilier\u0085", 60), "Fusilier");
  assert.equal(cutText("\u0085Fusilier", 60), "Fusilier");
  assert.equal(cutText(" \u0085 \t\u0085Fusilier\u0085\n ", 60), "Fusilier");
  assert.equal(cutText("\u0085", 60), "");
  assert.equal(cutText(" \u0085 ", 60), "");
});

test("cutText strips a U+0085 that the cut leaves at the end", () => {
  assert.equal(cutText(`${"x".repeat(5)}\u0085${"y".repeat(10)}`, 6), "x".repeat(5));
});

test("cutText keeps U+0085 and other white space inside a name", () => {
  assert.equal(cutText("Fusil\u0085ier", 60), "Fusil\u0085ier");
  assert.equal(cutText("Maître  voleur", 60), "Maître  voleur");
});

test("cutText strips what String.prototype.trim strips (no-break space, ideographic space, line separators)", () => {
  assert.equal(cutText("\u00a0Fusilier\u3000", 60), "Fusilier");
  assert.equal(cutText("\u2028Fusilier\u2029", 60), "Fusilier");
  assert.equal(cutText("\r\nFusilier\r\n", 60), "Fusilier");
});
