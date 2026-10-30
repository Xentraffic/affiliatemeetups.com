'use strict';

/**
 * Outbound mail for owner sign-in codes.
 *
 * Cyberimpact is the only outbound mail path that exists on this host (it is
 * what the live join form already uses). Its API key lives in the service
 * environment and was not available during the inspection, so this module has
 * three explicit modes and no silent fallback:
 *
 *   'cyberimpact' — real transactional send. Requires CYBERIMPACT_API_KEY.
 *   'log'         — writes the delivery intent to stdout without the code.
 *   'capture'     — test mode; codes land in an in-memory array.
 *
 * Default is 'log': a misconfigured deployment must never appear to have mailed
 * something it did not.
 */

const https = require('https');

const captured = [];

function mode() {
  return process.env.COMMUNITY_MAIL_MODE || 'log';
}

function cyberimpactSend(email, code) {
  const key = process.env.CYBERIMPACT_API_KEY;
  if (!key) return Promise.reject(new Error('CYBERIMPACT_API_KEY missing'));
  const payload = JSON.stringify({
    to: email,
    subject: 'Your Affiliate Meet-Ups sign-in code',
    text: `Your sign-in code is ${code}. It expires in 10 minutes.`,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cyberimpact.com',
      path: '/transactional',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        ok ? resolve({ ok, status: res.statusCode })
           : reject(new Error(`cyberimpact HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('cyberimpact timeout')); });
    req.write(payload);
    req.end();
  });
}

async function deliverLoginCode(email, code) {
  switch (mode()) {
    case 'cyberimpact':
      return cyberimpactSend(email, code);
    case 'capture':
      captured.push({ email, code, at: new Date().toISOString() });
      return { ok: true, mode: 'capture' };
    case 'log':
    default:
      // The code itself is deliberately not logged.
      console.log(`[community-mail] login code for ${email.slice(0, 3)}*** (mode=log, not delivered)`);
      return { ok: true, mode: 'log' };
  }
}

function capturedCodes() { return captured; }
function clearCaptured() { captured.length = 0; }

module.exports = { deliverLoginCode, capturedCodes, clearCaptured, mode };
