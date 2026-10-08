import { MODULE_ID, SETTINGS } from "../constants.js";
import { overlayRelay } from "../overlay/relay.js";
import { VariableActions, usesVariables, usesUpdates } from "../variables/dispatcher.js";
import { variableService } from "../variables/service.js";
import { buildSnapshot } from "./snapshot.js";
import { PROTOCOL_VERSION, MAX_MESSAGE_BYTES, ControlError, requireValue, normalizeBridgeUrl,
  normalizeBridgeKey, randomNonce, proof, equalProof, parseMessage, validateCommand, resultDetails } from "./protocol.js";

const HANDSHAKE_MS = 10000;
const HEARTBEAT_MS = 15000;
const SYNC_EVENTS = ["createActor", "updateActor", "deleteActor", "createMacro", "updateMacro", "deleteMacro",
  "createScene", "updateScene", "deleteScene", "createToken", "updateToken", "deleteToken",
  "createPlaylist", "updatePlaylist", "deletePlaylist", "createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound",
  "createJournalEntry", "updateJournalEntry", "deleteJournalEntry", "createJournalEntryPage", "updateJournalEntryPage",
  "deleteJournalEntryPage", "createRollTable", "updateRollTable", "deleteRollTable", "updateUser", "userConnected",
  "createCombat", "updateCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant",
  "createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "pauseGame", "targetToken", "renderSceneControls"];

export class StreamDeckBridge {
  constructor({ game = () => globalThis.game, canvas = () => globalThis.canvas, ui = () => globalThis.ui,
    config = () => globalThis.CONFIG, crypto = globalThis.crypto, socket = url => new WebSocket(url),
    setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = id => globalThis.clearTimeout(id), now = Date.now, actions = new VariableActions(), variables = variableService,
    snapshot = buildSnapshot, overlay = overlayRelay } = {}) {
    Object.assign(this, { game, canvas, ui, config, crypto, socket, setTimer, clearTimer, now, actions, snapshot, overlay, variables });
    this.changeEpoch = 0; this.extensions = {};
    this.state = "disabled";
    this.listeners = new Set();
    this.generation = 0;
    this.selectionRevision = 0;
    this.revision = 0;
    this.pending = 0;
    this.results = new Map();
    this.tail = Promise.resolve();
    this.incoming = Promise.resolve();
    this.backoff = 1000;
    this.capabilities = { overlay: { verification: "unchecked", entitled: null } };
  }
  setting(key) { return this.game()?.settings.get(MODULE_ID, SETTINGS[key]); }
  enabled() { return this.setting("streamDeckEnabled") === true; }
  status() { return { state: this.state, sessionId: this.session?.id ?? null, revision: this.revision,
    pending: this.pending, error: this.error ?? "", configured: Boolean(this.setting("streamDeckKey")) }; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(state = this.state, error = "") {
    this.state = state; this.error = error;
    for (const listener of this.listeners) { try { listener(this.status()); } catch { /* Observer cannot break transport. */ } }
  }
  identity() {
    const game = this.game();
    return `${game?.world?.id}|${game?.user?.id}|${game?.user?.role}|${game?.user?.isGM}`;
  }
  current(generation) { return this.enabled() && this.generation === generation && this.sessionIdentity === this.identity()
    && this.game()?.socket?.connected !== false; }
  stop(state = "disabled", error = "") {
    this.generation++;
    for (const timer of [this.retryTimer, this.handshakeTimer, this.syncTimer, this.heartbeatTimer, this.ackTimer]) this.clearTimer(timer);
    this.retryTimer = this.handshakeTimer = this.syncTimer = this.heartbeatTimer = null;
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); }
    this.session = null; this.key = null; this.revision = 0; this.dirty = false; this.results.clear(); this.extensions = {}; this.changeEpoch++;
    this.pending = 0; this.tail = Promise.resolve();
    this.capabilityController?.abort(); this.capabilityController = null;
    this.capabilities = { overlay: { verification: "unchecked", entitled: null } };
    this.notify(state, error);
  }
  refresh() { this.backoff = 1000; this.stop(); if (this.enabled()) this.connect(); }
  connect() {
    if (!this.enabled()) return;
    if (this.game()?.socket?.connected === false) { this.notify("unavailable", "wrongSession"); return; }
    let url, key;
    try { url = normalizeBridgeUrl(this.setting("streamDeckUrl")); key = normalizeBridgeKey(this.setting("streamDeckKey")); }
    catch (error) { this.notify("unconfigured", error.code ?? "invalidEndpoint"); return; }
    if (!this.crypto?.subtle) { this.notify("unavailable", "secureContext"); return; }
    this.key = key;
    this.sessionIdentity = this.identity();
    const game = this.game();
    if (!game?.user || !game.world) { this.notify("unavailable", "wrongSession"); return; }
    const generation = this.generation;
    this.session = { id: randomNonce(this.crypto), worldId: game.world.id, worldName: String(game.world.title ?? "").slice(0, 128),
      userId: game.user.id, userName: String(game.user.name ?? "").slice(0, 128), isGM: game.user.isGM === true,
      foundryVersion: game.version, systemId: game.system?.id, systemVersion: game.system?.version };
    this.clientNonce = randomNonce(this.crypto);
    this.notify("connecting");
    try { this.ws = this.socket(url); }
    catch { this.disconnected(generation, "connectionFailed"); return; }
    const ws = this.ws;
    this.handshakeTimer = this.setTimer(() => this.disconnected(generation, "handshakeTimeout"), HANDSHAKE_MS);
    ws.onopen = () => {
      if (!this.current(generation)) return;
      this.notify("authenticating");
      // Only the session ID before the companion proves the key: anything listening on the loopback port gets the hello.
      this.send({ type: "hello", session: { id: this.session.id }, nonce: this.clientNonce, extensions: { variables: 1, updates: 1 } });
    };
    ws.onmessage = event => {
      // Keep handshake and command admission ordered even while verifying an HMAC asynchronously.
      this.incoming = this.incoming.catch(() => {}).then(async () => {
        if (!this.current(generation)) return;
        try { await this.receive(parseMessage(event.data), generation); }
        catch (error) { if (this.current(generation)) this.disconnected(generation, error.code ?? "invalidMessage"); }
      });
    };
    ws.onclose = () => this.disconnected(generation, "connectionFailed");
    ws.onerror = () => this.disconnected(generation, "connectionFailed");
  }
  disconnected(generation, error) {
    if (generation !== this.generation) return;
    this.stop(this.enabled() ? "disconnected" : "disabled", error);
    if (!this.enabled()) return;
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, 30000);
    this.retryTimer = this.setTimer(() => this.connect(), delay);
  }
  send(message) {
    const data = JSON.stringify({ protocol: PROTOCOL_VERSION, sessionId: this.session?.id, ...message });
    requireValue(new TextEncoder().encode(data).length <= MAX_MESSAGE_BYTES, "snapshotTooLarge");
    requireValue(this.ws?.readyState === 1 && this.ws.bufferedAmount < MAX_MESSAGE_BYTES, "connectionFailed");
    this.ws.send(data);
  }
  async receive(message, generation) {
    requireValue(message.sessionId === this.session.id, "wrongSession");
    if (message.type === "challenge") {
      requireValue(this.state === "authenticating" && /^[a-f0-9]{64}$/.test(message.nonce), "invalidMessage");
      const expected = await proof(this.key, "bridge", this.session.id, this.clientNonce, message.nonce, this.crypto);
      if (!this.current(generation)) return;
      requireValue(equalProof(expected, message.proof), "authenticationFailed");
      const response = await proof(this.key, "foundry", this.session.id, this.clientNonce, message.nonce, this.crypto);
      if (!this.current(generation)) return;
      this.notify("awaitingAuthentication");
      // The companion has proved the key: world/user identity and versions travel with the module's own proof.
      const { id, ...details } = this.session;
      this.send({ type: "authenticate", proof: response, session: details }); return;
    }
    if (message.type === "authenticated") {
      requireValue(this.state === "awaitingAuthentication", "authenticationFailed");
      this.clearTimer(this.handshakeTimer); this.handshakeTimer = null;
      this.extensions = { ...(message.extensions?.variables === 1 ? { variables: 1 } : {}), ...(message.extensions?.updates === 1 ? { updates: 1 } : {}) };
      this.notify("synchronizing"); this.pushSnapshot("snapshot");
      this.lastPong = this.now(); this.heartbeat(generation); void this.verifyCapabilities(); return;
    }
    requireValue(["synchronizing", "ready"].includes(this.state), "authenticationRequired");
    if (message.type === "syncAck") {
      requireValue(Number.isInteger(message.revision) && message.revision <= this.revision, "invalidMessage");
      if (message.revision === this.revision && !this.dirty) {
        this.clearTimer(this.ackTimer); this.ackTimer = null;
        this.notify("ready"); this.backoff = 1000;
      } return;
    }
    if (message.type === "pong") { this.lastPong = this.now(); return; }
    if (message.type === "resync") { this.pushSnapshot("snapshot"); return; }
    if (message.type === "command") { this.admit(message, generation); return; }
    throw new ControlError("invalidMessage");
  }
  heartbeat(generation) {
    this.heartbeatTimer = this.setTimer(() => {
      if (!this.current(generation)) return;
      try {
        requireValue(this.now() - this.lastPong < HEARTBEAT_MS * 3, "heartbeatTimeout");
        this.send({ type: "ping" }); this.heartbeat(generation);
        if (this.now() - (this.capabilitiesCheckedAt ?? 0) >= 45000) void this.verifyCapabilities();
      } catch (error) { this.disconnected(generation, error.code ?? "connectionFailed"); }
    }, HEARTBEAT_MS);
  }
  pushSnapshot(type) {
    if (this.extensions.variables === 1) { void this.pushExtendedSnapshot(type); return; }
    this.publishSnapshot(type);
  }
  async pushExtendedSnapshot(type) {
    const generation = this.generation, epoch = this.changeEpoch;
    let variables;
    try { variables = await this.variables.projection(); }
    catch (error) { variables = { variables: [], lists: [], state: [], unavailable: error.code ?? "unavailable" }; }
    if (!this.current(generation) || epoch !== this.changeEpoch) return;
    try { this.publishSnapshot(type, variables); }
    catch (error) { this.disconnected(generation, error.code ?? "snapshotTooLarge"); }
  }
  publishSnapshot(type, variables) {
    const snapshot = this.snapshot({ game: this.game(), canvas: this.canvas(), ui: this.ui(), config: this.config(),
      selectionRevision: this.selectionRevision, overlay: this.overlay, capabilities: this.capabilities, variables, extensions: this.extensions });
    const baseRevision = this.revision++;
    this.dirty = false;
    this.notify("synchronizing");
    this.send({ type, revision: this.revision, baseRevision, ...snapshot });
    this.clearTimer(this.ackTimer);
    const generation = this.generation;
    this.ackTimer = this.setTimer(() => this.disconnected(generation, "syncTimeout"), HANDSHAKE_MS);
  }
  async verifyCapabilities() {
    if (this.capabilityController || !this.session || !["ready", "synchronizing"].includes(this.state)) return;
    const generation = this.generation, controller = new AbortController();
    this.capabilityController = controller;
    try {
      const access = this.overlay.access({ requireEnabled: false });
      if (!access.ok) this.capabilities = { overlay: { verification: "unconfigured", entitled: null } };
      else {
        this.capabilities = { overlay: { verification: "checking", entitled: null } }; this.changed();
        const response = await this.overlay.diagnostics(controller.signal);
        if (!this.current(generation) || controller.signal.aborted) return;
        const data = response.data;
        const valid = response.ok && data?.ok === true && data.tokenKind === "foundry" && typeof data.entitled === "boolean";
        this.capabilities = { overlay: { verification: valid ? "verified" : "unavailable", entitled: valid ? data.entitled : null } };
      }
      this.capabilitiesCheckedAt = this.now(); this.changed();
    } catch {
      if (this.current(generation) && !controller.signal.aborted) {
        this.capabilities = { overlay: { verification: "unavailable", entitled: null } }; this.changed();
      }
    } finally { if (this.capabilityController === controller) this.capabilityController = null; }
  }
  refreshCapabilities() {
    this.capabilityController?.abort(); this.capabilityController = null;
    this.capabilities = { overlay: { verification: "unchecked", entitled: null } };
    this.changed(); void this.verifyCapabilities();
  }
  changed({ selection = false, ownOperation = null } = {}) {
    if (!ownOperation || ownOperation !== this.variables.operation?.id) this.changeEpoch++;
    if (selection) this.selectionRevision++;
    if (!this.session) return;
    if (!this.current(this.generation)) { this.refresh(); return; }
    if (!["ready", "synchronizing"].includes(this.state)) return;
    // Invalidate command readiness immediately, before the debounced projection is sent.
    this.dirty = true;
    this.notify("synchronizing");
    this.clearTimer(this.syncTimer);
    const generation = this.generation;
    this.syncTimer = this.setTimer(() => {
      if (!this.current(generation)) return;
      if (this.variables.operation) { this.changed({ ownOperation: this.variables.operation.id }); return; }
      try { this.pushSnapshot("update"); }
      catch (error) { this.disconnected(generation, error.code ?? "snapshotTooLarge"); }
    }, 150);
  }
  admit(command, generation) {
    let guard;
    try {
      for (const [id, entry] of this.results) if (entry.code && entry.expiresAt <= this.now()) this.results.delete(id);
      requireValue(typeof command.id === "string" && command.sessionId === this.session.id, "invalidCommand");
      const fingerprint = JSON.stringify([command.action, command.parameters, command.selectionRevision, command.extensions]);
      const previous = this.results.get(command.id);
      if (previous) {
        requireValue(previous.fingerprint === fingerprint, "duplicateConflict");
        this.send({ type: "result", id: command.id, code: previous.code ?? "pending", ...(previous.details ? { details: previous.details } : {}) }); return;
      }
      requireValue(this.state === "ready", "notSynchronized");
      validateCommand(command, this.session.id, this.revision, this.now());
      requireValue(!usesVariables(command) || this.extensions.variables === 1 && command.extensions?.variables === 1, "unsupportedExtension");
      requireValue(!usesUpdates(command) || this.extensions.updates === 1 && command.extensions?.updates === 1, "unsupportedExtension");
      requireValue(this.pending < 20 && this.results.size < 256, "busy");
      const epoch = this.changeEpoch;
      guard = ({ ownOperation = null, confirmed = false } = {}) => {
        requireValue(this.current(generation), "cancelled");
        // After an explicit Yes in Foundry's own dialog, the GM's answer supersedes the deck's snapshot: table changes,
        // the synchronized revision and the command expiry no longer refuse it, but the session must still be this one.
        if (confirmed) return;
        requireValue(epoch === this.changeEpoch && (this.state === "ready" && command.revision === this.revision
          || ownOperation === command.id && this.variables.operation?.id === command.id), "staleState");
        requireValue(command.expiresAt > this.now(), "expired");
      };
      this.results.set(command.id, { fingerprint, expiresAt: this.now() + 60000 });
      this.pending++;
      this.send({ type: "accepted", id: command.id });
    } catch (error) {
      this.send({ type: "result", id: typeof command.id === "string" ? command.id.slice(0, 128) : "", code: error.code ?? "invalidCommand" });
      return;
    }
    this.tail = this.tail.catch(() => {}).then(async () => {
      let code, details;
      try { const result = await this.actions.execute(command, { guard, selectionRevision: () => this.selectionRevision }); code = result.code; details = resultDetails(result.details); }
      catch (error) { code = error instanceof ControlError ? error.code : "failed"; details = resultDetails(error.details); }
      finally { if (this.generation === generation) this.pending--; }
      if (!this.current(generation)) return;
      this.results.get(command.id).code = code;
      if (details && this.extensions.variables === 1) this.results.get(command.id).details = details;
      try { this.send({ type: "result", id: command.id, code, ...(details && this.extensions.variables === 1 ? { details } : {}) }); }
      catch { this.disconnected(generation, "connectionFailed"); return; }
      this.changed();
    });
  }
  registerHooks(hooks = globalThis.Hooks) {
    this.variables.subscribe(event => { if (!event.idle) this.changed(event); });
    for (const event of SYNC_EVENTS) hooks.on(event, () => this.variables.invalidate());
    for (const event of ["controlToken", "canvasReady", "canvasTearDown"]) hooks.on(event, () => { this.variables.invalidate(); this.changed({ selection: true }); });
    hooks.on("closeGame", () => { this.variables.invalidate(); this.stop(); });
    this.game()?.socket?.on?.("disconnect", () => { this.variables.invalidate(); this.stop("unavailable", "wrongSession"); });
    this.game()?.socket?.on?.("connect", () => { if (this.game()?.ready) { this.variables.invalidate(); this.refresh(); } });
    globalThis.window?.addEventListener("beforeunload", () => this.stop());
  }
}

export const streamDeckBridge = new StreamDeckBridge();
