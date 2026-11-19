-- Optional label for the sponsored click control. Empty means the public
-- default "Visit sponsor". Additive. Do not edit 001, 002, or 003.

ALTER TABLE sponsored_placements ADD COLUMN cta_label TEXT NOT NULL DEFAULT '';
