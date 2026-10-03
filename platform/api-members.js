#!/usr/bin/env node

/**
 * AMU Platform — Member Profiles API (L4.4)
 * Standalone Express server on port 3851
 * Proxied via Nginx at /api/members
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const app = express();
const PORT = 3851;
const DB_PATH = '/home/xenhive/amu-platform/stats.db';

app.use(cors({ origin: ['https://affiliatemeetups.com', 'https://www.affiliatemeetups.com', 'http://localhost:3000'] }));
app.use(express.json());

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

// GET /api/members — all completed profiles
app.get('/api/members', (req, res) => {
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

// GET /api/members/:username — single profile
app.get('/api/members/:username', (req, res) => {
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
app.get('/api/stats/today', (req, res) => {
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
app.get('/api/leaderboard', (req, res) => {
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

app.post('/api/members/register', async (req, res) => {
  const { firstname, lastname, email, company, jobtitle, phone } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  if (!firstname || !lastname) {
    return res.status(400).json({ ok: false, error: 'First and last name are required' });
  }
  try {
    const result = await cyberimpactAddMember(email, AMU_GROUP_ID, firstname, lastname);
    console.log(`[amu-register] ${email.slice(0,3)}*** → group ${AMU_GROUP_ID} — HTTP ${result.status}`);

    // 409 = contact already exists. Look up their ID and add to AMU group explicitly.
    if (result.status === 409) {
      try {
        const search = await cyberimpactRequest('GET', `/members/${encodeURIComponent(email)}`, CYBERIMPACT_API_KEY);
        const existing = search.ok ? search.body : null;
        if (existing && existing.id) {
          const addGroup = await cyberimpactRequest('POST', `/members/${existing.id}/groups`, CYBERIMPACT_API_KEY, { groups: String(AMU_GROUP_ID) });
          console.log(`[amu-register] existing member ${email.slice(0,3)}*** (id=${existing.id}) → added to group ${AMU_GROUP_ID} HTTP ${addGroup.status}`);
        } else {
          console.warn(`[amu-register] 409 but could not find member by email in search`);
        }
      } catch (e2) {
        console.error('[amu-register] 409 group-add fallback error:', e2.message);
      }
    }

    res.json({ ok: true, status: result.status, duplicate: result.status === 409 });
  } catch (err) {
    console.error('[amu-register] error:', err.message);
    res.status(500).json({ ok: false, error: 'Registration failed. Please try again.' });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'amu-members', timestamp: new Date().toISOString() });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ AMU Members API running on 127.0.0.1:${PORT}`);
});
