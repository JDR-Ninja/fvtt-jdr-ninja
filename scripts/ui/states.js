import { MODULE_ID, I18N, SETTINGS, DEFAULT_ORIGIN } from "../constants.js";
import { normalizeOrigin } from "../auth/origin.js";

/*
 * The state of the account and of every feature, shared by the Connections window and each feature's own window: one
 * state, one pill, one label, whichever window shows it. Each block derives a state, a pill and at most one step from
 * plain data here, so the templates only render what they receive and the tests need no rendering.
 * A step is one sentence with at most one button or link; a failure is an alert, anything else a status.
 */
const text = key => game.i18n.localize(`${I18N}.${key}`);
const CT = key => text(`creatures.${key}`);
const creatureMessage = code => CT(`error.${code}`);

/** Icon of each pill level. The text always accompanies it: the colour never carries a state alone. */
export const PILL_ICONS = Object.freeze({ success: "fa-circle-check", warning: "fa-triangle-exclamation", error: "fa-circle-xmark",
  info: "fa-circle-info", neutral: "fa-circle-minus" });
/** The icon of a state on its way somewhere: checking, connecting, loading. */
export const PROGRESS_ICON = "fa-spinner fa-spin";

export const pill = (level, label, icon = PILL_ICONS[level]) => ({ level, icon, label });
export const step = (level, sentence, extra = {}) => ({ level, role: level === "error" ? "alert" : "status", text: sentence, ...extra });
export const control = (name, label, icon, variant = "") => ({ name, label, icon, variant });

/** Subscriptions are offered on the saved site address; the overlay has its own offers page. */
const SUBSCRIPTION_PATHS = Object.freeze({ overlay: "/vtt-overlay/abonnement" });
export function subscriptionsUrl(kind) {
  let origin = DEFAULT_ORIGIN;
  try { origin = normalizeOrigin(game.settings?.get(MODULE_ID, SETTINGS.accountOrigin) || DEFAULT_ORIGIN); } catch { /* default site */ }
  return `${origin}${SUBSCRIPTION_PATHS[kind] ?? "/abonnements"}`;
}
/** The one subscriptions link, « Consulter les abonnements », whatever the feature. */
export const subscriptions = kind => ({ href: subscriptionsUrl(kind), label: text("creatures.subscription"), kind });

const disabledState = () => ({ state: "disabled", pill: pill("neutral", text("panel.state.disabled")), step: null });
const checkingState = () => ({ state: "checking", pill: pill("info", text("panel.state.checking"), PROGRESS_ICON), step: null });
const accountRequired = () => ({ state: "accountRequired", pill: pill("warning", text("panel.state.accountRequired")),
  step: step("warning", text("panel.step.connectAccount")) });

/** A refused token, or an answer that is not a Foundry account, needs a new connection; any other failure can be retried. */
const ACCOUNT_REJECTED = new Set(["unauthorized", "invalidResponse"]);
/**
 * What is known of the saved account credential: `none`, `checking`, `verified`, failed (`retry` or `reconnect`), or
 * `unchecked` while no answer describes it. The features that need the account follow this state.
 */
export function accountStatus({ configured, result = null, checking = false }) {
  if (checking) return "checking";
  if (!configured) return "none";
  if (result?.ok) return "verified";
  if (result && result.reason !== "unconfigured") return ACCOUNT_REJECTED.has(result.reason) ? "reconnect" : "retry";
  return "unchecked";
}

const ACCOUNT_PILLS = Object.freeze({ none: ["neutral", "status.disconnected"], verified: ["success", "status.connected"],
  retry: ["error", "panel.state.error"], reconnect: ["error", "panel.state.error"], unchecked: ["warning", "status.saved"] });
/**
 * The account banner: its pill, the account name once verified, the failure message and the actions of the state.
 * A pairing or pasted token that failed (`error`) is shown without changing what is known of the saved credential.
 */
export function accountState({ configured, result = null, checking = false, pairing = false, error = "" }) {
  const status = accountStatus({ configured, result, checking }), state = pairing ? "pairing" : status;
  const actions = {
    none: [control("pair", text("account.connect"), "fa-link", "bright")], pairing: [], checking: [],
    verified: [control("pair", text("account.change"), "fa-link")], retry: [control("checkAccount", text("button.retry"), "fa-rotate")],
    reconnect: [control("pair", text("button.reconnect"), "fa-link")], unchecked: [control("checkAccount", text("button.check"), "fa-rotate")],
  }[state];
  // Disconnecting stays possible while a token is saved, failures included.
  if (configured && state !== "pairing") actions.push(control("disconnectAccount", text("button.disconnect"), "fa-link-slash", "jn-danger"));
  const [level, key] = ACCOUNT_PILLS[state] ?? [];
  return { state, status, actions, label: state === "verified" ? result.label : "",
    pill: state === "pairing" ? pill("info", text("panel.state.pending"), "fa-hourglass-half") : state === "checking" ? checkingState().pill : pill(level, text(key)),
    intro: state === "none" ? text("account.needed") : "", link: state === "none" ? subscriptions("account") : null,
    error: error || (state === "retry" || state === "reconnect" ? text(`error.${result.reason}`) : "") };
}

