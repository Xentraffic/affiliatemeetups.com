"use strict";
const { assertTunnelOrigins } = require("./origin");
// Refuse public-mode startup with development authentication or missing secrets.
function validateRuntime(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const invalid = [];
  if (env.COMMUNITY_DEV_RETURN_CODES === "1")
    invalid.push("COMMUNITY_DEV_RETURN_CODES must be off");
  for (const key of ["COMMUNITY_ADMIN_TOKEN", "COMMUNITY_RATE_SECRET"])
    if ((env[key] || "").length < 32)
      invalid.push(key + " needs at least 32 characters");
  if (!/^[A-Z2-7]{16,}={0,6}$/i.test(env.COMMUNITY_ADMIN_TOTP_SECRET || ""))
    invalid.push(
      "COMMUNITY_ADMIN_TOTP_SECRET must be a valid Base32 authenticator secret",
    );
  try {
    const u = new URL(env.COMMUNITY_ORIGIN);
    if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash)
      throw Error();
  } catch {
    invalid.push("COMMUNITY_ORIGIN must be an HTTPS origin");
  }
  invalid.push(...assertTunnelOrigins(env));
  if (env.COMMUNITY_MAIL_MODE !== "smtp")
    invalid.push("COMMUNITY_MAIL_MODE must be smtp");
  for (const key of [
    "COMMUNITY_SMTP_HOST",
    "COMMUNITY_SMTP_USER",
    "COMMUNITY_SMTP_PASSWORD",
    "COMMUNITY_MAIL_FROM",
  ])
    if (!env[key]) invalid.push(key + " missing");
  if (![465, 587].includes(Number(env.COMMUNITY_SMTP_PORT || 587)))
    invalid.push("SMTP port must be 465 or 587");
  if (invalid.length)
    throw Error("Community startup configuration: " + invalid.join("; "));
}
module.exports = { validateRuntime };
