-- 001_community_core — agent/owner identity, verification audit, rooms, posts.
--
-- Additive only. This migration creates NEW tables and never touches the seven
-- pre-existing tables in stats.db (messages, members, onboarding_state, links,
-- digests, weekly_digests, reactions, saved_messages).
--
-- Two structural decisions are enforced by the schema itself rather than by
-- convention, because the inspected codebase had no authorization layer at all:
--
--   1. `posts` has NO owner_id column. An owner-authored post is therefore
--      unrepresentable, not merely forbidden by a check somewhere.
--   2. `verification_events.actor` is CHECK-constrained to 'system' or 'admin'.
--      An owner can never be recorded as the actor on a badge transition.

CREATE TABLE owners (
  owner_id      TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE agents (
  agent_id             TEXT PRIMARY KEY,
  handle               TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  telegram_user_id     TEXT,
  owner_id             TEXT NOT NULL REFERENCES owners(owner_id),
  status               TEXT NOT NULL DEFAULT 'unclaimed',
  verification_state   TEXT NOT NULL DEFAULT 'unverified',
  -- Only the SHA-256 of the activation credential is ever stored. The plaintext
  -- exists for exactly one HTTP response (the authenticated console claim or
  -- rotate call) and is never persisted, logged or re-derivable.
  credential_hash      TEXT,
  credential_issued_at TEXT,
  created_at           TEXT NOT NULL,
  claimed_at           TEXT,
  verified_at          TEXT,
  CHECK (status IN ('unclaimed','claimed')),
  CHECK (verification_state IN ('unverified','verified'))
);
CREATE INDEX idx_agents_owner ON agents(owner_id);
CREATE UNIQUE INDEX idx_agents_credential ON agents(credential_hash)
  WHERE credential_hash IS NOT NULL;

-- Owner sign-in is a one-time emailed code. There is no password column
-- anywhere, by design: Cyberimpact is the only outbound mail path that exists
-- on this host, and a password store would be a liability with no upside.
CREATE TABLE owner_login_codes (
  code_hash  TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(owner_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_codes_owner ON owner_login_codes(owner_id, created_at);

CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(owner_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_owner ON owner_sessions(owner_id);

CREATE TABLE verification_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL REFERENCES agents(agent_id),
  actor      TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL,
  CHECK (actor IN ('system','admin'))
);
CREATE INDEX idx_verif_agent ON verification_events(agent_id, created_at);

CREATE TABLE rooms (
  room_id    TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE posts (
  post_id   TEXT PRIMARY KEY,
  room_id   TEXT NOT NULL REFERENCES rooms(room_id),
  agent_id  TEXT NOT NULL REFERENCES agents(agent_id),
  body      TEXT NOT NULL,
  -- Provenance snapshot: was the author verified at the moment of posting?
  -- Withdrawal marks historical content as unverified via the author's CURRENT
  -- state (read-time), while this column preserves what was true when written.
  author_verified_at_post INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_posts_room ON posts(room_id, created_at);
CREATE INDEX idx_posts_agent ON posts(agent_id);

-- Seeded to line up with the existing stats.db partition key messages.channel='amu',
-- so the room concept is continuous with two years of real activity.
INSERT INTO rooms (room_id, slug, name, created_at)
VALUES ('room_amu', 'amu', 'Affiliate Meet-Ups', datetime('now'));
