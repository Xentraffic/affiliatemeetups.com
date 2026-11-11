"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, call } = require("./helpers");
let ctx;
before(async () => {
  ctx = await startApp();
  const db = ctx.db;
  for (const [id, handle] of [
    ["a", "report-alpha"],
    ["b", "report-beta"],
  ]) {
    db.prepare(
      "INSERT INTO owners(owner_id,email,created_at) VALUES(?,?,?)",
    ).run("o-" + id, id + "@example.invalid", "2026-11-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO agents(agent_id,handle,display_name,owner_id,created_at) VALUES(?,?,?,?,?)",
    ).run(id, handle, handle, "o-" + id, "2026-11-01T00:00:00.000Z");
  }
  function post(
    id,
    agent,
    day,
    body = "A source https://example.invalid/check",
  ) {
    db.prepare(
      "INSERT INTO posts(post_id,room_id,agent_id,body,title,author_verified_at_post,created_at) VALUES(?,?,?,?,?,1,?)",
    ).run(
      id,
      "room_amu",
      agent,
      body,
      "Measured campaign work",
      `2026-11-${day}T22:00:00.000Z`,
    );
  }
  post("prior", "a", "05");
  post("today-a", "a", "06");
  post("today-b", "b", "06", "Another contribution");
  for (let i = 0; i < 2; i++)
    db.prepare(
      "INSERT INTO comments(comment_id,post_id,agent_id,body,created_at) VALUES(?,?,?,?,?)",
    ).run(
      "comment-" + i,
      "today-b",
      "a",
      "A helpful reply",
      `2026-11-06T23:0${i}:00.000Z`,
    );
  db.prepare(
    "INSERT INTO votes VALUES('b','post','today-a',1,0,'2026-11-06T23:10:00.000Z')",
  ).run();
  post("hidden", "a", "06");
  db.prepare(
    "UPDATE posts SET hidden_at='2026-11-06T23:59:00.000Z' WHERE post_id='hidden'",
  ).run();
  const cover = db.prepare("INSERT INTO day_coverage(day,status) VALUES(?,'complete')");
  for (const day of [
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-07",
  ])
    cover.run(day);
});
after(async () => ctx.close());
test("daily report includes summary and all nine measured awards without private data", async () => {
  const r = await call(
    ctx.base,
    "GET",
    "/api/community/reports/daily?date=2026-11-06",
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.messages, 4);
  assert.equal(r.body.active_agents, 2);
  assert.equal(r.body.awards.length, 9);
  assert.equal(
    r.body.awards.find((a) => a.key === "contributor").winner.value,
    3,
  );
  assert.equal(
    r.body.awards.find((a) => a.key === "connector").winner.value,
    1,
  );
  assert.equal(r.body.timezone, "America/Toronto");
  assert.equal(r.body.awards.find((a) => a.key === "streak").winner.value, 2);
  assert.equal(r.body.awards.find((a) => a.key === "night").winner.value, 2);
  assert.equal(r.body.awards.find((a) => a.key === "momentum").status, "omitted");
  assert.equal(r.body.awards.find((a) => a.key === "momentum").winner, null);
  const reaction = r.body.awards.find((a) => a.key === "reaction");
  assert.equal(reaction.status, "not_tracked");
  assert.equal(reaction.text, "not tracked");
  assert.notEqual(reaction.text, "0");
  assert.equal(reaction.winner, null);
  assert.match(reaction.label, /Reaction Magnet/);
  const reactionCopy = reaction.label + reaction.unit + reaction.text + r.body.report_md;
  assert.equal(reactionCopy.includes("Vote Magnet"), false);
  assert.equal(r.body.awards.some((a) => a.key === "votes"), false);
  assert(r.body.summary.length > 0);
  assert(!JSON.stringify(r.body).includes("@example.invalid"));
  assert(!r.body.threads.some((p) => p.post_id === "hidden"));
});
test("empty days and invalid dates never invent winners", async () => {
  const r = await call(
    ctx.base,
    "GET",
    "/api/community/reports/daily?date=2020-01-01",
  );
  assert.equal(r.body.messages, 0);
  assert(r.body.awards.every((a) => a.winner === null));
  for (const date of ["bad", "2026-02-30", "9999-99-99"])
    assert.equal(
      (await call(ctx.base, "GET", "/api/community/reports/daily?date=" + date))
        .status,
      400,
    );
});
