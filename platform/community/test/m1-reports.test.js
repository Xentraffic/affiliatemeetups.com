"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, call, provisionClaimedAgent, ADMIN_AUTH } = require("./helpers");
const { addCalendarDays, torontoDate, torontoDayWindow, zonedToUtc } = require("../lib/toronto");
const { isNightOwl, nightWindow } = require("../lib/reports");

const A = "/api/community";
const DENY = /^(owner_email|owner_name|owner_phone|owner_id|api_key|token)$|payout|invoice|spend|balance|financial_|moderation_notes|reporter_owner_email|report_reason_private|strike_detail/i;

function deniedKeys(value, base = "") {
  const hits = [];
  if (!value || typeof value !== "object") return hits;
  for (const [key, child] of Object.entries(value)) {
    if (DENY.test(key)) hits.push(base + key);
    hits.push(...deniedKeys(child, base + key + "."));
  }
  return hits;
}

function totpCode(secret, nowMs = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.toUpperCase().replace(/[= ]/g, "")) {
    const n = alphabet.indexOf(ch);
    bits += n.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
  const count = Math.floor(nowMs / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(count));
  const mac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = mac[19] & 15;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, "0");
}

describe("M1 report scenarios", { concurrency: 1 }, () => {
  let ctx, db, owner;
  before(async () => {
    ctx = await startApp();
    db = ctx.db;
    owner = await provisionClaimedAgent(ctx.base, {
      handle: "owner-reader",
      owner_email: "owner-reader@example.invalid",
      display_name: "Owner Reader",
    });
    for (const [id, handle, kind] of [
      ["agt-a", "alpha", "ai_agent"],
      ["agt-b", "Beta", "ai_agent"],
      ["agt-c", "relay-bot", "system_relay"],
      ["agt-d", "announcement_bot", "announcement_bot"],
      ["agt-e", "human-one", "human"],
      ["agt-f", "spam-agent", "ai_agent"],
    ]) {
      db.prepare("INSERT INTO owners(owner_id,email,created_at) VALUES(?,?,?)").run(
        "own-" + id,
        id + "@example.invalid",
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO agents(agent_id,handle,display_name,owner_id,created_at,status,verification_state,participant_kind) VALUES(?,?,?,?,?,'claimed','verified',?)",
      ).run(id, handle, handle, "own-" + id, "2026-01-01T00:00:00.000Z", kind);
    }
  });
  after(async () => ctx.close());

  function cover(start, days, status = "complete") {
    const put = db.prepare("INSERT OR REPLACE INTO day_coverage(day,status) VALUES(?,?)");
    let day = start;
    for (let i = 0; i < days; i += 1) {
      put.run(day, status);
      day = addCalendarDays(day, 1);
    }
  }
  function post(id, agent, iso, body = "hello", extra = {}) {
    db.prepare(
      `INSERT INTO posts(post_id,room_id,agent_id,body,title,author_verified_at_post,created_at,type,source_event_id,link_previews,moderation_flag,metadata_json)
       VALUES(?,'room_amu',?,?,?,1,?,?,?,?,?,?)`,
    ).run(
      id,
      agent,
      body,
      extra.title || "Measured",
      iso,
      extra.type || "post",
      extra.source || null,
      extra.previews || "[]",
      extra.flag || null,
      extra.meta || "{}",
    );
  }
  async function report(date) {
    return call(ctx.base, "GET", A + "/reports/daily?date=" + date);
  }

  test("AT-DST-01 fall-back day is 25 hours", async () => {
    const naive = Date.parse("2026-11-01T00:00:00Z") + 86400000;
    const r = await report("2026-11-01");
    assert.equal(r.status, 200);
    assert.equal(r.body.window.start, "2026-11-01T04:00:00Z");
    assert.equal(r.body.window.end, "2026-11-02T05:00:00Z");
    assert.equal(r.body.window.duration_h, 25);
    assert.equal(r.body.add_24h_to_start_utc, false);
    assert.notEqual(Date.parse(r.body.window.end), naive);
  });

  test("AT-DST-02 spring-forward day is 23 hours", async () => {
    const r = await report("2026-03-08");
    assert.equal(r.body.window.start, "2026-03-08T05:00:00Z");
    assert.equal(r.body.window.end, "2026-03-09T04:00:00Z");
    assert.equal(r.body.window.duration_h, 23);
  });

  test("AT-DST-03 edge events land on the Toronto day", async () => {
    const stamps = [
      ["2026-11-01T04:30:00.000Z", "2026-11-01"],
      ["2026-11-02T04:30:00.000Z", "2026-11-01"],
      ["2026-11-01T05:30:00.000Z", "2026-11-01"],
      ["2026-11-01T06:30:00.000Z", "2026-11-01"],
      ["2026-11-02T05:00:00.000Z", "2026-11-02"],
      ["2026-03-08T05:30:00.000Z", "2026-03-08"],
      ["2026-03-09T03:30:00.000Z", "2026-03-08"],
    ];
    stamps.forEach(([iso, day], i) => {
      assert.equal(torontoDate(Date.parse(iso)), day);
      post("edge-" + i, "agt-a", iso, "edge " + i);
    });
    const nov1 = await report("2026-11-01");
    const nov2 = await report("2026-11-02");
    const mar8 = await report("2026-03-08");
    assert.equal(nov1.body.messages, 4);
    assert.equal(nov2.body.messages, 1);
    assert.equal(mar8.body.messages, 2);
    const direct = torontoDayWindow("2026-11-01");
    assert.equal(direct.duration_h, 25);
  });

  test("AT-DST-04 production window is not UTC midnight plus 24h", () => {
    const source = fs.readFileSync(path.join(__dirname, "../lib/toronto.js"), "utf8");
    assert.match(source, /America\/Toronto/);
    assert.match(source, /Intl\.DateTimeFormat/);
    for (const date of ["2026-11-01", "2026-03-08"]) {
      const window = torontoDayWindow(date);
      const naiveEnd = Date.parse(date + "T00:00:00Z") + 24 * 3600000;
      assert.notEqual(window.end, naiveEnd);
      assert.equal(window.add_24h_to_start_utc, false);
      assert.equal(window.iana, "America/Toronto");
    }
  });

  test("AT-API-01 public digest is readable without a session", async () => {
    cover("2026-02-01", 3);
    post("api01", "agt-a", "2026-02-02T15:00:00.000Z", "Public digest body");
    const r = await report("2026-02-02");
    assert.equal(r.status, 200);
    assert.ok(r.body.summary.length);
    assert.ok(r.body.highlights);
    assert.equal(deniedKeys(r.body).length, 0);
    assert.equal(r.body.owner_email, undefined);
  });

  test("AT-API-02 public digest omits private field names", async () => {
    db.prepare(
      "INSERT INTO reports(report_id,owner_id,reporter_agent_id,target_type,target_id,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run("rep-private", "own-agt-a", "agt-a", "post", "api01", "confidential_terms", "open", "2026-02-02T15:00:00.000Z");
    const r = await report("2026-02-02");
    assert.equal(r.status, 200);
    assert.deepEqual(deniedKeys(r.body), []);
    assert.equal(JSON.stringify(r.body).includes("owner-reader@example.invalid"), false);
    assert.equal(JSON.stringify(r.body).includes("agt-a@example.invalid"), false);
  });

  test("AT-API-03 owner, financial, and moderation reports require the right role", async () => {
    const paths = [
      A + "/reports/owner",
      A + "/reports/financial",
      A + "/reports/moderation",
    ];
    for (const path of paths) {
      const missing = await call(ctx.base, "GET", path);
      assert.equal(missing.status, 401, path);
      assert.deepEqual(deniedKeys(missing.body), []);
    }
    const agentFinancial = await call(ctx.base, "GET", A + "/reports/financial", {
      auth: owner.agentAuth,
    });
    const agentMod = await call(ctx.base, "GET", A + "/reports/moderation", { auth: owner.agentAuth });
    const agentOwner = await call(ctx.base, "GET", A + "/reports/owner", { auth: owner.agentAuth });
    assert.equal(agentFinancial.status, 403);
    assert.equal(agentMod.status, 403);
    assert.equal(agentOwner.status, 403);
    assert.deepEqual(deniedKeys(agentFinancial.body), []);
  });

  test("AT-API-04 moderation report requires a live admin session", async () => {
    const previous = process.env.COMMUNITY_ADMIN_TOTP_SECRET;
    process.env.COMMUNITY_ADMIN_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
    try {
      const code = totpCode(process.env.COMMUNITY_ADMIN_TOTP_SECRET);
      const login = await call(ctx.base, "POST", A + "/admin/login", {
        body: { token: process.env.COMMUNITY_ADMIN_TOKEN || "test-admin-token", code },
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const cookie = "amu_admin_session=" + /amu_admin_session=([^;]+)/.exec(login.setCookie.join(";"))[1];
      const ok = await call(ctx.base, "GET", A + "/reports/moderation", { cookie });
      assert.equal(ok.status, 200);
      assert.equal(typeof ok.body.open_reports, "number");
      db.prepare("UPDATE admin_sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
      const expired = await call(ctx.base, "GET", A + "/reports/moderation", { cookie });
      assert.equal(expired.status, 401);
      assert.notEqual(expired.status, 200);
      const stranger = await call(ctx.base, "GET", A + "/reports/moderation", { auth: owner.ownerAuth });
      assert.equal(stranger.status, 403);
    } finally {
      if (previous == null) delete process.env.COMMUNITY_ADMIN_TOTP_SECRET;
      else process.env.COMMUNITY_ADMIN_TOTP_SECRET = previous;
    }
  });

  test("AT-API-05 owner report succeeds and the public digest stays private", async () => {
    const mine = await call(ctx.base, "GET", A + "/reports/owner", { auth: owner.ownerAuth });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.owner_email, "owner-reader@example.invalid");
    const pub = await report("2026-02-02");
    assert.equal(pub.body.owner_email, undefined);
    assert.equal(JSON.stringify(pub.body).includes("owner-reader@example.invalid"), false);
  });

  test("AT-OWL-01 Night Owl uses the Toronto half-open daytime window", async () => {
    cover("2026-01-15", 1);
    const samples = [
      [8, 59],
      [9, 0],
      [17, 59],
      [18, 0],
      [8, 30],
    ];
    const flags = [];
    const window = nightWindow(db);
    samples.forEach(([hour, minute], index) => {
      const ms = zonedToUtc(2026, 1, 15, hour, minute, 0);
      flags.push(isNightOwl(ms, window.start, window.end) ? 1 : 0);
      post("owl-" + index, "agt-a", new Date(ms).toISOString(), "owl");
    });
    assert.deepEqual(flags.slice(0, 4), [1, 0, 0, 1]);
    const r = await report("2026-01-15");
    assert.equal(r.body.awards.find((a) => a.key === "night").winner.value, 3);
  });

  test("AT-OWL-02 both DST fold 01:30 instants are Night Owl", async () => {
    cover("2026-11-01", 1);
    const window = nightWindow(db);
    for (const iso of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"])
      assert.equal(isNightOwl(Date.parse(iso), window.start, window.end), true);
    const r = await report("2026-11-01");
    assert.ok(r.body.awards.find((a) => a.key === "night").winner.value >= 2);
  });

  test("AT-LINK-01 counts every URL occurrence", async () => {
    cover("2026-05-02", 1);
    post(
      "links-1",
      "agt-a",
      "2026-05-02T15:00:00.000Z",
      "See https://example.invalid/a and https://example.invalid/a plus https://example.invalid/b",
      { previews: '["https://preview.invalid/auto"]', source: "src-links" },
    );
    post(
      "links-dup",
      "agt-a",
      "2026-05-02T16:00:00.000Z",
      "https://example.invalid/should-not-count",
      { source: "src-links" },
    );
    const r = await report("2026-05-02");
    const links = r.body.awards.find((a) => a.key === "links");
    assert.equal(links.winner.value, 3);
    assert.equal(JSON.stringify(r.body.notable_links).includes("preview.invalid"), false);
    assert.equal(JSON.stringify(r.body.notable_links).includes("should-not-count"), false);
  });

  test("AT-HELP-01 self-replies do not score", async () => {
    cover("2026-05-03", 1);
    post("help-a", "agt-a", "2026-05-03T15:00:00.000Z", "question from A");
    post("help-b", "agt-b", "2026-05-03T15:05:00.000Z", "question from B");
    db.prepare(
      "INSERT INTO comments(comment_id,post_id,agent_id,body,created_at) VALUES(?,?,?,?,?)",
    ).run("help-self", "help-a", "agt-a", "self", "2026-05-03T16:00:00.000Z");
    db.prepare(
      "INSERT INTO comments(comment_id,post_id,agent_id,body,created_at) VALUES(?,?,?,?,?)",
    ).run("help-other", "help-b", "agt-a", "other", "2026-05-03T16:05:00.000Z");
    const r = await report("2026-05-03");
    assert.equal(r.body.awards.find((a) => a.key === "responder").winner.value, 1);
  });

  test("AT-HELP-02 unresolved parents are not tracked", async () => {
    cover("2026-05-04", 1);
    post("help2", "agt-b", "2026-05-04T15:00:00.000Z", "parent missing");
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO comments(comment_id,post_id,parent_id,agent_id,body,created_at) VALUES(?,?,?,?,?,?)",
    ).run("dangling", "help2", "missing-parent", "agt-a", "dangling reply", "2026-05-04T16:00:00.000Z");
    db.pragma("foreign_keys = ON");
    const r = await report("2026-05-04");
    const award = r.body.awards.find((a) => a.key === "responder");
    assert.equal(award.note, "not tracked");
    assert.equal(award.winner, null);
    assert.ok(r.body.manifest.unresolved_parent_count > 0);
  });

  test("AT-MOM-01 momentum is N_D minus the seven-day baseline", async () => {
    cover("2026-06-01", 10);
    for (let i = 0; i < 7; i += 1)
      post("mom-base-" + i, "agt-a", `2026-06-0${i + 1}T15:00:00.000Z`, "base");
    for (let i = 0; i < 6; i += 1)
      post("mom-day-" + i, "agt-a", "2026-06-08T15:0" + i + ":00.000Z", "burst");
    const r = await report("2026-06-08");
    const award = r.body.awards.find((a) => a.key === "momentum");
    assert.equal(award.winner.n_d, 6);
    assert.equal(award.winner.baseline, 1);
    assert.equal(award.winner.increase, 5);
    assert.equal(award.winner.value, 5);
  });

  test("AT-MOM-02 partial prior coverage is not tracked and verified zeros count as zero", async () => {
    cover("2026-06-10", 8);
    db.prepare("UPDATE day_coverage SET status='partial' WHERE day='2026-06-12'").run();
    post("mom-partial", "agt-a", "2026-06-17T15:00:00.000Z", "x");
    const partial = await report("2026-06-17");
    assert.equal(partial.body.awards.find((a) => a.key === "momentum").note, "not tracked");
    assert.equal(partial.body.awards.find((a) => a.key === "momentum").winner, null);
    cover("2026-06-20", 8);
    for (let i = 0; i < 7; i += 1)
      post("zero-day-" + i, "agt-b", "2026-06-20T15:00:" + String(i).padStart(2, "0") + ".000Z", "cluster");
    for (let i = 0; i < 14; i += 1)
      post("after-zero-" + i, "agt-b", "2026-06-27T15:00:" + String(i).padStart(2, "0") + ".000Z", "after");
    const verified = await report("2026-06-27");
    assert.equal(verified.body.awards.find((a) => a.key === "momentum").winner.baseline, 1);
  });

  test("AT-MOM-03 threshold, non-positive increase, and zero baseline omit the award", async () => {
    cover("2026-07-01", 20);
    for (let i = 0; i < 7; i += 1)
      post("m4b-" + i, "agt-b", `2026-07-0${i + 1}T15:00:00.000Z`, "b");
    for (let i = 0; i < 4; i += 1)
      post("m4-" + i, "agt-b", "2026-07-08T15:0" + i + ":00.000Z", "only four");
    const low = await report("2026-07-08");
    assert.equal(low.body.awards.find((a) => a.key === "momentum").status, "omitted");
    for (let i = 0; i < 35; i += 1)
      post("flat-base-" + i, "agt-a", "2026-07-14T15:00:00.000Z", "base " + i);
    for (let i = 0; i < 5; i += 1)
      post("flat-day-" + i, "agt-a", "2026-07-15T16:00:0" + i + ".000Z", "flat");
    const flat = await report("2026-07-15");
    assert.equal(flat.body.awards.find((a) => a.key === "momentum").status, "omitted");
    for (let i = 0; i < 5; i += 1)
      post("zero-base-" + i, "agt-e", "2026-07-20T15:0" + i + ":00.000Z", "no baseline");
    const zero = await report("2026-07-20");
    assert.equal(zero.body.awards.find((a) => a.key === "momentum").status, "omitted");
  });

  test("AT-STREAK-01 streak ends on the report date", async () => {
    cover("2026-08-01", 5);
    post("st1", "agt-a", "2026-08-02T15:00:00.000Z");
    post("st2", "agt-a", "2026-08-03T15:00:00.000Z");
    post("st3", "agt-a", "2026-08-04T15:00:00.000Z");
    const r = await report("2026-08-04");
    assert.equal(r.body.awards.find((a) => a.key === "streak").winner.value, 3);
    assert.equal(r.body.awards.find((a) => a.key === "streak").winner.handle, "alpha");
  });

  test("AT-STREAK-02 incomplete history has a lower bound and no winner", async () => {
    cover("2026-08-10", 4);
    db.prepare("DELETE FROM day_coverage WHERE day='2026-08-10'").run();
    post("sb1", "agt-a", "2026-08-11T15:00:00.000Z");
    post("sb2", "agt-a", "2026-08-12T15:00:00.000Z");
    post("sb3", "agt-a", "2026-08-13T15:00:00.000Z");
    const r = await report("2026-08-13");
    const award = r.body.awards.find((a) => a.key === "streak");
    assert.equal(award.winner, null);
    assert.match(award.note, /≥3 \(lower bound\)/);
  });

  test("AT-REACT-01 Vote Magnet winner is the most positive non-discounted votes in the Toronto day", async () => {
    cover("2026-04-01", 2);
    post("vote-target", "agt-b", "2026-04-01T15:00:00.000Z");
    post("vote-other", "agt-a", "2026-04-01T15:10:00.000Z");
    db.prepare("INSERT INTO votes VALUES('agt-a','post','vote-target',1,0,'2026-04-01T16:00:00.000Z')").run();
    db.prepare("INSERT INTO votes VALUES('agt-c','post','vote-target',1,0,'2026-04-01T16:01:00.000Z')").run();
    db.prepare("INSERT INTO votes VALUES('agt-e','post','vote-target',-1,0,'2026-04-01T16:05:00.000Z')").run();
    db.prepare("INSERT INTO votes VALUES('agt-f','post','vote-target',1,1,'2026-04-01T16:06:00.000Z')").run();
    db.prepare("INSERT INTO votes VALUES('agt-d','post','vote-other',1,0,'2026-04-01T16:07:00.000Z')").run();
    db.prepare(
      "INSERT INTO reaction_events(event_id,actor_agent_id,target_type,target_id,target_author_id,created_at,source_event_id,removed) VALUES(?,?,?,?,?,?,?,?)",
    ).run("ignored-event", "agt-a", "post", "vote-target", "agt-b", "2026-04-01T16:10:00.000Z", "evt", 0);
    const r = await report("2026-04-01");
    const award = r.body.awards.find((a) => a.key === "votes");
    assert.equal(award.status, "awarded");
    assert.equal(award.winner.handle, "Beta");
    assert.equal(award.winner.value, 2);
    const copy = award.label + " " + award.unit + " " + award.text + " " + r.body.definitions.votes + " " + r.body.report_md;
    assert.match(copy, /votes/);
    assert.equal(/reaction|emoji/i.test(copy), false);
  });

  test("AT-TIE-01 lists every co-winner in case-insensitive handle order", async () => {
    cover("2026-09-01", 1);
    post("tie-a", "agt-a", "2026-09-01T15:00:00.000Z", "one");
    post("tie-b", "agt-b", "2026-09-01T15:05:00.000Z", "one");
    const r = await report("2026-09-01");
    const award = r.body.awards.find((a) => a.key === "contributor");
    assert.deepEqual(award.co_winners, ["alpha", "Beta"]);
    assert.ok(award.co_winners.length >= 2);
  });

  test("AT-ZERO-01 omits an award when qualifying activity is zero", async () => {
    cover("2026-09-02", 1);
    post("zero-links", "agt-a", "2026-09-02T15:00:00.000Z", "no links here");
    const r = await report("2026-09-02");
    const links = r.body.awards.find((a) => a.key === "links");
    assert.equal(links.status, "omitted");
    assert.equal(links.winner, null);
    assert.equal(r.body.highlights.some((item) => item.key === "links"), false);
    assert.equal(r.body.report_md.includes("Link Champion"), false);
  });

  test("AT-NT-01 partial coverage says not tracked", async () => {
    post("partial-nt", "agt-a", "2026-09-03T15:00:00.000Z", "partial");
    const r = await report("2026-09-03");
    const award = r.body.awards.find((a) => a.key === "contributor");
    assert.equal(award.text, "not tracked");
    assert.notEqual(award.text, "0");
    assert.equal(award.winner, null);
  });

  test("AT-EXCL-01 relays, announcements, and spam are out; agents stay in", async () => {
    cover("2026-09-04", 1);
    post("ex-agent", "agt-e", "2026-09-04T15:00:00.000Z", "human and agent eligible");
    post("ex-relay", "agt-c", "2026-09-04T15:01:00.000Z", "relay");
    post("ex-bot", "agt-d", "2026-09-04T15:02:00.000Z", "announce");
    post("ex-spam", "agt-f", "2026-09-04T15:03:00.000Z", "spam", { flag: "spam" });
    const r = await report("2026-09-04");
    assert.equal(r.body.messages, 1);
    assert.equal(r.body.awards.find((a) => a.key === "contributor").winner.handle, "human-one");
  });

  test("AT-EXCL-02 deleted items are out and edits stay on the original instant", async () => {
    cover("2026-09-05", 2);
    post("edit-me", "agt-a", "2026-09-05T15:00:00.000Z", "original https://example.invalid/original");
    db.prepare("UPDATE posts SET body=?, edited_at=? WHERE post_id='edit-me'").run(
      "edited https://example.invalid/original https://example.invalid/original",
      "2026-09-06T15:00:00.000Z",
    );
    post("gone", "agt-b", "2026-09-05T16:00:00.000Z", "deleted");
    db.prepare("UPDATE posts SET deleted_at='2026-09-05T18:00:00.000Z' WHERE post_id='gone'").run();
    const day = await report("2026-09-05");
    const next = await report("2026-09-06");
    assert.equal(day.body.messages, 1);
    assert.equal(day.body.awards.find((a) => a.key === "links").winner.value, 2);
    assert.equal(next.body.messages, 0);
  });

  test("AT-SUM-01 summary failure keeps the awards", async () => {
    cover("2026-09-07", 1);
    post("sum-1", "agt-a", "2026-09-07T15:00:00.000Z", "still counted");
    db.prepare("INSERT INTO settings(name,value) VALUES('summary_force_unavailable','1')").run();
    try {
      const r = await report("2026-09-07");
      const section = r.body.report_md.split("## Summary")[1].split("## ")[0].trim();
      assert.equal(section, "Summary unavailable");
      assert.equal(r.body.messages, 1);
      assert.equal(r.body.awards.length, 9);
    } finally {
      db.prepare("DELETE FROM settings WHERE name='summary_force_unavailable'").run();
    }
  });

  test("AT-SHAPE-01 digest shape excludes sponsored ids from winners", async () => {
    cover("2026-09-08", 1);
    post("shape-1", "agt-a", "2026-09-08T15:00:00.000Z", "organic https://example.invalid/organic");
    db.prepare("UPDATE settings SET value='1' WHERE name='slot_digest_enabled'").run();
    db.prepare(
      `INSERT INTO sponsored_placements(placement_id,slot_type,headline,body,destination_url,starts_on,ends_on,created_at_utc,updated_at_utc)
       VALUES('spk-shape','digest_strip','Sponsor headline','https://sponsor.example/only','https://sponsor.example/only','2026-09-01','2026-09-30','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ).run();
    const r = await report("2026-09-08");
    assert.equal(r.body.key_takeaways.length, 3);
    assert.match(r.body.report_md, /Daily Digest — 2026-09-08/);
    assert.match(r.body.report_md, /## Summary/);
    assert.match(r.body.report_md, /## Key Takeaways/);
    assert.match(r.body.report_md, /## Notable Links/);
    assert.match(r.body.report_md, /## Daily Highlights/);
    const winners = r.body.awards.map((a) => a.winner && a.winner.agent_id).filter(Boolean);
    assert.equal(winners.includes("spk-shape"), false);
    assert.equal(JSON.stringify(r.body.notable_links).includes("sponsor.example"), false);
    assert.equal(r.body.sponsored_strip.placement_id, "spk-shape");
    assert.equal(r.body.sponsored_strip.eligible_for_awards, false);
  });

  test("financial report is admin-only and carries no hard-coded price", async () => {
    delete process.env.COMMUNITY_PRICE_SLOT;
    delete process.env.COMMUNITY_PRICE_PRO;
    const missing = await call(ctx.base, "GET", A + "/reports/financial");
    assert.equal(missing.status, 401);
    const asOwner = await call(ctx.base, "GET", A + "/reports/financial", { auth: owner.ownerAuth });
    assert.equal(asOwner.status, 403);
    const login = await call(ctx.base, "POST", A + "/admin/login", {
      body: { token: process.env.COMMUNITY_ADMIN_TOKEN || "test-admin-token" },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = "amu_admin_session=" + /amu_admin_session=([^;]+)/.exec(login.setCookie.join(";"))[1];
    const asAdmin = await call(ctx.base, "GET", A + "/reports/financial", { cookie });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.prices.p_slot, null);
    assert.equal(asAdmin.body.prices.p_pro, null);
    assert.equal(asAdmin.body.prices.approval, "unapproved_proposal");
    assert.equal(JSON.stringify(asAdmin.body).includes("$"), false);
    const staticHeader = await call(ctx.base, "GET", A + "/reports/financial", { auth: ADMIN_AUTH });
    assert.equal(staticHeader.status, 401);
  });
});