/**
 * The pill level of every Stream Deck bridge state. Ready is a success, a state on its way to ready is in progress, a
 * switched-off bridge is neutral and any state that stopped short of ready needs the user's attention.
 */
export const STREAM_DECK_LEVELS = Object.freeze({
  ready: "success",
  connecting: "warning", authenticating: "warning", awaitingAuthentication: "warning", synchronizing: "warning",
  disabled: "neutral",
  unconfigured: "error", disconnected: "error", unavailable: "error",
});
/** The pill of a bridge state: its level, an icon and the localized state name. */
export function streamDeckPill(state) {
  const level = STREAM_DECK_LEVELS[state] ?? "neutral";
  return { level, icon: level === "warning" ? PROGRESS_ICON : PILL_ICONS[level], label: text(`streamDeck.state.${state}`) };
}
/** Repaints a rendered pill in place: a live status change must never re-render, and so erase, a form being edited. */
export function paintStreamDeckPill(element, state) {
  if (!element) return;
  const { level, icon, label } = streamDeckPill(state);
  element.className = `jn-pill jn-pill--${level}`;
  const glyph = element.querySelector("[data-pill-icon]"), caption = element.querySelector("[data-pill-text]");
  if (glyph) glyph.className = `fa-solid ${icon}`;
  if (caption) caption.textContent = label;
}

/** The Stream Deck row: the bridge's own pill, repainted live, and the one step a missing companion key needs. */
export function streamDeckState(bridgeState) {
  return { state: bridgeState, pill: streamDeckPill(bridgeState),
    step: bridgeState === "unconfigured" ? step("warning", text("panel.step.streamDeckKey")) : null };
}

/**
 * The overlay sends this browser's public rolls with the account: it needs the account verified and a subscription.
 * A state that needs the account again says whether it must be reconnected (`reason: "reconnect"`) or checked again.
 */
export function overlayState({ enabled, legacy = false, account, allowed = false }) {
  if (!enabled) return disabledState();
  if (legacy) return { state: "unavailable", pill: pill("error", text("panel.state.unavailable")), step: step("error", text("overlay.error.legacyActive")) };
  if (account === "none") return accountRequired();
  if (account === "checking") return checkingState();
  if (account === "verified") {
    return allowed ? { state: "active", pill: pill("success", text("panel.state.active")), step: null }
      : { state: "subscriptionRequired", pill: pill("warning", text("panel.state.subscriptionRequired")),
        step: step("warning", text("overlay.error.notEntitled"), { link: subscriptions("overlay") }) };
  }
  const reconnect = account === "reconnect";
  return { state: "attention", reason: reconnect ? "reconnect" : "check", pill: pill("warning", text("panel.state.attention")),
    step: step("warning", text(reconnect ? "panel.step.reconnectAccount" : "panel.step.checkAccount")) };
}

/** Server answers that need the account reconnected rather than a new check. */
const CREATURE_RECONNECT = new Set(["unauthorized", "wrongDeviceKind"]);
/**
 * The generators row. A system that cannot import comes first (another game system is an error, an untested version
 * warns), then the local switch and account, then the access the server reported. Only a missing device permission
 * offers `pairCreatures`; an available service has an information line and no button.
 */
export function creatureState({ compatibility, restriction = null, access = null, result = null, checking = false }) {
  if (compatibility?.compatible === false) {
    const level = compatibility.code === "dndRequired" ? "error" : "warning";
    return { state: "incompatible", pill: pill(level, compatibility.label),
      step: step(level, compatibility.current, { detail: CT("error.incompatibleSystem") }) };
  }
  if (restriction === "disabled" || restriction === "notGM") return disabledState();
  if (restriction === "connectionRequired") return accountRequired();
  if (checking) return checkingState();
  // A grant wins over an older failure of this window; a failure of this window wins over a refusal reported elsewhere.
  const reason = access?.allowed ? "available" : result?.ok === false ? result.reason
    : access ? access.reason || "verificationUnavailable" : "notChecked";
  if (reason === "available") return { state: reason, pill: pill("success", CT("status.available")), step: step("info", text("panel.step.creaturesAvailable")) };
  if (reason === "devicePermissionRequired") {
    return { state: reason, pill: pill("warning", text("panel.state.permissionRequired")),
      step: step("warning", text("panel.step.devicePermission"), { action: control("pairCreatures", text("creatures.authorize"), "fa-key") }) };
  }
  if (reason === "tierRequired") {
    return { state: reason, pill: pill("warning", text("panel.state.subscriptionRequired")),
      step: step("warning", creatureMessage(reason), { link: subscriptions("creatures") }) };
  }
  if (reason === "notChecked") {
    return { state: reason, pill: pill("neutral", text("status.saved")),
      step: step("info", "", { action: control("checkCreatures", text("button.check"), "fa-rotate") }) };
  }
  if (CREATURE_RECONNECT.has(reason)) {
    return { state: "attention", reason: "reconnect", pill: pill("warning", text("panel.state.attention")), step: step("warning", text("panel.step.reconnectAccount")) };
  }
  return { state: "unavailable", pill: pill("error", text("panel.state.unavailable")),
    step: step("error", creatureMessage(reason), { action: control("checkCreatures", text("button.retry"), "fa-rotate") }) };
}

