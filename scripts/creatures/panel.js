import { MODULE_ID, I18N, SUBSCRIPTIONS_URL } from "../constants.js";
import { creatureClient } from "./api.js";
import { OPTION_FIELDS, optionErrors, CreatureError } from "./contract.js";
import { importCreature } from "./import.js";
import { compatibilityContext } from "./compatibility.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export const CT = key => game.i18n.localize(`${I18N}.creatures.${key}`);
export const creatureMessage = code => CT(`error.${code}`);
const primaryNpc = new Set(["presetId", "speciesId", "challengeRating", "nameGeneratorId"]);

/** The pill level of every state is derived here, so the template only renders the level it receives. */
export const PILL_ICONS = Object.freeze({ success: "fa-circle-check", warning: "fa-triangle-exclamation", error: "fa-circle-xmark",
  info: "fa-circle-info", neutral: "fa-circle-minus" });
const COMPATIBILITY_LEVELS = Object.freeze({ compatible: "success", versionUnsupported: "warning", dndRequired: "error" });
const ACCESS_LEVELS = Object.freeze({ available: "success", checking: "info", notChecked: "neutral" });
/** Compatible is success, an untested version warns, another game system cannot import at all. */
export const compatibilityLevel = code => COMPATIBILITY_LEVELS[code] ?? "neutral";
/**
 * A clean access state is a pill. Anything else is a message (a restriction, a denial or a failure): it shows once as a
 * notice, and the last failure keeps its own alert instead of repeating here.
 */
export function accessStatus(access, failure = "") {
  const level = ACCESS_LEVELS[access];
  if (level) return { pill: { level, icon: access === "checking" ? "fa-spinner fa-spin" : PILL_ICONS[level], label: CT(`status.${access}`) }, message: "" };
  return { pill: null, message: access === failure ? "" : creatureMessage(access) };
}

export class CreaturePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Set();
  static instance = null;
  static KIND = "monster";
  /** One window per generator: the settings menu, the Actors shortcuts, Connections and the API reuse it. */
  static open() {
    if (game.user?.isGM !== true) { ui.notifications.warn(creatureMessage("notGM")); return null; }
    const panel = this.instance ??= new this();
    if (!panel.rendered) panel.render({ force: true });
    else { if (panel.minimized) void panel.maximize(); panel.bringToFront(); }
    return panel;
  }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-creatures", classes: ["jdr-ninja", "jdr-ninja-creatures"], tag: "div",
    window: { title: `${I18N}.creatures.monster`, icon: "fa-solid fa-dragon", resizable: true },
    position: { width: 740, height: 760 },
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
  _error = "";
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
    const access = restriction ?? (this._controller ? "checking" : this._error || (creatureClient.access?.allowed ? "available" : creatureClient.access?.reason || "notChecked"));
    const preview = this._preview ? {
      name: this._preview.source.name, biography: this._preview.source.biography,
      entries: Object.values(this._preview.source.entries),
      challengeRating: this._preview.resolvedOptions.challengeRating,
      summary: this._preview.source.records.find(row => row.type === "actor"),
      changed: Object.keys(this._options).some(key => this._preview.requestedOptions[key] !== this._options[key]),
    } : null;
    const compatibility = compatibilityContext(), level = compatibilityLevel(compatibility.code);
    return { kind: this.kind, title: CT(this.kind), compatibility: { ...compatibility, level, icon: PILL_ICONS[level] }, enabled: creatureClient.enabled(), busy: Boolean(this._controller),
      subscriptionsUrl: SUBSCRIPTIONS_URL, showSubscriptionLink: creatureClient.needsSubscription(this._error),
      status: accessStatus(access, this._error),
      error: this._error ? creatureMessage(this._error) : "", delay, cooldown: delay > 0,
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
  async _run(action) {
    if (this._controller) return;
    this._read();
    const controller = this._controller = new AbortController(), epoch = this._epoch, state = creatureClient.capture();
    this._error = ""; this._fieldErrors = [];
    try {
      await this.render();
      if (controller.signal.aborted) return;
      const apply = await action(controller.signal, state);
      if (!controller.signal.aborted && epoch === this._epoch) { creatureClient.assertCurrent(state); apply?.(); }
    } catch (error) {
      if (!controller.signal.aborted && epoch === this._epoch) {
        this._error = error instanceof CreatureError ? error.code : "invalidResponse";
        this._fieldErrors = error.fields ?? [];
      }
    } finally {
      if (this._controller === controller) this._controller = null;
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
    });
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
    this._epoch++; this._controller?.abort(); this._controller = null;
    this._catalog = null; this._preview = null; this._previewState = null; this._actor = null;
    this._error = ""; this._initialized = false;
    if (this.rendered) this.render();
  }
  async close(options) {
    this._epoch++; this._controller?.abort(); clearTimeout(this._timer);
    this._preview = null;
    CreaturePanel.instances.delete(this);
    if (this.constructor.instance === this) this.constructor.instance = null;
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
    window: { ...CreaturePanel.DEFAULT_OPTIONS.window, title: `${I18N}.creatures.npc`, icon: "fa-solid fa-user" } };
}
