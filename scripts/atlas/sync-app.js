import { MODULE_ID, SETTINGS, STATUS, LOOKUP_BATCH, localizeStatus, isSyncableActor } from "./constants.js";
import { SCOPE, FOLDER, TARGET_WARNING, defaultFilters, filtersActive, folderOptions, sharedLinks, describeRow,
  rowVisible, targetFromLookup } from "./row-filter.js";
import { AtlasApi, cancelAtlasRequests } from "./api.js";
import { atlasAccess, connectionStamp, canContinue } from "./availability.js";
import { getLink, isLinked, setLink, clearLink } from "./flags.js";
import { pushActor, createActor, notify, resultMessage, portraitMessage } from "./sync.js";
import { portraitLimitMegabytes } from "./converter.js";
import { systemGuard, guardMessage } from "./system-guard.js";
import { PILL_ICONS, PROGRESS_ICON } from "../ui/states.js";
import { releaseSingleton } from "../ui/window.js";
import { formatMoment } from "../ui/format.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = key => game.i18n.localize(`JDRNINJA.atlas.${key}`);

const ROW_LABELS = { synced: "JDRNINJA.atlas.row.synced", linked: "JDRNINJA.atlas.row.linked",
  unlinked: "JDRNINJA.atlas.row.unlinked" };
/** The header names the connection only while it is not made: connected is the normal state and has no pill. */
const CONNECTION_LABELS = { loading: "JDRNINJA.atlas.app.loading", disconnected: "JDRNINJA.status.disconnected" };

/**
 * The pill of a character row, from its link alone: synced (with a date), linked but never synced, or not linked.
 * Levels are the shared pill levels: `success`, `warning`, `error`, `info` and `neutral`.
 */
export function rowStatus({ linked, synced }) {
  if (!linked) return { state: "unlinked", level: "neutral", icon: "fa-link-slash" };
  if (synced) return { state: "synced", level: "success", icon: PILL_ICONS.success };
  return { state: "linked", level: "info", icon: "fa-link" };
}

/**
 * The state of the connection to Atlas, for the window header. `failed` means the last request came back with an error.
 * Only `loading` and `disconnected` get a pill: a connected window shows the world instead.
 */
export function connectionStatus({ connected, loading, failed }) {
  if (connected) return { state: "connected", level: "success", icon: PILL_ICONS.success };
  if (loading) return { state: "loading", level: "info", icon: PROGRESS_ICON };
  const level = failed ? "error" : "neutral";
  return { state: "disconnected", level, icon: PILL_ICONS[level] };
}

