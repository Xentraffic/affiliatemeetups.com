#!/usr/bin/env node

/**
 * AMU Platform — Message Tracker (L4.1)
 * Logs all messages from AMU + XenTraffic main for Daily Highlights stats
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = '/home/xenhive/amu-platform/stats.db';

// L4.6 link feed: the live ingest path (ingest-webhook.js) flagged has_link but
// never populated the links table, so serve-digest.js /links and the digest's
// "Top links shared" section had nothing to read. Extract every URL from a
// message and record it here. Global flag so we capture ALL links, not just the first.
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

function extractLinks(text) {
  if (!text) return [];
  const matches = String(text).match(URL_REGEX) || [];
  // strip trailing punctuation the regex greedily swallows, then dedupe
  return [...new Set(matches.map(u => u.replace(/[.,;:!?)\]]+$/, '')))];
}

// Daily Highlights rank PEOPLE. user_id 777000 is Telegram's service account (the
// sender of anything forwarded from a linked channel) and was winning most badges —
// 38 of 141 tracked messages. Bots are excluded for the same reason. Kept as one
// fragment so a new highlight category cannot forget the filter.
const HUMANS_ONLY = `user_id != '777000' AND COALESCE(username,'') NOT LIKE '%bot'`;

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,           -- 'amu' or 'xentraffic'
      telegram_msg_id INTEGER,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      timestamp INTEGER NOT NULL,      -- Unix epoch ms
      has_link INTEGER DEFAULT 0,      -- 1 if message contains a URL
      is_reply INTEGER DEFAULT 0,      -- 1 if replying to someone
      reply_to_user_id TEXT,           -- who they replied to
      thread_id INTEGER,               -- thread/topic starter msg id
      is_thread_start INTEGER DEFAULT 0, -- 1 if started a new thread
      date TEXT NOT NULL               -- YYYY-MM-DD for easy grouping
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      telegram_msg_id INTEGER,
      from_user_id TEXT NOT NULL,
      emoji TEXT,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      join_date TEXT,
      first_seen TEXT,
      last_seen TEXT,
      total_messages INTEGER DEFAULT 0,
      streak_days INTEGER DEFAULT 0,
      last_streak_date TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, date);
  `);
  db.close();
  console.log('✅ DB initialized:', DB_PATH);
}

/**
 * Log a message event (called from OpenClaw hook or n8n)
 */
function logMessage(data) {
  const db = getDb();
  const date = new Date(data.timestamp).toISOString().slice(0, 10);

  const insert = db.prepare(`
    INSERT INTO messages (channel, telegram_msg_id, user_id, username, display_name,
      timestamp, has_link, is_reply, reply_to_user_id, thread_id, is_thread_start, date, text)
    VALUES (@channel, @telegram_msg_id, @user_id, @username, @display_name,
      @timestamp, @has_link, @is_reply, @reply_to_user_id, @thread_id, @is_thread_start, @date, @text)
  `);

  // text was previously dropped (not in the INSERT) even though the payload carries
  // it; store it so links can be re-derived and the digest can quote context.
  insert.run({ ...data, date, text: data.text ?? null });

  // L4.6: record each URL in the links table (INSERT OR IGNORE against the
  // uq_links_msg_url index makes re-ingestion and backfill idempotent).
  const links = extractLinks(data.text);
  if (links.length) {
    const linkInsert = db.prepare(`
      INSERT OR IGNORE INTO links
        (channel, user_id, username, display_name, url, telegram_msg_id, timestamp, date)
      VALUES (@channel, @user_id, @username, @display_name, @url, @telegram_msg_id, @timestamp, @date)
    `);
    for (const url of links) {
      linkInsert.run({
        channel: data.channel, user_id: data.user_id, username: data.username,
        display_name: data.display_name, url, telegram_msg_id: data.telegram_msg_id ?? null,
        timestamp: data.timestamp, date,
      });
    }
  }

  // Update member stats
  const upsert = db.prepare(`
    INSERT INTO members (user_id, username, display_name, first_seen, last_seen, total_messages)
    VALUES (@user_id, @username, @display_name, @date, @date, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      username = @username,
      display_name = @display_name,
      last_seen = @date,
      total_messages = total_messages + 1
  `);
  upsert.run({ user_id: data.user_id, username: data.username, display_name: data.display_name, date });

  // L3 Module 2: keep the daily posting streak. The columns existed since April but
  // nothing ever wrote them, so streak_days was 0 for all members and the "Streak
  // Leader" highlight could never fire. Rules:
  //   same day again      -> unchanged (re-ingesting a day is safe)
  //   exactly yesterday   -> +1
  //   older / never / gap -> reset to 1
  // Guarded on last_streak_date <= date so a backfill or an out-of-order webhook
  // can never walk a streak backwards.
  updateStreak(db, data.user_id, date);

  db.close();
}

