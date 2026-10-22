#!/usr/bin/env node

/**
 * AMU Platform — Daily Digest Generator (L4.5)
 * Generates AI summary of yesterday's conversations
 * Runs at 7:45am EST (before highlights post at 8am)
 * 
 * Usage: node generate-digest.js [amu|xentraffic|both] [YYYY-MM-DD]
 */

const Database = require('better-sqlite3');
const { getProvider, callClaude } = require('./anthropic-lib');
// Same humans-only fragment the highlights use. Until 2026-08-18 the digest had no
// filter at all, so Telegram's service account (user_id 777000, the sender of
// everything auto-forwarded from the linked channel) counted as a member and could
// top the contributor list: 61 of 243 tracked messages, 3 of the 8 messages on
// 2026-08-17. The digest therefore overstated activity the highlights understated.
const { HUMANS_ONLY } = require('./tracker');

const DB_PATH = '/home/xenhive/amu-platform/stats.db';
const ANTHROPIC_KEY_FILE = '/home/xenhive/.openclaw/openclaw.json';

function getDb() {
  return new Database(DB_PATH);
}

async function generateDigest(date, channel) {
  const db = getDb();

  // Get stats
  const stats = db.prepare(`
    SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as members
    FROM messages WHERE date = ? AND channel = ? AND ${HUMANS_ONLY}
  `).get(date, channel);

  if (!stats || stats.total === 0) {
    db.close();
    return null;
  }

  // Get top links
  const topLinks = db.prepare(`
    SELECT url, username, display_name, COUNT(*) as shares
    FROM links WHERE date = ? AND channel = ? AND ${HUMANS_ONLY}
    GROUP BY url ORDER BY shares DESC LIMIT 10
  `).all(date, channel);

  // Get sample messages for AI summary (up to 100 recent messages with text)
  const messages = db.prepare(`
    SELECT username, display_name, text, timestamp
    FROM messages 
    WHERE date = ? AND channel = ? AND text IS NOT NULL AND text != '' AND ${HUMANS_ONLY}
    ORDER BY timestamp DESC LIMIT 100
  `).all(date, channel);

  // Get top contributors
  const topContributors = db.prepare(`
    SELECT username, display_name, COUNT(*) as count
    FROM messages WHERE date = ? AND channel = ? AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC LIMIT 5
  `).all(date, channel);

  db.close();

  const channelName = channel === 'amu' ? 'Affiliate Meet-Ups' : 'XenTraffic';

  // Build AI prompt
  let summary = '';
  let keyTakeaways = '';

  const provider = getProvider();

  if (provider && messages.length > 0) {
    const msgSample = messages.slice(0, 50).map(m =>
      `@${m.username || m.display_name}: ${m.text}`
    ).join('\n');

    const linkList = topLinks.map(l => `- ${l.url} (shared by @${l.username || l.display_name})`).join('\n');

    const prompt = `You are summarizing a day's activity in the "${channelName}" affiliate marketing Telegram community.

Date: ${date}
Total messages: ${stats.total}
Active members: ${stats.members}

Top links shared:
${linkList || '(none)'}

Sample messages from the day:
${msgSample}

Write a concise daily digest with:
1. A 2-3 sentence summary of the main topics and energy of the day
2. 3 key takeaways (bullet points, each one sentence)

Format as JSON: {"summary": "...", "takeaways": ["...", "...", "..."]}
Keep it tight, no fluff. Write for affiliate marketers.`;

    try {
      const response = await callClaude(prompt, provider);
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
      summary = parsed.summary || '';
      keyTakeaways = JSON.stringify(parsed.takeaways || []);
    } catch(e) {
      console.error('Claude summary failed:', e.message);
      summary = `${stats.total} messages from ${stats.members} members on ${date}.`;
      keyTakeaways = JSON.stringify([]);
    }
  } else {
    // Reaching here means no provider resolved or no messages — say so, don't
    // quietly emit a counts-only 'summary' that reads like a real digest.
    console.error(provider ? 'no messages to summarize' : 'WARN — no Anthropic provider resolved; digest has no AI summary');
    summary = `${stats.total} messages from ${stats.members} active members.`;
    keyTakeaways = JSON.stringify([]);
  }

  // Save to DB
  const saveDb = getDb();
  saveDb.prepare(`
    INSERT OR REPLACE INTO digests (channel, date, total_messages, active_members, summary, top_links, key_takeaways, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    channel, date, stats.total, stats.members,
    summary,
    JSON.stringify(topLinks),
    keyTakeaways,
    new Date().toISOString()
  );
  saveDb.close();

  console.log(`✅ Digest generated for ${channel} on ${date}: ${stats.total} msgs, ${stats.members} members`);
  return { date, channel, stats, summary, topLinks, keyTakeaways };
}

// CLI
const target = process.argv[2] || 'both';
const date = process.argv[3] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const targets = target === 'both' ? ['amu', 'xentraffic'] : [target];

(async () => {
  for (const ch of targets) {
    await generateDigest(date, ch);
  }
})().catch(console.error);

module.exports = { generateDigest };
