"use strict";
const { setting, jsonSetting } = require("./settings");

const ASSET_KINDS = [
  "landing_page",
  "email",
  "social",
  "search",
  "native",
  "other",
];
const SEEKING = [
  "feedback",
  "partners_discussion",
  "creatives_discussion",
  "compliance_review",
  "other",
];
const CLIENT_KEYS = [
  "schema_version",
  "headline",
  "vertical",
  "destination_url",
  "network_name",
  "advertiser_name",
  "geo_scope",
  "asset_kinds",
  "seeking",
  "disclosure_ack",
  "provider",
  "tracking_base",
  "param_map",
  "param_overwrite",
  "vid2_funnel",
];
const PARAM_KEYS = ["sub1", "sub2", "sub3", "sub4", "sub5", "vid2"];

function fail(message) {
  const e = Error(message);
  e.status = 422;
  throw e;
}

function disclosureTemplate(db) {
  return (
    process.env.COMMUNITY_OFFER_DISCLOSURE ||
    setting(
      db,
      "offer_disclosure",
      "Offer discussion — no payouts, caps, or confidential terms. {kind}: {name}.",
    )
  );
}

function fillDisclosure(db, metadata) {
  const kind = metadata.advertiser_name ? "advertiser" : "network";
  const name = metadata.advertiser_name || metadata.network_name;
  const label = disclosureTemplate(db)
    .replaceAll("{kind}", kind === "advertiser" ? "Advertiser" : "Network")
    .replaceAll("{name}", name);
  return { kind, name, label };
}

function scanBanned(db, text) {
  const patterns = jsonSetting(db, "offer_banned_patterns", []);
  const hay = String(text || "");
  for (const source of patterns) {
    let re;
    try {
      re = new RegExp(source, "i");
    } catch {
      continue;
    }
    if (re.test(hay)) fail("offer_terms_not_allowed");
  }
}

