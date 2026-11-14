"use strict";
// Auth, scope separation, CORS and saved-message hardening for the legacy
// platform/serve-digest.js service (plus its only /saved caller).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const extra = path.join(__dirname, "..", "node_modules");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith(".") || path.isAbsolute(request))
    return resolveFilename.call(this, request, parent, isMain, options);
  try {
    return resolveFilename.call(
      this,
      request,
      { id: parent && parent.id, filename: parent && parent.filename, paths: [extra].concat((parent && parent.paths) || []) },
      isMain,
      options,
    );
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    return resolveFilename.call(this, request, parent, isMain, options);
  }
};

// Fake fixture values, not credentials.
const READ = "fixture-read-token-0123456789";
const SAVED = "fixture-saved-token-0123456789";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amu-digest-"));
const dbPath = path.join(dir, "stats.db");
const Database = require("better-sqlite3");
const seed = new Database(dbPath);
seed.exec(`
  CREATE TABLE onboarding_state (user_id TEXT, username TEXT, display_name TEXT, answers TEXT, completed_at TEXT);
  CREATE TABLE members (user_id TEXT, username TEXT, display_name TEXT, total_messages INTEGER, streak_days INTEGER, first_seen TEXT, last_seen TEXT);
  CREATE TABLE messages (user_id TEXT, username TEXT, display_name TEXT, channel TEXT, date TEXT, timestamp TEXT);
  CREATE TABLE links (user_id TEXT, username TEXT, display_name TEXT, url TEXT, channel TEXT, date TEXT, timestamp TEXT, ai_summary TEXT);
  CREATE TABLE digests (date TEXT, channel TEXT, summary TEXT, top_links TEXT, key_takeaways TEXT, total_messages INTEGER, active_members INTEGER);
  CREATE TABLE saved_messages (user_id TEXT, channel TEXT, telegram_msg_id INTEGER, message_text TEXT, from_username TEXT, saved_at TEXT, UNIQUE(user_id, telegram_msg_id));
  INSERT INTO onboarding_state VALUES ('111','fixture_user','Fixture Person','{"location":"Fixture City"}','2026-01-01');
  INSERT INTO members VALUES ('111','fixture_user','Fixture Person',5,2,'2026-01-01','2026-01-02');
  INSERT INTO links VALUES ('111','fixture_user','Fixture Person','https://example.com','amu','2026-01-01','2026-01-01T00:00:00Z',NULL);
`);
seed.close();
process.env.AMU_STATS_DB = dbPath;
delete process.env.AMU_DIGEST_CORS_ORIGINS;

const { app } = require("../../serve-digest");
const { postToSaved } = require("../../handle-reaction");

