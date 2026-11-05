#!/usr/bin/env node

/**
 * AMU Platform — Member Profiles API (L4.4)
 * Standalone Express server on port 3851
 * Proxied via Nginx at /api/members
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const { sendMail } = require('./mailer');
const waitlist = require('./waitlist-store');
const { joinPage, legalPage, LEGAL } = require('./join-form');

const app = express();
const PORT = 3851;
const DB_PATH = '/home/xenhive/amu-platform/stats.db';

app.use(cors({ origin: ['https://affiliatemeetups.com', 'https://www.affiliatemeetups.com', 'http://localhost:3000'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Directory, leaderboard, and onboarding answers are personal data.
// Closed unless AMU_MEMBERS_READ_TOKEN is set and sent as a Bearer token.
// POST /api/members/register does not use this check.
function requireMembersRead(req, res, next) {
  const expected = process.env.AMU_MEMBERS_READ_TOKEN || '';
  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  const ok = expected.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'authentication required' });
  next();
}

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

// GET /api/members — all completed profiles
app.get('/api/members', requireMembersRead, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT o.user_id, o.username, o.display_name, o.answers, o.completed_at,
             m.total_messages, m.streak_days, m.first_seen, m.last_seen
      FROM onboarding_state o
      LEFT JOIN members m ON o.user_id = m.user_id
      WHERE o.completed_at IS NOT NULL
      ORDER BY o.completed_at DESC
    `).all();
    db.close();
    const members = rows.map(r => ({ ...r, answers: JSON.parse(r.answers || '{}') }));
    res.json({ count: members.length, members });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/members/join', (req, res) => {
  const token = waitlist.issueFormToken();
  res.setHeader('Set-Cookie', `amu_join=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/api/members; Max-Age=7200`);
  res.type('html').send(joinPage({ token }));
});

app.get('/api/members/legal', (req, res) => {
  res.type('html').send(legalPage());
});

// GET /api/members/:username — single profile
app.get('/api/members/:username', requireMembersRead, (req, res) => {
  try {
    const db = getDb();
    const member = db.prepare(`
      SELECT o.user_id, o.username, o.display_name, o.answers, o.completed_at,
             m.total_messages, m.streak_days, m.first_seen, m.last_seen
      FROM onboarding_state o
      LEFT JOIN members m ON o.user_id = m.user_id
      WHERE o.username = ? AND o.completed_at IS NOT NULL
    `).get(req.params.username);
    db.close();
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json({ ...member, answers: JSON.parse(member.answers || '{}') });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats/today — today's activity
app.get('/api/stats/today', requireMembersRead, (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const stats = db.prepare(`
      SELECT channel, COUNT(*) as messages, COUNT(DISTINCT user_id) as members
      FROM messages WHERE date = ?
      GROUP BY channel
    `).all(today);
    db.close();
    res.json({ date: today, stats });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/leaderboard?channel=amu&date=2026-04-10
app.get('/api/leaderboard', requireMembersRead, (req, res) => {
  try {
    const db = getDb();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const channel = req.query.channel || 'amu';
    const top = db.prepare(`
      SELECT user_id, username, display_name, COUNT(*) as message_count
      FROM messages WHERE date = ? AND channel = ?
      GROUP BY user_id ORDER BY message_count DESC LIMIT 10
    `).all(date, channel);
    db.close();
    res.json({ date, channel, leaderboard: top });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/members/register — AMU registration form → Cyberimpact group 129 (Affiliate Meetups)
const https = require('https');
const CYBERIMPACT_API_KEY = process.env.CYBERIMPACT_API_KEY || '';
const AMU_GROUP_ID = process.env.GROUP_AMU || '129';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cyberimpactRequest(method, path, apiKey, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.cyberimpact.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let b;
        try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch { b = Buffer.concat(chunks).toString(); }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function cyberimpactAddMember(email, groupId, firstname, lastname) {
  const payload = JSON.stringify({
    email,
    groups: String(groupId),
    ...(firstname && { firstname }),
    ...(lastname && { lastname }),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cyberimpact.com',
      path: '/members',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CYBERIMPACT_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = Buffer.concat(chunks).toString(); }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 || res.statusCode === 409, status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

let cyberimpactForward = null;

function clientIp(req) {
  const forwarded = req.get('cf-connecting-ip') || req.get('x-real-ip') || req.get('x-forwarded-for') || '';
  return forwarded.split(',')[0].trim() || req.socket?.remoteAddress || '';
}

function readCookies(req) {
  const out = {};
  for (const part of (req.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = decodeURIComponent(rest.join('='));
  }
  return out;
}

async function forwardIfEnabled(email, firstname, lastname) {
  if (process.env.CYBERIMPACT_FORWARD !== '1') return { forwarded: false };
  const send = cyberimpactForward || cyberimpactAddMember;
  const result = await send(email, AMU_GROUP_ID, firstname, lastname);
  console.log(`[amu-register] ${email.slice(0, 3)}*** → group ${AMU_GROUP_ID} — HTTP ${result.status}`);
  if (!cyberimpactForward && result.status === 409) {
    try {
      const search = await cyberimpactRequest('GET', `/members/${encodeURIComponent(email)}`, CYBERIMPACT_API_KEY);
      const existing = search.ok ? search.body : null;
      if (existing && existing.id) {
        const addGroup = await cyberimpactRequest('POST', `/members/${existing.id}/groups`, CYBERIMPACT_API_KEY, { groups: String(AMU_GROUP_ID) });
        console.log(`[amu-register] existing member ${email.slice(0, 3)}*** → group ${AMU_GROUP_ID} HTTP ${addGroup.status}`);
      }
    } catch (err) {
      console.error('[amu-register] 409 group-add fallback error:', err.message);
    }
  }
  return { forwarded: true, status: result.status, duplicate: result.status === 409 };
}

app.post('/api/members/register', async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const firstname = waitlist.clip(body.firstname, 80);
  const lastname = waitlist.clip(body.lastname, 80);
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  if (!firstname || !lastname) {
    return res.status(400).json({ ok: false, error: 'First and last name are required' });
  }
  const blob = [body.company, body.role, body.goal, body.traffic].join('\n');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(blob) || /\bamu_(live|test)_[A-Za-z0-9_-]{8,}/.test(blob)) {
    return res.status(400).json({ ok: false, error: 'That submission cannot be stored' });
  }
  if (body.client === 'waitlist-form') {
    if (body.company_url_2) {
      return res.status(400).json({ ok: false, error: 'Could not accept this submission' });
    }
    const started = Number(body.started_at);
    const age = Date.now() - started;
    const cookies = readCookies(req);
    if (!body.form_token || cookies.amu_join !== body.form_token || !waitlist.consumeFormToken(body.form_token)) {
      return res.status(400).json({ ok: false, error: 'Could not accept this submission' });
    }
    if (!Number.isFinite(started) || age < 2000 || age > 2 * 60 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'Could not accept this submission' });
    }
  }
  const limit = waitlist.enforceRateLimit(email, clientIp(req));
  if (!limit.ok) {
    res.set('Retry-After', String(limit.retry_after));
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }
  const fields = {
    email,
    firstname,
    lastname,
    company: waitlist.clip(body.company, 200),
    role: waitlist.clip(body.role || body.jobtitle, 120),
    country: waitlist.clip(body.country, 80),
    website: waitlist.clip(body.website, 300),
    traffic: waitlist.clip(body.traffic, 500),
    source: waitlist.clip(body.source, 200),
    goal: waitlist.clip(body.goal, 2000),
    phone: waitlist.clip(body.phone, 40),
  };
  const saved = waitlist.insertSignup(fields, clientIp(req));
  let forwarded = { forwarded: false };
  try {
    forwarded = await forwardIfEnabled(email, firstname, lastname);
  } catch (err) {
    console.error('[amu-register] forward error:', err.message);
    forwarded = { forwarded: false, forward_error: true };
  }
  try {
    await sendMail({
      to: email,
      subject: 'AffiliateMeetups waitlist',
      text: `${LEGAL}\n\nWe stored your request ${saved.id}. No email provider is selected yet.`,
    });
  } catch (err) {
    console.error('[amu-register] mail error:', err.message);
  }
  if (req.is('application/x-www-form-urlencoded')) {
    return res.type('html').send(`<!doctype html><html lang="en"><body style="font-family:Georgia,serif;background:#F7F4EF;padding:32px"><h1>Request stored</h1><p>${LEGAL}</p><p>Reference ${saved.id}</p></body></html>`);
  }
  res.json({ ok: true, stored: true, id: saved.id, ...forwarded });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'amu-members', timestamp: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`✅ AMU Members API running on 127.0.0.1:${PORT}`);
  });
}

function setCyberimpactForwarder(fn) {
  cyberimpactForward = fn;
}

module.exports = { app, requireMembersRead, setCyberimpactForwarder };
