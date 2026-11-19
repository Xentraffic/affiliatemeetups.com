"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, call, provisionClaimedAgent, ADMIN_AUTH } = require("./helpers");
const { recordSponsoredClick } = require("../lib/sponsored");
const { torontoDate, addCalendarDays } = require("../lib/toronto");

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

  test("enabled placement click records one sponsored click and redirects to the destination", async () => {
    await flags({ slot_digest_enabled: true });
    const created = await place({
      slot_type: "digest_strip",
      headline: "Clickable sponsor",
      body: "A labelled paid strip.",
      destination_url: "https://sponsor.example/cta-destination",
      cta_label: "Open the sponsor",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.placement.placement_id;
    assert.equal(created.body.placement.cta_label, "Open the sponsor");
    assert.equal(created.body.placement.click_path, A + "/sponsored/" + id + "/click");
    const beforeClicks = ctx.db.prepare("SELECT click_count FROM sponsored_placements WHERE placement_id=?").get(id).click_count;
    const beforeEvents = ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE placement_id=? AND kind='click'").get(id).n;
    const beforeAll = ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE kind='click'").get().n;
    const click = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click");
    assert.equal(click.status, 302);
    assert.equal(click.location, "https://sponsor.example/cta-destination");
    assert.equal(ctx.db.prepare("SELECT click_count FROM sponsored_placements WHERE placement_id=?").get(id).click_count, beforeClicks + 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE placement_id=? AND kind='click'").get(id).n, beforeEvents + 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE kind='click'").get().n, beforeAll + 1);
  });

  test("disabled and unknown placements record no click", async () => {
    await flags({ slot_digest_enabled: true });
    const created = await place({
      slot_type: "digest_strip",
      headline: "Inactive sponsor",
      destination_url: "https://sponsor.example/disabled-cta",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.placement.placement_id;
    const snap = () => ({
      clicks: ctx.db.prepare("SELECT click_count FROM sponsored_placements WHERE placement_id=?").get(id).click_count,
      events: ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE kind='click'").get().n,
    });
    ctx.db.prepare("UPDATE sponsored_placements SET active=0 WHERE placement_id=?").run(id);
    const before = snap();
    const inactive = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click");
    assert.equal(inactive.status, 404);
    assert.equal(inactive.location, null);
    ctx.db.prepare("UPDATE sponsored_placements SET active=1 WHERE placement_id=?").run(id);
    await flags({ slot_digest_enabled: false });
    const flagged = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click");
    assert.equal(flagged.status, 404);
    assert.equal(flagged.location, null);
    const missing = await call(ctx.base, "GET", A + "/sponsored/spk-missing/click");
    assert.equal(missing.status, 404);
    assert.equal(missing.location, null);
    assert.deepEqual(snap(), before);
    await flags({ slot_digest_enabled: true });
  });

  test("digest GET writes no impressions and exposes the sponsored CTA", async () => {
    await flags({ slot_digest_enabled: true });
    const created = await place({
      slot_type: "digest_strip",
      headline: "Digest CTA sponsor",
      destination_url: "https://sponsor.example/digest-cta",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const impressions = () => ({
      events: ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE kind='impression'").get().n,
      count: ctx.db.prepare("SELECT COALESCE(SUM(impression_count),0) n FROM sponsored_placements").get().n,
    });
    const before = impressions();
    const first = await call(ctx.base, "GET", A + "/reports/daily?date=2026-11-10");
    const second = await call(ctx.base, "GET", A + "/reports/daily?date=2026-11-10");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const strip = first.body.sponsored_strip;
    assert.ok(strip && strip.placement_id);
    assert.equal(strip.click_path, A + "/sponsored/" + strip.placement_id + "/click");
    assert.equal(strip.sponsorship_label, "Sponsored");
    assert.ok(strip.cta_label);
    assert.match(first.body.report_md, /## Sponsored/);
    assert.ok(first.body.report_md.includes(strip.sponsorship_label));
    assert.ok(first.body.report_md.includes(strip.cta_label + ": " + strip.click_path));
    assert.deepEqual(impressions(), before);
    const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
    assert.match(source, /rel="sponsored noopener"/);
    assert.match(source, /sponsored_strip\.click_path/);
    const icon = await fetch(ctx.base + "/favicon.ico");
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") || "", /icon/);
    const page = await fetch(ctx.base + "/community");
    assert.match(await page.text(), /rel="icon"/);
  });

  test("digest CTA href includes the /staging base path", async () => {
    process.env.COMMUNITY_BASE_PATH = "/staging";
    const staged = await startApp();
    try {
      assert.equal(
        (await call(staged.base, "POST", "/staging" + A + "/admin/sponsored/flags", {
          auth: ADMIN_AUTH,
          body: { slot_digest_enabled: true },
        })).status,
        200,
      );
      const created = await call(staged.base, "POST", "/staging" + A + "/admin/sponsored/placements", {
        auth: ADMIN_AUTH,
        body: {
          slot_type: "digest_strip",
          headline: "Staging sponsor",
          destination_url: "https://sponsor.example/staging-cta",
          starts_on: "2026-01-01",
          ends_on: "2026-12-31",
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.placement.placement_id;
      const href = "/staging/api/community/sponsored/" + id + "/click";
      assert.equal(created.body.placement.click_path, href);
      assert.equal(created.body.placement.cta_label, "Visit sponsor");
      const digest = await call(staged.base, "GET", "/staging" + A + "/reports/daily?date=2026-11-10");
      assert.equal(digest.status, 200);
      assert.equal(digest.body.sponsored_strip.click_path, href);
      assert.ok(digest.body.report_md.includes(href));
      const click = await call(staged.base, "GET", href);
      assert.equal(click.status, 302);
      assert.equal(click.location, "https://sponsor.example/staging-cta");
      assert.equal(staged.db.prepare("SELECT click_count FROM sponsored_placements WHERE placement_id=?").get(id).click_count, 1);
      const bare = await fetch(staged.base + "/api/community/reports/daily?date=2026-11-10");
      assert.equal(bare.status, 404);
      const icon = await fetch(staged.base + "/favicon.ico");
      assert.equal(icon.status, 200);
      const prefixedIcon = await fetch(staged.base + "/staging/community/favicon.ico");
      assert.equal(prefixedIcon.status, 200);
    } finally {
      delete process.env.COMMUNITY_BASE_PATH;
      await staged.close();
    }
  });

  function clickTotals(id) {
    return {
      clicks: ctx.db.prepare("SELECT click_count FROM sponsored_placements WHERE placement_id=?").get(id).click_count,
      events: ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_events WHERE placement_id=? AND kind='click'").get(id).n,
    };
  }

  test("first sponsored click is counted and a repeat in the window is not", async () => {
    await flags({ slot_digest_enabled: true });
    const created = await place({
      slot_type: "digest_strip",
      headline: "Dedupe sponsor",
      destination_url: "https://sponsor.example/deduped",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.placement.placement_id;
    const headers = { "user-agent": "dedupe-visitor" };
    const first = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click", { headers });
    const second = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click", { headers });
    assert.equal(first.status, 302);
    assert.equal(first.location, "https://sponsor.example/deduped");
    assert.equal(second.status, 302);
    assert.equal(second.location, "https://sponsor.example/deduped");
    assert.deepEqual(clickTotals(id), { clicks: 1, events: 1 });
    const stored = ctx.db.prepare("SELECT dedupe_key FROM sponsored_click_dedupe").all().map((row) => row.dedupe_key).join("\n");
    assert.equal(stored.includes("127.0.0.1"), false);
    assert.equal(stored.includes("dedupe-visitor"), false);
  });

  test("per-IP sponsored click limit redirects without counting", async () => {
    await flags({ slot_digest_enabled: true });
    const created = await place({
      slot_type: "digest_strip",
      headline: "Rate limit sponsor",
      destination_url: "https://sponsor.example/rate-limited",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.placement.placement_id;
    ctx.db.prepare("DELETE FROM rate_buckets WHERE bucket LIKE 'sponsored-click-ip:%'").run();
    process.env.COMMUNITY_SPONSORED_CLICK_IP_LIMIT = "2";
    try {
      for (const agent of ["rate-a", "rate-b"]) {
        const res = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click", { headers: { "user-agent": agent } });
        assert.equal(res.status, 302, agent);
        assert.equal(res.location, "https://sponsor.example/rate-limited");
      }
      assert.deepEqual(clickTotals(id), { clicks: 2, events: 2 });
      const blocked = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click", { headers: { "user-agent": "rate-c" } });
      assert.equal(blocked.status, 302);
      assert.equal(blocked.location, "https://sponsor.example/rate-limited");
      assert.deepEqual(clickTotals(id), { clicks: 2, events: 2 });
    } finally {
      delete process.env.COMMUNITY_SPONSORED_CLICK_IP_LIMIT;
    }
  });

  test("expired, future, and disabled placements do not count or redirect", async () => {
    await flags({ slot_digest_enabled: true });
    const today = torontoDate(Date.now());
    const cases = [
      ["expired", addCalendarDays(today, -10), addCalendarDays(today, -1)],
      ["future", addCalendarDays(today, 1), addCalendarDays(today, 10)],
      ["disabled", "2026-01-01", "2026-12-31"],
    ];
    for (const [name, starts, ends] of cases) {
      const created = await place({
        slot_type: "digest_strip",
        headline: name + " sponsor",
        destination_url: "https://sponsor.example/" + name,
        starts_on: starts,
        ends_on: ends,
      });
      assert.equal(created.status, 201, name + " " + JSON.stringify(created.body));
      const id = created.body.placement.placement_id;
      if (name === "disabled") ctx.db.prepare("UPDATE sponsored_placements SET active=0 WHERE placement_id=?").run(id);
      const before = clickTotals(id);
      const res = await call(ctx.base, "GET", A + "/sponsored/" + id + "/click", { headers: { "user-agent": name + "-visitor" } });
      assert.equal(res.status, 404, name);
      assert.equal(res.location, null, name);
      assert.deepEqual(clickTotals(id), before, name);
    }
  });

  test("sponsored click count and event roll back together", async () => {
    await flags({ slot_digest_enabled: true });
    const created = await place({
      slot_type: "digest_strip",
      headline: "Atomic sponsor",
      destination_url: "https://sponsor.example/atomic",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.placement.placement_id;
    const today = torontoDate(Date.now());
    assert.throws(
      () =>
        recordSponsoredClick(ctx.db, {
          placementId: id,
          dedupeKey: "rollback-key",
          expiresAt: Date.now() + 60000,
          today,
          beforeEvent() {
            throw new Error("injected");
          },
        }),
      /injected/,
    );
    assert.deepEqual(clickTotals(id), { clicks: 0, events: 0 });
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM sponsored_click_dedupe WHERE dedupe_key='rollback-key'").get().n, 0);
    assert.equal(
      recordSponsoredClick(ctx.db, {
        placementId: id,
        dedupeKey: "rollback-key",
        expiresAt: Date.now() + 60000,
        today,
      }),
      "counted",
    );
    assert.deepEqual(clickTotals(id), { clicks: 1, events: 1 });
  });
});