let server, port;
test.before(async () => {
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  port = server.address().port;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function request(method, urlPath, { token, body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        port, method, path: urlPath,
        headers: {
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...(origin ? { origin } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null; try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const READ_ROUTES = ["/members/html", "/leaderboard/html", "/links", "/links/latest", "/links/html"];
const SAVED_ROUTES = [
  ["GET", "/saved/111"],
  ["POST", "/saved", { user_id: "111", telegram_msg_id: 9, message_text: "x" }],
  ["DELETE", "/saved/111/9"],
];

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(prev)) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

test("fails closed: every protected route is 401 when the tokens are not configured", () =>
  withEnv({ AMU_MEMBERS_READ_TOKEN: null, AMU_SAVED_API_TOKEN: null }, async () => {
    for (const p of READ_ROUTES) {
      assert.equal((await request("GET", p)).status, 401, p);
      assert.equal((await request("GET", p, { token: "anything-at-all-123456" })).status, 401, p);
    }
    for (const [m, p, body] of SAVED_ROUTES) assert.equal((await request(m, p, { body })).status, 401, m + " " + p);
  }));

test("a short configured token also fails closed", () =>
  withEnv({ AMU_MEMBERS_READ_TOKEN: "short" }, async () => {
    assert.equal((await request("GET", "/links", { token: "short" })).status, 401);
  }));

test("read routes: 401 without or with a wrong token, 200 with the read token", () =>
  withEnv({ AMU_MEMBERS_READ_TOKEN: READ, AMU_SAVED_API_TOKEN: SAVED }, async () => {
    for (const p of READ_ROUTES) {
      const none = await request("GET", p);
      assert.equal(none.status, 401, p);
      assert.ok(!none.text.includes("Fixture Person"), p + " leaked data without a token");
      assert.equal((await request("GET", p, { token: READ + "x" })).status, 401, p);
      const ok = await request("GET", p, { token: READ });
      assert.equal(ok.status, 200, p);
      assert.equal(ok.headers["cache-control"], "no-store", p);
    }
    const members = await request("GET", "/members/html", { token: READ });
    assert.ok(members.text.includes("Fixture Person"));
  }));

test("tokens are scoped: the read token cannot touch /saved and the saved token cannot read members", () =>
  withEnv({ AMU_MEMBERS_READ_TOKEN: READ, AMU_SAVED_API_TOKEN: SAVED }, async () => {
    for (const [m, p, body] of SAVED_ROUTES) assert.equal((await request(m, p, { token: READ, body })).status, 401, m + " " + p);
    assert.equal((await request("GET", "/members/html", { token: SAVED })).status, 401);
  }));

test("saved messages: the service token can save, list and delete; ids are validated", () =>
  withEnv({ AMU_SAVED_API_TOKEN: SAVED }, async () => {
    const saved = await request("POST", "/saved", { token: SAVED, body: { user_id: "111", telegram_msg_id: 42, message_text: "hi" } });
    assert.equal(saved.status, 200);
    const list = await request("GET", "/saved/111", { token: SAVED });
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 1);
    assert.equal((await request("DELETE", "/saved/111/42", { token: SAVED })).status, 200);
    assert.equal((await request("GET", "/saved/111", { token: SAVED })).json.count, 0);
    assert.equal((await request("GET", "/saved/1%20OR%201=1", { token: SAVED })).status, 400);
    assert.equal((await request("DELETE", "/saved/111/abc", { token: SAVED })).status, 400);
    assert.equal((await request("POST", "/saved", { token: SAVED, body: { user_id: "x", telegram_msg_id: 1 } })).status, 400);
  }));

test("the reaction handler reaches /saved over HTTP with the service token", () =>
  withEnv({ AMU_SAVED_API_TOKEN: SAVED }, async () => {
    const r = await postToSaved({ user_id: "222", channel: "amu", telegram_msg_id: 7, message_text: "m" }, { port });
    assert.equal(r.success, true);
    assert.equal((await request("GET", "/saved/222", { token: SAVED })).json.count, 1);
  }));

test("the reaction handler refuses to run without the service token", () =>
  withEnv({ AMU_SAVED_API_TOKEN: null }, async () => {
    await assert.rejects(postToSaved({ user_id: "222", telegram_msg_id: 8 }, { port }), /AMU_SAVED_API_TOKEN/);
  }));

test("CORS: no cross-origin access by default; only allowlisted origins when configured", async () => {
  await withEnv({ AMU_DIGEST_CORS_ORIGINS: null }, async () => {
    const r = await request("GET", "/health", { origin: "https://evil.example" });
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    const own = await request("GET", "/health", { origin: "https://affiliatemeetups.com" });
    assert.equal(own.headers["access-control-allow-origin"], undefined);
  });
  await withEnv({ AMU_DIGEST_CORS_ORIGINS: "https://affiliatemeetups.com, https://www.affiliatemeetups.com" }, async () => {
    const ok = await request("GET", "/health", { origin: "https://affiliatemeetups.com" });
    assert.equal(ok.headers["access-control-allow-origin"], "https://affiliatemeetups.com");
    const bad = await request("GET", "/health", { origin: "https://evil.example" });
    assert.equal(bad.headers["access-control-allow-origin"], undefined);
  });
});

test("public routes stay public: /health and /digest need no token", () =>
  withEnv({ AMU_MEMBERS_READ_TOKEN: null, AMU_SAVED_API_TOKEN: null }, async () => {
    assert.equal((await request("GET", "/health")).status, 200);
    assert.equal((await request("GET", "/digest?date=2026-01-01")).status, 404); // no digest row; not 401
    assert.equal((await request("GET", "/digest/html?date=2026-01-01")).status, 200);
  }));
