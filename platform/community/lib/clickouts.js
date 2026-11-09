"use strict";
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

function channelFor(url) {
  const host = url.hostname.toLowerCase();
  if (host.includes("ringba")) return "ringba";
  if (host.includes("buygoods")) return "oo_buygoods";
  if (host.includes("everflow")) return "everflow";
  return "other";
}

function vid2(channel, utcMs) {
  if (channel !== "oo_buygoods") return null;
  const day = torontoDate(utcMs).slice(2).replace(/-/g, "");
  return `oo-amu-${day}`.slice(0, 23);
}

function recordClick(db, post, ownerId) {
  const metadata = JSON.parse(post.metadata_json || "{}");
  const destination = new URL(metadata.destination_url);
  const now = Date.now();
  const agentOpaque = ensureOpaque(db, "agent", post.agent_id);
  const ownerOpaque = ensureOpaque(db, "owner", ownerId);
  const contextOpaque = ensureOpaque(db, "post", post.post_id);
  const channel = channelFor(destination);
  const minute = new Date(Math.floor(now / 60000) * 60000).toISOString();
  const dedupe = sha256([agentOpaque, post.post_id, minute].join("|"));
  const existing = db.prepare("SELECT * FROM amu_clickouts WHERE dedupe_key=?").get(dedupe);
  const clickoutId = existing?.clickout_id || newId("clk");
  const sub = {
    sub1: agentOpaque,
    sub2: ownerOpaque,
    sub3: "amu",
    sub4: contextOpaque,
    sub5: clickoutId,
  };
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
      vid2(channel, now),
      sub.sub1,
      sub.sub2,
      sub.sub3,
      sub.sub4,
      sub.sub5,
      dedupe,
    );
  }
  for (const [key, value] of Object.entries(sub)) destination.searchParams.set(key, value);
  return destination.toString();
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

module.exports = { installClickouts, ensureOpaque };