export class AtlasSyncApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-atlas-sync", classes: ["jdr-ninja", "jdr-ninja-atlas"], tag: "div",
    window: { title: "JDRNINJA.atlas.app.title", icon: "fa-solid fa-globe", resizable: true },
    position: { width: 760, height: 680 },
    actions: {
      refresh: AtlasSyncApp.prototype.loadData,
      sync: AtlasSyncApp.prototype._onSync,
      unlink: AtlasSyncApp.prototype._onUnlink,
      create: AtlasSyncApp.prototype._onCreate,
      link: AtlasSyncApp.prototype._onLink,
      syncAll: AtlasSyncApp.prototype._onSyncAll,
    },
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/atlas-sync.hbs`, scrollable: [".jn-scroll"] } };
  _data = { loading: true, whoami: null, campaigns: [], error: null };
  /** actorId → the warning shown on that row: a failed sync, or a sync that left the portrait out. */
  _syncErrors = new Map();
  /** actorId → the level of that row's message: `error` for a failed sync, `warning` for a portrait left out. */
  _syncLevels = new Map();
  /** The view filters: name search, link state and Foundry folder. They narrow the list and « Sync all », nothing else. */
  _filters = defaultFilters();
  /** Atlas character id → its lookup item; `lookupReady` stays false until a lookup succeeds (or with an older server). */
  _lookup = { targets: new Map(), lookupReady: false };
  _busy = false;
  _closed = false;

  /** The one window, like the other windows' `openSingleton`, but it loads its data once rendered, and only for a GM who can sync. */
  static open() {
    const access = atlasAccess();
    if (!access.ok) { notify(access); return null; }
    const app = this.instance ??= new this();
    if (app.rendered && !app._closed) { if (app.minimized) void app.maximize(); app.bringToFront(); return app; }
    app._closed = false;
    Promise.resolve(app.render({ force: true })).then(() => app.loadData())
      .catch(() => ui.notifications.warn(L("status.UNKNOWN")));
    return app;
  }

  get selectedCampaignId() { return game.settings.get(MODULE_ID, SETTINGS.campaignId) ?? ""; }

  async _perform(action) {
    if (this._busy || this._closed) return;
    const access = atlasAccess();
    if (!access.ok) { notify(access); return; }
    const stamp = connectionStamp();
    this._busy = true;
    try {
      await this.render();
      if (this._closed || !canContinue(stamp).ok) return;
      await action(stamp);
    } catch {
      this._data.loading = false;
      this._data.error = STATUS.VALIDATION_FAILED;
      ui.notifications.warn(L("status.VALIDATION_FAILED"));
    } finally {
      this._busy = false;
      if (this.rendered && !this._closed) await this.render();
    }
  }

  loadData() {
    return this._perform(async stamp => {
      this._data = { loading: true, whoami: null, campaigns: [], error: null };
      this._forgetRowMessages();
      const who = await AtlasApi.whoami();
      if (!who.ok) { this._data = { loading: false, whoami: null, campaigns: [], error: who.status }; return; }
      if (!canContinue(stamp).ok || this._closed) return;
      if (!who.body.tier?.allowed) {
        this._data = { loading: false, whoami: who.body, campaigns: [], error: null }; return;
      }
      const campaigns = await AtlasApi.campaigns();
      if (!canContinue(stamp).ok || this._closed) return;
      if (!(await this._loadTargets(stamp))) return;
      this._data = { loading: false, whoami: who.body,
        campaigns: campaigns.ok && Array.isArray(campaigns.body.items) ? campaigns.body.items : [],
        error: campaigns.ok ? null : campaigns.status };
    });
  }

  /**
   * Resolves the Atlas characters the actors are linked to, LOOKUP_BATCH ids per request. A failed lookup (an older
   * server, a network error) leaves the links unresolved without an error: the rows then show no Atlas line, as
   * before. Returns false when the operation was cancelled meanwhile.
   */
  async _loadTargets(stamp) {
    const ids = [...new Set(game.actors.filter(actor => isSyncableActor(actor))
      .map(actor => getLink(actor)?.atlasCharacterId).filter(id => typeof id === "string" && id.trim()))];
    const targets = new Map();
    for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
      const result = await AtlasApi.lookup(ids.slice(start, start + LOOKUP_BATCH));
      if (!canContinue(stamp).ok || this._closed) return false;
      if (!result.ok || !Array.isArray(result.body?.items)) {
        this._lookup = { targets: new Map(), lookupReady: false };
        return true;
      }
      for (const item of result.body.items) {
        const target = targetFromLookup(item);
        if (target) targets.set(target.id, target);
      }
    }
    this._lookup = { targets, lookupReady: true };
    return true;
  }

  /** Every player-character actor, with its link and what the filters and the link checks know about it. */
  _rowModels() {
    const selectedCampaignId = this.selectedCampaignId;
    const entries = game.actors.filter(actor => isSyncableActor(actor)).map(actor => ({ actor, link: getLink(actor) }));
    const shared = sharedLinks(entries.map(({ actor, link }) =>
      ({ actorId: actor.id, name: actor.name, atlasCharacterId: link?.atlasCharacterId })));
    return entries.map(({ actor, link }) => ({ actor, link,
      ...describeRow(actor, { link, lookup: this._lookup, selectedCampaignId, sharedWith: shared.get(actor.id) ?? [] }) }));
  }

  /** The localized sentence of one link warning. */
  _warningText(warning) {
    if (warning.code === TARGET_WARNING.MISSING) return L("target.missing");
    if (warning.code === TARGET_WARNING.OTHER_CAMPAIGN) {
      return game.i18n.format("JDRNINJA.atlas.target.otherCampaign", { campaign: warning.campaign });
    }
    return game.i18n.format("JDRNINJA.atlas.target.shared", { names: warning.names.join(", ") });
  }

  async _prepareContext() {
    const guard = systemGuard();
    const access = atlasAccess();
    const data = this._data;
    const selected = this.selectedCampaignId;
    const filters = this._filters;
    const models = this._rowModels();
    const rows = models.map(model => {
      const { actor, link } = model;
      const syncedLabel = formatMoment(link?.syncedAtUtc, game.i18n.lang);
      const status = rowStatus({ linked: model.linked, synced: syncedLabel !== null });
      return { actorId: actor.id, name: actor.name, img: actor.img, linked: model.linked,
        status: { ...status, label: game.i18n.localize(ROW_LABELS[status.state]) }, syncedLabel,
        error: this._syncErrors.get(actor.id) ?? null, errorLevel: this._syncLevels.get(actor.id) ?? "warning",
        search: model.search, scope: model.scope, folder: model.folder, hidden: !rowVisible(model, filters),
        target: model.target, warnings: model.warnings.map(warning => ({ level: warning.level, text: this._warningText(warning) })) };
    });
    const syncCount = rows.filter(row => row.linked && !row.hidden).length;
    const scopes = [SCOPE.ALL, SCOPE.CAMPAIGN, SCOPE.OTHER, SCOPE.UNLINKED].map(value =>
      ({ value, label: L(`filter.scope.${value}`), selected: value === filters.scope }));
    const folders = folderOptions(models.map(model => model.actor), L("filter.folderNone"));
    const connection = connectionStatus({ connected: Boolean(data.whoami), loading: data.loading, failed: Boolean(data.error) });
    return {
      guardMessage: !guard.ok ? guardMessage(guard) : !access.ok ? localizeStatus(access.status) : null,
      loading: data.loading, busy: this._busy,
      error: data.error ? localizeStatus(data.error) : null,
      connection: connection.state === "connected" ? null : { ...connection, label: game.i18n.localize(CONNECTION_LABELS[connection.state]) },
      connected: Boolean(data.whoami), worldName: data.whoami?.world?.name ?? "",
      tierAllowed: data.whoami?.tier?.allowed === true,
      systemLabel: `${game.system.title ?? game.system.id} · v${game.system.version}`,
      campaigns: data.campaigns.map(c => ({ id: c.id, name: c.name, count: c.characterCount, selected: c.id === selected })),
      hasCampaign: data.campaigns.some(c => c.id === selected),
      markClaimable: game.settings.get(MODULE_ID, SETTINGS.markCreatedAsClaimable) === true,
      rows, canWrite: access.ok && !this._busy && data.whoami?.tier?.allowed === true,
      filters: { query: filters.query, scopes,
        folders: folders.length ? [{ id: FOLDER.ALL, label: L("filter.folderAll"), selected: filters.folder === FOLDER.ALL },
          ...folders.map(folder => ({ ...folder, selected: folder.id === filters.folder }))] : [] },
      filtersActive: filtersActive(filters), syncCount,
      filteredEmpty: rows.length > 0 && rows.every(row => row.hidden),
    };
  }

  /**
   * Re-applies the filters to the rendered rows without a redraw (the search field keeps its focus and caret), then
   * updates the footer's label and count and the empty-list message.
   */
  _applyFilters() {
    const root = this.element;
    if (!root) return;
    const rows = [...root.querySelectorAll(".jn-atlas-row[data-actor-id]")];
    let shown = 0, linked = 0;
    for (const row of rows) {
      const { search = "", scope = "", folder = "" } = row.dataset;
      row.hidden = !rowVisible({ search, scope, folder }, this._filters);
      if (!row.hidden) { shown++; if (row.dataset.linked === "true") linked++; }
    }
    const active = filtersActive(this._filters);
    for (const label of root.querySelectorAll("[data-sync-label]")) {
      label.hidden = (label.dataset.syncLabel === "shown") !== active;
    }
    const count = root.querySelector("[data-sync-count]");
    if (count) count.textContent = String(linked);
    const empty = root.querySelector("[data-filter-empty]");
    if (empty) empty.hidden = !(rows.length > 0 && shown === 0);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    root.querySelector('[data-control="campaign"]')?.addEventListener("change", async event => {
      if (this._busy || !atlasAccess().ok) return;
      await game.settings.set(MODULE_ID, SETTINGS.campaignId, event.currentTarget.value);
      await this.render();
    });
    root.querySelector('[data-control="claimable"]')?.addEventListener("change", async event => {
      if (this._busy || !atlasAccess().ok) return;
      await game.settings.set(MODULE_ID, SETTINGS.markCreatedAsClaimable, event.currentTarget.checked);
    });
    // The filters only change what is shown: they work while a sync runs and never redraw the window.
    root.querySelector('[data-control="search"]')?.addEventListener("input", event => {
      this._filters = { ...this._filters, query: event.currentTarget.value };
      this._applyFilters();
    });
    for (const [control, key] of [["scope", "scope"], ["folder", "folder"]]) {
      root.querySelector(`[data-control="${control}"]`)?.addEventListener("change", event => {
        this._filters = { ...this._filters, [key]: event.currentTarget.value };
        this._applyFilters();
      });
    }
  }

  _actorFromTarget(target) {
    const id = target.closest("[data-actor-id]")?.dataset.actorId;
    const actor = id ? game.actors.get(id) : null;
    return isSyncableActor(actor) ? actor : null;
  }

  /** Records the row warning for a sync result: its error, a portrait left out, or nothing. */
  _recordRowResult(actor, result) {
    const message = result.ok ? portraitMessage(result) : resultMessage(result);
    if (message) {
      this._syncErrors.set(actor.id, message);
      this._syncLevels.set(actor.id, result.ok ? "warning" : "error");
    } else this._forgetRowMessages(actor.id);
  }

  /** Drops the message of one row, or of every row. */
  _forgetRowMessages(actorId) {
    if (actorId === undefined) { this._syncErrors.clear(); this._syncLevels.clear(); return; }
    this._syncErrors.delete(actorId);
    this._syncLevels.delete(actorId);
  }

  _onSync(_event, target) {
    return this._perform(async () => {
      const actor = this._actorFromTarget(target);
      if (!actor) return;
      const result = await pushActor(actor);
      this._recordRowResult(actor, result);
      notify(result);
    });
  }

  _onCreate(_event, target) {
    return this._perform(async stamp => {
      const actor = this._actorFromTarget(target);
      const campaign = this.selectedCampaignId;
      if (!actor) return;
      if (!this._data.campaigns.some(c => c.id === campaign)) { ui.notifications.warn(L("notify.pickCampaign")); return; }
      const result = await createActor(actor, campaign, game.settings.get(MODULE_ID, SETTINGS.markCreatedAsClaimable));
      this._recordRowResult(actor, result);
      notify(result, "JDRNINJA.atlas.notify.created");
      if (result.ok && this._lookup.lookupReady) await this._loadTargets(stamp);
    });
  }

  _onUnlink(_event, target) {
    return this._perform(async () => {
      const actor = this._actorFromTarget(target);
      if (!actor) return;
      await clearLink(actor);
      this._forgetRowMessages(actor.id);
      ui.notifications.info(L("notify.unlinked"));
    });
  }

  _onLink(_event, target) {
    return this._perform(async stamp => {
      const actor = this._actorFromTarget(target);
      const campaign = this.selectedCampaignId;
      if (!actor) return;
      if (!this._data.campaigns.some(c => c.id === campaign)) { ui.notifications.warn(L("notify.pickCampaign")); return; }
      const items = [];
      for (let page = 1; ; page++) {
        const list = await AtlasApi.characters(campaign, { page, pageSize: 200 });
        if (!list.ok) { notify(list); return; }
        if (!canContinue(stamp).ok || this._closed) return;
        if (!Array.isArray(list.body.items) || !Number.isFinite(list.body.total)) throw new Error("Invalid character page");
        items.push(...list.body.items);
        if (items.length >= list.body.total || list.body.items.length === 0) break;
      }
      if (!items.length) { ui.notifications.info(L("notify.noCharacters")); return; }
      const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
      const options = items.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join("");
      const chosen = await foundry.applications.api.DialogV2.prompt({
        window: { title: L("dialog.linkTitle") },
        content: `<div class="form-group"><label>${escape(L("dialog.linkLabel"))}</label><select name="pc">${options}</select></div>`,
        ok: { label: L("dialog.linkConfirm"), callback: (_event, button) => button.form.elements.pc.value },
        rejectClose: false,
      });
      if (!chosen || this._closed || !canContinue(stamp).ok || this.selectedCampaignId !== campaign) return;
      if (!items.some(item => item.id === chosen)) return;
      await setLink(actor, chosen);
      ui.notifications.info(L("notify.linked"));
      if (this._lookup.lookupReady) await this._loadTargets(stamp);
    });
  }

  _onSyncAll() {
    return this._perform(async stamp => {
      // The linked characters the filters show: with no filter, every linked character.
      const shown = new Set(this._rowModels().filter(model => model.linked && rowVisible(model, this._filters))
        .map(model => model.actorId));
      const actors = game.actors.filter(actor => isSyncableActor(actor) && isLinked(actor) && shown.has(actor.id));
      if (!actors.length) { ui.notifications.info(L("notify.nothingLinked")); return; }
      const progress = ui.notifications.info(L("app.loading"), { progress: true });
      let ok = 0;
      const failures = [];
      const portraitsLeftOut = [];
      this._forgetRowMessages();
      try {
        for (let i = 0; i < actors.length; i++) {
          if (this._closed || !canContinue(stamp).ok) { ui.notifications.warn(L("status.OPERATION_CANCELLED")); return; }
          const actor = actors[i];
          progress?.update?.({ pct: i / actors.length,
            message: game.i18n.format("JDRNINJA.atlas.notify.batchProgress", { name: actor.name, current: i + 1, total: actors.length }) });
          const result = await pushActor(actor);
          if (this._closed || !canContinue(stamp).ok) { ui.notifications.warn(L("status.OPERATION_CANCELLED")); return; }
          this._recordRowResult(actor, result);
          if (!result.ok) failures.push(actor.name);
          else {
            ok++;
            if (portraitMessage(result)) portraitsLeftOut.push(actor.name);
          }
        }
        const key = failures.length ? "notify.batchDoneErrors" : "notify.batchDone";
        ui.notifications[failures.length ? "warn" : "info"](game.i18n.format(`JDRNINJA.atlas.${key}`,
          { ok, failed: failures.length, names: failures.join(", ") }));
        if (portraitsLeftOut.length) {
          ui.notifications.warn(game.i18n.format("JDRNINJA.atlas.notify.batchPortraitTooLarge",
            { count: portraitsLeftOut.length, names: portraitsLeftOut.join(", "), size: portraitLimitMegabytes() }));
        }
      } finally { progress?.update?.({ pct: 1 }); }
    });
  }

  async close(options) {
    this._closed = true;
    releaseSingleton(this);
    cancelAtlasRequests();
    return super.close(options);
  }
}
