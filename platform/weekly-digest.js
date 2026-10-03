#!/usr/bin/env node

/**
 * AMU Platform — Weekly Digest (Phase L3, Module 2, last open item)
 *
 * The plan asked for a "weekly digest for XenTraffic main". Taken literally that has no
 * data source: -1002055907504 is a BROADCAST CHANNEL, not a group, so it has no member
 * activity to aggregate — `messages` holds 0 rows for channel 'xentraffic'. What it does
 * have is CONTENT: every post published in that channel is auto-forwarded into the AMU
 * supergroup and lands here under Telegram's service account (user_id 777000), text
 * included. So the digest is built as two blocks, decided 2026-08-18:
 *
 *   Block A — what the AMU community did       (human messages, HUMANS_ONLY)
 *   Block B — what XenTraffic published        (the 777000 forwards, deduped)
 *
 * Delivery is Slack first for validation (#affiliatemeetups), NOT the Telegram group.
 * Publishing to the group is one flag change once the format is signed off.
 *
 * Dry run is the DEFAULT: without --post it prints the digest and posts nothing.
 *
 *   node weekly-digest.js                      # last complete week, print only
 *   node weekly-digest.js --week-of 2026-08-11 # the week containing that date
 *   node weekly-digest.js --post               # generate + post to Slack
 *   node weekly-digest.js --post --channel C0…  # override the Slack channel
 *   node weekly-digest.js --no-ai              # skip the Claude summary
 *
 * Post-conditions are asserted, not assumed: a --post run that gets no message ts back
 * exits non-zero so `xen-cron-guard` escalates it. A Slack call that answers ok:true
 * without a ts is treated as a failure, not a success (cf. the empty-message trap).
 */

const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HUMANS_ONLY } = require('./tracker');
const { getProvider, callClaude } = require('./anthropic-lib');

const DB_PATH = '/home/xenhive/amu-platform/stats.db';
const SLACK_POST = '/usr/local/sbin/cobra-slack-post';
const DEFAULT_CHANNEL = 'C0A4KAMNPKM';           // #affiliatemeetups
const SERVICE_ACCOUNT = '777000';                // Telegram's linked-channel forwarder
const CHANNEL = 'amu';                           // the only channel that carries rows

// ---------------------------------------------------------------- args + week window

function parseArgs(argv) {
  const a = { post: false, ai: true, channel: DEFAULT_CHANNEL, weekOf: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--post': a.post = true; break;
      case '--no-ai': a.ai = false; break;
      case '--channel': a.channel = argv[++i]; break;
      case '--week-of': a.weekOf = argv[++i]; break;
      case '--help': case '-h': a.help = true; break;
      default:
        console.error(`unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }
  return a;
}

const DAY_MS = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Monday of the week containing `ref`. Weeks are Monday to Sunday in UTC — the daily
 * jobs already key everything on the UTC date string, so anything else would make the
 * weekly totals disagree with the dailies they are meant to summarize.
 */
function mondayOf(ref) {
  const d = new Date(ref.getTime());
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;   // Sunday=0 -> 6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - daysSinceMonday * DAY_MS);
}

function resolveWeek(weekOf) {
  if (weekOf) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
      console.error('--week-of expects YYYY-MM-DD');
      process.exit(2);
    }
    const start = mondayOf(new Date(weekOf + 'T00:00:00Z'));
    return { start: iso(start), end: iso(new Date(start.getTime() + 6 * DAY_MS)) };
  }
  // Default: the last COMPLETE week, i.e. the one before the week we are in.
  const start = new Date(mondayOf(new Date()).getTime() - 7 * DAY_MS);
  return { start: iso(start), end: iso(new Date(start.getTime() + 6 * DAY_MS)) };
}

// ---------------------------------------------------------------------------- queries

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function ensureRegistry(db) {
  // What was generated, and what actually reached Slack. Without the ts column a
  // "posted" row would only record that we tried.
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_digests (
      week_start TEXT PRIMARY KEY,
      week_end TEXT NOT NULL,
      community_messages INTEGER,
      community_members INTEGER,
      channel_posts INTEGER,
      body TEXT,
      generated_at TEXT,
      posted_at TEXT,
      slack_channel TEXT,
      slack_ts TEXT
    );
  `);
}

function communityStats(db, start, end) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS messages,
           COUNT(DISTINCT user_id) AS members,
           COUNT(DISTINCT date) AS active_days
    FROM messages WHERE channel = ? AND date BETWEEN ? AND ? AND ${HUMANS_ONLY}
  `).get(CHANNEL, start, end);

  const contributors = db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) AS count
    FROM messages WHERE channel = ? AND date BETWEEN ? AND ? AND ${HUMANS_ONLY}
    GROUP BY user_id ORDER BY count DESC, user_id LIMIT 5
  `).all(CHANNEL, start, end);

  const badge = (extraWhere) => db.prepare(`
    SELECT user_id, username, display_name, COUNT(*) AS count
    FROM messages WHERE channel = ? AND date BETWEEN ? AND ? AND ${HUMANS_ONLY} ${extraWhere}
    GROUP BY user_id ORDER BY count DESC, user_id LIMIT 1
  `).get(CHANNEL, start, end);

  // Streak leader over the week: longest run of consecutive active days that ENDS
  // inside the window. Derived from `messages` with the same gaps-and-islands query
  // the daily highlights use, never from members.streak_days — that column holds the
  // streak as of the member's last activity, which is wrong for a past week.
  const streak = db.prepare(`
    WITH active AS (
      SELECT DISTINCT user_id, date FROM messages
      WHERE channel = ? AND date <= ? AND ${HUMANS_ONLY}
    ),
    grouped AS (
      SELECT user_id, date,
             julianday(date) - ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date) AS grp
      FROM active
    ),
    runs AS (
      SELECT user_id, COUNT(*) AS count, MAX(date) AS run_end FROM grouped GROUP BY user_id, grp
    )
    SELECT r.user_id, mb.username, mb.display_name, r.count
    FROM runs r LEFT JOIN members mb ON mb.user_id = r.user_id
    WHERE r.run_end BETWEEN ? AND ? AND r.count > 1
    ORDER BY r.count DESC, r.user_id LIMIT 1
  `).get(CHANNEL, end, start, end);

  const links = db.prepare(`
    SELECT url, username, display_name, COUNT(*) AS shares
    FROM links WHERE channel = ? AND date BETWEEN ? AND ? AND ${HUMANS_ONLY}
    GROUP BY url ORDER BY shares DESC, url LIMIT 8
  `).all(CHANNEL, start, end);

  const sample = db.prepare(`
    SELECT username, display_name, text FROM messages
    WHERE channel = ? AND date BETWEEN ? AND ? AND text IS NOT NULL AND text != '' AND ${HUMANS_ONLY}
    ORDER BY timestamp ASC LIMIT 120
  `).all(CHANNEL, start, end);

  return {
    totals,
    contributors,
    badges: {
      top_contributor: badge(''),
      link_champion: badge('AND has_link = 1'),
      conversation_starter: badge('AND is_thread_start = 1'),
      helpful_responder: badge('AND is_reply = 1'),
      streak_leader: streak,
    },
    links,
    sample,
  };
}

