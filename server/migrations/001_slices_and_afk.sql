-- Adds passive melon slices and AFK (piston-broken) melons.
--
-- Applied to a live database, so these are ALTERs rather than a schema rebuild. SQLite adds
-- columns with their default filled in for existing rows, so every current player starts at zero
-- for the new stats without a backfill.
--
-- NOTE: `--file` does NOT work with a wrangler OAuth login. Cloudflare's D1 import endpoint
-- rejects it with "Authentication error [code: 10000]" even though --command works fine. Run the
-- statements individually instead:
--
--   wrangler d1 execute melonboard --remote --yes --command "ALTER TABLE ..."
--
-- schema.sql is the authoritative shape for a fresh database; this file records what changed.

-- Observed play time, in ticks, accumulated only while the mod was actually reporting.
-- Slices are derived from this at read time rather than stored, so changing the rate re-scores
-- everyone consistently -- the same reason points are derived from the raw counters.
ALTER TABLE players ADD COLUMN watched_ticks INTEGER NOT NULL DEFAULT 0;

-- Melons broken by pistons within render distance. Unlike every other counter these are NOT a
-- vanilla statistic -- the player did not break them -- so they are counted by the client and
-- cannot be corroborated by the server. Kept as an absolute total with a baseline, matching the
-- others, so resubmission stays idempotent.
ALTER TABLE players ADD COLUMN t_afk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN b_afk INTEGER NOT NULL DEFAULT 0;
