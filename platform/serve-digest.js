#!/usr/bin/env node

/**
 * AMU Platform — Digest & Links API (L4.5 + L4.6)
 * Runs on port 3852
 * Routes:
 *   GET /digest?date=YYYY-MM-DD&channel=amu    → digest JSON
 *   GET /digest/html?date=...&channel=...       → rendered HTML page
 *   GET /links?date=YYYY-MM-DD&channel=amu      → links feed
 *   GET /links/latest?channel=amu&limit=20      → latest links
 *   POST /saved                                 → save a message (L4.7)
 *   GET /saved/:user_id                         → get saved messages
 *   DELETE /saved/:user_id/:msg_id              → unsave
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = 3852;
const DB_PATH = '/home/xenhive/amu-platform/stats.db';

app.use(cors({ origin: '*' }));
app.use(express.json());

function getDb(readonly = true) {
  return new Database(DB_PATH, { readonly });
}

// ─── L4.5 DIGEST ───────────────────────────────────────────

// GET /digest?date=YYYY-MM-DD&channel=amu
app.get('/digest', (req, res) => {
  const date = req.query.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const channel = req.query.channel || 'amu';
  try {
    const db = getDb();
    const digest = db.prepare('SELECT * FROM digests WHERE date = ? AND channel = ?').get(date, channel);
    db.close();
    if (!digest) return res.status(404).json({ error: 'No digest for this date', date, channel });
    res.json({
      ...digest,
      top_links: JSON.parse(digest.top_links || '[]'),
      key_takeaways: JSON.parse(digest.key_takeaways || '[]'),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /digest/html?date=YYYY-MM-DD&channel=amu — rendered page
// One stylesheet, two pages. Duplicating it is how the digest and the link feed
// would slowly stop looking like the same product.
const PAGE_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e0e0e0; line-height: 1.6; }
    .container { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
    .header { border-bottom: 1px solid #2a2a3a; padding-bottom: 24px; margin-bottom: 32px; }
    .logo { color: #ff6b35; font-size: 14px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; }
    .meta { color: #888; font-size: 14px; margin-top: 8px; }
    .section { margin-bottom: 36px; }
    .section-title { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #ff6b35; margin-bottom: 16px; }
    .summary { font-size: 17px; color: #ccc; line-height: 1.8; }
    .takeaway { display: flex; gap: 12px; margin-bottom: 12px; }
    .bullet { color: #ff6b35; font-weight: 700; flex-shrink: 0; }
    .link-item { padding: 12px 0; border-bottom: 1px solid #1e1e2a; }
    .link-item:last-child { border: none; }
    .link-url { color: #4a9eff; text-decoration: none; font-size: 14px; word-break: break-all; }
    .link-url:hover { text-decoration: underline; }
    .link-meta { color: #666; font-size: 12px; margin-top: 4px; }
    .stats-row { display: flex; gap: 32px; }
    .stat { text-align: center; }
    .stat-num { font-size: 32px; font-weight: 700; color: #fff; }
    .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
    .top-member { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #1e1e2a; }
    .top-member:last-child { border: none; }
    .rank { color: #ff6b35; font-weight: 700; width: 24px; }
    .member-name { color: #fff; }
    .member-count { color: #888; font-size: 13px; margin-left: auto; }
    .footer { color: #555; font-size: 13px; text-align: center; padding-top: 32px; border-top: 1px solid #1e1e2a; }
    .join-cta { background: #ff6b35; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 700; margin-top: 16px; }
`;

app.get('/digest/html', (req, res) => {
  const date = req.query.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const channel = req.query.channel || 'amu';
  try {
    const db = getDb();
    const digest = db.prepare('SELECT * FROM digests WHERE date = ? AND channel = ?').get(date, channel);
    const highlights = db.prepare(`
      SELECT user_id, username, display_name, COUNT(*) as count
      FROM messages WHERE date = ? AND channel = ?
      GROUP BY user_id ORDER BY count DESC LIMIT 3
    `).all(date, channel);
    db.close();

    const channelName = channel === 'amu' ? 'Affiliate Meet-Ups' : 'XenTraffic';
    const topLinks = digest ? JSON.parse(digest.top_links || '[]') : [];
    const takeaways = digest ? JSON.parse(digest.key_takeaways || '[]') : [];

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Digest — ${date} | ${channelName}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">📊 Daily Digest</div>
      <h1>${channelName}</h1>
      <div class="meta">${new Date(date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    </div>

    ${digest ? `
    <div class="section">
      <div class="stats-row">
        <div class="stat">
          <div class="stat-num">${digest.total_messages || 0}</div>
          <div class="stat-label">Messages</div>
        </div>
        <div class="stat">
          <div class="stat-num">${digest.active_members || 0}</div>
          <div class="stat-label">Active Members</div>
        </div>
        <div class="stat">
          <div class="stat-num">${topLinks.length}</div>
          <div class="stat-label">Links Shared</div>
        </div>
      </div>
    </div>

    ${digest.summary ? `
    <div class="section">
      <div class="section-title">Overview</div>
      <div class="summary">${digest.summary}</div>
    </div>` : ''}

    ${takeaways.length ? `
    <div class="section">
      <div class="section-title">Key Takeaways</div>
      ${takeaways.map(t => `<div class="takeaway"><span class="bullet">•</span><span>${t}</span></div>`).join('')}
    </div>` : ''}
    ` : '<div class="section"><div class="summary">No digest available for this date yet.</div></div>'}

    ${highlights.length ? `
    <div class="section">
      <div class="section-title">Top Contributors</div>
      ${highlights.map((m, i) => `
        <div class="top-member">
          <span class="rank">${i + 1}</span>
          <span class="member-name">@${m.username || m.display_name}</span>
          <span class="member-count">${m.count} messages</span>
        </div>`).join('')}
    </div>` : ''}

    ${topLinks.length ? `
    <div class="section">
      <div class="section-title">Links Shared Today</div>
      ${topLinks.slice(0, 10).map(l => `
        <div class="link-item">
          <a href="${l.url}" target="_blank" rel="noopener" class="link-url">${l.url}</a>
          <div class="link-meta">Shared by @${l.username || l.display_name}</div>
        </div>`).join('')}
    </div>` : ''}

    <div class="footer">
      <div>Powered by AMU 🔮</div>
      <a href="https://t.me/+nrDKZxYhDRxiOTE8" class="join-cta">Join the Community →</a>
    </div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// ─── L4.6 LINK FEED ────────────────────────────────────────

// GET /links?date=YYYY-MM-DD&channel=amu
app.get('/links', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const channel = req.query.channel || 'amu';
  try {
    const db = getDb();
    const links = db.prepare(`
      SELECT * FROM links WHERE date = ? AND channel = ?
      ORDER BY timestamp DESC
    `).all(date, channel);
    db.close();
    res.json({ date, channel, count: links.length, links });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /links/latest?channel=amu&limit=20
app.get('/links/latest', (req, res) => {
  const channel = req.query.channel || 'amu';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const db = getDb();
    const links = db.prepare(`
      SELECT * FROM links WHERE channel = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(channel, limit);
    db.close();
    res.json({ channel, count: links.length, links });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── L4.7 SAVED MESSAGES ───────────────────────────────────

// POST /saved — save a message (called when user reacts with 🥰)
app.post('/saved', (req, res) => {
  const { user_id, channel, telegram_msg_id, message_text, from_username } = req.body;
  if (!user_id || !telegram_msg_id) return res.status(400).json({ error: 'user_id and telegram_msg_id required' });
  try {
    const db = getDb(false);
    db.prepare(`
      INSERT OR IGNORE INTO saved_messages (user_id, channel, telegram_msg_id, message_text, from_username, saved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(user_id), channel || 'amu', telegram_msg_id, message_text || null, from_username || null, new Date().toISOString());
    db.close();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /saved/:user_id — get user's saved messages
// GET /links/html?channel=amu&limit=60 — the human-readable link feed.
// Telegram's service account (777000) is the sender of everything auto-forwarded from
// the linked XenTraffic channel. Publicly labelling those "shared by @Telegram" would
// read like a bug, so they are attributed to the channel they actually came from.
app.get('/links/html', (req, res) => {
  const channel = req.query.channel || 'amu';
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  try {
    const db = getDb();
    const links = db.prepare(`
      SELECT * FROM links WHERE channel = ? ORDER BY timestamp DESC LIMIT ?
    `).all(channel, limit);
    db.close();

    const channelName = channel === 'amu' ? 'Affiliate Meet-Ups' : 'XenTraffic';
    const summarised = links.filter(l => l.ai_summary && l.ai_summary.trim()).length;
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const who = (l) => l.user_id === '777000'
      ? 'XenTraffic channel'
      : '@' + esc(l.username || l.display_name || 'unknown');

    const byDate = {};
    for (const l of links) (byDate[l.date] = byDate[l.date] || []).push(l);
    const dates = Object.keys(byDate).sort().reverse();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Feed | ${channelName}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🔗 Link Feed</div>
      <h1>${channelName}</h1>
      <div class="meta">Everything the community shares, newest first</div>
    </div>

    <div class="section">
      <div class="stats-row">
        <div class="stat">
          <div class="stat-num">${links.length}</div>
          <div class="stat-label">Links</div>
        </div>
        <div class="stat">
          <div class="stat-num">${summarised}</div>
          <div class="stat-label">Summarised</div>
        </div>
        <div class="stat">
          <div class="stat-num">${dates.length}</div>
          <div class="stat-label">Days covered</div>
        </div>
      </div>
    </div>

    ${links.length === 0 ? '<div class="section"><div class="summary">No links shared yet.</div></div>' : ''}

    ${dates.map(d => `
    <div class="section">
      <div class="section-title">${new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}</div>
      ${byDate[d].map(l => `
        <div class="link-item">
          <a href="${esc(l.url)}" target="_blank" rel="noopener nofollow" class="link-url">${esc(l.url)}</a>
          ${l.ai_summary && l.ai_summary.trim() ? `<div class="summary" style="font-size:14px;margin-top:6px">${esc(l.ai_summary)}</div>` : ''}
          <div class="link-meta">${who(l)}</div>
        </div>`).join('')}
    </div>`).join('')}

    <div class="footer">
      <div>Powered by AMU 🔮</div>
      <a href="https://t.me/+nrDKZxYhDRxiOTE8" class="join-cta">Join the Community →</a>
    </div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/saved/:user_id', (req, res) => {
  try {
    const db = getDb();
    const saved = db.prepare(`
      SELECT * FROM saved_messages WHERE user_id = ?
      ORDER BY saved_at DESC
    `).all(req.params.user_id);
    db.close();
    res.json({ count: saved.length, saved });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /saved/:user_id/:msg_id — unsave
app.delete('/saved/:user_id/:msg_id', (req, res) => {
  try {
    const db = getDb(false);
    db.prepare('DELETE FROM saved_messages WHERE user_id = ? AND telegram_msg_id = ?')
      .run(req.params.user_id, parseInt(req.params.msg_id));
    db.close();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─── L4.4 MEMBER PROFILES HTML ─────────────────────────────────────────────

const MEMBERS_CSS = PAGE_CSS + `
  .member-card { display:flex; align-items:flex-start; gap:16px; padding:20px 0; border-bottom:1px solid #1e1e2a; }
  .member-card:last-child { border-bottom:none; }
  .avatar { width:48px; height:48px; border-radius:50%; background:#1e1e2a; display:flex; align-items:center; justify-content:center; font-size:22px; flex-shrink:0; }
  .member-info { flex:1; }
  .member-name { font-size:17px; font-weight:700; color:#fff; }
  .member-handle { font-size:13px; color:#888; margin-top:2px; }
  .member-answers { margin-top:12px; display:flex; flex-direction:column; gap:6px; }
  .answer-row { font-size:14px; color:#ccc; }
  .answer-label { color:#ff6b35; font-weight:600; margin-right:6px; }
  .member-stats { display:flex; gap:16px; margin-top:12px; flex-wrap:wrap; }
  .member-stat { font-size:12px; color:#888; }
  .member-stat span { color:#fff; font-weight:700; }
  .empty-state { text-align:center; padding:60px 20px; }
  .empty-state .emoji { font-size:48px; margin-bottom:16px; }
  .empty-state h3 { font-size:20px; font-weight:700; color:#fff; margin-bottom:8px; }
  .empty-state p { color:#888; font-size:15px; margin-bottom:24px; }
  .tg-btn { display:inline-block; background:#0088cc; color:#fff; padding:12px 24px; border-radius:10px; font-weight:700; font-size:14px; text-decoration:none; }
  .search-box { width:100%; background:#1e1e2a; border:1px solid #2a2a3a; border-radius:10px; padding:12px 16px; font-size:15px; color:#fff; outline:none; margin-bottom:24px; font-family:inherit; }
  .search-box::placeholder { color:#888; }
  .lb-row { display:flex; align-items:center; gap:14px; padding:12px 0; border-bottom:1px solid #1e1e2a; }
  .lb-row:last-child { border-bottom:none; }
  .lb-rank { font-size:20px; font-weight:900; color:#ff6b35; width:32px; text-align:center; flex-shrink:0; }
  .lb-name { color:#fff; font-size:15px; font-weight:600; flex:1; }
  .lb-score { color:#888; font-size:13px; }
`;

// GET /members/html — member profiles page
app.get('/members/html', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT o.user_id, o.username, o.display_name, o.answers, o.completed_at,
             m.total_messages, m.streak_days, m.first_seen
      FROM onboarding_state o
      LEFT JOIN members m ON o.user_id = m.user_id
      WHERE o.completed_at IS NOT NULL
      ORDER BY m.total_messages DESC NULLS LAST
    `).all();
    db.close();

    const members = rows.map(r => ({ ...r, answers: JSON.parse(r.answers || '{}') }));

    const memberCards = members.length === 0
      ? `<div class="empty-state">
          <div class="emoji">👥</div>
          <h3>Profiles coming soon</h3>
          <p>Members who join the Telegram group get onboarded here. Be the first to fill out your profile.</p>
          <a href="https://t.me/+nrDKZxYhDRxiOTE8" target="_blank" class="tg-btn">Join AMU Telegram →</a>
        </div>`
      : members.map(m => `
          <div class="member-card">
            <div class="avatar">👤</div>
            <div class="member-info">
              <div class="member-name">${escHtml(m.display_name || 'Anonymous')}</div>
              <div class="member-handle">${m.username ? '@' + escHtml(m.username) : ''}</div>
              <div class="member-answers">
                ${m.answers.building ? `<div class="answer-row"><span class="answer-label">Building:</span>${escHtml(m.answers.building)}</div>` : ''}
                ${m.answers.traffic ? `<div class="answer-row"><span class="answer-label">Traffic:</span>${escHtml(m.answers.traffic)}</div>` : ''}
                ${m.answers.stage ? `<div class="answer-row"><span class="answer-label">Stage:</span>${escHtml(m.answers.stage)}</div>` : ''}
                ${m.answers.location ? `<div class="answer-row"><span class="answer-label">Based in:</span>${escHtml(m.answers.location)}</div>` : ''}
                ${m.answers.share ? `<div class="answer-row"><span class="answer-label">Can share:</span>${escHtml(m.answers.share)}</div>` : ''}
              </div>
              <div class="member-stats">
                ${m.total_messages ? `<div class="member-stat"><span>${m.total_messages}</span> messages</div>` : ''}
                ${m.streak_days > 0 ? `<div class="member-stat"><span>${m.streak_days}🔥</span> day streak</div>` : ''}
                ${m.first_seen ? `<div class="member-stat">Joined <span>${m.first_seen.slice(0,10)}</span></div>` : ''}
              </div>
            </div>
          </div>`).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AMU Members — Affiliate Meet-Ups</title>
      <style>${MEMBERS_CSS}</style>
    </head><body>
      <div class="container">
        <div class="header">
          <div class="logo"><a href="/" style="color:inherit;text-decoration:none">← affiliatemeetups.com</a></div>
          <h1>Community Members</h1>
          <div class="meta">${members.length} affiliate${members.length !== 1 ? 's' : ''} with profiles · <a href="https://t.me/+nrDKZxYhDRxiOTE8" target="_blank" style="color:#ff6b35">Join the group →</a></div>
        </div>
        ${members.length > 3 ? '<input class="search-box" id="search" placeholder="Search members..." oninput="filterMembers(this.value)"/>' : ''}
        <div id="memberList">${memberCards}</div>
      </div>
      <script>
        function filterMembers(q) {
          const cards = document.querySelectorAll('.member-card');
          const lq = q.toLowerCase();
          cards.forEach(c => { c.style.display = c.textContent.toLowerCase().includes(lq) ? '' : 'none'; });
        }
      </script>
    </body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// GET /leaderboard/html — live leaderboard page
app.get('/leaderboard/html', (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);

    // All-time top 20
    const alltime = db.prepare(`
      SELECT user_id, username, display_name, total_messages, streak_days, last_seen
      FROM members
      ORDER BY total_messages DESC
      LIMIT 20
    `).all();

    // Today's activity
    const todayTop = db.prepare(`
      SELECT user_id, username, display_name, COUNT(*) as msgs
      FROM messages
      WHERE channel = 'amu' AND date(timestamp) = ?
      GROUP BY user_id ORDER BY msgs DESC LIMIT 10
    `).all(today);

    // Community stats
    const stats = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as members, COUNT(*) as messages
      FROM messages WHERE channel='amu'
    `).get();

    const linkCount = db.prepare('SELECT COUNT(*) as n FROM links').get().n;
    db.close();

    const medals = ['🥇','🥈','🥉'];
    const allTimeRows = alltime.map((m, i) => `
      <div class="lb-row">
        <div class="lb-rank">${medals[i] || (i + 1)}</div>
        <div class="lb-name">${escHtml(m.display_name || m.username || 'Member')}${m.username ? `<div style="font-size:12px;color:#888;font-weight:400">@${escHtml(m.username)}</div>` : ''}</div>
        <div class="lb-score">${m.total_messages} msgs${m.streak_days > 1 ? ` · ${m.streak_days}🔥` : ''}</div>
      </div>`).join('');

    const todayRows = todayTop.length
      ? todayTop.map((m, i) => `
          <div class="lb-row">
            <div class="lb-rank">${i + 1}</div>
            <div class="lb-name">${escHtml(m.display_name || m.username || 'Member')}</div>
            <div class="lb-score">${m.msgs} msg${m.msgs !== 1 ? 's' : ''} today</div>
          </div>`).join('')
      : '<div style="color:#888;padding:20px 0;text-align:center">No activity yet today</div>';

    res.send(`<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AMU Leaderboard — Affiliate Meet-Ups</title>
      <style>${MEMBERS_CSS}</style>
    </head><body>
      <div class="container">
        <div class="header">
          <div class="logo"><a href="/" style="color:inherit;text-decoration:none">← affiliatemeetups.com</a></div>
          <h1>🏆 Leaderboard</h1>
          <div class="meta">Live community stats · Updated daily</div>
        </div>
        <div class="section">
          <div class="section-title">Community Overview</div>
          <div class="stats-row">
            <div class="stat"><div class="stat-num">${stats.members}</div><div class="stat-label">Active Members</div></div>
            <div class="stat"><div class="stat-num">${stats.messages}</div><div class="stat-label">Total Messages</div></div>
            <div class="stat"><div class="stat-num">${linkCount}</div><div class="stat-label">Links Shared</div></div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">Today's Activity</div>
          ${todayRows}
        </div>
        <div class="section">
          <div class="section-title">All-Time Top Members</div>
          ${allTimeRows || '<div style="color:#888;padding:20px 0;text-align:center">No data yet</div>'}
        </div>
        <div style="margin-top:32px;text-align:center">
          <a href="https://t.me/+nrDKZxYhDRxiOTE8" target="_blank" class="tg-btn">Join AMU Telegram →</a>
        </div>
      </div>
    </body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'amu-digest', port: PORT }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ AMU Digest/Links/Saved API on 127.0.0.1:${PORT}`);
});
