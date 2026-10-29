/**
 * Bounded free text, shared by the converters. The Atlas API caps every text field in UTF-16
 * code units, so the cut is a `slice(0, max)` and never a code-point count. Two
 * traps follow from cutting a string that way, both handled here:
 *  - a cut that lands right after a space keeps a trailing space that the server trims before it
 *    compares names without case sensitivity, so two cut names differing only by that
 *    space would collide server-side and the whole sheet be refused: trim again after the cut;
 *  - a cut that lands between the two halves of a surrogate pair leaves a lone high surrogate,
 *    which JSON.stringify writes as `\udXXX` and the server refuses as invalid JSON: drop it.
 *
 * The trim is the server's, not JavaScript's. The server trims every character its platform counts
 * as white space, and that set differs from `String.prototype.trim` in one character: U+0085 (next
 * line), which JavaScript keeps. Left alone, « Fusilier » and « Fusilier\u0085 » would leave here as
 * two names that the server reads as one, and the whole sheet would be refused as a duplicate. The
 * JavaScript set otherwise contains the server's (it also strips U+FEFF, which only merges more).
 */

/** `value` trimmed of the white space of both runtimes (JavaScript's, plus U+0085). */
function trimText(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isSpace(value[start])) start += 1;
  while (end > start && isSpace(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function isSpace(char) {
  return char === "\u0085" || char.trim() === "";
}

/** `value` as trimmed text of at most `max` UTF-16 code units, never ending on a lone surrogate. */
export function cutText(value, max) {
  let text = trimText(String(value ?? "")).slice(0, max);
  if (isHighSurrogate(text.charCodeAt(text.length - 1))) text = text.slice(0, -1);
  return trimText(text);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}