function validateOffer(db, raw, body) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_offer_metadata");
  const unknown = Object.keys(raw).filter((k) => !CLIENT_KEYS.includes(k));
  if (unknown.length) fail("unknown_offer_field");
  if (raw.schema_version !== "offer.v1") fail("invalid_offer_schema");
  if (raw.disclosure_ack !== true) fail("disclosure_required");
  const headline = String(raw.headline || "").trim();
  if (headline.length < 1 || headline.length > 120) fail("invalid_offer_headline");
  const verticals = jsonSetting(db, "offer_verticals", []);
  if (!verticals.includes(raw.vertical)) fail("invalid_vertical");
  let destination;
  try {
    destination = new URL(String(raw.destination_url || ""));
  } catch {
    fail("invalid_destination_url");
  }
  if (destination.protocol !== "https:") fail("invalid_destination_url");
  if (destination.username || destination.password) fail("invalid_destination_url");
  if (String(raw.destination_url).length > 2048) fail("invalid_destination_url");
  const network = raw.network_name == null ? "" : String(raw.network_name).trim();
  const advertiser = raw.advertiser_name == null ? "" : String(raw.advertiser_name).trim();
  if (!network && !advertiser) fail("disclosure_required");
  if (network && (network.length < 1 || network.length > 80)) fail("invalid_network_name");
  if (advertiser && (advertiser.length < 1 || advertiser.length > 80))
    fail("invalid_advertiser_name");
  let geo = [];
  if (raw.geo_scope != null) {
    if (!Array.isArray(raw.geo_scope) || raw.geo_scope.length > 30) fail("invalid_geo_scope");
    geo = raw.geo_scope.map((g) => String(g).toUpperCase());
    if (geo.some((g) => !/^[A-Z]{2}$/.test(g))) fail("invalid_geo_scope");
  }
  let assets = [];
  if (raw.asset_kinds != null) {
    if (!Array.isArray(raw.asset_kinds) || raw.asset_kinds.length > 8) fail("invalid_asset_kinds");
    assets = raw.asset_kinds;
    if (assets.some((a) => !ASSET_KINDS.includes(a))) fail("invalid_asset_kinds");
  }
  if (raw.seeking != null && !SEEKING.includes(raw.seeking)) fail("invalid_seeking");
  let provider = "unknown";
  if (raw.provider != null && raw.provider !== "") {
    provider = String(raw.provider).trim();
    if (!/^[a-z0-9_-]{1,40}$/.test(provider)) fail("invalid_provider");
  }
  let trackingBase = null;
  if (raw.tracking_base != null && raw.tracking_base !== "") {
    let tracked;
    try {
      tracked = new URL(String(raw.tracking_base));
    } catch {
      fail("invalid_tracking_base");
    }
    if (tracked.protocol !== "https:" || tracked.username || tracked.password) fail("invalid_tracking_base");
    if (String(raw.tracking_base).length > 2048) fail("invalid_tracking_base");
    trackingBase = tracked.toString();
  }
  let paramMap = null;
  if (raw.param_map != null) {
    if (typeof raw.param_map !== "object" || Array.isArray(raw.param_map)) fail("invalid_param_map");
    const extra = Object.keys(raw.param_map).filter((key) => !PARAM_KEYS.includes(key));
    if (extra.length) fail("invalid_param_map");
    paramMap = {};
    for (const key of PARAM_KEYS) {
      if (raw.param_map[key] == null || raw.param_map[key] === "") continue;
      const name = String(raw.param_map[key]);
      if (!/^[A-Za-z0-9_]{1,40}$/.test(name)) fail("invalid_param_map");
      paramMap[key] = name;
    }
  }
  let overwrite = [];
  if (raw.param_overwrite != null) {
    if (!Array.isArray(raw.param_overwrite)) fail("invalid_param_overwrite");
    if (raw.param_overwrite.some((key) => !PARAM_KEYS.includes(key))) fail("invalid_param_overwrite");
    overwrite = [...new Set(raw.param_overwrite)];
  }
  let vid2Funnel = null;
  if (raw.vid2_funnel != null && raw.vid2_funnel !== "") {
    vid2Funnel = String(raw.vid2_funnel).trim();
    if (!/^[a-z0-9]{1,8}$/.test(vid2Funnel)) fail("invalid_vid2_funnel");
  }
  if (paramMap && paramMap.vid2 && !vid2Funnel) fail("vid2_funnel_required");
  const metadata = {
    schema_version: "offer.v1",
    headline,
    vertical: raw.vertical,
    destination_url: destination.toString(),
    disclosure_ack: true,
    provider,
  };
  if (trackingBase) metadata.tracking_base = trackingBase;
  if (paramMap && Object.keys(paramMap).length) metadata.param_map = paramMap;
  if (overwrite.length) metadata.param_overwrite = overwrite;
  if (vid2Funnel) metadata.vid2_funnel = vid2Funnel;
  if (network) metadata.network_name = network;
  if (advertiser) metadata.advertiser_name = advertiser;
  if (geo.length) metadata.geo_scope = geo;
  if (assets.length) metadata.asset_kinds = assets;
  if (raw.seeking) metadata.seeking = raw.seeking;
  const blob = [body, headline, network, advertiser, raw.destination_url, raw.vertical].join("\n");
  scanBanned(db, blob);
  const disclosure = fillDisclosure(db, metadata);
  if (/operated by/i.test(disclosure.label)) fail("invalid_disclosure_copy");
  return { metadata, disclosure };
}

function offerFromRow(db, row) {
  if (!row || row.type !== "offer") return null;
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || "{}");
  } catch {
    metadata = {};
  }
  if (!metadata.network_name && !metadata.advertiser_name) return null;
  const disclosure = fillDisclosure(db, metadata);
  return { metadata, disclosure };
}

module.exports = { validateOffer, offerFromRow, fillDisclosure };
