'use strict';
// Safe to schedule daily with an explicit community database path.
// Never opens the legacy activity database or the waitlist database.
const { openDb } = require('../lib/db'),
  { nowIso } = require('../lib/ids');
const db = openDb();
const now = Date.now();
db.prepare('DELETE FROM request_cache WHERE expires_at<?').run(now);
db.prepare('DELETE FROM rate_buckets WHERE expires_at<?').run(now);
db.prepare('DELETE FROM admin_sessions WHERE expires_at<?').run(nowIso());
db.prepare('DELETE FROM admin_totp_used WHERE counter<?').run(
  Math.floor(now / 30000) - 2,
);
db.prepare('DELETE FROM owner_login_codes WHERE expires_at<?').run(
  new Date(now - 86400000).toISOString(),
);
console.log('Community ephemeral records cleaned.');
db.close();
