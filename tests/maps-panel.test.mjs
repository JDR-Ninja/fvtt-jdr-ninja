import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { carteFixture, archiveFixture } from "./maps-fixture.mjs";

const warnings = [];
class Application {
  rendered = false; minimized = false; renders = 0; fronted = 0;
  async render() { this.rendered = true; this.renders++; return this; }
  async close() { this.rendered = false; return this; }
  async maximize() { this.minimized = false; }
  bringToFront() { this.fronted++; }
}
globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: base => base } } };
globalThis.HTMLElement = class {};
const hooks = new Map();
globalThis.Hooks = { on: (name, fn) => hooks.set(name, fn) };
globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
const locales = Object.fromEntries(await Promise.all(["en", "fr", "es", "de", "it"].map(async lang =>
  [lang, JSON.parse(await readFile(new URL(`../lang/${lang}.json`, import.meta.url), "utf8"))])));
const template = await readFile(new URL("../templates/maps.hbs", import.meta.url), "utf8");

/** Foundry's i18n over one locale's strings: `format` fills `{name}` placeholders. */
const i18n = strings => ({ localize: key => strings[key] ?? key,
  format: (key, data) => Object.entries(data).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), strings[key] ?? key) });
const viewed = [];
const player = { id: "gm", isGM: false, can: () => false };
const gm = (upload = true, browse = true) => ({ id: "gm", isGM: true,
  can: permission => (permission === "FILES_UPLOAD" && upload) || (permission === "FILES_BROWSE" && browse) });
const reset = (strings = locales.en, user = gm()) => { globalThis.game = { user, i18n: i18n(strings), scenes: new Map(), system: { grid: { units: "ft" } }, world: { id: "world-panel" } }; };
reset();
const { MapImportPanel, MT, describeFailure, progressState } = await import("../scripts/maps/panel.js");
const { renderMapButton, registerMapIntegration } = await import("../scripts/maps/integration.js");
const { MapError, MAP_ERROR_CODES } = await import("../scripts/maps/errors.js");
const { readMapArchive } = await import("../scripts/maps/zip.js");

function render(context, strings = locales.en) {
  const renderer = Handlebars.create();
  renderer.registerHelper("localize", key => strings[key] ?? key);
  return renderer.compile(template)(context).replace(/>\s+</g, "><");
}
const buttons = html => [...html.matchAll(/<button type="button"(?: class="bright")? data-action="(\w+)"([^>]*)>/g)]
  .map(match => ({ action: match[1], disabled: /\bdisabled\b/.test(match[2]) }));
const archive = async () => readMapArchive(archiveFixture());
async function loaded(overrides = {}) {
  const panel = new MapImportPanel();
  panel._archive = await archive(); panel._fileName = "carte-foundry.zip"; panel._folder = "jdr-ninja/cartes/chateau-20261014-090507";
  Object.assign(panel, overrides);
  return panel;
}

test("the window is one instance: opening it again brings it forward, and it is a GM's only", async () => {
  reset();
  const first = MapImportPanel.open();
  assert(first instanceof MapImportPanel); assert(first.rendered);
  assert.equal(MapImportPanel.open(), first); assert.equal(first.fronted, 1);
  first.minimized = true; MapImportPanel.open(); assert.equal(first.minimized, false);
  await first.close();
  assert.notEqual(MapImportPanel.open(), first, "a closed window is not reused");
  await MapImportPanel.instance.close();
  reset(locales.en, player);
  assert.equal(MapImportPanel.open(), null);
  assert.deepEqual(warnings, [locales.en["JDRNINJA.maps.error.notGM"]]);
  assert.equal(MapImportPanel.instance, null);
  reset();
});

test("with no file chosen the window asks for one and the import button is off", async () => {
  const panel = new MapImportPanel(), context = await panel._prepareContext(), html = render(context);
  assert.equal(context.hasArchive, false); assert.equal(context.canImport, false);
  assert(html.includes('<input id="jn-maps-archive" name="archive" type="file"'));
  assert(!html.includes('name="folder"'));
  assert.deepEqual(buttons(html), [{ action: "import", disabled: true }]);
  assert(html.includes(locales.en["JDRNINJA.maps.fileHint"]));
});

