/**
 * Bounded free text, shared by the converters. The Atlas API caps every text field in UTF-16
 * code units, so the cut is a `slice(0, max)` and never a code-point count. Two
 * traps follow from cutting a string that way, both handled here:
 *  - a cut that lands right after a space keeps a trailing space that the server trims before it
 *    compares names without case sensitivity, so two cut names differing only by that
 *    space would collide server-side and the whole sheet be refused: trim again after the cut;
 *  - a cut that lands between the two halves of a surrogate pair leaves a lone high surrogate,
 *    which JSON.stringify writes as `\udXXX` and the server refuses as invalid JSON: drop it.
 */

/** `value` as trimmed text of at most `max` UTF-16 code units, never ending on a lone surrogate. */
export function cutText(value, max) {
  let text = String(value ?? "").trim().slice(0, max);
  if (isHighSurrogate(text.charCodeAt(text.length - 1))) text = text.slice(0, -1);
  return text.trim();
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}
