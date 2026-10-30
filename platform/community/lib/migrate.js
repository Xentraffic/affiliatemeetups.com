'use strict';

/**
 * Migration runner.
 *
 * The inspected system had no migration tool and no way to tell what schema a
 * given database was at. This records every applied version with a checksum and
 * refuses to run if an already-applied file has been edited — the failure mode
 * that silently diverges staging from production otherwise.
 */

const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { sha256, nowIso } = require('./ids');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.replace(/\.sql$/, ''), file, sql, checksum: sha256(sql) };
    });
}

function migrate(dbPath, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const db = openDb(dbPath);
  try {
    ensureMigrationsTable(db);
    const applied = new Map(
      db.prepare('SELECT version, checksum FROM schema_migrations').all()
        .map(r => [r.version, r.checksum])
    );

    const pending = [];
    for (const m of listMigrations(dir)) {
      if (!applied.has(m.version)) { pending.push(m); continue; }
      if (applied.get(m.version) !== m.checksum) {
        throw new Error(
          `migration ${m.version} was already applied but its file has changed ` +
          `(recorded ${applied.get(m.version).slice(0, 12)}, on disk ${m.checksum.slice(0, 12)}). ` +
          `Add a new migration instead of editing an applied one.`
        );
      }
    }

    for (const m of pending) {
      // Each migration is one transaction: a half-applied schema is worse than
      // an unapplied one.
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.checksum, nowIso());
        db.exec('COMMIT');
        log(`applied ${m.version}`);
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`migration ${m.version} failed: ${e.message}`);
      }
    }
    return { applied: pending.map(m => m.version), alreadyApplied: [...applied.keys()] };
  } finally {
    db.close();
  }
}

module.exports = { migrate, listMigrations };

if (require.main === module) {
  const dbPath = process.argv[2] || process.env.COMMUNITY_DB_PATH;
  try {
    const r = migrate(dbPath, { log: s => console.log(`  ${s}`) });
    console.log(r.applied.length
      ? `✅ ${r.applied.length} migration(s) applied to ${dbPath}`
      : `✅ ${dbPath} already up to date (${r.alreadyApplied.length} applied)`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}
