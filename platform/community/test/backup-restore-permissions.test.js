'use strict';

/**
 * Backup and restore must protect the data as strictly as the live database does.
 * They did not, and this suite is the measurement that found it.
 *
 * Measured on 2026-11-12, before the fix, on a 0600 database:
 *   backup file            644      (world-readable copy of the whole database)
 *   backup .sha256         664
 *   backups/ directory     775
 *   sidelined database     644      (restore-db.sh, via `sqlite3 .backup`)
 *   restored target        inherited whatever mode already existed
 *
 * Two causes stack, and either alone would mask the other:
 *   1. api.js sets process.umask(0o077) — that covers files created by the
 *      APPLICATION, not a shell script run from cron or by an operator.
 *   2. `sqlite3 .backup` creates its file 0644 REGARDLESS of the umask, so a
 *      `umask` line in the script fixes nothing on its own.
 *
 * Every case below therefore runs the scripts under `umask 000`, the most hostile
 * umask available. If the explicit chmods were ever removed, a permissive umask
 * would no longer hide it: these tests fail.
 *
 * Restores always target a SEPARATE stopped database, per ops guidance — never
 * over a running application.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const OPS = path.resolve(__dirname, '..', 'ops');
const LIB = path.resolve(__dirname, '..', 'lib');
const mode = p => (fs.statSync(p).mode & 0o777).toString(8);

/** Runs a script with an explicitly hostile umask, exactly as cron might. */
function runHostile(script, args, opts = {}) {
  return execFileSync('/bin/sh',
    ['-c', 'umask 000; s="$1"; shift; "$s" "$@"', '--', script, ...args],
    { encoding: 'utf8', ...opts });
}

describe('backup and restore permissions', () => {
  let dir, db, backup;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmty-bk-'));
    db = path.join(dir, 'community.db');
    execFileSync('node', [path.join(LIB, 'migrate.js'), db], { encoding: 'utf8' });
    fs.chmodSync(db, 0o600);
    const out = runHostile(path.join(OPS, 'backup-db.sh'), [db, path.join(dir, 'backups')]);
    const m = out.match(/^✅ (.+)$/m);
    assert.ok(m, `unexpected backup output:\n${out}`);
    backup = m[1];
  });

  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the backup file is 0600 even under umask 000', () => {
    assert.equal(mode(backup), '600');
  });

  test('the recorded checksum is 0600', () => {
    assert.equal(mode(`${backup}.sha256`), '600');
  });

  test('the backups directory is 0700', () => {
    assert.equal(mode(path.join(dir, 'backups')), '700');
  });

  test('the backup passes integrity and carries every table', () => {
    const b = new Database(backup, { readonly: true });
    assert.equal(b.pragma('integrity_check', { simple: true }), 'ok');
    const n = b.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    const live = new Database(db, { readonly: true });
    assert.equal(n, live.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n);
    assert.ok(n > 0, 'a backup with no tables is not a backup');
    b.close(); live.close();
  });

  test('restoring into a separate stopped database yields 0600, ok integrity, no FK violation', () => {
    const target = path.join(dir, 'restored', 'community-test.db');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = runHostile(path.join(OPS, 'restore-db.sh'), [backup, target]);
    assert.match(out, /restored/);
    assert.equal(mode(target), '600');

    const r = new Database(target, { readonly: true });
    assert.equal(r.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(r.pragma('foreign_key_check'), []);

    const live = new Database(db, { readonly: true });
    const tables = live.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(x => x.name);
    for (const t of tables) {
      assert.equal(
        r.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n,
        live.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n,
        `row count differs for ${t}`
      );
    }
    r.close(); live.close();
  });

  test('the sidelined database is 0600, not a world-readable copy', () => {
    const target = path.join(dir, 'sideline', 'community-test.db');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    runHostile(path.join(OPS, 'restore-db.sh'), [backup, target]);           // first restore
    runHostile(path.join(OPS, 'restore-db.sh'), [backup, target, '--force']); // forces a sideline
    const sidelined = fs.readdirSync(path.dirname(target)).filter(f => f.includes('.replaced-'));
    assert.equal(sidelined.length, 1, 'expected exactly one sidelined copy');
    assert.equal(mode(path.join(path.dirname(target), sidelined[0])), '600');
  });

  test('restoring over an existing database without --force is refused', () => {
    const target = path.join(dir, 'guard', 'community-test.db');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    runHostile(path.join(OPS, 'restore-db.sh'), [backup, target]);
    assert.throws(
      () => runHostile(path.join(OPS, 'restore-db.sh'), [backup, target], { stdio: 'pipe' }),
      /./
    );
  });

  test('a tampered checksum stops the restore', () => {
    const copy = path.join(dir, 'tampered.db');
    fs.copyFileSync(backup, copy);
    fs.writeFileSync(`${copy}.sha256`, '0'.repeat(64), { mode: 0o600 });
    assert.throws(
      () => runHostile(path.join(OPS, 'restore-db.sh'), [copy, path.join(dir, 'never.db')], { stdio: 'pipe' }),
      /./
    );
    assert.equal(fs.existsSync(path.join(dir, 'never.db')), false,
      'a refused restore must not leave a target behind');
  });
});
