import { MODULE_ID, SETTINGS, STATUS, localizeStatus, isSyncableActor } from "./constants.js";
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
      this._data = { loading: false, whoami: who.body,
        campaigns: campaigns.ok && Array.isArray(campaigns.body.items) ? campaigns.body.items : [],
        error: campaigns.ok ? null : campaigns.status };
    });
  }

  async _prepareContext() {
    const guard = systemGuard();
    const access = atlasAccess();
    const data = this._data;
    const selected = this.selectedCampaignId;
    const rows = game.actors.filter(a => isSyncableActor(a)).map(actor => {
      const link = getLink(actor);
      const syncedLabel = formatMoment(link?.syncedAtUtc, game.i18n.lang);
      const status = rowStatus({ linked: Boolean(link?.atlasCharacterId), synced: syncedLabel !== null });
      return { actorId: actor.id, name: actor.name, img: actor.img, linked: Boolean(link?.atlasCharacterId),
        status: { ...status, label: game.i18n.localize(ROW_LABELS[status.state]) }, syncedLabel,
        error: this._syncErrors.get(actor.id) ?? null, errorLevel: this._syncLevels.get(actor.id) ?? "warning" };
    });
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
    };
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
    return this._perform(async () => {
      const actor = this._actorFromTarget(target);
      const campaign = this.selectedCampaignId;
      if (!actor) return;
      if (!this._data.campaigns.some(c => c.id === campaign)) { ui.notifications.warn(L("notify.pickCampaign")); return; }
      const result = await createActor(actor, campaign, game.settings.get(MODULE_ID, SETTINGS.markCreatedAsClaimable));
      this._recordRowResult(actor, result);
      notify(result, "JDRNINJA.atlas.notify.created");
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
    });
  }

  _onSyncAll() {
    return this._perform(async stamp => {
      const actors = game.actors.filter(actor => isSyncableActor(actor) && isLinked(actor));
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
