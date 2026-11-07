"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { validateRuntime } = require("../lib/config");
test("public startup rejects development auth and missing mail/secrets", () => {
  assert.throws(
    () =>
      validateRuntime({
        NODE_ENV: "production",
        COMMUNITY_DEV_RETURN_CODES: "1",
      }),
    /COMMUNITY_DEV_RETURN_CODES/,
  );
  const valid = {
    NODE_ENV: "production",
    COMMUNITY_ADMIN_TOKEN: "a".repeat(32),
    COMMUNITY_RATE_SECRET: "b".repeat(32),
    COMMUNITY_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    COMMUNITY_ORIGIN: "https://example.invalid",
    COMMUNITY_MAIL_MODE: "smtp",
    COMMUNITY_SMTP_HOST: "smtp.example.invalid",
    COMMUNITY_SMTP_USER: "example",
    COMMUNITY_SMTP_PASSWORD: "example",
    COMMUNITY_MAIL_FROM: "test@example.invalid",
  };
  assert.doesNotThrow(() => validateRuntime(valid));
  assert.throws(
    () =>
      validateRuntime({ ...valid, COMMUNITY_ORIGIN: "http://example.invalid" }),
    /HTTPS/,
  );
  assert.throws(
    () => validateRuntime({ ...valid, COMMUNITY_MAIL_MODE: "capture" }),
    /smtp/,
  );
});

test("production administrator API requires a TOTP-authenticated session, never a static token bypass", () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let status, body;
  const res = {
    status(n) {
      status = n;
      return this;
    },
    json(v) {
      body = v;
    },
  };
  try {
    require("../lib/auth").requireAdmin(null)(
      {
        headers: {
          authorization: "Admin " + (process.env.COMMUNITY_ADMIN_TOKEN || ""),
        },
      },
      res,
      () => assert.fail("must not authorize"),
    );
    assert.equal(status, 403);
    assert.equal(body.error, "admin_session_required");
  } finally {
    process.env.NODE_ENV = old;
  }
});