/**
 * Advance a member's consecutive-days streak. Exported so the backfill reuses the
 * exact same rule as the live path rather than a second implementation.
 */
function updateStreak(db, user_id, date) {
  const row = db.prepare('SELECT streak_days, last_streak_date FROM members WHERE user_id = ?').get(user_id);
  if (!row) return;
  const last = row.last_streak_date;
  if (last === date) return;        // already counted for that day
  if (last && last > date) return;  // out-of-order / backfill: never rewind
  const yesterday = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000)
    .toISOString().slice(0, 10);
  const streak = last === yesterday ? (row.streak_days || 0) + 1 : 1;
  db.prepare('UPDATE members SET streak_days = ?, last_streak_date = ? WHERE user_id = ?')
    .run(streak, date, user_id);
}

/**
 * Get daily stats for a specific date and channel
 */
function getDailyStats(date, channel) {
  const db = getDb();

  const stats = {
    date,
    channel,
    total_messages: 0,
    active_members: 0,
    highlights: {}
  };

  // Total messages + active members
  const summary = db.prepare(`
    SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as members
    FROM messages WHERE date = ? AND channel = ? AND ${HUMANS_ONLY}
  `).get(date, channel);
  stats.total_messages = summary.total;
  stats.active_members = summary.members;

  // 🏆 Top Contributor (most messages)
  const topContributor = db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) as count
    FROM messages WHERE date = ? AND channel = ? AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel);
  stats.highlights.top_contributor = topContributor;

  // 🔗 Link Champion (most links shared)
  const linkChamp = db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) as count
    FROM messages WHERE date = ? AND channel = ? AND has_link = 1 AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel);
  stats.highlights.link_champion = linkChamp;

  // 💬 Conversation Starter (most thread starts)
  const convStarter = db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) as count
    FROM messages WHERE date = ? AND channel = ? AND is_thread_start = 1 AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel);
  stats.highlights.conversation_starter = convStarter;

  // 🤝 Helpful Responder (most replies sent)
  const helpfulResponder = db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) as count
    FROM messages WHERE date = ? AND channel = ? AND is_reply = 1 AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel);
  stats.highlights.helpful_responder = helpfulResponder;

  // 🌐 Community Connector (replied to most unique people)
  const connector = db.prepare(`
    SELECT user_id, username, display_name, COUNT(DISTINCT reply_to_user_id) as count
    FROM messages WHERE date = ? AND channel = ? AND is_reply = 1 AND reply_to_user_id IS NOT NULL AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel);
  stats.highlights.community_connector = connector;

  // 🦉 Night Owl (most messages outside 9am-6pm UTC)
  const nightOwl = db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) as count
    FROM messages WHERE date = ? AND channel = ?
    AND (CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch')) AS INTEGER) < 9
      OR CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch')) AS INTEGER) >= 18)
    AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel);
  stats.highlights.night_owl = nightOwl;

  // 🌟 Rising Star (most messages, joined <14 days ago)
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const risingStar = db.prepare(`
    SELECT m.user_id, m.username, m.display_name, COUNT(*) as count
    FROM messages m
    JOIN members mb ON m.user_id = mb.user_id
    WHERE m.date = ? AND m.channel = ? AND mb.first_seen >= ? AND ${HUMANS_ONLY.replace(/user_id/g, 'm.user_id').replace(/username/g, 'm.username')}
    GROUP BY m.user_id ORDER BY count DESC LIMIT 1
  `).get(date, channel, twoWeeksAgo);
  stats.highlights.rising_star = risingStar;

  // 🔥 Streak Leader (longest run of consecutive active days, among today's actives).
  // Restricted to members active on `date` so the badge always names someone who
  // actually showed up that day, not a dormant record-holder.
  // Derived from the messages table AS OF `date` (gaps-and-islands: consecutive days
  // share date - row_number), NOT from members.streak_days — that column holds the
  // streak as of the member's last activity, which would be wrong when re-posting an
  // older day. HAVING run_end = date keeps only streaks still alive that day.
  const streakLeader = db.prepare(`
    WITH active AS (
      SELECT DISTINCT user_id, date FROM messages WHERE channel = ? AND date <= ? AND ${HUMANS_ONLY}
    ),
    grouped AS (
      SELECT user_id, date,
             julianday(date) - ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date) AS grp
      FROM active
    ),
    runs AS (
      SELECT user_id, COUNT(*) AS count, MAX(date) AS run_end
      FROM grouped GROUP BY user_id, grp
    )
    SELECT r.user_id, mb.username, mb.display_name, r.count
    FROM runs r LEFT JOIN members mb ON mb.user_id = r.user_id
    WHERE r.run_end = ? AND r.count > 1
    ORDER BY r.count DESC LIMIT 1
  `).get(channel, date, date);
  stats.highlights.streak_leader = streakLeader;

  db.close();
  return stats;
}

/**
 * Format highlights as Telegram message (Jason's style)
 */
function formatHighlights(stats) {
  const h = stats.highlights;
  const channelName = stats.channel === 'amu' ? 'Affiliate Meet-Ups' : 'XenTraffic';
  const lines = [];

  lines.push(`📊 <b>Daily Highlights — ${stats.date}</b>`);
  lines.push(`<i>${stats.active_members} active members · ${stats.total_messages} messages</i>`);
  lines.push('');

  const fmt = (emoji, title, stat, tagline) => {
    if (!stat || stat.count === 0) return null;
    const handle = stat.username ? `@${stat.username}` : stat.display_name;
    return `${emoji} ${title}: ${handle}\n ${stat.count} ${tagline}`;
  };

  const sections = [
    fmt('🏆', 'Top Contributor', h.top_contributor, 'messages — <i>Unstoppable.</i>'),
    fmt('🔗', 'Link Champion', h.link_champion, 'links shared — <i>Always bringing the goods.</i>'),
    fmt('💬', 'Conversation Starter', h.conversation_starter, 'threads sparked — <i>The catalyst.</i>'),
    fmt('🤝', 'Helpful Responder', h.helpful_responder, 'replies — <i>Always in your corner.</i>'),
    fmt('🌐', 'Community Connector', h.community_connector, 'people replied to — <i>Bringing the network together.</i>'),
    fmt('🌟', 'Rising Star', h.rising_star, 'messages (joined &lt;2 weeks ago) — <i>New here and already owning it.</i>'),
    fmt('🦉', 'Night Owl', h.night_owl, 'messages outside business hours — <i>Burning the midnight oil.</i>'),
    fmt('🔥', 'Streak Leader', h.streak_leader, 'days in a row — <i>Never misses.</i>')
  ].filter(Boolean);

  lines.push(...sections);
  lines.push('');
  lines.push(`🔮 <i>Powered by AMU</i>`);

  return lines.join('\n');
}

// CLI interface. Guarded on require.main because this file is require()d by
// post-highlights.js, generate-digest.js, backfill-streaks.js and the amu-tracker
// service: without the guard the dispatch ran on every require and printed
// "Usage: node tracker.js …" into highlights.log/digest.log on each cron run.
if (require.main === module) {
const cmd = process.argv[2];

if (cmd === 'init') {
  initDb();
} else if (cmd === 'log') {
  const data = JSON.parse(process.argv[3]);
  logMessage(data);
} else if (cmd === 'stats') {
  const date = process.argv[3] || new Date().toISOString().slice(0, 10);
  const channel = process.argv[4] || 'amu';
  const stats = getDailyStats(date, channel);
  console.log(JSON.stringify(stats, null, 2));
} else if (cmd === 'highlights') {
  const date = process.argv[3] || new Date(Date.now() - 86400000).toISOString().slice(0, 10); // yesterday
  const channel = process.argv[4] || 'amu';
  const stats = getDailyStats(date, channel);
  console.log(formatHighlights(stats));
} else {
  console.log('Usage: node tracker.js [init|log|stats|highlights] [args]');
}
}

// HUMANS_ONLY is exported so the digest path reuses the exact same fragment as the
// highlights path. Two copies of this filter is how the service account crept back
// into one of them.
module.exports = { initDb, logMessage, getDailyStats, formatHighlights, extractLinks, updateStreak, HUMANS_ONLY };