test("a read archive shows its map and counts, offers the default folder and enables the import", async () => {
  const panel = await loaded(), context = await panel._prepareContext(), html = render(context);
  assert.equal(context.mapName, "Château des Brumes");
  assert.deepEqual(context.rows.map(row => [row.label, row.value]), [["Levels", 3], ["Walls and doors", 7], ["Passages between levels", 2], ["Difficult ground", 3], ["Drops", 1]]);
  assert(html.includes('<h3 id="jn-maps-name">Château des Brumes</h3>'));
  assert(html.includes("<dt>Walls and doors</dt><dd>7</dd>"));
  assert(html.includes('name="folder" type="text" value="jdr-ninja/cartes/chateau-20261014-090507"'));
  assert(!html.includes('name="archive"'));
  assert.equal(context.canImport, true);
  assert.deepEqual(buttons(html), [{ action: "clear", disabled: false }, { action: "import", disabled: false }]);
  assert.equal([...html.matchAll(/class="bright"/g)].length, 1);
  for (const action of html.matchAll(/data-action="(\w+)"/g)) assert.equal(typeof MapImportPanel.DEFAULT_OPTIONS.actions[action[1]], "function", action[1]);
});

test("an invalid folder is flagged and blocks the import; a missing permission locks the window", async () => {
  const flagged = await loaded({ _folder: "../elsewhere" }), context = await flagged._prepareContext(), html = render(context);
  assert.equal(context.folderInvalid, true); assert.equal(context.canImport, false);
  assert(html.includes('aria-invalid="true"')); assert.deepEqual(buttons(html).at(-1), { action: "import", disabled: true });
  reset(locales.en, gm(false));
  const locked = await loaded(), lockedContext = await locked._prepareContext();
  assert.equal(lockedContext.canImport, false); assert.equal(lockedContext.permissionMessage, locales.en["JDRNINJA.maps.error.noUpload"]);
  assert(render(lockedContext).includes(Handlebars.escapeExpression(locales.en["JDRNINJA.maps.error.noUpload"])));
  assert(render(await new MapImportPanel()._prepareContext()).includes("disabled"), "the file field is disabled too");
  // The folder is made and read through the file browser's socket: the import needs that permission as well, and the
  // message names the one that is missing.
  reset(locales.en, gm(true, false));
  const noBrowse = await (await loaded())._prepareContext();
  assert.equal(noBrowse.canImport, false); assert.equal(noBrowse.locked, true);
  assert.equal(noBrowse.permissionMessage, locales.en["JDRNINJA.maps.error.noBrowse"]);
  assert.notEqual(locales.en["JDRNINJA.maps.error.noBrowse"], locales.en["JDRNINJA.maps.error.noUpload"]);
  assert(render(await new MapImportPanel()._prepareContext()).includes("disabled"), "the file field is disabled too");
  reset(locales.en, gm(false, false));
  assert.equal((await new MapImportPanel()._prepareContext()).permissionMessage, locales.en["JDRNINJA.maps.error.noUpload"], "upload is named first");
  reset(); assert.equal((await (await loaded())._prepareContext()).canImport, true);
  reset();
});

test("while importing the bar counts the folder, each image and the scene and the fields are off", async () => {
  const panel = await loaded({ _busy: true, _progress: { step: "upload", current: 2, total: 3, file: "carte-rez-de-chaussee.webp" } });
  const context = await panel._prepareContext(), html = render(context);
  assert.deepEqual(context.progress, { max: 5, value: 2, text: "Uploading image 2 of 3: carte-rez-de-chaussee.webp" });
  assert(html.includes('<progress max="5" value="2"></progress>'));
  assert(html.includes("Uploading image 2 of 3: carte-rez-de-chaussee.webp"));
  assert.equal(context.canImport, false);
  assert(buttons(html).every(button => button.disabled));
  assert(/name="folder"[^>]*disabled/.test(html));
  assert.deepEqual(progressState({ step: "folder" }, 3), { max: 5, value: 0, text: "Creating the folder…" });
  assert.deepEqual(progressState({ step: "scene" }, 3), { max: 5, value: 4, text: "Creating the scene…" });
});