/**
 * Block B. The forwards carry the channel's own posts. They arrive duplicated when a
 * post is edited or re-forwarded, so identical texts collapse to one entry; rows with
 * no text are counted separately rather than silently dropped — they are the messages
 * ingested before `text` was stored in July, and pretending the week was quieter than
 * it was would be the same silent-success bug as everywhere else.
 */
function channelPosts(db, start, end) {
  const rows = db.prepare(`
    SELECT date, text, timestamp FROM messages
    WHERE channel = ? AND user_id = ? AND date BETWEEN ? AND ?
    ORDER BY timestamp ASC
  `).all(CHANNEL, SERVICE_ACCOUNT, start, end);

  const seen = new Set();
  const posts = [];
  let missingText = 0;
  for (const r of rows) {
    const text = (r.text || '').trim();
    if (!text) { missingText++; continue; }
    const key = text.slice(0, 200).replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) || text;
    posts.push({ date: r.date, title: firstLine, text });
  }
  return { posts, missingText, rawCount: rows.length };
}

// ------------------------------------------------------------------------ AI summary

async function aiSummary(week, community, channel) {
  const provider = getProvider();
  if (!provider) {
    console.error('WARN — no Anthropic provider resolved; the digest ships without a summary');
    return null;
  }
  if (community.sample.length === 0 && channel.posts.length === 0) return null;

  const convo = community.sample
    .map(m => `@${m.username || m.display_name}: ${m.text}`)
    .join('\n')
    .slice(0, 12000);
  const published = channel.posts.map(p => `- ${p.date}: ${p.title}`).join('\n').slice(0, 4000);

  const prompt = `You are writing the weekly recap of the "Affiliate Meet-Ups" Telegram community for the week of ${week.start} to ${week.end}.

Community activity: ${community.totals.messages} messages from ${community.totals.members} members over ${community.totals.active_days} active days.

Member conversations this week:
${convo || '(no member messages with text)'}

Posts published in the linked XenTraffic channel this week:
${published || '(none)'}

Write:
1. "summary": 2 or 3 sentences on what the community actually discussed and the state of the group this week. If the week was quiet, say it plainly instead of inflating it.
2. "takeaways": exactly 3 one-sentence bullets an affiliate would care about.

Rules: write for affiliate marketers, no fluff, no invented facts, no emoji, and do not use dashes as punctuation. Answer as JSON only: {"summary": "...", "takeaways": ["...", "...", "..."]}`;

  try {
    const raw = await callClaude(prompt, provider, 900);
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!parsed.summary) throw new Error('no summary field in model output');
    return { summary: parsed.summary, takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways : [] };
  } catch (e) {
    // Loud, and the digest still ships with the numbers. A missing summary must not
    // read like a summary that had nothing to say.
    console.error('AI summary failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------- render

const handle = (s) => (s ? (s.username ? '@' + s.username : s.display_name || s.user_id) : null);

function render(week, community, channel, ai) {
  const t = community.totals;
  const L = [];
  L.push(`## Weekly digest — AMU + XenTraffic`);
  L.push(`Week of ${week.start} to ${week.end}`);
  L.push('');

  L.push(`### 1. Community (Affiliate Meet-Ups)`);
  L.push(`${t.messages} messages from ${t.members} members over ${t.active_days} active day(s).`);
  if (ai) {
    L.push('');
    L.push(ai.summary);
    if (ai.takeaways.length) {
      L.push('');
      for (const tk of ai.takeaways) L.push(`• ${tk}`);
    }
  }
  L.push('');

  if (community.contributors.length) {
    L.push(`*Most active*`);
    for (const c of community.contributors) L.push(`• ${handle(c)}: ${c.count} messages`);
    L.push('');
  }

  const badgeLines = [
    ['Top contributor', community.badges.top_contributor, 'messages'],
    ['Link champion', community.badges.link_champion, 'links'],
    ['Conversation starter', community.badges.conversation_starter, 'threads'],
    ['Helpful responder', community.badges.helpful_responder, 'replies'],
    ['Streak leader', community.badges.streak_leader, 'days in a row'],
  ].filter(([, s]) => s && s.count > 0)
   .map(([label, s, unit]) => `• ${label}: ${handle(s)} (${s.count} ${unit})`);
  if (badgeLines.length) {
    L.push(`*Badges of the week*`);
    L.push(...badgeLines);
    L.push('');
  }

  if (community.links.length) {
    L.push(`*Links shared*`);
    for (const l of community.links) {
      L.push(`• ${l.url}${l.shares > 1 ? ` (${l.shares}x)` : ''} — ${handle(l) || 'unknown'}`);
    }
    L.push('');
  }

  L.push(`### 2. Published on XenTraffic`);
  if (channel.posts.length === 0) {
    L.push('Nothing published in the channel this week.');
  } else {
    L.push(`${channel.posts.length} post(s) published.`);
    for (const p of channel.posts) {
      const title = p.title.length > 120 ? p.title.slice(0, 117) + '...' : p.title;
      L.push(`• ${p.date}: ${title}`);
    }
  }
  if (channel.missingText > 0) {
    L.push('');
    L.push(`Note: ${channel.missingText} forwarded row(s) carry no text (ingested before text was stored in July) and are not listed above.`);
  }
  L.push('');
  L.push(`_Generated by amu-platform/weekly-digest.js. Slack review copy, not published to the Telegram group._`);
  return L.join('\n');
}

// ------------------------------------------------------------------------------ post

function postToSlack(body, week, channelId) {
  const tmp = path.join(os.tmpdir(), `amu-weekly-${week.start}-${process.pid}.md`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    const out = execFileSync(SLACK_POST, [
      '--channel', channelId,
      '--title', `Weekly digest ${week.start} to ${week.end}`,
      '--file', tmp,
    ], { encoding: 'utf8' });
    // cobra-slack-post prints the parent ts on success. No ts means we cannot prove
    // anything landed, so this is a failure even if the exit code was 0.
    const ts = (out.match(/\d{10}\.\d{6}/) || [])[0];
    if (!ts) throw new Error(`no message ts in transport output: ${out.trim().slice(0, 200)}`);
    return ts;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp file, best effort */ }
  }
}

// ------------------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const week = resolveWeek(args.weekOf);

  const db = getDb();
  ensureRegistry(db);
  const community = communityStats(db, week.start, week.end);
  const channel = channelPosts(db, week.start, week.end);
  const ai = args.ai ? await aiSummary(week, community, channel) : null;
  const body = render(week, community, channel, ai);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO weekly_digests (week_start, week_end, community_messages, community_members,
                                channel_posts, body, generated_at)
    VALUES (@week_start, @week_end, @messages, @members, @posts, @body, @now)
    ON CONFLICT(week_start) DO UPDATE SET
      week_end = @week_end, community_messages = @messages, community_members = @members,
      channel_posts = @posts, body = @body, generated_at = @now
  `).run({
    week_start: week.start, week_end: week.end,
    messages: community.totals.messages, members: community.totals.members,
    posts: channel.posts.length, body, now,
  });

  if (!args.post) {
    console.log(body);
    console.error(`\n(dry run — nothing posted. Add --post to send to Slack ${args.channel})`);
    db.close();
    return;
  }

  const already = db.prepare('SELECT slack_ts, posted_at FROM weekly_digests WHERE week_start = ?').get(week.start);
  if (already && already.slack_ts) {
    console.log(`already posted for week ${week.start} at ${already.posted_at} (ts ${already.slack_ts}) — nothing to do`);
    db.close();
    return;
  }

  const ts = postToSlack(body, week, args.channel);
  db.prepare('UPDATE weekly_digests SET posted_at = ?, slack_channel = ?, slack_ts = ? WHERE week_start = ?')
    .run(new Date().toISOString(), args.channel, ts, week.start);
  db.close();
  console.log(`posted weekly digest ${week.start} to ${week.end} in ${args.channel} (ts ${ts})`);
}

main().catch(e => {
  console.error('weekly-digest failed:', e.message);
  process.exit(1);
});
