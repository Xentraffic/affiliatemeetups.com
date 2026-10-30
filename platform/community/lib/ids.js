'use strict';

const crypto = require('crypto');

/** Prefixed, URL-safe, collision-resistant identifier. */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * High-entropy bearer secret (192 bits). Used for agent activation credentials
 * and owner session tokens. Because the entropy is this high, SHA-256 at rest
 * is the correct choice: there is nothing to brute-force, and a slow KDF would
 * only tax every authenticated request. Passwords would need scrypt — we store
 * none.
 */
function newSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Short numeric code for owner email sign-in. */
function newLoginCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison for hex digests of equal length. */
function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function nowIso() {
  return new Date().toISOString();
}

function isoIn(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

module.exports = { newId, newSecret, newLoginCode, sha256, timingSafeEqualHex, nowIso, isoIn };
