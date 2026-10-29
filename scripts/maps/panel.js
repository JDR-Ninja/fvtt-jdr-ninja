import { MODULE_ID, I18N } from "../constants.js";
import { MapError } from "./errors.js";
import { summarize } from "./description.js";
import { defaultFolder, normalizeFolder } from "./translate.js";
import { ARCHIVE_LIMITS, readMapArchive } from "./zip.js";
import { importMap, missingFilePermission } from "./import.js";
import { openSingleton, releaseSingleton } from "../ui/window.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
/** A localized string of this window; the second argument fills its `{placeholders}`. */
export const MT = (key, data) => data ? game.i18n.format(`${I18N}.maps.${key}`, data) : game.i18n.localize(`${I18N}.maps.${key}`);

/**
 * The text a failure shows, and the files already uploaded when it came after the upload began. The technical `detail` of
 * a rejected description (the path of the offending value) is not part of the message: it goes to the console.
 */
export function describeFailure(error) {
  const failure = error instanceof MapError ? error : new MapError("unknown", {}, error);
  const { uploaded = [], ...values } = failure.details;
  if (values.detail !== undefined) console.warn(`${MODULE_ID} | Map import: ${failure.code}: ${values.detail}`);
  return { message: MT(`error.${failure.code}`, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]))), uploaded };
}

/** The progress bar counts the folder, each image and the scene: levels + 2 steps. */
export function progressState(state, levels) {
  const max = levels + 2;
  if (state.step === "upload") return { max, value: state.current, text: MT("progress.upload", { current: state.current, total: state.total, file: state.file }) };
  if (state.step === "scene") return { max, value: levels + 1, text: MT("progress.scene") };
  return { max, value: 0, text: MT("progress.folder") };
}

export class MapImportPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;
  /** One window, for a GM only: the Scenes directory button and the module API reuse it. */
  static open() {
    if (game.user?.isGM !== true) { ui.notifications.warn(MT("error.notGM")); return null; }
    return openSingleton(this);
  }
  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-map-import", classes: ["jdr-ninja", "jdr-ninja-maps"], tag: "div",
    window: { title: `${I18N}.maps.title`, icon: "fa-solid fa-map", resizable: true },
    position: { width: 600, height: 540 },
    actions: {
      import: MapImportPanel.prototype._import,
      clear: MapImportPanel.prototype._clear,
      another: MapImportPanel.prototype._clear,
      view: MapImportPanel.prototype._view,
    },
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/maps.hbs`, scrollable: [".jn-scroll"] } };

  _archive = null;
  _fileName = "";
  _folder = "";
  _folderEdited = false;
  _failure = null;
  _busy = false;
  _progress = null;
  _result = null;
  _warnings = [];

  async _prepareContext() {
    const gm = game.user?.isGM === true, missing = gm ? missingFilePermission(game.user) : null;
    const summary = this._archive ? summarize(this._archive.carte) : null;
    const folderValid = Boolean(normalizeFolder(this._folder));
    return {
      isDone: Boolean(this._result), hasArchive: Boolean(this._archive), busy: this._busy,
      permissionMessage: !gm ? MT("error.notGM") : missing ? MT(`error.${missing}`) : "",
      mapName: summary?.name || this._fileName, fileName: this._fileName,
      rows: summary ? [
        { label: MT("summary.levels"), value: summary.levels }, { label: MT("summary.walls"), value: summary.walls },
        { label: MT("summary.links"), value: summary.links }, { label: MT("summary.areas"), value: summary.areas },
        { label: MT("summary.drops"), value: summary.drops },
      ] : [],
      folder: this._folder, folderInvalid: Boolean(this._folder) && !folderValid,
      canImport: gm && !missing && Boolean(this._archive) && !this._busy && folderValid,
      locked: !gm || Boolean(missing),
      failure: this._failure, warnings: this._warnings.includes("drops") ? [MT("warning.drops")] : [],
      progress: this._progress && this._archive ? progressState(this._progress, this._archive.carte.levels.length) : null,
      sceneName: this._result?.sceneName ?? "",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const archive = this.element.querySelector('input[name="archive"]');
    archive?.addEventListener("change", () => { const file = archive.files?.[0]; if (file) void this._load(file); });
    this.element.querySelector('input[name="folder"]')?.addEventListener("input", event => {
      this._folder = event.currentTarget.value; this._folderEdited = true;
      // The field keeps focus: only the button and the field's validity change, without a new rendering.
      const valid = Boolean(normalizeFolder(this._folder));
      event.currentTarget.setAttribute("aria-invalid", String(Boolean(this._folder) && !valid));
      const button = this.element.querySelector('[data-action="import"]');
      if (button) button.disabled = !valid || !this._archive || this._busy;
    });
  }

  /** Reads and validates the chosen archive as soon as it is chosen, so a bad file is reported before the import. */
  async _load(file) {
    this._failure = null; this._result = null;
    try {
      if (file.size > ARCHIVE_LIMITS.archiveBytes) throw new MapError("tooLarge");
      const archive = await readMapArchive(await file.arrayBuffer());
      this._archive = archive; this._fileName = file.name;
      if (!this._folderEdited) this._folder = defaultFolder(archive.carte.name);
    } catch (error) {
      this._archive = null; this._fileName = "";
      this._failure = describeFailure(error);
    }
    if (this.rendered) await this.render();
  }

  async _import() {
    if (this._busy) return;
    const field = this.element?.querySelector('input[name="folder"]');
    if (field) this._folder = field.value;
    if (!this._archive) { this._failure = describeFailure(new MapError("noFile")); await this.render(); return; }
    this._busy = true; this._failure = null; this._warnings = []; this._progress = { step: "folder" };
    await this.render();
    try {
      const result = await importMap(this._archive, { folder: this._folder, onProgress: state => {
        this._progress = state;
        if (this.rendered) void this.render();
      } });
      this._result = { sceneName: result.scene.name, sceneId: result.scene.id };
      this._warnings = result.warnings;
    } catch (error) {
      this._failure = describeFailure(error);
      if (!(error instanceof MapError)) console.error(`${MODULE_ID} | Map import failed`, error);
    } finally {
      this._busy = false; this._progress = null;
      if (this.rendered) await this.render();
    }
  }

  /** Back to the file field, for a different archive or a second map. */
  _clear() {
    if (this._busy) return;
    this._archive = null; this._fileName = ""; this._folder = ""; this._folderEdited = false;
    this._failure = null; this._result = null; this._warnings = [];
    return this.render();
  }

  _view() { return game.scenes?.get(this._result?.sceneId)?.view(); }

  async close(options) {
    releaseSingleton(this);
    return super.close(options);
  }
}
