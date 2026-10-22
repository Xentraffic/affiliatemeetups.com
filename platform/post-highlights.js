#!/usr/bin/env node

/**
 * AMU Platform — Daily Highlights Poster (L4.2)
 * Runs at 8am EST via cron
 * Generates highlights for yesterday and posts to AMU + XenTraffic main
 * 
 * Usage: node post-highlights.js [amu|xentraffic|both] [YYYY-MM-DD]
 */

const { getDailyStats, formatHighlights } = require('./tracker');
const https = require('https');

const BOT_TOKEN = process.env.AMU_BOT_TOKEN;

// Minimum distinct HUMAN posters required before a Daily Highlights post goes out.
const MIN_ACTIVE_MEMBERS = 2;

const CHANNELS = {
  amu: '-1001892904354',
  xentraffic: '-1002055907504',
};

// Yesterday in EST (UTC-5, no DST adjust needed for cron)
function getYesterday() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function sendTelegram(chat_id, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.ok) resolve(parsed);
        else reject(new Error(JSON.stringify(parsed)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const target = process.argv[2] || 'both';
  const date = process.argv[3] || getYesterday();

  const targets = target === 'both' ? ['amu', 'xentraffic'] : [target];

  for (const channel of targets) {
    try {
      const stats = getDailyStats(date, channel);

      // Skip if no activity
      if (stats.total_messages === 0) {
        console.log(`⏭️  No messages for ${channel} on ${date} — skipping`);
        continue;
      }

      // Skip if fewer than MIN_ACTIVE_MEMBERS active members (not worth posting).
      // Lowered 5 -> 3 on 2026-08-18: once the Telegram service account (777000) was
      // excluded in July the group almost never reaches 5 humans a day, so the guard
      // was silencing most days rather than filtering thin ones.
      if (stats.active_members < MIN_ACTIVE_MEMBERS) {
        console.log(`⏭️  Only ${stats.active_members} members active in ${channel} on ${date} — skipping`);
        continue;
      }

      const text = formatHighlights(stats);
      const chat_id = CHANNELS[channel];

      const result = await sendTelegram(chat_id, text);
      console.log(`✅ Posted highlights for ${channel} (${date}) — ${stats.active_members} members, ${stats.total_messages} messages`);
      // Write to AMU dedup registry
      if (channel === 'amu') {
        const crypto = require('crypto');
        const registryPath = '/home/xenhive/.openclaw/workspace/content/amu/posted-registry.json';
        const contentHash = crypto.createHash('sha256').update(text + '').digest('hex').slice(0, 16);
        let registry = { posts: [] };
        try { registry = JSON.parse(require('fs').readFileSync(registryPath, 'utf8')); } catch {}
        registry.posts.push({
          content_hash: contentHash,
          chat_id: '-1001892904354',
          message_id: result.result && result.result.message_id,
          timestamp_utc: new Date().toISOString(),
          photo: null,
          text_preview: text.slice(0, 120),
          script: 'amu-platform/post-highlights.js',
        });
        try { require('fs').writeFileSync(registryPath, JSON.stringify(registry, null, 2)); } catch(e) { console.error('Registry write failed:', e.message); }
      }
    } catch (err) {
      console.error(`❌ Error posting ${channel}:`, err.message);
    }
  }
}

run();
