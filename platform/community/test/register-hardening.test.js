"use strict";
// POST /api/members/register stays public but gets brakes. None of these
// cases reach Cyberimpact: every request is rejected or short-circuited first.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
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
process.env.AMU_REGISTER_PER_IP_HOURLY = "5";
delete process.env.AMU_REGISTER_ORIGINS;
const { app } = require("../../api-members");

let server, port;
test.before(async () => {
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  port = server.address().port;
});
test.after(() => server.close());

function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { port, method: "POST", path: "/api/members/register",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { json = null; }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Each test uses its own forwarded client address so the per-IP limit is isolated.
test("a foreign browser Origin is refused; our own origin is not", async () => {
  const ip = { "x-forwarded-for": "198.51.100.1" };
  assert.equal((await post({}, { ...ip, origin: "https://evil.example" })).status, 403);
  assert.equal((await post({}, { ...ip, origin: "https://affiliatemeetups.com" })).status, 400);
});

test("the honeypot short-circuits with a success-shaped reply", async () => {
  const r = await post({ email: "bot@example.com", firstname: "B", lastname: "T", website_fax: "x" }, { "x-forwarded-for": "198.51.100.2" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("oversized or non-string fields are rejected before any outbound call", async () => {
  const ip = { "x-forwarded-for": "198.51.100.3" };
  assert.equal((await post({ email: "a@b.co", firstname: "x".repeat(81), lastname: "y" }, ip)).status, 400);
  assert.equal((await post({ email: { $ne: 1 }, firstname: "x", lastname: "y" }, ip)).status, 400);
  assert.equal((await post({ email: "not-an-email", firstname: "x", lastname: "y" }, ip)).status, 400);
});

test("per-IP rate limit: the 6th attempt in an hour is 429, other visitors are unaffected", async () => {
  const ip = { "x-forwarded-for": "198.51.100.4" };
  for (let i = 0; i < 5; i++) assert.equal((await post({}, ip)).status, 400, "attempt " + (i + 1));
  const limited = await post({}, ip);
  assert.equal(limited.status, 429);
  assert.equal((await post({}, { "x-forwarded-for": "198.51.100.5" })).status, 400);
});
