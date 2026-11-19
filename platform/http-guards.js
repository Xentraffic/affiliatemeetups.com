'use strict';

/**
 * Small, dependency-free guards shared by the legacy AMU services
 * (serve-digest.js, api-members.js). Everything reads its configuration from
 * the environment at request time and fails closed when it is missing.
 */

const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 16;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time comparison that does not leak the expected length: both sides
// are hashed to 32 bytes before timingSafeEqual.
function tokenMatches(presented, expected) {
  if (!expected || expected.length < MIN_TOKEN_LENGTH || !presented) return false;
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

function presentedBearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Express middleware: 401 unless `Authorization: Bearer <token>` matches the
// value of process.env[envName]. A missing or short env value closes the route.
function requireBearer(envName) {
  return function bearerGuard(req, res, next) {
    if (!tokenMatches(presentedBearer(req), process.env[envName] || '')) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'authentication required' });
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
}

function originList(envName, fallback = []) {
  const raw = process.env[envName];
  if (raw == null || raw.trim() === '') return fallback.slice();
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// `cors` options whose allowlist comes from a comma-separated env var.
// Default: no cross-origin access at all (no Access-Control-Allow-Origin).
function corsFromEnv(envName, fallback = []) {
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, false);
      cb(null, originList(envName, fallback).includes(origin));
    },
  };
}

// Fixed-window in-memory limiter. Good enough for a single pm2 instance; the
// limits reset on restart, which is acceptable for an abuse brake.
function rateLimit({ windowMs, max, key = req => req.ip, error = 'rate_limited' }) {
  const hits = new Map();
  return function limiter(req, res, next) {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [hk, hv] of hits) if (now - hv.start >= windowMs) hits.delete(hk);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)));
      return res.status(429).json({ ok: false, error });
    }
    next();
  };
}

module.exports = { requireBearer, tokenMatches, corsFromEnv, originList, rateLimit, MIN_TOKEN_LENGTH };
