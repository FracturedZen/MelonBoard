-- Pack counter, and bought slots in the card pool.
--
-- Applied to a live database, so these are ALTERs and CREATEs rather than a rebuild. Run the
-- statements INDIVIDUALLY -- `--file` does not work with a wrangler OAuth login:
--
--   wrangler d1 execute melonboard --remote --yes --command "ALTER TABLE ..."
--
-- schema.sql carries the same definitions and is the authoritative shape for a fresh database.

-- Packs opened, counted at the time rather than derived. Deriving it from the pulls log would mean
-- dividing by CARDS_PER_PACK, which silently rewrites everybody's history the day that changes.
ALTER TABLE players ADD COLUMN packs_opened INTEGER NOT NULL DEFAULT 0;

-- Backfill from the pull log. Safe as a one-off because a pack has always been six cards; that is
-- exactly the assumption the column exists to stop depending on.
UPDATE players SET packs_opened =
  (SELECT COUNT(*) FROM pulls WHERE pulls.uuid = players.uuid) / 6;

-- A bought slot in the card pool: "put my card in the packs", priced by tier.
--
-- UNIQUE (uuid, tier) is what enforces one purchase per tier per player. It lives in the database
-- rather than in a read-then-write check because that check races itself -- two clicks a moment
-- apart both read "not bought yet" and both charge.
--
-- A slot is bought PENDING. The art is drawn by hand afterwards, so the card only becomes
-- pullable when an admin activates it with /cardslot activate, which is also what sets card_key.
-- The key is the PNG filename without .png, and doubles as the card's display name via prettyKey,
-- so there is no separate name to keep in step.
CREATE TABLE IF NOT EXISTS card_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid          TEXT NOT NULL,
  discord_id    TEXT NOT NULL,
  username      TEXT NOT NULL,          -- Minecraft name at purchase, for the art ticket
  tier          TEXT NOT NULL,          -- rare | epic | legendary | unique
  card_key      TEXT,                   -- set at activation
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | active
  bought_at     INTEGER NOT NULL,
  activated_at  INTEGER,
  UNIQUE (uuid, tier)
);

CREATE INDEX IF NOT EXISTS idx_card_claims_status ON card_claims(status);
