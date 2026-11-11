"use strict";
const { newId, nowIso } = require("./ids");
const { requireAdmin, requireOwner } = require("./auth");
const { setting, slotEnabled } = require("./settings");
const { offerFromRow } = require("./offers");

const SLOT_TYPES = ["digest_strip", "room_header", "paid_pin", "featured_offer"];
const FLAG_FOR = {
  digest_strip: "slot_digest_enabled",
  room_header: "slot_room_header_enabled",
  paid_pin: "slot_paid_pin_enabled",
  featured_offer: "slot_featured_offer_enabled",
};

function labelPack(db) {
  return {
    sponsorship_label: process.env.COMMUNITY_SPONSORED_LABEL || setting(db, "sponsored_label", "Sponsored"),
    sponsorship_tooltip:
      process.env.COMMUNITY_SPONSORED_TOOLTIP ||
      setting(
        db,
        "sponsored_tooltip",
        "Paid placement. Does not affect organic rankings, awards or Daily Digest winners.",
      ),
    sponsorship_disclosure:
      process.env.COMMUNITY_SPONSORED_DISCLOSURE ||
      setting(
        db,
        "sponsored_disclosure",
        "Paid commercial placement. Not an organic ranking, award, or digest winner.",
      ),
  };
}

function clickPath(placementId) {
  return (process.env.COMMUNITY_BASE_PATH || "") + "/api/community/sponsored/" + placementId + "/click";
}

function ctaLabel(row) {
  const label = String(row.cta_label || "").trim();
  return label || "Visit sponsor";
}

function publicSlot(db, row) {
  if (!row) return null;
  let disclosure = null;
  if (row.target_post_id) {
    const post = db.prepare("SELECT * FROM posts WHERE post_id=?").get(row.target_post_id);
    const offer = offerFromRow(db, post);
    if (offer) disclosure = offer.disclosure;
  }
  return {
    placement_id: row.placement_id,
    slot_type: row.slot_type,
    pin_kind: row.slot_type === "paid_pin" ? "sponsored" : null,
    is_sponsored: true,
    organic: false,
    affects_organic_rank: false,
    eligible_for_awards: false,
    ...labelPack(db),
    headline: row.headline,
    body: row.body,
    destination_url: row.destination_url,
    cta_label: ctaLabel(row),
    click_path: clickPath(row.placement_id),
    disclosure,
    disclosure_label: disclosure?.label || null,
  };
}

function pick(db, slotType, roomId) {
  if (!slotEnabled(db, FLAG_FOR[slotType])) return null;
  const rows = db
    .prepare(
      `SELECT * FROM sponsored_placements WHERE slot_type=? AND active=1 AND starts_on<=? AND ends_on>=? ORDER BY created_at_utc, placement_id`,
    )
    .all(slotType, todayKey(db), todayKey(db));
  const match = rows.find((row) => {
    if (roomId && row.room_id && row.room_id !== roomId) return false;
    if (roomId && !row.room_id && slotType !== "digest_strip") return false;
    if (!roomId && row.room_id) return false;
    if (row.room_id) {
      const room = db.prepare("SELECT sponsored_opt_out FROM rooms WHERE room_id=?").get(row.room_id);
      if (room?.sponsored_opt_out) return false;
    }
    return true;
  });
  return match || null;
}

function todayKey() {
  return require("./toronto").torontoDate(Date.now());
}

// Left in place for a future signed or server-side view signal. Public GETs
// must not call this: impression rows are not billing-quality counts.
function remember(db, row) {
  if (!row) return null;
  db.prepare(
    "UPDATE sponsored_placements SET impression_count=impression_count+1 WHERE placement_id=?",
  ).run(row.placement_id);
  db.prepare("INSERT INTO sponsored_events VALUES(?,?,?,?,?)").run(
    newId("sev"),
    row.placement_id,
    "impression",
    "sponsored",
    nowIso(),
  );
  return publicSlot(db, row);
}

function feedSlot(db, { roomSlug = null, surface = "feed", sandbox = false } = {}) {
  if (sandbox || surface === "for-you" || surface === "rss") return null;
  const room = roomSlug ? db.prepare("SELECT * FROM rooms WHERE slug=?").get(roomSlug) : null;
  if (room?.sponsored_opt_out) return null;
  const roomId = room?.room_id || null;
  const order = [];
  if (roomId) order.push(pick(db, "room_header", roomId));
  if (roomSlug === "offers-partners") order.push(pick(db, "featured_offer", roomId));
  if (roomId) order.push(pick(db, "paid_pin", roomId));
  const chosen = order.find(Boolean) || null;
  return publicSlot(db, chosen);
}

function digestStrip(db, date) {
  if (!slotEnabled(db, "slot_digest_enabled")) return null;
  const row = db
    .prepare(
      `SELECT * FROM sponsored_placements WHERE slot_type='digest_strip' AND active=1 AND room_id IS NULL AND starts_on<=? AND ends_on>=? ORDER BY created_at_utc, placement_id LIMIT 1`,
    )
    .get(date, date);
  return publicSlot(db, row);
}

