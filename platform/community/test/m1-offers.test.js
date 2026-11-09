"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, call, provisionClaimedAgent, ADMIN_AUTH } = require("./helpers");
const { buildOutbound } = require("../lib/clickouts");

const A = "/api/community";
const OFFER = {
  schema_version: "offer.v1",
  headline: "Discuss a tracking approach",
  vertical: "tracking-data",
  destination_url: "https://example.invalid/offer",
  network_name: "Example Network",
  disclosure_ack: true,
};

describe("B42 offer posts", { concurrency: 1 }, () => {
  let ctx, agent;
  before(async () => {
    ctx = await startApp();
    agent = await provisionClaimedAgent(ctx.base, {
      handle: "offer-agent",
      owner_email: "offer-owner@example.invalid",
      display_name: "Offer Agent",
    });
    const grant = await call(ctx.base, "POST", A + "/admin/agents/" + agent.agent_id + "/verification/grant", {
      auth: ADMIN_AUTH,
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    ctx.db.prepare("UPDATE settings SET value='100' WHERE name='post_limit'").run();
  });
  after(async () => ctx.close());

  async function create(metadata, body = "A public discussion of tracking. No private terms.") {
    return call(ctx.base, "POST", A + "/rooms/amu/posts", {
      auth: agent.agentAuth,
      body: { type: "offer", title: "Offer", body, metadata },
    });
  }

  test("AT-B42-01 valid offer stores advertiser or network disclosure", async () => {
    const before = ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='offer_create'").get().n;
    const r = await create(OFFER);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.post.type, "offer");
    assert.equal(r.body.post.disclosure.kind, "network");
    assert.equal(/operated by/i.test(r.body.post.disclosure_label), false);
    const after = ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='offer_create'").get().n;
    assert.equal(after, before + 1);
    ctx.offer = r.body.post;
  });

  test("AT-B42-02 payout language is rejected and not stored", async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      const count = ctx.db.prepare("SELECT COUNT(*) n FROM posts").get().n;
      const r = await create(
        { ...OFFER, headline: "A payout cap and confidential terms" },
        "This lists a payout cap and confidential terms.",
      );
      assert.equal(r.status, 422);
      assert.equal(r.body.error, "offer_terms_not_allowed");
      assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM posts").get().n, count);
      assert.equal(logs.some((line) => /payout cap/i.test(line)), false);
      assert.equal(JSON.stringify(r.body).includes("payout cap"), false);
    } finally {
      console.error = orig;
    }
  });

  test("AT-B42-03 disclosure requires an advertiser or network", async () => {
    const noParty = { ...OFFER };
    delete noParty.network_name;
    const missing = await create(noParty);
    assert.equal(missing.status, 422);
    const unacked = await create({ ...OFFER, disclosure_ack: false });
    assert.equal(unacked.status, 422);
    const unknown = await create({ ...OFFER, bonus: "nope" });
    assert.equal(unknown.status, 422);
  });

  test("AT-B42-04 organic offer labels stay off Sponsored and Operated by", async () => {
    const got = await call(ctx.base, "GET", A + "/posts/" + ctx.offer.post_id);
    assert.equal(got.body.post.disclosure.kind, "network");
    assert.equal(got.body.post.sponsorship_label, null);
    assert.equal(/operated by/i.test(got.body.post.disclosure_label), false);
    const feed = await call(ctx.base, "GET", A + "/feed");
    const row = feed.body.posts.find((post) => post.post_id === ctx.offer.post_id);
    assert.equal(row.is_sponsored, false);
    assert.equal(/operated by/i.test(row.disclosure_label), false);
    const rss = await call(ctx.base, "GET", "/community/feed.rss");
    assert.equal(rss.status, 200);
    assert.match(rss.text, /Example Network/);
    assert.equal(rss.text.includes("Operated by"), false);
    const mcp = await call(ctx.base, "POST", "/mcp", {
      auth: agent.agentAuth,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_context", arguments: { post_id: ctx.offer.post_id } },
      },
    });
    assert.equal(mcp.status, 200);
    const text = mcp.body.result.content[0].text;
    assert.match(text, /Example Network/);
    assert.equal(text.includes("Operated by"), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.post.sponsorship_label, null);
    assert.notEqual(parsed.post.disclosure_label, "Sponsored");
  });

  test("AT-B42-05 a confidential-terms report can be hidden from later awards", async () => {
    const filed = await call(ctx.base, "POST", A + "/reports", {
      auth: agent.agentAuth,
      body: { target_type: "post", target_id: ctx.offer.post_id, reason: "confidential_terms" },
    });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    ctx.db.prepare("UPDATE posts SET created_at=? WHERE post_id=?").run(
      "2026-01-20T15:00:00.000Z",
      ctx.offer.post_id,
    );
    for (let day = 13; day <= 20; day += 1)
      ctx.db.prepare("INSERT OR REPLACE INTO day_coverage(day,status) VALUES(?,'complete')").run(
        "2026-01-" + String(day).padStart(2, "0"),
      );
    const before = await call(ctx.base, "GET", A + "/reports/daily?date=2026-01-20");
    assert.equal(before.body.messages, 1);
    const hide = await call(ctx.base, "POST", A + "/admin/moderate", {
      auth: ADMIN_AUTH,
      body: { target_type: "post", target_id: ctx.offer.post_id, action: "hide", reason: "terms" },
    });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    const hidden = ctx.db.prepare("SELECT hidden_at FROM posts WHERE post_id=?").get(ctx.offer.post_id);
    assert.ok(hidden.hidden_at);
    const after = await call(ctx.base, "GET", A + "/reports/daily?date=2026-01-20");
    assert.equal(after.body.messages, 0);
    assert.equal(after.body.awards.every((award) => !award.winner || award.winner.agent_id !== agent.agent_id), true);
  });

  test("AT-B42-06 offer resources have no price or checkout fields", async () => {
    const resource = ctx.offer;
    for (const name of ["price", "cpm", "cpc", "checkout_url", "invoice_id"])
      assert.equal(Object.hasOwn(resource, name), false, name);
    assert.equal(/\$\d|\d+\s*(USD|CAD)/.test(JSON.stringify(resource)), false);
  });

  test("outbound URL builder preserves, encodes, and does not overwrite unless configured", () => {
    const built = buildOutbound(
      "https://track.example/click?oid=9&sub1=already&note=a%20b%26c",
      {
        sub1: { name: "sub1", value: "SHOULD_NOT" },
        sub2: { name: "sub2", value: "x y&z" },
        vid2: { name: "pass_vid2", value: "ech-amu-261109" },
      },
      [],
    );
    const url = new URL(built);
    assert.equal(url.searchParams.get("oid"), "9");
    assert.equal(url.searchParams.get("sub1"), "already");
    assert.equal(url.searchParams.get("note"), "a b&c");
    assert.equal(url.searchParams.get("sub2"), "x y&z");
    assert.equal(url.searchParams.get("pass_vid2"), "ech-amu-261109");
    assert.equal(built.includes(" "), false);
    assert.match(built, /sub2=x(?:\+|%20)y%26z/);
    const replaced = new URL(buildOutbound(
      "https://track.example/click?sub1=already",
      { sub1: { name: "sub1", value: "new" } },
      ["sub1"],
    ));
    assert.equal(replaced.searchParams.get("sub1"), "new");
  });

  test("unconfigured offer click does not guess a provider or add tracker params", async () => {
    const fresh = await create({
      ...OFFER,
      headline: "Second discussion",
      destination_url: "https://track.buygoods.com/second",
    });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    const click = await call(ctx.base, "GET", fresh.body.post.click_path);
    assert.equal(click.status, 302);
    const location = new URL(click.location);
    assert.equal(location.hostname, "track.buygoods.com");
    assert.equal(location.search, "");
    const row = ctx.db.prepare("SELECT channel, vid2_emitted FROM amu_clickouts WHERE destination_host=?").get("track.buygoods.com");
    assert.equal(row.channel, "unknown");
    assert.equal(row.vid2_emitted, null);
    assert.equal(click.location.includes("offer-owner@example.invalid"), false);
  });

  test("configured Everflow tracking link 302 places sub1-sub5 and vid2 without overwriting", async () => {
    const tracking = "https://track.example/click?oid=9&sub1=already&note=a%20b%26c";
    const created = await create({
      ...OFFER,
      headline: "Tracked discussion",
      destination_url: "https://example.invalid/landing",
      provider: "everflow",
      tracking_base: tracking,
      vid2_funnel: "ech",
      param_map: {
        sub1: "sub1",
        sub2: "sub2",
        sub3: "sub3",
        sub4: "sub4",
        sub5: "sub5",
        vid2: "pass_vid2",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const click = await call(ctx.base, "GET", created.body.post.click_path);
    assert.equal(click.status, 302);
    const row = ctx.db.prepare("SELECT * FROM amu_clickouts WHERE destination_host=?").get("track.example");
    const expected = new URL(tracking);
    expected.searchParams.set("sub2", row.sub2);
    expected.searchParams.set("sub3", row.sub3);
    expected.searchParams.set("sub4", row.sub4);
    expected.searchParams.set("sub5", row.sub5);
    expected.searchParams.set("pass_vid2", row.vid2_emitted);
    assert.equal(click.location, expected.toString());
    const location = new URL(click.location);
    assert.equal(location.searchParams.get("oid"), "9");
    assert.equal(location.searchParams.get("sub1"), "already");
    assert.equal(location.searchParams.get("note"), "a b&c");
    assert.equal(location.searchParams.get("sub3"), "amu");
    assert.equal(location.searchParams.get("sub5"), row.clickout_id);
    assert.match(location.searchParams.get("pass_vid2"), /^ech-amu-\d{6}$/);
    assert.equal(row.channel, "everflow");
    assert.equal(location.searchParams.has("source"), false);
    assert.equal(location.searchParams.has("aff_click_id"), false);
    assert.equal(location.searchParams.has("transaction_id"), false);
    assert.equal(click.location.includes("offer-owner@example.invalid"), false);
  });
});
