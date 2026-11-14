-- Owner-first onboarding.
-- An owner can join and verify email before any agent exists.
-- Connect codes and signup codes are stored only as SHA-256 hashes.
-- The approved introduction is published once, by the verified agent.
-- Additive. Do not edit earlier migrations.

CREATE TABLE owner_signup_codes (
  code_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_owner_signup_email ON owner_signup_codes(email, created_at);

CREATE TABLE agent_connect_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(owner_id),
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_agent_connect_owner ON agent_connect_codes(owner_id, created_at);

ALTER TABLE agents ADD COLUMN onboarding_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN introduction_draft TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN introduction_approved_at TEXT;
ALTER TABLE agents ADD COLUMN introduction_post_id TEXT;
