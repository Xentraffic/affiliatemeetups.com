'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { migrate } = require('../lib/migrate');
const { openDb } = require('../lib/db');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amu-migrate-'));
  return { dir, dbPath: path.join(dir, 'staging.db') };
}

describe('migrations', () => {
  test('applies cleanly and is idempotent', () => {
    const { dir, dbPath } = tmpDb();
    try {
      const first = migrate(dbPath);
      assert.ok(first.applied.includes('001_community_core'));
      const second = migrate(dbPath);
      assert.deepEqual(second.applied, [], 're-running must apply nothing');

      const db = openDb(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all().map(r => r.name);
      for (const t of ['agents', 'owners', 'owner_sessions', 'owner_login_codes',
                       'posts', 'rooms', 'verification_events', 'schema_migrations']) {
        assert.ok(tables.includes(t), `missing table ${t}`);
      }
      // The amu room is seeded to line up with stats.db messages.channel.
      assert.equal(db.prepare('SELECT slug FROM rooms').get().slug, 'amu');
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to run when an applied migration file has been edited', () => {
    const { dir, dbPath } = tmpDb();
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amu-migdir-'));
    try {
      fs.writeFileSync(path.join(fakeDir, '001_x.sql'), 'CREATE TABLE a (x TEXT);');
      migrate(dbPath, { dir: fakeDir });
      fs.writeFileSync(path.join(fakeDir, '001_x.sql'), 'CREATE TABLE a (x TEXT, y TEXT);');
      assert.throws(() => migrate(dbPath, { dir: fakeDir }), /already applied but its file has changed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  test('a failing migration leaves no partial schema behind', () => {
    const { dir, dbPath } = tmpDb();
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amu-migfail-'));
    try {
      fs.writeFileSync(path.join(fakeDir, '001_bad.sql'),
        'CREATE TABLE good (x TEXT); CREATE TABLE bad (;');
      assert.throws(() => migrate(dbPath, { dir: fakeDir }), /migration 001_bad failed/);
      const db = openDb(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      assert.ok(!tables.includes('good'), 'rolled back migration must not leave tables');
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  test('openDb refuses to guess a path', () => {
    assert.throws(() => openDb(undefined), /refusing to guess/);
  });

  test('foreign keys are enforced', () => {
    const { dir, dbPath } = tmpDb();
    try {
      migrate(dbPath);
      const db = openDb(dbPath);
      assert.throws(
        () => db.prepare(`INSERT INTO posts (post_id, room_id, agent_id, body, author_verified_at_post, created_at)
                          VALUES ('p1','room_amu','agt_missing','x',1,'now')`).run(),
        /FOREIGN KEY/,
      );
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
