/**
 * The Atlas window's view filters and link checks, kept free of Foundry globals so the window and the tests share
 * one definition. A row is described once (`describeRow`); the window renders the description, the name search
 * re-applies `rowVisible` to it without a redraw, and « Sync all » syncs the linked rows it keeps visible.
 */

/** The link-state filter. `campaign`: linked to a character of the selected campaign; `other`: linked elsewhere. */
export const SCOPE = { ALL: "all", CAMPAIGN: "campaign", OTHER: "other", UNLINKED: "unlinked" };

/** The folder filter's two fixed values; any other value is a Foundry folder id. */
export const FOLDER = { ALL: "all", NONE: "none" };

/** What a linked row says about its Atlas character, besides its name and campaign. */
export const TARGET_WARNING = { OTHER_CAMPAIGN: "otherCampaign", MISSING: "missing", SHARED: "shared" };

export function defaultFilters() {
  return { query: "", scope: SCOPE.ALL, folder: FOLDER.ALL };
}

/** True when a filter narrows the list, i.e. the footer action no longer covers every linked character. */
export function filtersActive(filters) {
  return Boolean(searchKey(filters?.query)) || (filters?.scope ?? SCOPE.ALL) !== SCOPE.ALL
    || (filters?.folder ?? FOLDER.ALL) !== FOLDER.ALL;
}

/** Case- and accent-insensitive search text: « Élise » is found with « elise ». */
export function searchKey(text) {
  return String(text ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

/** The folder of an actor as the filter stores it: its id, or FOLDER.NONE. */
export function folderKey(actor) {
  return actor?.folder?.id ?? FOLDER.NONE;
}

/** « Parent / Child » for a nested folder; Foundry lists `ancestors` from the direct parent upward. */
export function folderLabel(folder) {
  const ancestors = Array.isArray(folder?.ancestors) ? [...folder.ancestors].reverse() : [];
  return [...ancestors, folder].map(entry => entry?.name ?? "").filter(Boolean).join(" / ");
}

/**
 * The folder choices of the actors on the list, sorted by label, then « No folder » last when some actor has none.
 * `noFolderLabel` is the localized label of that last choice.
 */
export function folderOptions(actors, noFolderLabel) {
  const folders = new Map();
  let loose = false;
  for (const actor of actors) {
    if (actor?.folder?.id) folders.set(actor.folder.id, folderLabel(actor.folder));
    else loose = true;
  }
  const options = [...folders].map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
  if (loose && options.length) options.push({ id: FOLDER.NONE, label: noFolderLabel });
  return options;
}

/** The comparison key of an Atlas character id: ids are compared without regard to case. */
export function idKey(id) {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

/** An http(s) address, or null: a lookup answer never puts another scheme into a link. */
function webAddress(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

/** One lookup item as the window keeps it, or null when it has no usable id. */
export function targetFromLookup(item) {
  const id = idKey(item?.id);
  if (!id) return null;
  const text = value => (typeof value === "string" ? value : "");
  return {
    id, name: text(item.name), campaignId: idKey(item.campaignId), campaignName: text(item.campaignName),
    publicUrl: webAddress(item.publicUrl), workshopUrl: webAddress(item.workshopUrl),
  };
}

/**
 * actorId → the names of the other actors linked to the same Atlas character. A duplicated actor keeps the link of
 * its original, so two actors then write to one Atlas character.
 */
export function sharedLinks(entries) {
  const byTarget = new Map();
  for (const { actorId, name, atlasCharacterId } of entries) {
    const key = idKey(atlasCharacterId);
    if (!key) continue;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push({ actorId, name });
  }
  const shared = new Map();
  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    for (const { actorId } of group) {
      shared.set(actorId, group.filter(other => other.actorId !== actorId).map(other => other.name));
    }
  }
  return shared;
}

/**
 * Where a link points, from the lookup's answer. `targets` maps an Atlas character id (`idKey`) to its lookup item;
 * while `lookupReady` is false (lookup not loaded, or a server without it) nothing is known and a linked row counts
 * as linked to the selected campaign, as it did before the lookup existed.
 */
export function linkTarget(atlasCharacterId, { targets, lookupReady } = {}) {
  const key = idKey(atlasCharacterId);
  if (!key) return { state: "none", target: null };
  if (!lookupReady) return { state: "unknown", target: null };
  const target = targets?.get(key) ?? null;
  return target ? { state: "found", target } : { state: "missing", target: null };
}

/** The link-state bucket of a row: unlinked, linked to the selected campaign, or linked elsewhere (or to nothing). */
export function linkScope(link, selectedCampaignId) {
  if (link.state === "none") return SCOPE.UNLINKED;
  if (link.state === "unknown") return SCOPE.CAMPAIGN;
  if (link.state === "missing") return SCOPE.OTHER;
  const selected = idKey(selectedCampaignId);
  return selected && link.target.campaignId === selected ? SCOPE.CAMPAIGN : SCOPE.OTHER;
}

/**
 * The warnings a linked row carries, most serious first, each with its notice level. A campaign mismatch needs a
 * selected campaign to mean anything.
 */
export function targetWarnings(link, { selectedCampaignId, sharedWith = [] }) {
  const warnings = [];
  const selected = idKey(selectedCampaignId);
  if (link.state === "missing") warnings.push({ code: TARGET_WARNING.MISSING, level: "error" });
  if (link.state === "found" && selected && link.target.campaignId !== selected) {
    warnings.push({ code: TARGET_WARNING.OTHER_CAMPAIGN, level: "warning", campaign: link.target.campaignName });
  }
  if (link.state !== "none" && sharedWith.length) warnings.push({ code: TARGET_WARNING.SHARED, level: "warning", names: sharedWith });
  return warnings;
}

/** True when the row passes the three filters. `row` carries `search`, `scope` and `folder`, as `describeRow` builds it. */
export function rowVisible(row, filters) {
  const query = searchKey(filters?.query);
  if (query && !row.search.includes(query)) return false;
  const scope = filters?.scope ?? SCOPE.ALL;
  if (scope !== SCOPE.ALL && row.scope !== scope) return false;
  const folder = filters?.folder ?? FOLDER.ALL;
  if (folder !== FOLDER.ALL && row.folder !== folder) return false;
  return true;
}

/**
 * Everything the filters and the link checks need about one actor. `link` is the actor's Atlas link flag (or null),
 * `lookup` the `{ targets, lookupReady }` pair of the window, `sharedWith` the names `sharedLinks` gave it.
 */
export function describeRow(actor, { link, lookup, selectedCampaignId, sharedWith = [] }) {
  const atlasCharacterId = link?.atlasCharacterId ?? null;
  const target = linkTarget(atlasCharacterId, lookup);
  return {
    actorId: actor.id,
    linked: Boolean(atlasCharacterId),
    search: searchKey(actor.name),
    folder: folderKey(actor),
    scope: linkScope(target, selectedCampaignId),
    target: target.target,
    warnings: targetWarnings(target, { selectedCampaignId, sharedWith }),
  };
}
