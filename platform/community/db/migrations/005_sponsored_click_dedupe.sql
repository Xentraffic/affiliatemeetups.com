-- Bounded dedupe for indicative sponsored click counts.
-- Stores a salted hash only. No raw IP or user-agent. Rows expire with the
-- dedupe window and are also capped. Additive. Do not edit earlier migrations.

CREATE TABLE sponsored_click_dedupe (
  dedupe_key TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sponsored_click_dedupe_exp ON sponsored_click_dedupe(expires_at);
