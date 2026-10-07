import { MODULE_ID, SETTINGS, STATUS, localizeStatus } from "./constants.js";
import { AtlasApi, cancelAtlasRequests } from "./api.js";
import { atlasAccess, connectionStamp, canContinue } from "./availability.js";
import { getLink, isLinked, setLink, clearLink } from "./flags.js";
import { pushActor, createActor, notify, resultMessage, portraitMessage } from "./sync.js";
import { portraitLimitMegabytes } from "./converter.js";
import { systemGuard, guardMessage } from "./system-guard.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = key => game.i18n.localize(`JDRNINJA_ATLAS_SYNC.${key}`);

export class AtlasSyncApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-atlas-sync", classes: ["jdr-ninja", "jdr-ninja-atlas"], tag: "div",
    window: { title: "JDRNINJA_ATLAS_SYNC.app.title", icon: "fa-solid fa-globe", resizable: true },
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
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/atlas-sync.hbs`, scrollable: [".atlas-sync__rows"] } };
  _data = { loading: true, whoami: null, campaigns: [], error: null };
  /** actorId → the warning shown on that row: a failed sync, or a sync that left the portrait out. */
  _syncErrors = new Map();
  _busy = false;
  _closed = false;

  static open() {
    const access = atlasAccess();
    if (!access.ok) { notify(access); return null; }
    const app = this._instance ??= new this();
    if (app.rendered && !app._closed) { app.bringToFront(); return app; }
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
      this._syncErrors.clear();
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
    const rows = game.actors.filter(a => a.type === "character").map(actor => {
      const link = getLink(actor);
      return { actorId: actor.id, name: actor.name, img: actor.img, linked: Boolean(link?.atlasCharacterId),
        syncedLabel: link?.syncedAtUtc ? new Date(link.syncedAtUtc).toLocaleString() : null,
        error: this._syncErrors.get(actor.id) ?? null };
    });
    return {
      guardMessage: !guard.ok ? guardMessage(guard) : !access.ok ? localizeStatus(access.status) : null,
      loading: data.loading, busy: this._busy,
      error: data.error ? localizeStatus(data.error) : null,
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
    return actor?.type === "character" ? actor : null;
  }

  /** Records the row warning for a sync result: its error, a portrait left out, or nothing. */
  _recordRowResult(actor, result) {
    const message = result.ok ? portraitMessage(result) : resultMessage(result);
    if (message) this._syncErrors.set(actor.id, message);
    else this._syncErrors.delete(actor.id);
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
      notify(result, "JDRNINJA_ATLAS_SYNC.notify.created");
    });
  }

  _onUnlink(_event, target) {
    return this._perform(async () => {
      const actor = this._actorFromTarget(target);
      if (!actor) return;
      await clearLink(actor);
      this._syncErrors.delete(actor.id);
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
      const actors = game.actors.filter(actor => actor.type === "character" && isLinked(actor));
      if (!actors.length) { ui.notifications.info(L("notify.nothingLinked")); return; }
      const progress = ui.notifications.info(L("app.loading"), { progress: true });
      let ok = 0;
      const failures = [];
      const portraitsLeftOut = [];
      this._syncErrors.clear();
      try {
        for (let i = 0; i < actors.length; i++) {
          if (this._closed || !canContinue(stamp).ok) { ui.notifications.warn(L("status.OPERATION_CANCELLED")); return; }
          const actor = actors[i];
          progress?.update?.({ pct: i / actors.length,
            message: game.i18n.format("JDRNINJA_ATLAS_SYNC.notify.batchProgress", { name: actor.name, current: i + 1, total: actors.length }) });
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
        ui.notifications[failures.length ? "warn" : "info"](game.i18n.format(`JDRNINJA_ATLAS_SYNC.${key}`,
          { ok, failed: failures.length, names: failures.join(", ") }));
        if (portraitsLeftOut.length) {
          ui.notifications.warn(game.i18n.format("JDRNINJA_ATLAS_SYNC.notify.batchPortraitTooLarge",
            { count: portraitsLeftOut.length, names: portraitsLeftOut.join(", "), size: portraitLimitMegabytes() }));
        }
      } finally { progress?.update?.({ pct: 1 }); }
    });
  }

  async close(options) {
    this._closed = true;
    if (AtlasSyncApp._instance === this) AtlasSyncApp._instance = null;
    cancelAtlasRequests();
    return super.close(options);
  }
}
