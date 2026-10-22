#!/usr/bin/env node

/**
 * AMU Platform — Onboarding Bot (L4.3)
 * Manages multi-step DM questionnaire for new AMU members
 * State stored in SQLite
 */

const Database = require('better-sqlite3');
const https = require('https');

const DB_PATH = '/home/xenhive/amu-platform/stats.db';
const BOT_TOKEN = process.env.AMU_BOT_TOKEN;
const AMU_GROUP_ID = '-1001892904354';

// Onboarding questions (Jason's format, AMU-specific)
const QUESTIONS = [
  { key: 'building',     text: '👋 Welcome to Affiliate Meet-Ups!\n\nI\'m Xen, the AMU assistant. Quick intro form so the community knows who you are — takes 2 min.\n\n*What are you currently building or working on?*' },
  { key: 'stage',        text: '💪 Nice! *What stage are you at?*\n\n(e.g. testing, scaling, building something new, consulting)' },
  { key: 'experience',   text: '📅 *How many years have you been in affiliate/performance marketing?*' },
  { key: 'traffic',      text: '🚦 *What traffic sources do you run?*\n\n(e.g. Meta, Google, Native, Email, SEO, etc.)' },
  { key: 'share',        text: '🤝 *What can you share with the community?*\n\n(knowledge, connections, tools, verticals you know well)' },
  { key: 'location',     text: '🌍 *Where are you based?*' },
];

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function initOnboardingTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_state (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      step INTEGER DEFAULT 0,
      answers TEXT DEFAULT '{}',
      started_at TEXT,
      completed_at TEXT,
      intro_posted INTEGER DEFAULT 0
    );
  `);
  db.close();
}

function sendTelegram(chat_id, text, parse_mode = 'Markdown') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id, text, parse_mode });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Telegram answers 200 with {"ok":false} when it refuses (user has DMs
        // closed, blocked the bot, chat not found). Resolving on that made a
        // refused DM look like a delivered one — the questionnaire would sit at
        // step 0 forever with nobody aware. Reject so the caller can log it.
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { return reject(new Error('telegram: bad JSON')); }
        if (!parsed.ok) return reject(new Error(`telegram ${parsed.error_code}: ${parsed.description}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Start onboarding for a new member
 * Called when new_chat_members event fires
 */
async function startOnboarding(user_id, username, display_name) {
  const db = getDb();

  // Check if already onboarded
  const existing = db.prepare('SELECT * FROM onboarding_state WHERE user_id = ?').get(String(user_id));
  if (existing && existing.completed_at) {
    db.close();
    return; // Already done
  }

  // Initialize state
  db.prepare(`
    INSERT OR REPLACE INTO onboarding_state (user_id, username, display_name, step, answers, started_at)
    VALUES (?, ?, ?, 0, '{}', ?)
  `).run(String(user_id), username || null, display_name, new Date().toISOString());
  db.close();

  // Send first question. If the DM bounces, drop the state we just wrote —
  // a half-open row makes this member look mid-questionnaire forever and
  // blocks any later retry.
  try {
    await sendTelegram(user_id, QUESTIONS[0].text);
  } catch (e) {
    const db2 = getDb();
    db2.prepare('DELETE FROM onboarding_state WHERE user_id = ? AND completed_at IS NULL').run(String(user_id));
    db2.close();
    console.error(`❌ Onboarding DM refused for ${display_name} (${user_id}): ${e.message}`);
    return;
  }
  console.log(`✅ Onboarding started for ${display_name} (${user_id})`);
}

/**
 * Handle a DM reply during onboarding
 * Called when a DM message comes in from a user in onboarding state
 */
async function handleReply(user_id, username, display_name, text) {
  const db = getDb();
  const state = db.prepare('SELECT * FROM onboarding_state WHERE user_id = ?').get(String(user_id));

  if (!state || state.completed_at) {
    db.close();
    return false; // Not in onboarding
  }

  const currentStep = state.step;
  const answers = JSON.parse(state.answers || '{}');

  // Save this answer
  answers[QUESTIONS[currentStep].key] = text;
  const nextStep = currentStep + 1;

  if (nextStep < QUESTIONS.length) {
    // More questions
    db.prepare('UPDATE onboarding_state SET step = ?, answers = ? WHERE user_id = ?')
      .run(nextStep, JSON.stringify(answers), String(user_id));
    db.close();
    await sendTelegram(user_id, QUESTIONS[nextStep].text);
  } else {
    // All done — mark complete
    db.prepare('UPDATE onboarding_state SET step = ?, answers = ?, completed_at = ? WHERE user_id = ?')
      .run(nextStep, JSON.stringify(answers), new Date().toISOString(), String(user_id));
    db.close();

    // Send confirmation DM
    await sendTelegram(user_id,
      `✅ Perfect! I'll introduce you to the community now.\n\nWelcome to AMU, ${display_name.split(' ')[0]}! 🔮`
    );

    // Post intro to AMU group
    await postIntro(user_id, username, display_name, answers);
  }

  return true;
}

/**
 * Generate and post intro message to AMU group
 */
async function postIntro(user_id, username, display_name, answers) {
  const handle = username ? `@${username}` : display_name;

  const intro = `👋 *New member alert!*

Say hello to ${handle} — here's who just joined AMU:

🔨 *Building:* ${answers.building || '—'}
📈 *Stage:* ${answers.stage || '—'}
⏳ *Experience:* ${answers.experience || '—'} in the industry
🚦 *Traffic:* ${answers.traffic || '—'}
🤝 *Can share:* ${answers.share || '—'}
🌍 *Based in:* ${answers.location || '—'}

Welcome to the crew! Drop a 👋 below.`;

  await sendTelegram(AMU_GROUP_ID, intro);

  // Mark intro as posted
  const db = getDb();
  db.prepare('UPDATE onboarding_state SET intro_posted = 1 WHERE user_id = ?').run(String(user_id));
  db.close();

  console.log(`✅ Intro posted for ${handle}`);
}

// CLI interface — only when run directly, so `require()` stays silent.
const cmd = require.main === module ? process.argv[2] : undefined;

if (cmd === 'init') {
  initOnboardingTables();
  console.log('✅ Onboarding tables initialized');
} else if (cmd === 'start') {
  // node onboarding.js start <user_id> <username> <display_name>
  const [,, , user_id, username, display_name] = process.argv;
  startOnboarding(user_id, username, display_name).catch(console.error);
} else if (cmd === 'reply') {
  // node onboarding.js reply <user_id> <username> <display_name> <text>
  const [,, , user_id, username, display_name, ...textParts] = process.argv;
  handleReply(user_id, username, display_name, textParts.join(' ')).catch(console.error);
} else if (cmd === 'status') {
  const db = getDb();
  const rows = db.prepare('SELECT user_id, username, display_name, step, completed_at, intro_posted FROM onboarding_state').all();
  console.table(rows);
  db.close();
} else if (require.main === module) {
  console.log('Usage: node onboarding.js [init|start|reply|status]');
}

module.exports = { startOnboarding, handleReply, initOnboardingTables };