test("a failure shows its message and the images already uploaded, escaped", async () => {
  const failure = describeFailure(new MapError("uploadFailed", { file: "<b>x</b>.webp", uploaded: ["maps/a.webp", "maps/<i>.webp"] }));
  assert.equal(failure.message, "The image <b>x</b>.webp could not be uploaded.");
  assert.deepEqual(failure.uploaded, ["maps/a.webp", "maps/<i>.webp"]);
  const html = render(await (await loaded({ _failure: failure }))._prepareContext());
  assert(html.includes('role="alert"')); assert(html.includes("&lt;b&gt;x&lt;/b&gt;.webp could not be uploaded."));
  assert(html.includes("<li>maps/a.webp</li>")); assert(html.includes("<li>maps/&lt;i&gt;.webp</li>")); assert(!html.includes("<i>.webp"));
  assert(html.includes(locales.en["JDRNINJA.maps.uploaded"]));
  const plain = describeFailure(new MapError("notZip"));
  assert.deepEqual(plain, { message: locales.en["JDRNINJA.maps.error.notZip"], uploaded: [] });
  assert.equal(describeFailure(new Error("boom")).message, locales.en["JDRNINJA.maps.error.unknown"]);
});

test("a rejected description shows a plain sentence and sends the path of the offending value to the console", () => {
  const logged = [], original = console.warn;
  console.warn = (...parts) => logged.push(parts.join(" "));
  try {
    const failure = describeFailure(new MapError("badDescription", { detail: "levels[2].walls[14]" }));
    assert.equal(failure.message, locales.en["JDRNINJA.maps.error.badDescription"]);
    assert(!failure.message.includes("levels[2]") && !failure.message.includes("{detail}"));
    assert.equal(logged.length, 1); assert(logged[0].includes("levels[2].walls[14]")); assert(logged[0].includes("jdr-ninja"));
    describeFailure(new MapError("notZip"));
    assert.equal(logged.length, 1, "a failure with no detail logs nothing");
    for (const [lang, strings] of Object.entries(locales)) {
      reset(strings);
      assert(!/levels\[|\{detail\}/.test(describeFailure(new MapError("badDescription", { detail: "levels[0].id" })).message), lang);
    }
  } finally { console.warn = original; reset(); }
});

test("every error code has a message in every language, with the placeholders its details fill", () => {
  for (const [lang, strings] of Object.entries(locales)) {
    for (const code of MAP_ERROR_CODES) assert.equal(typeof strings[`JDRNINJA.maps.error.${code}`], "string", `${lang} ${code}`);
    assert(strings["JDRNINJA.maps.error.missingImage"].includes("{level}") && strings["JDRNINJA.maps.error.missingImage"].includes("{file}"), lang);
    assert(!strings["JDRNINJA.maps.error.badDescription"].includes("{detail}"), `${lang}: the path of the offending value is for the console`);
    assert(strings["JDRNINJA.maps.progress.upload"].includes("{current}") && strings["JDRNINJA.maps.progress.upload"].includes("{total}"), lang);
    assert(strings["JDRNINJA.maps.error.folderFailed"].includes("{folder}"), lang);
    assert(strings["JDRNINJA.maps.error.folderUnreadable"].includes("{folder}"), lang);
    assert(strings["JDRNINJA.maps.error.badImage"].includes("{file}"), lang);
  }
});

test("when the map is imported the window names the scene and offers to view it or import another map", async () => {
  const panel = await loaded({ _result: { sceneName: "Château <Brumes>", sceneId: "abc" }, _warnings: ["drops"] });
  const context = await panel._prepareContext(), html = render(context);
  assert(html.includes("Château &lt;Brumes&gt;")); assert(html.includes(locales.en["JDRNINJA.maps.done"]));
  assert(html.includes(Handlebars.escapeExpression(locales.en["JDRNINJA.maps.warning.drops"])));
  assert.deepEqual(buttons(html), [{ action: "view", disabled: false }, { action: "another", disabled: false }]);
  assert(!html.includes('name="folder"')); assert(!html.includes('name="archive"'));
  game.scenes.set("abc", { view() { viewed.push("abc"); } });
  panel._view(); assert.deepEqual(viewed, ["abc"]);
  await panel._clear();
  assert.equal(panel._archive, null); assert.equal(panel._result, null); assert.equal(panel._folderEdited, false);
  assert(render(await panel._prepareContext()).includes('name="archive"'));
});

test("every language renders the window in every state with no missing string", async () => {
  for (const [lang, strings] of Object.entries(locales)) {
    reset(strings);
    const states = [new MapImportPanel(), await loaded(), await loaded({ _busy: true, _progress: { step: "scene" } }),
      await loaded({ _failure: describeFailure(new MapError("missingImage", { level: "Étage", file: "niveaux/x.webp" })) }),
      await loaded({ _result: { sceneName: "S", sceneId: "s" }, _warnings: ["drops"] })];
    for (const panel of states) {
      const html = render(await panel._prepareContext(), strings);
      assert(!html.includes("JDRNINJA."), `${lang}: a key is missing`);
      assert(!/\{\w+\}/.test(html), `${lang}: an unfilled placeholder`);
    }
    assert.equal(MT("title"), strings["JDRNINJA.maps.title"]);
  }
  reset();
});

test("choosing a file reads it, reports a bad one and keeps a folder the GM edited", async () => {
  const panel = new MapImportPanel(); panel.rendered = true;
  await panel._load(new File([archiveFixture()], "carte-foundry.zip"));
  assert.equal(panel._fileName, "carte-foundry.zip"); assert.equal(panel._failure, null);
  assert.match(panel._folder, /^jdr-ninja\/cartes\/chateau-des-brumes-\d{8}-\d{6}$/);
  panel._folder = "mes-cartes/ici"; panel._folderEdited = true;
  await panel._load(new File([archiveFixture()], "autre.zip"));
  assert.equal(panel._folder, "mes-cartes/ici");
  await panel._load(new File([new Uint8Array(50)], "pas-un-zip.zip"));
  assert.equal(panel._archive, null); assert.equal(panel._failure.message, locales.en["JDRNINJA.maps.error.notZip"]);
  const missing = new File([archiveFixture(carteFixture(), { omit: ["niveaux/carte-etage-1.webp"] })], "incomplet.zip");
  await panel._load(missing);
  assert.equal(panel._failure.message, "The image of level Étage is missing from the archive: niveaux/carte-etage-1.webp");
});

test("typing a folder updates the import button without rendering the window again", async () => {
  const panel = await loaded(); panel.rendered = true;
  const attributes = {}, listeners = {};
  const field = { value: "", addEventListener: (type, fn) => { listeners.folder = fn; }, setAttribute: (name, value) => { attributes[name] = value; } };
  const picker = { addEventListener: (type, fn) => { listeners.archive = fn; }, files: [] };
  const button = { disabled: false };
  panel.element = { querySelector: selector => ({ 'input[name="folder"]': field, 'input[name="archive"]': picker, '[data-action="import"]': button })[selector] ?? null };
  const renders = panel.renders;
  panel._onRender({}, {});
  listeners.folder({ currentTarget: { value: "bad folder", setAttribute: field.setAttribute } });
  assert.equal(panel._folder, "bad folder"); assert.equal(panel._folderEdited, true);
  assert.equal(attributes["aria-invalid"], "true"); assert.equal(button.disabled, true);
  listeners.folder({ currentTarget: { value: "bons/dossiers", setAttribute: field.setAttribute } });
  assert.equal(attributes["aria-invalid"], "false"); assert.equal(button.disabled, false);
  assert.equal(panel.renders, renders, "typing never rerenders");
});

/* ------------------------------ the whole import ------------------------------ */

/** The Foundry globals the module's own services read, recorded. */
function foundryStubs({ failCreate = false } = {}) {
  const log = { uploads: [], created: [], directories: [] };
  const files = {
    async createDirectory(source, path) { log.directories.push(path); },
    async browse() { return {}; },
    async upload(source, path, file) { log.uploads.push(`${path}/${file.name}`); return { path: `${path}/${file.name}` }; },
  };
  class SquareGrid { calculateDimensions() { return { x: 500, y: 400 }; } }
  const Scene = { async create(data) {
    if (failCreate) throw new Error("rejected");
    log.created.push(data);
    const regions = new Map(data.regions.map(region => [region._id, { id: region._id, documentName: "Region",
      behaviors: new Map(region.behaviors.map(b => [b._id, { id: b._id, system: { destinations: new Set(b.system.destinations ?? []) } }])) }]));
    return { id: data._id, name: data.name, regions };
  } };
  foundry.applications.apps = { FilePicker: { implementation: files } };
  foundry.grid = { SquareGrid };
  foundry.utils = { randomID: () => "PanelSceneId0001", fromUuidSync: (uuid) => log.created.at(-1) && null };
  globalThis.CONFIG = { Scene: { documentClass: Scene }, Token: { movement: { actions: { walk: {}, fly: {} } } } };
  return log;
}

test("the window imports through the module's own Foundry services and shows the scene it made", async () => {
  const log = foundryStubs();
  foundry.utils.fromUuidSync = (uuid, { relative }) => {
    const scene = log.created.at(-1), id = uuid.slice(2);
    return scene.regions.some(region => region._id === id) ? { id, documentName: "Region" } : null;
  };
  const panel = await loaded({ _folder: "jdr-ninja/cartes/essai" }); panel.rendered = true;
  const seen = [];
  const original = panel.render.bind(panel);
  panel.render = async () => { seen.push({ busy: panel._busy, progress: panel._progress?.step ?? null }); return original(); };
  await panel._import();
  assert.deepEqual(log.directories, ["jdr-ninja", "jdr-ninja/cartes", "jdr-ninja/cartes/essai"]);
  assert.equal(log.uploads.length, 3); assert.equal(log.created.length, 1);
  assert.deepEqual(panel._result, { sceneName: "Château des Brumes", sceneId: "PanelSceneId0001" });
  assert.deepEqual(panel._warnings, []); assert.equal(panel._failure, null); assert.equal(panel._busy, false); assert.equal(panel._progress, null);
  assert(seen.some(state => state.busy && state.progress === "folder")); assert(seen.some(state => state.progress === "scene"));
  assert.deepEqual(seen.at(-1), { busy: false, progress: null });
  assert(render(await panel._prepareContext()).includes(locales.en["JDRNINJA.maps.done"]));
});

test("a failed import keeps the archive and the folder, reports the failure and releases the window", async () => {
  const log = foundryStubs({ failCreate: true });
  const panel = await loaded({ _folder: "jdr-ninja/cartes/essai" }); panel.rendered = true;
  await panel._import();
  assert.equal(panel._failure.message, locales.en["JDRNINJA.maps.error.sceneFailed"]);
  assert.equal(panel._failure.uploaded.length, 3); assert.deepEqual(panel._failure.uploaded, log.uploads);
  assert.equal(panel._result, null); assert.equal(panel._busy, false);
  assert(panel._archive && panel._folder === "jdr-ninja/cartes/essai");
  const html = render(await panel._prepareContext());
  assert(html.includes("<li>jdr-ninja/cartes/essai/carte-etage-1.webp</li>"));
  assert.deepEqual(buttons(html).at(-1), { action: "import", disabled: false }, "the GM can try again");
  // With no file read there is nothing to import.
  const empty = new MapImportPanel(); empty.rendered = true;
  await empty._import();
  assert.equal(empty._failure.message, locales.en["JDRNINJA.maps.error.noFile"]);
});

/* ----------------------------- the Scenes directory ----------------------------- */

/** The few DOM members the shortcut uses: children, class selectors, append, remove, attributes and click listeners. */
class Element extends globalThis.HTMLElement {
  nodes = []; attributes = {}; listeners = {}; parent = null; className = ""; type = "";
  constructor(tag) { super(); this.tag = tag; }
  get children() { return this.nodes.filter(node => node instanceof Element); }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.nodes.map(node => typeof node === "string" ? node : node.textContent).join(""); }
  set textContent(value) { this.nodes = [value]; }
  append(...items) { for (const item of items) { if (item instanceof Element) { item.remove(); item.parent = this; } this.nodes.push(item); } }
  remove() { this.parent?.nodes.splice(this.parent.nodes.indexOf(this), 1); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  hasClass(name) { return this.className.split(/\s+/).includes(name); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.hasClass(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.document = { createElement: tag => new Element(tag) };
const child = (parent, className, tag = "div") => { const element = new Element(tag); element.className = className; parent.append(element); return element; };
function directory({ header = true, footer = false } = {}) {
  const root = child(new Element("body"), "directory");
  const actions = header ? child(root, "header-actions") : null;
  if (actions) child(actions, "create-entry", "button");
  if (footer) child(root, "directory-footer");
  return { root, actions, buttons: () => root.querySelectorAll(".jdr-ninja-map-open"), rows: () => root.querySelectorAll(".jn-directory-actions") };
}

test("a GM gets one labelled shortcut in the Scenes directory's header actions, and it opens the window", async () => {
  reset();
  const view = directory();
  renderMapButton(null, [view.root]);
  const [button] = view.buttons();
  assert.equal(view.buttons().length, 1); assert.equal(button.className, "jdr-ninja-map-open jn-directory-button"); assert.equal(button.type, "button");
  assert.equal(button.textContent, "Import a JDR Ninja map");
  assert.equal(button.attributes["data-tooltip"], locales.en["JDRNINJA.maps.title"]); assert.equal(button.attributes["aria-label"], locales.en["JDRNINJA.maps.title"]);
  assert.deepEqual([button.children[0].tag, button.children[0].className, button.children[0].attributes["aria-hidden"]], ["i", "fa-solid fa-map", "true"]);
  assert.equal(view.rows().length, 1); assert.equal(view.rows()[0].parent, view.actions);
  assert.equal(view.actions.nodes.indexOf(view.rows()[0]), 1, "after Foundry's own button");
  for (let i = 0; i < 3; i++) renderMapButton(null, view.root);
  assert.equal(view.buttons().length, 1, "a new render replaces it"); assert.equal(view.rows().length, 1);
  view.buttons()[0].listeners.click();
  assert(MapImportPanel.instance?.rendered);
  await MapImportPanel.instance.close();
});

test("the shortcut joins the module's shared row, falls back to the footer or the root, and a player gets none", () => {
  reset();
  const shared = directory();
  const row = child(shared.actions, "jn-directory-actions"); child(row, "jdr-ninja-atlas-open jn-directory-button", "button");
  renderMapButton(null, shared.root);
  assert.equal(shared.rows().length, 1); assert.deepEqual(row.children.map(button => button.className),
    ["jdr-ninja-atlas-open jn-directory-button", "jdr-ninja-map-open jn-directory-button"]);
  const footer = directory({ header: false, footer: true });
  renderMapButton(null, footer.root);
  assert(footer.rows()[0].parent.hasClass("directory-footer")); assert.equal(footer.buttons().length, 1);
  const bare = directory({ header: false });
  renderMapButton(null, bare.root);
  assert.equal(bare.rows()[0].parent, bare.root);
  reset(locales.en, player);
  renderMapButton(null, shared.root);
  assert.equal(shared.buttons().length, 0); assert.equal(shared.rows().length, 1, "the other integration's button stays");
  renderMapButton(null, bare.root);
  assert.equal(bare.buttons().length, 0); assert.equal(bare.rows().length, 0, "no empty row is left behind");
  reset();
});

test("the shortcut is drawn whenever the Scenes directory renders", () => {
  registerMapIntegration();
  assert.equal(hooks.get("renderSceneDirectory"), renderMapButton);
});
