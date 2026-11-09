"use strict";
// Click logging only. The 302 target is the offer's configured tracking_base
// (intended: a XenTraffic Everflow tracking link) or, if that is unset,
// destination_url. This file does not verify that Everflow, the advertiser,
// or BuyGoods receive or keep any parameter, and it does not record a sale.
//
// vid2 is attached only as the query name in metadata.param_map.vid2.
// Nothing in this repo names which Everflow field is forwarded downstream.
const crypto = require("node:crypto");
const { newId, sha256, nowIso } = require("./ids");
const { torontoDate, torontoIso } = require("./toronto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function opaqueId() {
  const bytes = crypto.randomBytes(12);
  return [...bytes].map((b) => ALPHABET[b % 32]).join("");
}

function ensureOpaque(db, kind, internalRef) {
  const existing = db
    .prepare("SELECT opaque_id FROM amu_id_map WHERE kind=? AND internal_ref=? AND revoked_at_utc IS NULL")
    .get(kind, internalRef);
  if (existing) return existing.opaque_id;
  const id = opaqueId();
  db.prepare("INSERT INTO amu_id_map VALUES(?,?,?,?,NULL)").run(id, kind, internalRef, nowIso());
  return id;
}

function vid2Value(funnel, utcMs) {
  if (!funnel) return null;
  const day = torontoDate(utcMs).slice(2).replace(/-/g, "");
  return `${funnel}-amu-${day}`.slice(0, 23);
}

function buildOutbound(base, assignments, overwriteLogical = []) {
  const url = new URL(base);
  const overwrite = new Set(overwriteLogical);
  for (const [logical, spec] of Object.entries(assignments)) {
    if (!spec || spec.value == null || spec.value === "" || !spec.name) continue;
    if (url.searchParams.has(spec.name) && !overwrite.has(logical)) continue;
    url.searchParams.set(spec.name, String(spec.value));
  }
  return url.toString();
}

function recordClick(db, post, ownerId) {
  const metadata = JSON.parse(post.metadata_json || "{}");
  const outboundBase = metadata.tracking_base || metadata.destination_url;
  const destination = new URL(outboundBase);
  const now = Date.now();
  const agentOpaque = ensureOpaque(db, "agent", post.agent_id);
  const ownerOpaque = ensureOpaque(db, "owner", ownerId);
  const contextOpaque = ensureOpaque(db, "post", post.post_id);
  const channel = /^[a-z0-9_-]{1,40}$/.test(metadata.provider || "") ? metadata.provider : "unknown";
  const minute = new Date(Math.floor(now / 60000) * 60000).toISOString();
  const dedupe = sha256([agentOpaque, post.post_id, minute].join("|"));
  const existing = db.prepare("SELECT * FROM amu_clickouts WHERE dedupe_key=?").get(dedupe);
  const clickoutId = existing?.clickout_id || newId("clk");
  const emittedVid2 = existing
    ? existing.vid2_emitted
    : vid2Value(metadata.vid2_funnel, now);
  const values = {
    sub1: agentOpaque,
    sub2: ownerOpaque,
    sub3: "amu",
    sub4: contextOpaque,
    sub5: clickoutId,
    vid2: emittedVid2,
  };
  const map = metadata.param_map || {};
  const assignments = {};
  for (const logical of Object.keys(values)) {
    if (!map[logical]) continue;
    assignments[logical] = { name: map[logical], value: values[logical] };
  }
  if (!existing) {
    db.prepare(
      `INSERT INTO amu_clickouts(clickout_id,ts_utc,ts_toronto,channel,offer_network_id,vertical,agent_opaque_id,owner_opaque_id,source_tag,context_opaque_id,destination_host,vid2_emitted,sub1,sub2,sub3,sub4,sub5,dedupe_key)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      clickoutId,
      new Date(now).toISOString(),
      torontoIso(now),
      channel,
      null,
      metadata.vertical || null,
      agentOpaque,
      ownerOpaque,
      "amu",
      contextOpaque,
      destination.hostname,
      map.vid2 ? emittedVid2 : null,
      values.sub1,
      values.sub2,
      values.sub3,
      values.sub4,
      values.sub5,
      dedupe,
    );
  }
  return buildOutbound(outboundBase, assignments, metadata.param_overwrite || []);
}

function installClickouts(app, db) {
  app.get("/api/community/offers/:post_id/click", (req, res, next) => {
    try {
      const post = db
        .prepare(
          "SELECT p.*, a.owner_id FROM posts p JOIN agents a USING(agent_id) WHERE p.post_id=? AND p.deleted_at IS NULL AND p.hidden_at IS NULL",
        )
        .get(req.params.post_id);
      if (!post || post.type !== "offer") return res.status(404).json({ ok: false, error: "not_found" });
      const location = recordClick(db, post, post.owner_id);
      if (location.includes("@") && location.includes(post.owner_id)) {
        return res.status(500).json({ ok: false, error: "internal_error" });
      }
      res.redirect(302, location);
    } catch (e) {
      next(e);
    }
  });
}

module.exports = { installClickouts, ensureOpaque, buildOutbound };
