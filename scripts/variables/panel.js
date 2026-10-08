import { MODULE_ID, I18N } from "../constants.js";
import { ControlError, requireValue } from "../stream-deck/protocol.js";
import { variableService } from "./service.js";
import { VALUE_TYPES, DOCUMENT_TYPES, SCOPES, copy, uuid7, operations, preview } from "./schema.js";
import { parseExpression, formatExpression, inspectExpression, expressionReferences } from "./expressions.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
export const VT = key => game.i18n.localize(`${I18N}.variables.${key}`);
export const variableError = error => { const key = `${I18N}.variables.error.${error?.code ?? "failed"}`;
  return game.i18n.has?.(key) === false ? VT("error.failed") : game.i18n.localize(key); };
const ref = (scope, id) => ({ source: "variable", scope, id });
const option = (value, selected, label = value) => ({ value, label, selected: value === selected });

export function typedValue(type, raw, source = "uuid", userId = "") {
  if (type === "number") { requireValue(raw.trim() !== ""); const value = Number(raw); requireValue(Number.isFinite(value), "outOfBounds"); return value; }
  if (type === "boolean") { requireValue(["true", "false"].includes(raw)); return raw === "true"; }
  if (type === "text") return raw;
  if (source === "selectedToken") return { source };
  if (source === "userCharacter") return { source, ...(userId ? { userId } : {}) };
  return { uuid: raw.trim() };
}
export function dependencies(stores, scope, collection, id) {
  const rows = [];
  for (const s of SCOPES) for (const v of stores[s].variables) {
    // A variable used as a part of a document path counts like any other reference.
    const uses = collection === "lists" ? v.list?.scope === scope && v.list.id === id
      : Boolean(v.expression) && expressionReferences(v.expression).some(node => node.scope === scope && node.id === id);
    if (uses) rows.push(`${VT(s)}: ${v.name}`);
  }
  return rows;
}
export class VariablePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;
  /** One window: the settings menu and the module API reuse it, and a reopen never redraws a draft. */
  static open() {
    const panel = this._instance ??= new this();
    if (!panel.rendered) panel.render({ force: true });
    else { if (panel.minimized) void panel.maximize(); panel.bringToFront(); }
    return panel;
  }
  static DEFAULT_OPTIONS = { id: "jdr-ninja-variables", classes: ["jdr-ninja"], tag: "div",
    window: { title: `${I18N}.variables.title`, icon: "fa-solid fa-sliders", resizable: true }, position: { width: 920, height: 720 },
    actions: Object.fromEntries(["scope", "switchTab", "select", "create", "save", "reload", "duplicate", "remove", "preview", "mutate", "entryAdd", "entryRemove", "entryUp", "entryDown", "insert", "openDocument", "controller", "reconcile"]
      .map(key => [key, function(event, target) { return this._action(key, target); }])) };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/variables.hbs`, scrollable: [""] } };
  scope = "personal"; collection = "variables"; search = ""; draft = null; baseRevision = null; dirty = false; busy = false; message = "";
  /** A variable is written by its name alone; the id only stands in when the variable no longer exists. */
  label(scope, id) { return this.stores[scope]?.variables.find(v => v.id === id)?.name ?? id; }
  /** The scopes an expression may read: a world definition sees the world only, a personal one sees both. */
  readableScopes() { return SCOPES.filter(s => this.scope !== "world" || s === "world"); }
  async _prepareContext() {
    try { this.stores = variableService.stores(); this.projection = await variableService.projection(); }
    catch (error) { const message = variableError(error); return { error: message, advanced: VT("advanced"), layout: JSON.stringify(["error", message]) }; }
    const store = this.stores[this.scope], writable = variableService.canWrite(this.scope, this.stores), search = this.search.toLocaleLowerCase();
    // Every row is drawn and the search only hides rows, so the layout below never depends on the search text.
    const rows = store[this.collection].map(v => {
      const value = this.projection.state.find(state => state.scope === this.scope && state.id === v.id);
      return { id: v.id, name: v.name, type: VT(`type.${v.type}`), kind: VT(`kind.${v.kind ?? "list"}`), selected: this.draft?.id === v.id,
        hidden: !v.name.toLocaleLowerCase().includes(search),
        value: value?.status === "available" ? value.preview.text + (value.preview.shortened ? "…" : "") : value ? VT(`error.${value.status}`) : `${v.entries.length} ${VT("entries")}` };
    });
    const controller = game.users.get(this.stores.world.controller);
    const context = { scope: this.scope, scopes: SCOPES.map(s => option(s, this.scope, VT(s))),
      tabs: ["variables", "lists"].map(s => option(s, this.collection, VT(s))), rows, search: this.search, writable, busy: this.busy,
      status: VT(writable ? "writable" : "readOnly"), controllerName: controller?.name ?? VT("noController"), controllerOnline: VT(controller?.active ? "online" : "offline"),
      canAssign: variableService.fullGM() && (controller?.id === game.user.id || !controller?.active && variableService.candidate()?.id === game.user.id),
      controllers: Array.from(game.users.contents).filter(u => u.active && variableService.fullGM(u)).map(u => option(u.id, this.stores.world.controller, u.name)),
      stale: this.draft && this.baseRevision !== store.revision, uncertain: variableService.uncertain.has(this.scope), message: this.message, editor: null };
    // What the window draws apart from the value cells: a live change with no draft open redraws only when this moves.
    context.layout = JSON.stringify([this.scope, this.collection, writable, context.uncertain, context.message, context.controllerName,
      context.controllerOnline, context.canAssign, context.controllers, rows.map(row => [row.id, row.name, row.type, row.kind, row.selected])]);
    if (this.draft) context.editor = this.editorContext(writable);
    return context;
  }
  editorContext(writable) {
    const d = this.draft, variable = this.collection === "variables", existing = this.stores[this.scope][this.collection].find(v => v.id === d.id);
    const context = { ...d, variable, existing: Boolean(existing), readonlyType: Boolean(existing), writable,
      kindOptions: ["stored", "list", "computed"].map(k => option(k, d.kind, VT(`kind.${k}`))),
      types: VALUE_TYPES.map(t => option(t, d.type, VT(`type.${t}`))), stored: d.kind === "stored", computed: d.kind === "computed", selection: d.kind === "list",
      numeric: d.type === "number", textual: d.type === "text", constraints: d.constraints ?? {},
      expressionText: this.expressionText ?? (d.expression ? formatExpression(d.expression, (s, i) => this.label(s, i)) : ""),
      dependencies: dependencies(this.stores, this.scope, this.collection, d.id),
      referenceGroups: this.readableScopes().map(s => ({ label: VT(s), options: this.stores[s].variables.filter(v => v.id !== d.id).map(v => ({ value: `${s}:${v.id}`, label: this.label(s, v.id) })) }))
        .filter(group => group.options.length),
      lists: this.readableScopes().flatMap(s => this.stores[s].lists.filter(l => l.type === d.type).map(l => option(`${s}:${l.id}`, `${d.list?.scope}:${d.list?.id}`, `${VT(s)}: ${l.name}`))),
      operationOptions: variable && existing && existing.kind === d.kind ? operations(existing).map(op => ({ value: op, label: VT(`operation.${op}`) })) : [],
      values: [] };
    if (variable && d.kind === "stored") context.values = [{ key: "default", label: VT("default"), value: d.default }, { key: "current", label: VT("current"), value: existing?.current ?? d.current, runtime: Boolean(existing) }];
    if (!variable) context.values = d.entries.map((entry, index) => ({ key: entry.id, label: entry.label, value: entry.value, entry: true, first: index === 0, last: index === d.entries.length - 1 }));
    const list = d.list && this.stores[d.list.scope].lists.find(l => l.id === d.list.id);
    if (context.selection) context.entryChoices = (list?.entries ?? []).map(e => option(e.id, d.default, e.label));
    if (context.selection) context.currentEntryChoices = (list?.entries ?? []).map(e => option(e.id, existing?.current ?? d.current, e.label));
    context.values = context.values.map(field => ({ ...field, numeric: d.type === "number", boolean: d.type === "boolean", document: DOCUMENT_TYPES.includes(d.type),
      valueText: DOCUMENT_TYPES.includes(d.type) ? field.value?.uuid ?? "" : field.value ?? "", unset: field.value === null,
      boolChoices: ["true", "false"].map(v => option(v, String(field.value))),
      sources: ["uuid", ...(d.type === "Token" ? ["selectedToken"] : d.type === "Actor" ? ["userCharacter"] : [])].map(v => option(v, field.value?.source ?? "uuid", VT(`source.${v}`))),
      userId: field.value?.userId ?? "", users: [{ value: "", label: VT("executingUser"), selected: !field.value?.userId }, ...game.users.contents.map(u => option(u.id, field.value?.userId, u.name))] }));
    context.documents = this.documentChoices(d.type);
    return context;
  }
  documentChoices(type) {
    const collections = { Actor: game.actors, Macro: game.macros, Scene: game.scenes, JournalEntry: game.journal, Playlist: game.playlists, RollTable: game.tables, Combat: game.combats };
    let documents = collections[type]?.contents ?? [];
    if (type === "JournalEntryPage") documents = game.journal.contents.filter(d => d.testUserPermission(game.user, "OBSERVER")).flatMap(d => d.pages.contents);
    if (type === "PlaylistSound") documents = game.playlists.contents.filter(d => d.testUserPermission(game.user, "OBSERVER")).flatMap(d => d.sounds.contents);
    if (type === "Token") documents = canvas?.scene?.tokens.contents ?? [];
    return documents.filter(d => d.testUserPermission(game.user, "OBSERVER") && (!d.hidden || game.user.isGM)).slice(0, 64).map(d => ({ uuid: d.uuid, name: d.name }));
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    // Subscribed while the window is shown: close() drops it, so a closed window never keeps listening.
    this.unsubscribe ??= variableService.subscribe(() => { void this._queueRefresh(); });
    this.wasWritable = context.writable;
    this.layout = context.layout;
    this.element.querySelector('[name="search"]')?.addEventListener("input", event => {
      this.search = event.target.value; for (const row of this.element.querySelectorAll("[data-row-name]")) row.hidden = !row.dataset.rowName.toLocaleLowerCase().includes(this.search.toLocaleLowerCase());
    });
    this.element.querySelectorAll("[data-field], [data-value-field]").forEach(input => input.addEventListener("change", event => this._change(event.target)));
  }
  /**
   * The service notifies on every actor, token, scene, combat or user change, in bursts. One refresh runs at a time
   * and a burst arriving meanwhile costs one more.
   */
  _queueRefresh() {
    this._refreshQueued = true;
    return this._refreshing ??= (async () => {
      try {
        await null;
        while (this._refreshQueued) {
          this._refreshQueued = false;
          try { await this._refreshState(); } catch { /* The next change retries. */ }
        }
      } finally { this._refreshing = null; }
    })();
  }
  async _refreshState() {
    if (!this.rendered) return;
    const element = this.element;
    if (!this.draft) {
      // Values change in place; only a change to what the window lists (definitions, rights, controller) redraws it.
      const context = await this._prepareContext();
      if (!this.rendered || this.element !== element || this.draft) return;
      if (context.layout !== this.layout) await this._renderKeepingFocus();
      else this._writeValues(context.rows ?? []);
      return;
    }
    // Incoming state never replaces a draft or moves its focus; a manual reload is explicit.
    try {
      const stores = variableService.stores();
      if (this.wasWritable !== undefined && this.wasWritable !== variableService.canWrite(this.scope, stores)) {
        const fields = [...this.element.querySelectorAll("[data-field], [data-value-field]")];
        const key = input => input.dataset.field ?? `${input.closest("[data-value-key]")?.dataset.valueKey}/${input.dataset.valueField}`;
        const saved = new Map(fields.map(input => [key(input), { value: input.value, checked: input.checked }]));
        const active = document.activeElement, focus = fields.includes(active) ? { key: key(active), start: active.selectionStart, end: active.selectionEnd } : null;
        await this.render();
        for (const input of this.element.querySelectorAll("[data-field], [data-value-field]")) {
          const value = saved.get(key(input)); if (value) { input.value = value.value; input.checked = value.checked; }
          if (focus?.key === key(input)) { input.focus(); if (focus.start !== null) input.setSelectionRange?.(focus.start, focus.end); }
        }
        return;
      }
      this.element.querySelector("[data-stale]")?.toggleAttribute("hidden", stores[this.scope].revision === this.baseRevision);
      const projection = await variableService.projection();
      if (!this.rendered || this.element !== element) return;
      for (const state of projection.state.filter(s => s.scope === this.scope)) {
        const target = [...this.element.querySelectorAll("[data-state-id]")].find(el => el.dataset.stateId === state.id);
        if (target) target.textContent = state.status === "available" ? state.preview.text + (state.preview.shortened ? "…" : "") : VT(`error.${state.status}`);
      }
    } catch (error) { const message = this.rendered && this.element?.querySelector("[data-message]"); if (message) message.textContent = variableError(error); }
  }
  _writeValues(rows) {
    const values = new Map(rows.map(row => [row.id, row.value]));
    for (const cell of this.element.querySelectorAll("[data-state-id]")) {
      const value = values.get(cell.dataset.stateId);
      if (value !== undefined && cell.textContent !== value) cell.textContent = value;
    }
  }
  /** A redraw keeps the search text (`this.search`), the focused control and its caret, and an unsent controller choice. */
  async _renderKeepingFocus() {
    const controls = () => [...this.element.querySelectorAll("[name], [data-action]")];
    const key = control => [control.name ?? "", control.dataset?.action ?? "", control.dataset?.id ?? "", control.dataset?.value ?? ""].join("|");
    const caret = (control, field) => { try { return control[field] ?? null; } catch { return null; } };
    const before = controls(), active = this.element.ownerDocument?.activeElement;
    const focus = before.includes(active) ? { key: key(active), start: caret(active, "selectionStart"), end: caret(active, "selectionEnd") } : null;
    const choices = new Map(before.filter(control => control.tagName === "SELECT").map(control => [key(control), control.value]));
    await this.render();
    if (!this.rendered) return;
    for (const control of controls()) {
      const choice = choices.get(key(control));
      if (choice !== undefined && [...control.options ?? []].some(option => option.value === choice)) control.value = choice;
      if (focus?.key !== key(control)) continue;
      control.focus();
      if (focus.start !== null) control.setSelectionRange?.(focus.start, focus.end);
    }
  }
  _change(input) {
    if (!this.draft) return;
    const key = input.dataset.field;
    if (["kind", "type", "list"].includes(key)) {
      try { this.captureValues(); } catch (error) { this.message = variableError(error); }
    }
    if (key) {
      if (key === "expression") this.expressionText = input.value;
      else if (key === "list") { const [scope, id] = input.value.split(":"); this.draft.list = { scope, id }; this.draft.default = null; this.draft.current = null; }
      else if (key.startsWith("constraints.")) {
        const name = key.slice(12); this.draft.constraints ??= {};
        if (input.type === "checkbox") this.draft.constraints[name] = input.checked;
        else if (input.value === "") delete this.draft.constraints[name]; else this.draft.constraints[name] = Number(input.value);
      } else if (key === "kind") this.changeKind(input.value);
      else if (key === "type") { this.draft.type = input.value; if (this.collection === "lists") this.draft.entries = []; else this.changeKind(this.draft.kind); }
      else this.draft[key] = input.type === "checkbox" ? input.checked : input.value || (key === "default" ? null : "");
    }
    this.dirty = true;
    if (["kind", "type", "list"].includes(key)) void this.render();
  }
  changeKind(kind) {
    const { id, name, type } = this.draft;
    this.draft = { id, name, type, kind, constraints: {}, ...(kind === "computed" ? { expression: { op: "literal", type, value: this.initialValue(type) } }
      : kind === "list" ? { list: { scope: this.scope, id: "" }, current: null, default: null, wrap: false }
      : { current: this.initialValue(type), default: this.initialValue(type) }) };
    this.expressionText = kind === "computed" ? "" : undefined;
  }
  initialValue(type) { return type === "number" ? 0 : type === "boolean" ? false : type === "text" ? "" : null; }
  captureValues() {
    if (!this.draft) return;
    for (const row of this.element.querySelectorAll("[data-value-key]")) {
      const key = row.dataset.valueKey;
      const field = suffix => row.querySelector(`[data-value-field="${suffix}"]`);
      const raw = field("value")?.value ?? "";
      const value = field("unset")?.checked ? null : typedValue(this.draft.type, raw, field("source")?.value, field("user")?.value);
      if (key === "current") { this.currentInput = value; if (!this.stores[this.scope].variables.some(v => v.id === this.draft.id)) this.draft.current = value; }
      else if (key === "default") this.draft.default = value;
      else { const entry = this.draft.entries.find(e => e.id === key); entry.value = value; entry.label = field("label").value; }
    }
  }
  async _action(action, target) {
    if (this.busy) return;
    let renderAfter = true;
    try {
      if (["scope", "switchTab", "select", "create", "reload"].includes(action)) {
        if (this.dirty && !await DialogV2.confirm({ window: { title: VT("discardTitle") }, content: VT("discard") })) return;
        this.draft = null; this.expressionText = undefined; this.dirty = false; this.message = "";
        if (action === "scope") this.scope = target.dataset.value;
        if (action === "switchTab") this.collection = target.dataset.value;
        const stores = variableService.stores(); this.baseRevision = stores[this.scope].revision;
        if (["select", "reload"].includes(action)) this.draft = copy(stores[this.scope][this.collection].find(v => v.id === (target.dataset.id ?? this.selectedId)) ?? null);
        if (action === "create") this.draft = this.collection === "lists" ? { id: uuid7(), name: "", type: "number", entries: [] }
          : { id: uuid7(), name: "", type: "number", kind: "stored", current: 0, default: 0, constraints: {} };
        this.selectedId = this.draft?.id; renderAfter = false; await this.render(); return;
      }
      this.captureValues();
      if (["entryAdd", "entryRemove", "entryUp", "entryDown"].includes(action)) {
        const entries = this.draft.entries, index = entries.findIndex(e => e.id === target.dataset.id);
        if (action === "entryAdd") entries.push({ id: uuid7(), label: "", value: this.initialValue(this.draft.type) });
        else if (action === "entryRemove") {
          const affected = dependencies(variableService.stores(), this.scope, "lists", this.draft.id);
          const content = document.createElement("p"); content.textContent = `${VT("deleteEntry")} ${affected.join(", ")} ${VT("externalReferences")}`;
          if (!await DialogV2.confirm({ window: { title: VT("deleteTitle") }, content: content.outerHTML })) return; entries.splice(index, 1);
        } else { const destination = index + (action === "entryUp" ? -1 : 1);
          if (index >= 0 && destination >= 0 && destination < entries.length) [entries[index], entries[destination]] = [entries[destination], entries[index]]; }
        this.dirty = true; renderAfter = false; await this.render(); return;
      }
      if (action === "insert") {
        const value = this.element.querySelector('[name="reference"]')?.value; const [scope, id] = (value ?? "").split(":"); requireValue(id);
        const input = this.element.querySelector('[data-field="expression"]'); const insertion = `@{${this.label(scope, id)}}`;
        input.setRangeText(insertion, input.selectionStart, input.selectionEnd, "end"); this.expressionText = input.value; this.dirty = true; input.focus(); renderAfter = false; return;
      }
      if (action === "openDocument") {
        const ctx = variableService.context(); const binding = target.dataset.id === "current" ? this.currentInput : target.dataset.id === "default" ? this.draft.default : this.draft.entries.find(e => e.id === target.dataset.id)?.value;
        const doc = await ctx.document(binding, this.draft.type); ctx.check();
        const page = doc.documentName === "JournalEntryPage"; await (page ? doc.parent : doc).sheet.render({ force: true, ...(page ? { pageId: doc.id } : {}) }); renderAfter = false; return;
      }
      this.busy = true;
      if (action === "controller") {
        const stores = variableService.stores(); await variableService.reconcile("world");
        await variableService.assignController(this.element.querySelector('[name="controller"]')?.value, stores.world.revision);
      } else if (action === "reconcile") await variableService.reconcile(this.scope);
      else if (action === "preview") {
        const candidate = this.compiledDraft(), stores = variableService.stores(), base = variableService.context(); const store = stores[this.scope];
        store[this.collection] = store[this.collection].filter(v => v.id !== candidate.id).concat(candidate);
        variableService.validateDefinitions(stores, this.scope, candidate.id);
        if (this.collection === "variables") { const ctx = variableService.context(stores), value = await ctx.resolve(this.scope, candidate.id);
          base.documents.push(...ctx.documents); base.check();
          this.message = `${VT("current")}: ${preview(DOCUMENT_TYPES.includes(candidate.type) ? await ctx.documentText(value, "name") : value).text}`; }
        else this.message = VT("valid");
      } else if (action === "save") {
        const candidate = this.compiledDraft(); const existing = variableService.stores()[this.scope][this.collection].find(v => v.id === candidate.id);
        const convert = existing && existing.kind !== candidate.kind;
        if (convert && !await DialogV2.confirm({ window: { title: VT("convertTitle") }, content: VT("convert") })) return;
        await (this.collection === "variables" ? variableService.saveVariable(this.scope, candidate, this.baseRevision, { convert }) : variableService.saveList(this.scope, candidate, this.baseRevision));
        this.dirty = false; this.baseRevision = variableService.stores()[this.scope].revision; this.draft = copy(variableService.stores()[this.scope][this.collection].find(v => v.id === candidate.id)); this.message = VT("saved");
      } else if (action === "duplicate") {
        const candidate = this.compiledDraft(); candidate.id = uuid7(); candidate.name += ` (${VT("copy")})`;
        if (candidate.entries) candidate.entries.forEach(entry => { entry.id = uuid7(); });
        this.draft = candidate; this.baseRevision = variableService.stores()[this.scope].revision; this.dirty = true; this.selectedId = candidate.id;
      } else if (action === "remove") {
        const affected = dependencies(variableService.stores(), this.scope, this.collection, this.draft.id);
        const content = document.createElement("p"); content.textContent = `${VT("deleteConfirm")} ${this.draft.name}. ${affected.join(", ")} ${VT("externalReferences")}`;
        if (!await DialogV2.confirm({ window: { title: VT("deleteTitle") }, content: content.outerHTML })) return;
        await variableService.remove(this.scope, this.collection, this.draft.id, this.baseRevision); this.draft = null; this.dirty = false;
      } else if (action === "mutate") {
        const operation = this.element.querySelector('[name="operation"]')?.value, before = variableService.stores()[this.scope].revision;
        const value = this.draft.kind === "list" ? this.element.querySelector('[name="currentEntry"]')?.value : this.currentInput;
        await variableService.mutate({ operation, variable: ref(this.scope, this.draft.id),
          ...(["set", "select"].includes(operation) ? { value } : ["increment", "decrement"].includes(operation) ? { amount: Number(this.element.querySelector('[name="amount"]').value) } : {}) });
        if (this.baseRevision === before) this.baseRevision = variableService.stores()[this.scope].revision; this.message = VT("applied");
      }
    } catch (error) { this.message = variableError(error); ui.notifications.warn(this.message); }
    finally { this.busy = false; if (renderAfter && this.rendered) await this.render(); }
  }
  compiledDraft() {
    const d = copy(this.draft);
    if (this.collection === "variables" && d.kind === "computed") {
      // A name resolves to exactly one variable among those this editor may read.
      d.expression = parseExpression(this.expressionText ?? formatExpression(d.expression, (s, i) => this.label(s, i)), name => {
        const matches = this.readableScopes().flatMap(s => variableService.stores()[s].variables.filter(v => v.name.trim() === name.trim()).map(v => ({ scope: s, id: v.id })));
        requireValue(matches.length > 0, "missingVariable"); requireValue(matches.length === 1, "duplicateName"); return matches[0]; });
      inspectExpression(d.expression, (s, i) => variableService.stores()[s].variables.find(v => v.id === i), this.scope, new Set([`${this.scope}:${d.id}`]));
    }
    return d;
  }
  async close(options) {
    if (this.dirty && !await DialogV2.confirm({ window: { title: VT("discardTitle") }, content: VT("discard") })) return this;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (VariablePanel._instance === this) VariablePanel._instance = null;
    return super.close(options);
  }
}