/**
 * The Atlas row, shared by every GM of the world. The token field sits in the row while a token is missing or refused.
 * A pasted token that failed (`error`) replaces the sentence of the step without changing the state of the saved one.
 */
export function atlasState({ enabled, notice = "", configured, result = null, checking = false, error = "" }) {
  const row = notice ? { state: "unavailable", pill: pill("error", text("panel.state.unavailable")), step: step("error", notice) }
    : !enabled ? disabledState()
    : checking ? checkingState()
    : !configured ? { state: "tokenRequired", pill: pill("warning", text("panel.state.tokenRequired")), step: step("warning", "", { field: true }) }
    : result?.ok && result.allowed ? { state: "connected", pill: pill("success", text("status.connected")), step: null }
    : result?.ok ? { state: "subscriptionRequired", pill: pill("warning", text("panel.state.subscriptionRequired")),
      step: step("warning", text("atlas.limited"), { link: subscriptions("atlas") }) }
    : result?.reason === "unauthorized" ? { state: "rejected", pill: pill("error", text("panel.state.error")), step: step("error", text("error.unauthorized"), { field: true }) }
    : result && result.reason !== "unconfigured" ? { state: "failed", pill: pill("error", text("panel.state.error")),
      step: step("error", text(`error.${result.reason}`), { action: control("checkAtlas", text("button.retry"), "fa-rotate") }) }
    : { state: "unchecked", pill: pill("warning", text("status.saved")), step: step("info", "", { action: control("checkAtlas", text("button.check"), "fa-rotate") }) };
  if (error) row.step = { ...row.step, ...step("error", error) };
  return { ...row, label: result?.ok ? result.label : "" };
}

/** « Configurer les connexions »: the one way back to Connections, offered only by a window that a connection blocks. */
export const connectionsAction = () => control("connections", text("menu.label"), "fa-link");

/** States in which a feature works: its window shows no step. */
const WORKING = new Set(["active", "available", "connected", "ready"]);
/** Actions only Connections performs in place. */
const CONNECTIONS_ONLY = new Set(["pair", "pairCreatures", "checkAccount", "checkAtlas", "checkCreatures"]);
/**
 * A Connections row as a feature window shows it (the brief's « ligne d'état »). The pill is the row's own. What
 * Connections does in place (connect, reconnect, authorize) becomes « Configurer les connexions »; a check that can be
 * retried goes through the window's own `retry` control, with the failure `message` the window received: the action
 * keeps its own label and icon (a check stays « Vérifier la connexion », a retry stays « Réessayer ») and only its name
 * comes from the window. A saved credential nothing has answered for yet reads « À vérifier » with that check. A working
 * state has no step. The Connections steps say « above »: the window says where instead.
 */
export function windowState(row, { retry = null, message = "" } = {}) {
  const toConnections = (level, key) => ({ ...row, step: step(level, text(key), { action: connectionsAction() }) });
  if (row.state === "disabled") return toConnections("info", "notice.disabled");
  if (row.state === "accountRequired") return toConnections("warning", "notice.connectAccount");
  if (row.state === "devicePermissionRequired") return toConnections("warning", "panel.step.devicePermission");
  if (row.state === "attention") {
    if (row.reason === "reconnect") return toConnections("warning", "notice.reconnectAccount");
    if (!message) {
      return { ...row, pill: pill("warning", text("status.saved")),
        step: retry ? step("info", "", { action: { ...retry, label: text("button.check") } }) : null };
    }
    return { ...row, step: step("error", message, retry ? { action: retry } : {}) };
  }
  if (WORKING.has(row.state)) return { ...row, step: null };
  if (!row.step?.action || !CONNECTIONS_ONLY.has(row.step.action.name)) return row;
  const { action, ...rest } = row.step;
  return { ...row, step: retry ? { ...rest, action: { ...action, name: retry.name } } : rest };
}
