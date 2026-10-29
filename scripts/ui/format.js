/**
 * A moment in Foundry's language, short and without seconds (for instance "Oct 8, 2026, 7:30 PM" in English). Returns
 * null for a missing or unreadable value, so a window shows nothing instead of "Invalid Date".
 */
export function formatMoment(value, locale, { timeZone } = {}) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const options = { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) };
  try { return new Intl.DateTimeFormat(locale, options).format(date); }
  catch { return new Intl.DateTimeFormat(undefined, options).format(date); }
}
