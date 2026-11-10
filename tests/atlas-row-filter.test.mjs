import { test } from "node:test";
import assert from "node:assert/strict";
import { SCOPE, FOLDER, TARGET_WARNING, defaultFilters, filtersActive, searchKey, folderLabel, folderOptions, sharedLinks,
  linkTarget, linkScope, targetWarnings, rowVisible, describeRow, targetFromLookup, idKey } from "../scripts/atlas/row-filter.js";

const target = (id, campaignId, extra = {}) => ({ id, name: `PC ${id}`, campaignId, campaignName: `Campaign ${campaignId}`, ...extra });

test("the search ignores case and accents, and an empty filter set narrows nothing", () => {
  assert.equal(searchKey("  Élise d'Aubépine "), "elise d'aubepine");
  assert.equal(searchKey(null), "");
  assert.equal(filtersActive(defaultFilters()), false);
  assert.equal(filtersActive({ ...defaultFilters(), query: "   " }), false, "blank search is no filter");
  assert.equal(filtersActive({ ...defaultFilters(), query: "aeg" }), true);
  assert.equal(filtersActive({ ...defaultFilters(), scope: SCOPE.UNLINKED }), true);
  assert.equal(filtersActive({ ...defaultFilters(), folder: "f1" }), true);
});

test("folders read from the top ancestor down, sorted, with « no folder » last only when some actor has none", () => {
  const players = { id: "players", name: "Joueurs", ancestors: [] };
  const old = { id: "old", name: "Anciens", ancestors: [players] };
  assert.equal(folderLabel(old), "Joueurs / Anciens");
  const actors = [{ folder: old }, { folder: players }, { folder: null }, { folder: players }];
  assert.deepEqual(folderOptions(actors, "Sans dossier"), [
    { id: "players", label: "Joueurs" }, { id: "old", label: "Joueurs / Anciens" }, { id: FOLDER.NONE, label: "Sans dossier" }]);
  assert.deepEqual(folderOptions([{ folder: null }], "Sans dossier"), [], "no folder at all: no folder filter");
});

test("two actors on one Atlas character name each other, whatever the id's case", () => {
  const shared = sharedLinks([
    { actorId: "a", name: "Aegis", atlasCharacterId: "019EF0F0-AAAA" },
    { actorId: "b", name: "Aegis (copie)", atlasCharacterId: "019ef0f0-aaaa" },
    { actorId: "c", name: "Brann", atlasCharacterId: "other" },
    { actorId: "d", name: "Free", atlasCharacterId: null },
  ]);
  assert.deepEqual([...shared], [["a", ["Aegis (copie)"]], ["b", ["Aegis"]]]);
});

test("a link is found, missing, or unknown while the lookup is not loaded; its bucket follows the selected campaign", () => {
  const targets = new Map([["pc-1", target("pc-1", "camp-a")]]);
  assert.deepEqual(linkTarget(null, { targets, lookupReady: true }), { state: "none", target: null });
  assert.deepEqual(linkTarget("pc-1", { targets, lookupReady: false }), { state: "unknown", target: null });
  assert.equal(linkTarget("PC-1", { targets, lookupReady: true }).state, "found");
  assert.equal(linkTarget("pc-2", { targets, lookupReady: true }).state, "missing");
  const found = linkTarget("pc-1", { targets, lookupReady: true });
  assert.equal(linkScope(found, "CAMP-A"), SCOPE.CAMPAIGN);
  assert.equal(linkScope(found, "camp-b"), SCOPE.OTHER);
  assert.equal(linkScope(found, ""), SCOPE.OTHER, "no campaign selected: nothing is in « this campaign »");
  assert.equal(linkScope({ state: "missing", target: null }, "camp-a"), SCOPE.OTHER);
  assert.equal(linkScope({ state: "unknown", target: null }, "camp-a"), SCOPE.CAMPAIGN, "an older server keeps the old behaviour");
  assert.equal(linkScope({ state: "none", target: null }, "camp-a"), SCOPE.UNLINKED);
});

test("warnings: a missing character, another campaign (only with a selected campaign) and a shared link", () => {
  const found = { state: "found", target: target("pc-1", "camp-b") };
  assert.deepEqual(targetWarnings(found, { selectedCampaignId: "camp-a" }),
    [{ code: TARGET_WARNING.OTHER_CAMPAIGN, level: "warning", campaign: "Campaign camp-b" }]);
  assert.deepEqual(targetWarnings(found, { selectedCampaignId: "" }), []);
  assert.deepEqual(targetWarnings({ state: "missing", target: null }, { selectedCampaignId: "camp-a", sharedWith: ["Copy"] }), [
    { code: TARGET_WARNING.MISSING, level: "error" }, { code: TARGET_WARNING.SHARED, level: "warning", names: ["Copy"] }]);
  assert.deepEqual(targetWarnings({ state: "unknown", target: null }, { selectedCampaignId: "camp-a" }), []);
});

test("a row passes the search, the link state and the folder together", () => {
  const lookup = { targets: new Map([["pc-1", target("pc-1", "camp-a")]]), lookupReady: true };
  const row = describeRow({ id: "a", name: "Aegis", folder: { id: "players" } },
    { link: { atlasCharacterId: "pc-1" }, lookup, selectedCampaignId: "camp-a" });
  assert.deepEqual([row.linked, row.search, row.folder, row.scope], [true, "aegis", "players", SCOPE.CAMPAIGN]);
  assert(rowVisible(row, defaultFilters()));
  assert(rowVisible(row, { query: "ÉGI", scope: SCOPE.CAMPAIGN, folder: "players" }), "accents and case ignored");
  assert(!rowVisible(row, { query: "brann", scope: SCOPE.ALL, folder: FOLDER.ALL }));
  assert(!rowVisible(row, { query: "", scope: SCOPE.OTHER, folder: FOLDER.ALL }));
  assert(!rowVisible(row, { query: "", scope: SCOPE.ALL, folder: FOLDER.NONE }));
  const loose = describeRow({ id: "b", name: "Brann" }, { link: null, lookup, selectedCampaignId: "camp-a" });
  assert.deepEqual([loose.linked, loose.folder, loose.scope, loose.target, loose.warnings], [false, FOLDER.NONE, SCOPE.UNLINKED, null, []]);
});

test("a lookup item keeps only http(s) addresses and compares ids without case", () => {
  assert.equal(targetFromLookup({ name: "No id" }), null);
  assert.deepEqual(targetFromLookup({ id: "PC-1", name: "Aegis", campaignId: "CAMP", campaignName: "Althar",
    publicUrl: "https://www.jdr.ninja/atlas/campagne/w/c/personnage/aegis", workshopUrl: "javascript:alert(1)" }), {
    id: "pc-1", name: "Aegis", campaignId: "camp", campaignName: "Althar",
    publicUrl: "https://www.jdr.ninja/atlas/campagne/w/c/personnage/aegis", workshopUrl: null });
  assert.equal(targetFromLookup({ id: "x", publicUrl: "not a url" }).publicUrl, null);
  assert.equal(idKey(" AbC "), "abc");
  assert.equal(idKey(42), "");
});
