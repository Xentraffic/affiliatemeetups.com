"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const Module = require("node:module");

const repo = path.resolve(__dirname, "../../..");

test("tracked source no longer contains a private Telegram invite link", () => {
  let listed = "";
  try {
    listed = execFileSync("git", ["grep", "-I", "-l", "-E", "t\\.me/\\+", "--", "."], {
      cwd: repo,
      encoding: "utf8",
    });
  } catch (err) {
    if (err.status === 1) listed = "";
    else throw err;
  }
  const files = listed.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(files, []);
});

test("digest invite link is omitted when AMU_TELEGRAM_INVITE_URL is unset and has no built-in URL", () => {
  const extra = path.join(__dirname, "..", "node_modules");
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request.startsWith(".") || path.isAbsolute(request)) {
      return resolveFilename.call(this, request, parent, isMain, options);
    }
    try {
      return resolveFilename.call(
        this,
        request,
        {
          id: parent && parent.id,
          filename: parent && parent.filename,
          paths: [extra].concat((parent && parent.paths) || []),
        },
        isMain,
        options,
      );
    } catch (err) {
      if (err.code !== "MODULE_NOT_FOUND") throw err;
      return resolveFilename.call(this, request, parent, isMain, options);
    }
  };
  const previous = process.env.AMU_TELEGRAM_INVITE_URL;
  delete process.env.AMU_TELEGRAM_INVITE_URL;
  try {
    const { inviteLink } = require("../../serve-digest");
    assert.equal(inviteLink("Join"), "");
    process.env.AMU_TELEGRAM_INVITE_URL = "https://example.invalid/invite-placeholder";
    const html = inviteLink("Join", 'class="join-cta"');
    assert.match(html, /href="https:\/\/example\.invalid\/invite-placeholder"/);
    assert.match(html, /Join/);
    assert.equal(/t\.me\/\+/.test(html), false);
  } finally {
    if (previous == null) delete process.env.AMU_TELEGRAM_INVITE_URL;
    else process.env.AMU_TELEGRAM_INVITE_URL = previous;
    Module._resolveFilename = resolveFilename;
  }
});
