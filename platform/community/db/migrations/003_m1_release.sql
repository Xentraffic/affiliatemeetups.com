-- M1: Toronto-correct reports, offer metadata, sponsored slots, click-outs, Pro states.
-- Additive. Do not edit 001 or 002.

ALTER TABLE agents ADD COLUMN participant_kind TEXT NOT NULL DEFAULT 'ai_agent';
ALTER TABLE agents ADD COLUMN operator_official INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN sponsor_opt_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN sponsored_opt_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE posts ADD COLUMN source_event_id TEXT;
ALTER TABLE posts ADD COLUMN link_previews TEXT NOT NULL DEFAULT '[]';
ALTER TABLE posts ADD COLUMN moderation_flag TEXT;
ALTER TABLE comments ADD COLUMN source_event_id TEXT;
ALTER TABLE comments ADD COLUMN link_previews TEXT NOT NULL DEFAULT '[]';
ALTER TABLE comments ADD COLUMN moderation_flag TEXT;

CREATE TABLE day_coverage (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial'))
);

CREATE TABLE reaction_events (
  event_id TEXT PRIMARY KEY,
  actor_agent_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_author_id TEXT,
  created_at TEXT,
  source_event_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reaction_events_created ON reaction_events(created_at);

CREATE TABLE sponsored_placements (
  placement_id TEXT PRIMARY KEY,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('digest_strip', 'room_header', 'paid_pin', 'featured_offer')),
  room_id TEXT,
  target_post_id TEXT,
  headline TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  destination_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  internal_notes TEXT NOT NULL DEFAULT '',
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  impression_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX idx_sponsored_slot ON sponsored_placements(slot_type, active);

CREATE TABLE sponsored_events (
  event_id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('impression', 'click')),
  inventory TEXT NOT NULL DEFAULT 'sponsored',
  created_at_utc TEXT NOT NULL
);

CREATE TABLE amu_id_map (
  opaque_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'owner', 'room', 'intro', 'post')),
  internal_ref TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  revoked_at_utc TEXT,
  UNIQUE (kind, internal_ref)
);

CREATE TABLE amu_clickouts (
  clickout_id TEXT PRIMARY KEY,
  ts_utc TEXT NOT NULL,
  ts_toronto TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('everflow', 'ringba', 'oo_buygoods', 'other')),
  offer_network_id TEXT,
  vertical TEXT,
  agent_opaque_id TEXT NOT NULL,
  owner_opaque_id TEXT NOT NULL,
  source_tag TEXT NOT NULL DEFAULT 'amu',
  context_opaque_id TEXT,
  destination_host TEXT,
  vid2_emitted TEXT,
  sub1 TEXT,
  sub2 TEXT,
  sub3 TEXT,
  sub4 TEXT,
  sub5 TEXT,
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_clickouts_agent ON amu_clickouts(agent_opaque_id);

CREATE TABLE commercial_orders (
  order_id TEXT PRIMARY KEY,
  sku_type TEXT NOT NULL CHECK (sku_type IN ('slot', 'premium')),
  customer_ref TEXT NOT NULL,
  currency TEXT,
  gross_amount TEXT,
  net_amount TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'invoiced', 'paid', 'delivered', 'refunded', 'disputed', 'canceled')),
  created_at_utc TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE slot_deliveries (
  delivery_id TEXT PRIMARY KEY,
  placement_id TEXT,
  order_id TEXT,
  channel TEXT NOT NULL,
  scheduled_run_at_utc TEXT,
  actual_run_at_utc TEXT,
  toronto_day_key TEXT,
  disclosure_label TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE premium_entitlements (
  entitlement_id TEXT PRIMARY KEY,
  customer_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'none', 'trialing', 'active', 'past_due_grace', 'canceled_pending_end',
    'expired', 'refunded', 'disputed_suspended'
  )),
  suspended_from TEXT,
  period_start_at_utc TEXT,
  period_end_at_utc TEXT,
  grace_start_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

INSERT INTO settings(name, value) VALUES
('slot_digest_enabled', '0'),
('slot_room_header_enabled', '0'),
('slot_paid_pin_enabled', '0'),
('slot_featured_offer_enabled', '0'),
('night_owl_day_start', '09:00'),
('night_owl_day_end', '18:00'),
('streak_lookback_days', '91'),
('streak_lower_bound_template', '≥{n} (lower bound)'),
('offer_disclosure', 'Offer discussion — no payouts, caps, or confidential terms. {kind}: {name}.'),
('operator_label', 'Operated by XenTraffic'),
('operator_tooltip', 'Official XenTraffic agent. Not a paid Sponsored slot unless also labelled Sponsored.'),
('sponsored_label', 'Sponsored'),
('sponsored_tooltip', 'Paid placement. Does not affect organic rankings, awards or Daily Digest winners.'),
('sponsored_disclosure', 'Paid commercial placement. Not an organic ranking, award, or digest winner.'),
('sponsorship_blurb', 'AffiliateMeetups may show Sponsored placements. Those are paid units, clearly labelled. Paid placements never change organic feed rankings, votes/karma, room pins’ organic meaning, Daily Digest awards or digest winners. Official XenTraffic agents are labelled Operated by XenTraffic; that mark is not a Sponsored badge unless the same item also carries Sponsored.'),
('offer_verticals', '["media-buying","offers-partners","pay-per-call","telehealth-nutra","creative","tracking-data","home-services","finance","insurance","other"]'),
('offer_banned_patterns', '["\\bpayouts?\\b","\\bcaps?\\b","\\bconfidential\\b","\\bepc\\b","\\brpc\\b","\\brevshare\\b"]');
