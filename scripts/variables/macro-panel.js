import { MODULE_ID, I18N } from "../constants.js";
import { copy, VALUE_TYPES, DOCUMENT_TYPES } from "./schema.js";
import { validateMacroDeclaration } from "./dispatcher.js";
import { variableService } from "./service.js";
import { requireValue } from "../stream-deck/protocol.js";
import { VT, variableError, typedValue } from "./panel.js";
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class MacroArgumentsPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;
  /** One window: the settings menu and the module API reuse it, and a reopen never redraws unsaved fields. */
  static open() {
    const panel = this._instance ??= new this();
    if (!panel.rendered) panel.render({ force: true });
    else { if (panel.minimized) void panel.maximize(); panel.bringToFront(); }
    return panel;
  }
  static DEFAULT_OPTIONS = { id: "jdr-ninja-macro-arguments", classes: ["jdr-ninja"], tag: "div",
    window: { title: `${I18N}.variables.menu.macroArguments`, icon: "fa-solid fa-code", resizable: true }, position: { width: 720, height: 660 },
    actions: Object.fromEntries(["load", "add", "remove", "save", "disable"].map(key => [key, function(_event, target) { return this.action(key, target); }])) };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/macro-arguments.hbs` } };
  draft = { version: 1, arguments: [] }; macroId = ""; dirty = false; message = ""; base = undefined;
  macros() { return game.macros.contents.filter(macro => macro.type === "script" && macro.canExecute && macro.testUserPermission(game.user, "OWNER")); }
  async _prepareContext() {
    const macro = game.macros.get(this.macroId);
    return { macros: this.macros().map(m => ({ id: m.id, name: m.name, selected: m.id === this.macroId })), selected: Boolean(macro),
      stale: macro && JSON.stringify(macro.getFlag(MODULE_ID, "arguments")) !== this.base, message: this.message,
      arguments: this.draft.arguments.map((arg, index) => ({ ...arg, index,
        types: VALUE_TYPES.map(type => ({ value: type, label: VT(`type.${type}`), selected: type === arg.type })),
        hasDefault: arg.default !== undefined, defaultText: DOCUMENT_TYPES.includes(arg.type) ? arg.default?.uuid ?? "" : arg.default === undefined ? "" : String(arg.default) })),
      sample: 'const args = scope.jdrNinja.arguments;\n// Perform your native action, then acknowledge it.\nreturn { jdrNinja: { version: 1, status: "executed" } };' };
  }
  _onRender(context, options) { super._onRender?.(context, options);
    this.element.querySelectorAll("[data-arg-field]").forEach(input => input.addEventListener("change", () => { this.dirty = true; })); }
  capture() {
    for (const row of this.element.querySelectorAll("[data-argument]")) {
      const arg = this.draft.arguments[Number(row.dataset.argument)]; const field = name => row.querySelector(`[data-arg-field="${name}"]`);
      arg.name = field("name").value.trim(); arg.type = field("type").value; arg.required = field("required").checked;
      if (field("hasDefault").checked) arg.default = typedValue(arg.type, field("default").value); else delete arg.default;
    }
  }
  async action(action, target) {
    try {
      if (action === "load") {
        if (this.dirty && !await DialogV2.confirm({ window: { title: VT("discardTitle") }, content: VT("discard") })) return;
        this.macroId = this.element.querySelector('[name="macro"]')?.value ?? ""; const macro = game.macros.get(this.macroId); requireValue(this.macros().includes(macro), "incompatibleMacro");
        const flag = macro.getFlag(MODULE_ID, "arguments"); this.base = JSON.stringify(flag);
        this.draft = flag ? copy(validateMacroDeclaration(flag)) : { version: 1, arguments: [] }; this.dirty = false; this.message = "";
      } else {
        this.capture();
        if (action === "add") { requireValue(this.draft.arguments.length < 16, "capacity"); this.draft.arguments.push({ name: "", type: "text", required: true }); this.dirty = true; }
        else if (action === "remove") { this.draft.arguments.splice(Number(target.dataset.index), 1); this.dirty = true; }
        else if (["save", "disable"].includes(action)) {
          if (action === "disable" && !await DialogV2.confirm({ window: { title: VT("deleteTitle") }, content: VT("disableMacroConfirm") })) return;
          const declaration = action === "save" ? copy(validateMacroDeclaration(this.draft)) : null;
          await variableService.run(async op => {
            const macro = game.macros.get(this.macroId); requireValue(this.macros().includes(macro), "denied");
            requireValue(JSON.stringify(macro.getFlag(MODULE_ID, "arguments")) === this.base, "conflict"); op.guard();
            if (declaration) await macro.setFlag(MODULE_ID, "arguments", declaration); else await macro.unsetFlag(MODULE_ID, "arguments");
          });
          this.base = JSON.stringify(game.macros.get(this.macroId).getFlag(MODULE_ID, "arguments")); this.dirty = false; this.message = VT("saved");
        }
      }
    } catch (error) { this.message = variableError(error); ui.notifications.warn(this.message); }
    finally { if (this.rendered) await this.render(); }
  }
  async close(options) { if (this.dirty && !await DialogV2.confirm({ window: { title: VT("discardTitle") }, content: VT("discard") })) return this;
    if (MacroArgumentsPanel._instance === this) MacroArgumentsPanel._instance = null; return super.close(options); }
}
