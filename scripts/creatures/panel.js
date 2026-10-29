import { MODULE_ID, I18N } from "../constants.js";
import { creatureClient } from "./api.js";
import { OPTION_FIELDS, optionErrors, CreatureError } from "./contract.js";
import { importCreature } from "./import.js";
import { compatibilityContext } from "./compatibility.js";
import { creatureState, windowState, control, subscriptionsUrl } from "../ui/states.js";
import { openSingleton, releaseSingleton } from "../ui/window.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const CT = key => game.i18n.localize(`${I18N}.creatures.${key}`);
const creatureMessage = code => CT(`error.${code}`);
const primaryNpc = new Set(["presetId", "speciesId", "challengeRating", "nameGeneratorId"]);
/**
 * Refusals of a generation that also withdraw the access (`CreatureClient.call`): the status line reports them like those
 * of the access check, with the state it gives each.
 */
const ACCESS_REFUSALS = Object.freeze({ tierRequired: "tierRequired", devicePermissionRequired: "devicePermissionRequired",
  unauthorized: "attention", wrongDeviceKind: "attention" });

export class CreaturePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Set();
  static instance = null;
  static KIND = "monster";
  /** One window per generator: the settings menu, the Actors shortcuts, Connections and the API reuse it. */
  static open() {
    if (game.user?.isGM !== true) { ui.notifications.warn(creatureMessage("notGM")); return null; }
    return openSingleton(this);
  }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-creatures", classes: ["jdr-ninja", "jdr-ninja-creatures"], tag: "div",
    window: { title: `${I18N}.creatures.monster`, icon: "fa-solid fa-dragon", resizable: true },
    position: { width: 760, height: 760 },
    actions: {
      check: CreaturePanel.prototype._load,
      generate: CreaturePanel.prototype._generate,
      cancel: CreaturePanel.prototype._cancel,
      dismiss: CreaturePanel.prototype._dismiss,
      create: CreaturePanel.prototype._create,
      sheet: CreaturePanel.prototype._sheet,
      connections: CreaturePanel.prototype._connections,
    },
  };
  /** The content scrolls inside the window while the footer stays: its scroll position survives each render. */
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/creatures.hbs`, scrollable: [".jn-scroll"] } };
  _catalog = null;
  _options = {};
  _controller = null;
  /** The failure of a generation or a creation, shown as an alert; the access and options failure of `_load` is `_loadError`. */
  _error = "";
  _loadError = "";
  /** True only while the access and the options load: a generation in progress is not a verification. */
  _loading = false;
  _fieldErrors = [];
  _preview = null;
  _previewState = null;
  _actor = null;
  _folder = "";
  _name = "";
  _advanced = false;
  _initialized = false;
  _epoch = 0;
  _timer = null;
  get kind() { return this.constructor.KIND; }

  /**
   * The line above the form, or null while everything works: a system that cannot import, a connection that blocks the
   * generators, a verification in progress, or the failure of the access check or of the options load. A failed
   * generation or creation keeps its own alert, except a refusal of the access (subscription, permission, connection):
   * the line reports that one, since it withdrew the access. A failure of the load wins over a grant seen elsewhere,
   * since the options it needs are missing, while a grant seen after a refusal of a generation wins over that refusal;
   * a window that is about to load already reads as checking.
   */
  _status(restriction) {
    const refusal = this._refusal();
    const failure = this._loadError ? { ok: false, reason: this._loadError } : refusal ? { ok: false, reason: refusal } : null;
    const row = creatureState({ compatibility: compatibilityContext(), restriction, access: this._loadError ? null : creatureClient.access,
      result: failure, checking: this._loading || !this._initialized });
    const retry = control("check", game.i18n.localize(`${I18N}.button.retry`), "fa-rotate");
    const status = windowState(row, { retry });
    return status.state === "available" ? null : status;
  }
  /** The refusal of the access that ended the last generation or creation, unless the failure of the load already speaks. */
  _refusal() { return !this._loadError && Object.hasOwn(ACCESS_REFUSALS, this._error) ? this._error : ""; }

  async _prepareContext() {
    const restriction = creatureClient.local();
    const validation = this._catalog ? optionErrors(this._catalog, this._options, this.kind) : [];
    const preset = this._catalog?.constraints.presets?.find(p => p.id === this._options.presetId);
    // The selected role or profile explains itself under its field, and the recommended FP sits under the FP.
    const hint = (field, description) => [description, field === "challengeRating" && preset?.recommendedChallengeRating
      ? `${CT("recommendation")} ${preset.recommendedChallengeRating}` : ""].filter(Boolean).join(" ");
    const fields = this._catalog ? OPTION_FIELDS[this.kind].map(field => {
      const description = this._catalog.choices[field]?.find(choice => choice.id === this._options[field])?.description ?? "";
      return {
        name: field, id: `jn-${this.kind}-${field}`, label: CT(`field.${field}`), value: this._options[field],
        advanced: this.kind === "npc" && !primaryNpc.has(field), boolean: field === "includeSecret",
        error: validation.includes(field) || this._fieldErrors.includes(field),
        choices: (this._catalog.choices[field] ?? []).map(choice => ({ ...choice, selected: choice.id === this._options[field] })),
        description, hint: hint(field, description),
        unavailableSelection: field !== "includeSecret" && !this._catalog.choices[field]?.some(c => c.id === this._options[field]),
      };
    }) : [];
    const delay = Math.ceil(creatureClient.remainingDelay() / 1000);
    const status = this._status(restriction);
    // The status line reports a refusal of the access once: the alert does not repeat it.
    const refusal = this._refusal(), reported = Boolean(refusal && status?.state === ACCESS_REFUSALS[refusal]);
    const preview = this._preview ? {
      name: this._preview.source.name, biography: this._preview.source.biography,
      entries: Object.values(this._preview.source.entries),
      challengeRating: this._preview.resolvedOptions.challengeRating,
      summary: this._preview.source.records.find(row => row.type === "actor"),
      changed: Object.keys(this._options).some(key => this._preview.requestedOptions[key] !== this._options[key]),
    } : null;
    // A denied generation offers the subscriptions link below its alert, unless the status line already offers it.
    return { kind: this.kind, title: CT(this.kind), enabled: creatureClient.enabled(), busy: Boolean(this._controller),
      status, showSubscriptionLink: this._error === "tierRequired" && !status?.step?.link, subscriptionsUrl: subscriptionsUrl("creatures"),
      error: this._error && !reported ? creatureMessage(this._error) : "", delay, cooldown: delay > 0,
      cooldownText: game.i18n.format(`${I18N}.creatures.cooldown`, { seconds: delay }),
      primaryFields: fields.filter(field => !field.advanced), advancedFields: fields.filter(field => field.advanced),
      hasAdvanced: fields.some(field => field.advanced), advanced: this._advanced, hasCatalog: Boolean(this._catalog),
      invalidOptions: validation.length > 0, canGenerate: !restriction && !this._controller && this._catalog && !validation.length && !delay && creatureClient.access?.allowed === true,
      canCreate: Boolean(preview && !restriction && !this._controller && !this._actor), preview,
      imported: Boolean(this._actor), name: this._name, folder: this._folder, worldName: game.world?.title ?? game.world?.id ?? "",
      folders: (game.folders?.contents ?? []).filter(folder => folder.type === "Actor").map(folder => ({ id: folder.id, name: folder.name, selected: folder.id === this._folder })) };
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    CreaturePanel.instances.add(this);
    this.element.querySelectorAll("[data-creature-option]").forEach(input => input.addEventListener("change", () => {
      this._read(); this._fieldErrors = []; if (this._error === "invalidOptions") this._error = "";
      this.render();
    }));
    this.element.querySelector("[data-creature-advanced]")?.addEventListener("toggle", event => { this._advanced = event.currentTarget.open; });
    clearTimeout(this._timer);
    if (creatureClient.remainingDelay()) this._timer = setTimeout(() => { if (this.rendered) { this._read(); this.render(); } }, 1000);
    if (!this._initialized) {
      this._initialized = true;
      if (!creatureClient.local()) queueMicrotask(() => { if (this.rendered) void this._load(); });
    }
  }
  _read() {
    for (const input of this.element?.querySelectorAll("[data-creature-option]") ?? []) this._options[input.name] = input.type === "checkbox" ? input.checked : input.value;
    const name = this.element?.querySelector('[name="importName"]');
    const folder = this.element?.querySelector('[name="importFolder"]');
    if (name) this._name = name.value;
    if (folder) this._folder = folder.value;
  }
  async _run(action, { load = false } = {}) {
    if (this._controller) return;
    this._read();
    const controller = this._controller = new AbortController(), epoch = this._epoch, state = creatureClient.capture();
    this._error = ""; this._fieldErrors = [];
    this._loading = load;
    if (load) this._loadError = "";
    try {
      await this.render();
      if (controller.signal.aborted) return;
      const apply = await action(controller.signal, state);
      if (!controller.signal.aborted && epoch === this._epoch) { creatureClient.assertCurrent(state); apply?.(); }
    } catch (error) {
      if (!controller.signal.aborted && epoch === this._epoch) {
        const code = error instanceof CreatureError ? error.code : "invalidResponse";
        // The access check and the options load report on the status line, a generation or a creation in an alert.
        if (load) this._loadError = code; else this._error = code;
        this._fieldErrors = error.fields ?? [];
      }
    } finally {
      if (this._controller === controller) { this._controller = null; this._loading = false; }
      if (this.rendered) await this.render();
    }
  }
  _load() {
    return this._run(async (signal, state) => {
      await creatureClient.check(signal, state);
      const data = await creatureClient.options(this.kind, signal, state);
      return () => {
        this._catalog = data;
        // Catalog refresh never rewrites an explicit FP or another existing selection.
        this._options = { ...data.defaults, ...this._options };
      };
    }, { load: true });
  }
  _generate() {
    return this._run(async (signal, state) => {
      if (!this._catalog) throw new CreatureError("apiUnavailable");
      const body = creatureClient.makeRequest(this._catalog, this._options, this.kind);
      if (creatureClient.remainingDelay()) throw new CreatureError("rateLimited");
      const result = await creatureClient.generate(this.kind, body, { signal, state });
      return () => this._accept(result, state);
    });
  }
  _accept(result, state) { this._preview = result; this._previewState = state; this._name = result.source.name; this._actor = null; }
  _create() {
    if (!this._preview || this._actor) return;
    return this._run(async signal => {
      const actor = await importCreature(this._preview, { state: this._previewState, folderId: this._folder, name: this._name, signal });
      return () => { this._actor = actor; };
    });
  }
  _sheet() { if (game.user?.isGM === true && this._actor) return this._actor.sheet?.render({ force: true }); }
  _cancel() { this._controller?.abort(); this._error = "cancelled"; }
  _dismiss() { if (this._controller) return; this._preview = null; this._previewState = null; this._actor = null; this.render(); }
  /** The module API opens the `ConnectionPanel.open()` singleton (an import would be circular). */
  _connections() { return game.modules.get(MODULE_ID)?.api?.openConnections(); }
  invalidate() {
    this._epoch++; this._controller?.abort(); this._controller = null; this._loading = false;
    this._catalog = null; this._preview = null; this._previewState = null; this._actor = null;
    this._error = ""; this._loadError = ""; this._initialized = false;
    if (this.rendered) this.render();
  }
  async close(options) {
    this._epoch++; this._controller?.abort(); clearTimeout(this._timer);
    this._preview = null;
    CreaturePanel.instances.delete(this);
    releaseSingleton(this);
    return super.close(options);
  }
}
export class MonsterGeneratorPanel extends CreaturePanel {
  static instance = null;
  static KIND = "monster";
  static DEFAULT_OPTIONS = { ...CreaturePanel.DEFAULT_OPTIONS, id: "jdr-ninja-monsters" };
}
export class NpcGeneratorPanel extends CreaturePanel {
  static instance = null;
  static KIND = "npc";
  static DEFAULT_OPTIONS = { ...CreaturePanel.DEFAULT_OPTIONS, id: "jdr-ninja-npcs",
    window: { ...CreaturePanel.DEFAULT_OPTIONS.window, title: `${I18N}.creatures.npc`, icon: "fa-solid fa-masks-theater" } };
}
