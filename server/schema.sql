-- MelonBoard D1 schema.
--
-- TOTALS AND BASELINES
-- --------------------
-- The client submits ABSOLUTE totals read from the server's own statistics, never deltas. We
-- store the latest totals (t_*) and the totals the player had when they first submitted (b_*).
-- Score is computed from the difference, so:
--
--   * everyone starts at zero regardless of how long they have played on the server;
--   * a duplicated or replayed submission changes nothing, because it is not an addend;
--   * a dropped submission costs nothing, because the next one carries the full picture.
--
-- The baseline is written exactly once, here, on a player's first submission. It is never sent
-- by the client and never accepted from the client: if it lived client-side, deleting a config
-- file would rebaseline to zero and award the player their entire lifetime history.
--
-- Points are computed at READ time from the weights in wrangler.toml rather than stored. That
-- means changing a weight re-scores the whole board consistently, with no migration.

CREATE TABLE IF NOT EXISTS players (
  uuid        TEXT PRIMARY KEY,           -- Mojang UUID, dashed. The identity; names change.
  username    TEXT NOT NULL,              -- last name seen, refreshed on every submission
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,

  -- latest absolute totals as reported
  t_placed    INTEGER NOT NULL DEFAULT 0,
  t_mined     INTEGER NOT NULL DEFAULT 0,
  t_crafted   INTEGER NOT NULL DEFAULT 0,
  t_planted   INTEGER NOT NULL DEFAULT 0,

  -- totals at first submission; score = t_* - b_*
  b_placed    INTEGER NOT NULL DEFAULT 0,
  b_mined     INTEGER NOT NULL DEFAULT 0,
  b_crafted   INTEGER NOT NULL DEFAULT 0,
  b_planted   INTEGER NOT NULL DEFAULT 0,

  play_time   INTEGER NOT NULL DEFAULT 0, -- server play ticks, for rate sanity checks

  -- Play ticks we actually observed (bounded by real elapsed time), which passive melon slices
  -- are derived from. Play time itself keeps counting with the mod off; this does not.
  watched_ticks INTEGER NOT NULL DEFAULT 0,

  -- Melons broken by pistons in render distance. NOT a vanilla statistic -- the player did not
  -- break them -- so unlike every other counter the server cannot corroborate these.
  t_afk       INTEGER NOT NULL DEFAULT 0,
  b_afk       INTEGER NOT NULL DEFAULT 0,
  -- ECONOMY
  -- Points mean two different things and conflating them would punish participation: the
  -- leaderboard ranks LIFETIME points (derived from the counters above and never decreasing),
  -- while the shop charges against a BALANCE of lifetime + bonus_points - points_spent. Buying
  -- something must never drop a player down the board.
  points_spent  INTEGER NOT NULL DEFAULT 0,
  slices_spent  INTEGER NOT NULL DEFAULT 0,
  bonus_points  INTEGER NOT NULL DEFAULT 0, -- from selling duplicate cards

  banned      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_players_username ON players(username);

-- Outstanding Mojang joinServer challenges. Short lived; the cron sweeps expired rows.
CREATE TABLE IF NOT EXISTS challenges (
  server_id   TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  expires     INTEGER NOT NULL
);

-- Bearer tokens. Only the sha256 is stored, so a database dump cannot be replayed as a client.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  uuid        TEXT NOT NULL,
  username    TEXT NOT NULL,
  issued      INTEGER NOT NULL,
  expires     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_uuid ON tokens(uuid);
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens(expires);

-- Submissions worth a second look. Recorded, not rejected: a false positive that silently eats
-- someone's score is worse than a log line nobody reads.
CREATE TABLE IF NOT EXISTS flags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  reason  TEXT NOT NULL,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_flags_uuid ON flags(uuid);
CREATE INDEX IF NOT EXISTS idx_flags_at ON flags(at);

-- board_message_id, board_hash.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Every shop transaction, kept as an audit trail. Balances are derived from the players table,
-- so this exists to answer "where did my points go", not to compute anything.
CREATE TABLE IF NOT EXISTS purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL,
  discord_id TEXT,
  item       TEXT NOT NULL,
  cost       INTEGER NOT NULL,
  currency   TEXT NOT NULL,   -- 'points' or 'slices'
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchases_uuid ON purchases(uuid);

-- Discord account <-> Minecraft account. One to one in both directions; see linkClaim.
CREATE TABLE IF NOT EXISTS link_codes (
  code         TEXT PRIMARY KEY,
  discord_id   TEXT NOT NULL,
  discord_name TEXT,
  expires      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  discord_id TEXT PRIMARY KEY,
  uuid       TEXT NOT NULL UNIQUE,
  linked_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON link_codes(expires);
