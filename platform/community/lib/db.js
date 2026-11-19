'use strict';

const Database = require('better-sqlite3');

/**
 * Open the community database.
 *
 * Staging and production never share a file. The path comes from
 * COMMUNITY_DB_PATH with no default that could point at production stats.db —
 * an unset variable is a hard error, not a silent fallback.
 */
function openDb(dbPath = process.env.COMMUNITY_DB_PATH, { readonly = false } = {}) {
  if (!dbPath) {
    throw new Error('COMMUNITY_DB_PATH is not set — refusing to guess a database path');
  }
  const db = new Database(dbPath, { readonly });
  if (!readonly) db.pragma('journal_mode = WAL');
  // Off by default in SQLite; every REFERENCES clause in 001 is inert without it.
  db.pragma('foreign_keys = ON');
  return db;
}

module.exports = { openDb };
