#!/usr/bin/env node
/**
 * One-shot backfill of members.streak_days / last_streak_date from the existing
 * messages. The columns have been in the schema since April but nothing ever wrote
 * them, so every member sat at 0. Replays each (user_id, date) in chronological
 * order through the SAME updateStreak() the live path uses — no second rule to
 * drift out of sync.
 *
 * Idempotent: resets both columns first, so re-running lands on the same answer.
 */
const Database = require('better-sqlite3');
const { updateStreak } = require('/home/xenhive/amu-platform/tracker.js');

const db = new Database('/home/xenhive/amu-platform/stats.db');
db.pragma('journal_mode = WAL');

db.prepare('UPDATE members SET streak_days = 0, last_streak_date = NULL').run();

const rows = db.prepare(
  'SELECT DISTINCT user_id, date FROM messages ORDER BY date ASC, user_id ASC'
).all();

for (const r of rows) updateStreak(db, r.user_id, r.date);

const top = db.prepare(`
  SELECT username, display_name, streak_days, last_streak_date
  FROM members WHERE streak_days > 0 ORDER BY streak_days DESC LIMIT 5
`).all();

console.log(`replayed ${rows.length} (member, day) pairs`);
console.log('top streaks:');
for (const t of top) {
  console.log(`  ${t.username || t.display_name}: ${t.streak_days}d (last active ${t.last_streak_date})`);
}
db.close();