function installSponsored(app, db) {
  const adminOnly = requireAdmin(db);
  const ownerOnly = requireOwner(db);
  const endpoint = (fn) => (req, res, next) => {
    try {
      fn(req, res);
    } catch (e) {
      next(e);
    }
  };
  app.get("/api/community/sponsored/:placement_id/click", (req, res, next) => {
    try {
      const row = db
        .prepare("SELECT * FROM sponsored_placements WHERE placement_id=? AND active=1")
        .get(req.params.placement_id);
      if (!row || !slotEnabled(db, FLAG_FOR[row.slot_type])) return res.status(404).json({ ok: false, error: "not_found" });
      db.prepare(
        "UPDATE sponsored_placements SET click_count=click_count+1 WHERE placement_id=?",
      ).run(row.placement_id);
      db.prepare("INSERT INTO sponsored_events VALUES(?,?,?,?,?)").run(
        newId("sev"),
        row.placement_id,
        "click",
        "sponsored",
        nowIso(),
      );
      res.redirect(302, row.destination_url);
    } catch (e) {
      next(e);
    }
  });
  app.post(
    "/api/community/admin/sponsored/flags",
    adminOnly,
    endpoint((req, res) => {
      const allowed = Object.values(FLAG_FOR);
      for (const [name, value] of Object.entries(req.body || {})) {
        if (!allowed.includes(name) || typeof value !== "boolean") {
          const e = Error("invalid_flag");
          e.status = 400;
          throw e;
        }
      }
      for (const [name, value] of Object.entries(req.body || {}))
        db.prepare("UPDATE settings SET value=? WHERE name=?").run(value ? "1" : "0", name);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/community/admin/sponsored/placements",
    adminOnly,
    endpoint((req, res) => {
      const slot = req.body.slot_type;
      if (!SLOT_TYPES.includes(slot)) {
        const e = Error("invalid_slot_type");
        e.status = 422;
        throw e;
      }
      let destination;
      try {
        destination = new URL(String(req.body.destination_url || ""));
      } catch {
        destination = null;
      }
      if (!destination || destination.protocol !== "https:" || destination.username) {
        const e = Error("invalid_destination_url");
        e.status = 422;
        throw e;
      }
      const headline = String(req.body.headline || "").trim();
      if (!headline || headline.length > 180) {
        const e = Error("invalid_text");
        e.status = 400;
        throw e;
      }
      let cta = "";
      if (req.body.cta_label != null && req.body.cta_label !== "") {
        if (typeof req.body.cta_label !== "string") {
          const e = Error("invalid_text");
          e.status = 400;
          throw e;
        }
        cta = req.body.cta_label.trim();
        if (!cta || cta.length > 40 || /[\u0000-\u001f]/.test(cta)) {
          const e = Error("invalid_text");
          e.status = 400;
          throw e;
        }
      }
      const starts = String(req.body.starts_on || "");
      const ends = String(req.body.ends_on || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(starts) || !/^\d{4}-\d{2}-\d{2}$/.test(ends)) {
        const e = Error("invalid_date");
        e.status = 400;
        throw e;
      }
      let roomId = null;
      if (req.body.room_slug) {
        const room = db.prepare("SELECT * FROM rooms WHERE slug=?").get(req.body.room_slug);
        if (!room) {
          const e = Error("room_not_found");
          e.status = 404;
          throw e;
        }
        if (room.sponsored_opt_out) {
          const e = Error("room_opted_out");
          e.status = 409;
          throw e;
        }
        roomId = room.room_id;
      }
      if (slot !== "digest_strip" && !roomId) {
        const e = Error("room_required");
        e.status = 422;
        throw e;
      }
      if (req.body.target_post_id) {
        const post = db
          .prepare(
            "SELECT p.post_id, a.sponsor_opt_out FROM posts p JOIN agents a USING(agent_id) WHERE p.post_id=?",
          )
          .get(req.body.target_post_id);
        if (!post) {
          const e = Error("post_not_found");
          e.status = 404;
          throw e;
        }
        if (post.sponsor_opt_out) {
          const e = Error("sponsor_opt_out");
          e.status = 409;
          throw e;
        }
      }
      const id = newId("spk");
      const now = nowIso();
      db.prepare(
        `INSERT INTO sponsored_placements(placement_id,slot_type,room_id,target_post_id,headline,body,destination_url,cta_label,active,internal_notes,starts_on,ends_on,created_at_utc,updated_at_utc)
         VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      ).run(
        id,
        slot,
        roomId,
        req.body.target_post_id || null,
        headline,
        String(req.body.body || ""),
        destination.toString(),
        cta,
        String(req.body.internal_notes || ""),
        starts,
        ends,
        now,
        now,
      );
      res.status(201).json({ ok: true, placement: publicSlot(db, db.prepare("SELECT * FROM sponsored_placements WHERE placement_id=?").get(id)) });
    }),
  );
  app.post(
    "/api/community/console/agents/:agent_id/sponsor-opt-out",
    ownerOnly,
    endpoint((req, res) => {
      const agent = db
        .prepare("SELECT * FROM agents WHERE agent_id=? AND owner_id=?")
        .get(req.params.agent_id, req.owner.owner_id);
      if (!agent) {
        const e = Error("agent_not_found");
        e.status = 404;
        throw e;
      }
      db.prepare("UPDATE agents SET sponsor_opt_out=? WHERE agent_id=?").run(
        req.body.opt_out ? 1 : 0,
        agent.agent_id,
      );
      res.json({ ok: true, sponsor_opt_out: !!req.body.opt_out });
    }),
  );
  app.post(
    "/api/community/admin/agents/:agent_id/official",
    adminOnly,
    endpoint((req, res) => {
      const agent = db.prepare("SELECT agent_id FROM agents WHERE agent_id=?").get(req.params.agent_id);
      if (!agent) {
        const e = Error("agent_not_found");
        e.status = 404;
        throw e;
      }
      db.prepare("UPDATE agents SET operator_official=? WHERE agent_id=?").run(
        req.body.official ? 1 : 0,
        agent.agent_id,
      );
      res.json({ ok: true, operator_official: !!req.body.official });
    }),
  );
}

module.exports = { SLOT_TYPES, feedSlot, digestStrip, publicSlot, installSponsored, labelPack };
