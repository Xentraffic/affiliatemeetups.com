const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const cache = new Map();

function dbPath() {
  return process.env.WAITLIST_DB_PATH || path.join(__dirname, 'waitlist.db');
}

function open() {
  const file = dbPath();
  if (cache.has(file)) return cache.get(file);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      email TEXT NOT NULL,
      firstname TEXT,
      lastname TEXT,
      company TEXT,
      role TEXT,
      country TEXT,
      website TEXT,
      traffic TEXT,
      source TEXT,
      goal TEXT,
      phone TEXT,
      ip_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS rate_buckets (
      bucket_key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (bucket_key, window_start)
    );
    CREATE TABLE IF NOT EXISTS form_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  cache.set(file, db);
  return db;
}

function clip(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function pepper() {
  return process.env.WAITLIST_PEPPER || 'amu-waitlist';
}

function issueFormToken() {
  const token = crypto.randomBytes(16).toString('base64url');
  open().prepare('INSERT INTO form_tokens (token_hash, expires_at) VALUES (?, ?)').run(sha256(token), Date.now() + 2 * 60 * 60 * 1000);
  return token;
}

function consumeFormToken(token) {
  if (!token) return false;
  const db = open();
  const row = db.prepare('SELECT expires_at FROM form_tokens WHERE token_hash = ?').get(sha256(token));
  if (!row || row.expires_at < Date.now()) return false;
  db.prepare('DELETE FROM form_tokens WHERE token_hash = ?').run(sha256(token));
  return true;
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hit(key, limit, windowSec) {
  const db = open();
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSec * 1000)) * windowSec * 1000;
  const row = db.prepare('SELECT count FROM rate_buckets WHERE bucket_key = ? AND window_start = ?').get(key, windowStart);
  const count = row ? row.count : 0;
  if (count >= limit) {
    const retry = Math.max(1, Math.ceil((windowStart + windowSec * 1000 - now) / 1000));
    return { ok: false, retry_after: retry };
  }
  db.prepare(`INSERT INTO rate_buckets (bucket_key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = count + 1`).run(key, windowStart);
  return { ok: true };
}

function enforceRateLimit(email, ip) {
  const windowSec = Number(process.env.WAITLIST_WINDOW_SEC || 3600);
  const emailLimit = Number(process.env.WAITLIST_EMAIL_LIMIT || 5);
  const ipLimit = Number(process.env.WAITLIST_IP_LIMIT || 20);
  const emailHit = hit(`email:${sha256(String(email).toLowerCase())}`, emailLimit, windowSec);
  if (!emailHit.ok) return emailHit;
  if (ip && !isLoopback(ip)) {
    const ipHit = hit(`ip:${sha256(pepper() + '|' + ip)}`, ipLimit, windowSec);
    if (!ipHit.ok) return ipHit;
  }
  return { ok: true };
}

function insertSignup(fields, ip) {
  const id = `wl_${crypto.randomBytes(9).toString('base64url')}`;
  const now = new Date().toISOString();
  open().prepare(`INSERT INTO signups
    (id, created_at, email, firstname, lastname, company, role, country, website, traffic, source, goal, phone, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, now,
    fields.email, fields.firstname, fields.lastname, fields.company, fields.role,
    fields.country, fields.website, fields.traffic, fields.source, fields.goal, fields.phone,
    ip && !isLoopback(ip) ? sha256(pepper() + '|' + ip) : null,
  );
  return { id, created_at: now };
}

function getSignup(id) {
  return open().prepare('SELECT * FROM signups WHERE id = ?').get(id);
}

module.exports = {
  clip, issueFormToken, consumeFormToken, enforceRateLimit, insertSignup, getSignup, sha256,
};
