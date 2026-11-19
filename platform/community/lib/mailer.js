"use strict";
// Email delivery is explicit. No invented Cyberimpact transactional API endpoint.
const captured = [];
function mode() {
  return process.env.COMMUNITY_MAIL_MODE || "disabled";
}
async function deliverLoginCode(email, code) {
  if (mode() === "capture" && process.env.NODE_ENV !== "production") {
    captured.push({ email, code, at: new Date().toISOString() });
    return { ok: true, mode: "capture" };
  }
  if (mode() !== "smtp") throw Error("Transactional SMTP not configured");
  const e = process.env;
  for (const k of [
    "COMMUNITY_SMTP_HOST",
    "COMMUNITY_SMTP_USER",
    "COMMUNITY_SMTP_PASSWORD",
    "COMMUNITY_MAIL_FROM",
  ])
    if (!e[k]) throw Error("SMTP configuration incomplete");
  const transport = require("nodemailer").createTransport({
    host: e.COMMUNITY_SMTP_HOST,
    port: Number(e.COMMUNITY_SMTP_PORT || 587),
    secure: e.COMMUNITY_SMTP_PORT === "465",
    requireTLS: e.COMMUNITY_SMTP_PORT !== "465",
    auth: { user: e.COMMUNITY_SMTP_USER, pass: e.COMMUNITY_SMTP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  await transport.sendMail({
    from: e.COMMUNITY_MAIL_FROM,
    to: { address: email },
    subject: "Your AffiliateMeetups sign-in code",
    text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this message.`,
  });
  return { ok: true, mode: "smtp" };
}
module.exports = {
  deliverLoginCode,
  capturedCodes: () => captured,
  clearCaptured: () => {
    captured.length = 0;
  },
  mode,
};
