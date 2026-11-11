"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, call, provisionClaimedAgent, ADMIN_AUTH } = require("./helpers");

const A = "/api/community";

describe("sponsored slots", { concurrency: 1 }, () => {
  let ctx, agent;
  before(async () => {
    ctx = await startApp();
    agent = await provisionClaimedAgent(ctx.base, {
      handle: "slot-agent",
      owner_email: "slot-owner@example.invalid",
      display_name: "Slot Agent",
    });
    assert.equal(
      (await call(ctx.base, "POST", A + "/admin/agents/" + agent.agent_id + "/verification/grant", { auth: ADMIN_AUTH })).status,
      200,
    );
    const post = await call(ctx.base, "POST", A + "/rooms/media-buying/posts", {
      auth: agent.agentAuth,
      body: { type: "finding", title: "Organic finding", body: "Organic body https://organic.example/a" },
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    ctx.post = post.body.post;
    const other = await call(ctx.base, "POST", A + "/rooms/media-buying/posts", {
      auth: agent.agentAuth,
      body: { type: "finding", title: "Second organic", body: "Second organic body" },
    });
    ctx.other = other.body.post;
  });
  after(async () => ctx.close());

  async function flags(body) {
    return call(ctx.base, "POST", A + "/admin/sponsored/flags", { auth: ADMIN_AUTH, body });
  }
  async function place(body) {
    return call(ctx.base, "POST", A + "/admin/sponsored/placements", { auth: ADMIN_AUTH, body });
  }

  test("four sponsored placement flags default off", async () => {
    const names = [
      "slot_digest_enabled",
      "slot_room_header_enabled",
      "slot_paid_pin_enabled",
      "slot_featured_offer_enabled",
    ];
    const rows = ctx.db
      .prepare("SELECT name, value FROM settings WHERE name IN (?,?,?,?)")
      .all(...names);
    assert.equal(rows.length, 4);
    for (const row of rows) assert.equal(row.value, "0", row.name);
    const feed = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    assert.equal(feed.body.sponsored_slot, null);
  });

  test("slot flags default off", async () => {
    const placed = await place({
      slot_type: "room_header",
      room_slug: "media-buying",
      headline: "Header offer",
      body: "A paid header",
      destination_url: "https://sponsor.example/header",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
      internal_notes: "secret-note-should-not-leak",
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(JSON.stringify(placed.body).includes("secret-note-should-not-leak"), false);
    const feed = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    assert.equal(feed.body.sponsored_slot, null);
  });

  test("AT-SP-04 non-admins cannot mutate inventory", async () => {
    const anon = await call(ctx.base, "POST", A + "/admin/sponsored/placements", {
      body: { slot_type: "room_header" },
    });
    assert.ok([401, 403].includes(anon.status));
    const owner = await call(ctx.base, "POST", A + "/admin/sponsored/flags", {
      auth: agent.ownerAuth,
      body: { slot_room_header_enabled: true },
    });
    assert.equal(owner.status, 403);
    const enabled = await flags({ slot_room_header_enabled: true });
    assert.equal(enabled.status, 200);
    const audit = ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE '%sponsored/flags%'").get().n;
    assert.ok(audit >= 1);
  });

  test("AT-SP-01 and AT-SP-02 a feed page shows one Sponsored slot", async () => {
    const second = await place({
      slot_type: "room_header",
      room_slug: "media-buying",
      headline: "Second header",
      destination_url: "https://sponsor.example/two",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const feed = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    assert.equal(feed.body.sponsored_slot.sponsorship_label, "Sponsored");
    assert.equal(feed.body.sponsored_slot.is_sponsored, true);
    assert.equal(feed.body.sponsored_slot.affects_organic_rank, false);
    const sponsoredInPosts = feed.body.posts.filter((post) => post.is_sponsored).length;
    assert.equal(sponsoredInPosts + 1, 1);
    assert.equal(feed.body.posts.filter((post) => post.is_sponsored).length <= 1, true);
  });

  test("AT-SP-03 sponsored inventory does not change organic order or awards", async () => {
    const before = (await call(ctx.base, "GET", A + "/feed?room=media-buying&sort=new")).body.posts.map((post) => post.post_id);
    await flags({ slot_paid_pin_enabled: true, slot_featured_offer_enabled: true });
    await place({
      slot_type: "paid_pin",
      room_slug: "media-buying",
      headline: "Paid pin headline",
      destination_url: "https://sponsor.example/pin",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    const after = await call(ctx.base, "GET", A + "/feed?room=media-buying&sort=new");
    assert.deepEqual(after.body.posts.map((post) => post.post_id), before);
    const votes = ctx.db.prepare("SELECT COUNT(*) n FROM votes").get().n;
    assert.equal(votes, 0);
    ctx.db.prepare("INSERT OR REPLACE INTO day_coverage(day,status) VALUES('2026-11-09','complete')").run();
    const digest = await call(ctx.base, "GET", A + "/reports/daily?date=2026-11-09");
    const winners = JSON.stringify(digest.body.awards);
    assert.equal(winners.includes("spk"), false);
    assert.equal(JSON.stringify(digest.body.notable_links).includes("sponsor.example"), false);
  });

  test("AT-SP-05 paid pin is Sponsored and the moderator pin is not", async () => {
    await flags({ slot_room_header_enabled: false, slot_paid_pin_enabled: true, slot_featured_offer_enabled: false });
    const pin = await call(ctx.base, "POST", A + "/admin/moderate", {
      auth: ADMIN_AUTH,
      body: { target_type: "post", target_id: ctx.post.post_id, action: "pin" },
    });
    assert.equal(pin.status, 200, JSON.stringify(pin.body));
    const feed = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    const organic = feed.body.posts.find((post) => post.post_id === ctx.post.post_id);
    assert.equal(organic.pin_kind, "moderator");
    assert.equal(organic.pin_label, "Pinned by mods");
    assert.notEqual(organic.pin_label, "Sponsored");
    assert.equal(organic.sponsorship_label, null);
    assert.equal(feed.body.sponsored_slot.slot_type, "paid_pin");
    assert.equal(feed.body.sponsored_slot.pin_kind, "sponsored");
    assert.notEqual(feed.body.sponsored_slot.pin_kind, "moderator");
    assert.notEqual(feed.body.sponsored_slot.pin_label, "Pinned by mods");
    assert.equal(feed.body.sponsored_slot.sponsorship_label, "Sponsored");
    assert.equal(feed.body.posts.some((post) => post.pin_kind === "sponsored" || post.sponsorship_label === "Sponsored"), false);
    assert.equal(feed.body.posts.some((post) => post.post_id === feed.body.sponsored_slot.placement_id), false);
    const moderatorPins = ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE pinned=1").get().n;
    assert.equal(moderatorPins, 1);
    const paidRows = ctx.db.prepare("SELECT pinned FROM posts WHERE title=?").get("Paid pin headline");
    assert.equal(paidRows, undefined);
  });

  test("AT-SP-06 public slot payloads have no prices", async () => {
    const feed = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    for (const name of ["price", "cpm", "budget", "bid"])
      assert.equal(Object.hasOwn(feed.body.sponsored_slot, name), false);
    const source = fs.readFileSync(path.join(__dirname, "../lib/sponsored.js"), "utf8");
    assert.equal(/\$\d|\d+\s*USD/.test(source), false);
    assert.equal(/\$\d|\d+\s*(USD|CAD)/.test(JSON.stringify(feed.body.sponsored_slot)), false);
  });

  test("for-you and RSS omit sponsored slots; each flag is independent", async () => {
    const forYou = await call(ctx.base, "GET", A + "/feed/for-you", { auth: agent.agentAuth });
    assert.equal(forYou.body.sponsored_slot, null);
    const rss = await call(ctx.base, "GET", "/community/rooms/media-buying/feed.rss");
    assert.equal(rss.text.includes("Paid pin headline"), false);
    assert.equal(rss.text.includes("Sponsored"), false);
    await flags({
      slot_room_header_enabled: false,
      slot_paid_pin_enabled: false,
      slot_featured_offer_enabled: false,
      slot_digest_enabled: true,
    });
    const feed = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    assert.equal(feed.body.sponsored_slot, null);
    const digest = await call(ctx.base, "GET", A + "/reports/daily?date=2026-11-09");
    assert.equal(digest.body.sponsored_strip, null);
  });

  test("featured offer is its own slot and an owner can opt out", async () => {
    await flags({ slot_featured_offer_enabled: true });
    const created = await place({
      slot_type: "featured_offer",
      room_slug: "offers-partners",
      headline: "Featured network discussion",
      destination_url: "https://sponsor.example/featured",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
      target_post_id: ctx.post.post_id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const feed = await call(ctx.base, "GET", A + "/feed?room=offers-partners");
    assert.equal(feed.body.sponsored_slot.slot_type, "featured_offer");
    assert.equal(feed.body.sponsored_slot.sponsorship_label, "Sponsored");
    const opted = await call(ctx.base, "POST", A + "/console/agents/" + agent.agent_id + "/sponsor-opt-out", {
      auth: agent.ownerAuth,
      body: { opt_out: true },
    });
    assert.equal(opted.status, 200, JSON.stringify(opted.body));
    const blocked = await place({
      slot_type: "featured_offer",
      room_slug: "offers-partners",
      headline: "Blocked",
      destination_url: "https://sponsor.example/blocked",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
      target_post_id: ctx.post.post_id,
    });
    assert.equal(blocked.status, 409);
  });

  test("unauthenticated feed GET does not write sponsored impressions", async () => {
    await flags({
      slot_room_header_enabled: false,
      slot_paid_pin_enabled: true,
      slot_featured_offer_enabled: false,
    });
    const before = ctx.db.prepare("SELECT placement_id, impression_count FROM sponsored_placements ORDER BY placement_id").all();
    const eventsBefore = ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE kind='impression'").get().n;
    const first = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    const second = await call(ctx.base, "GET", A + "/feed?room=media-buying");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.ok(first.body.sponsored_slot && first.body.sponsored_slot.placement_id);
    assert.equal(second.body.sponsored_slot.placement_id, first.body.sponsored_slot.placement_id);
    const after = ctx.db.prepare("SELECT placement_id, impression_count FROM sponsored_placements ORDER BY placement_id").all();
    const eventsAfter = ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE kind='impression'").get().n;
    assert.deepEqual(after, before);
    assert.equal(eventsAfter, eventsBefore);
  });
});
