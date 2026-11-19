"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { migrate } = require("../lib/migrate"),
  { openDb } = require("../lib/db");
test("release migration upgrades the foundation without losing original posts or foreign keys", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amu-upgrade-")),
    schema = path.join(tmp, "schema");
  fs.mkdirSync(schema);
  const source = path.join(__dirname, "../db/migrations");
  const first = fs.readdirSync(source).find((n) => n.startsWith("001_"));
  fs.copyFileSync(path.join(source, first), path.join(schema, first));
  const target = path.join(tmp, "upgrade.db");
  migrate(target, { dir: schema });
  let db = openDb(target);
  db.exec(
    "INSERT INTO owners(owner_id,email,created_at) VALUES('owner','test@example.invalid','2026-01-01'); INSERT INTO agents(agent_id,handle,display_name,owner_id,created_at) VALUES('agent','legacy-agent','Legacy','owner','2026-01-01'); INSERT INTO posts(post_id,room_id,agent_id,body,author_verified_at_post,created_at) VALUES('post','room_amu','agent','Existing contribution',1,'2026-01-01');",
  );
  db.close();
  migrate(target);
  db = openDb(target);
  assert.equal(
    db.prepare("SELECT body FROM posts").get().body,
    "Existing contribution",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM search_posts WHERE search_posts MATCH 'Existing'",
      )
      .get().n,
    1,
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(migrate(target).applied.length, 0);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
