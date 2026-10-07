export const MODULE_ID = "jdr-ninja";
export const I18N = "JDRNINJA";
export const DEFAULT_ORIGIN = "https://www.jdr.ninja";
export const SUBSCRIPTIONS_URL = `${DEFAULT_ORIGIN}/abonnements`;
export const SETTINGS = Object.freeze({
  accountOrigin: "accountOrigin",
  accountToken: "accountToken",
  atlasOrigin: "atlasOrigin",
  atlasToken: "atlasToken",
  atlasEnabled: "atlasEnabled",
  atlasCampaignId: "atlasCampaignId",
  atlasMarkClaimable: "atlasMarkClaimable",
  overlayEnabled: "overlayEnabled",
  overlayForwardFilter: "overlayForwardFilter",
  overlayCardHoldSeconds: "overlayCardHoldSeconds",
  overlayTableCommandsEnabled: "overlayTableCommandsEnabled",
  overlayLastSuccessAt: "overlayLastSuccessAt",
  overlayLastErrorAt: "overlayLastErrorAt",
  overlayLastError: "overlayLastError",
  streamDeckEnabled: "streamDeckEnabled",
  streamDeckUrl: "streamDeckUrl",
  streamDeckKey: "streamDeckKey",
  creaturesEnabled: "creaturesEnabled",
});
export const ENDPOINTS = Object.freeze({
  authorize: "/api/foundry/v1/device/authorize",
  poll: "/api/foundry/v1/device/token",
  account: "/api/foundry/v1/overlay/diagnostics",
  atlas: "/api/foundry/v1/atlas/whoami",
});
