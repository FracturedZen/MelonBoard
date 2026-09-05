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

-- COLUMN ORDER DIFFERS FROM THE LIVE DATABASE and that is fine. watched_ticks, t_afk and b_afk
-- arrived by ALTER TABLE, which appends, so live has them after `banned` while this file declares
-- them where they belong. Same twenty columns either way, and D1 returns rows keyed by name, so
-- nothing depends on the order. Do not "fix" it by reordering a live table.
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


-- ============================================================================ CARDS
--
-- Everything below was created directly against the live database while the card economy was
-- being built, and existed nowhere in the repo until it was dumped back out of sqlite_master.
-- Keep it that way round from now on: change this file, then apply it.

-- What each player owns. One row per (player, card) with a count, so duplicates do not multiply
-- rows. Cards are decremented rather than deleted, which is why readers filter on count > 0
-- instead of on the row existing.
CREATE TABLE IF NOT EXISTS collection (
  uuid          TEXT NOT NULL,
  card          TEXT NOT NULL,              -- card key; the art filename without .png
  count         INTEGER NOT NULL DEFAULT 0,
  first_pulled  INTEGER,
  PRIMARY KEY (uuid, card)
);

-- Every pull ever, append only. Nothing reads it today. It exists so that a dispute about who
-- pulled what, or a question about whether the odds are behaving, can be answered from evidence
-- rather than from memory.
CREATE TABLE IF NOT EXISTS pulls (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid    TEXT NOT NULL,
  card    TEXT NOT NULL,
  rarity  TEXT NOT NULL,
  at      INTEGER NOT NULL
);

-- The ledger of numbered cards: one row per CLAIMED COPY, so a 5/5 can occupy five rows and a
-- 1/1 exactly one. The composite primary key is what makes a claim atomic -- openPack walks the
-- copy numbers with INSERT OR IGNORE, and a copy somebody took a moment earlier simply changes
-- nothing, so the next is tried.
--
-- This table is the ONLY record of who holds a given one-of-one. It cannot be recomputed from
-- anything else, which is the reason this database is worth exporting.
--
-- What EXISTS is separate: print runs live in meta under 'limited_supply' as {cardKey: copies},
-- so a print run can change without a deploy. This table records only what has been taken.
CREATE TABLE IF NOT EXISTS limited_claims (
  card        TEXT NOT NULL,
  copy_no     INTEGER NOT NULL,
  uuid        TEXT NOT NULL,
  claimed_at  INTEGER NOT NULL,
  PRIMARY KEY (card, copy_no)
);

-- Completed poker sets, as an audit trail of what /combine consumed. `cards` is the JSON list of
-- the exact keys spent, duplicates expanded, so a set can be explained -- and reversed by hand if
-- it ever has to be.
CREATE TABLE IF NOT EXISTS sets (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid     TEXT NOT NULL,
  set_key  TEXT NOT NULL,
  cards    TEXT NOT NULL,                   -- JSON array of card keys
  made_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sets_uuid ON sets(uuid);

-- ============================================================================ GIVEAWAYS

CREATE TABLE IF NOT EXISTS lotteries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  prize              TEXT NOT NULL,
  entry_cost         INTEGER NOT NULL,
  currency           TEXT NOT NULL,          -- 'points' or 'slices'
  ends_at            INTEGER NOT NULL,
  channel_id         TEXT,
  message_id         TEXT,                   -- the giveaway post, edited in place as it fills
  created_by         TEXT,
  status             TEXT NOT NULL DEFAULT 'open',   -- open | drawn
  winner_discord_id  TEXT,
  winner_name        TEXT,
  drawn_at           INTEGER
);

-- The cron asks for open lotteries whose time is up on every single tick, so this one earns its
-- keep even at small row counts.
CREATE INDEX IF NOT EXISTS idx_lotteries_open ON lotteries(status, ends_at);

-- Entries are WEIGHTS, not rows: ten tickets increment one row by ten rather than inserting ten.
-- The draw walks the weights, so a large entry costs no more to store than a small one.
CREATE TABLE IF NOT EXISTS lottery_entries (
  lottery_id  INTEGER NOT NULL,
  discord_id  TEXT NOT NULL,
  entries     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lottery_id, discord_id)
);

-- ============================================================================ TRADES

-- A proposed swap, held until the other side presses a button or it lapses.
--
-- `give` and `want` are JSON offers rather than columns because one side of a trade can be
-- several cards and an amount of currency at once. Both sides are RE-VERIFIED at settlement --
-- what a player held when a trade was proposed says nothing about what they hold when it is
-- accepted -- and 'settling' is how that is made safe: the trade is claimed with a conditional
-- UPDATE ... WHERE status = 'open', so two clicks cannot both deliver.
CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_uuid     TEXT NOT NULL,
  from_discord  TEXT NOT NULL,
  to_uuid       TEXT NOT NULL,
  to_discord    TEXT NOT NULL,
  give          TEXT NOT NULL,          -- JSON offer from the proposer
  want          TEXT NOT NULL,          -- JSON offer asked in return
  -- open | settling | done | declined | expired | failed
  status        TEXT NOT NULL DEFAULT 'open',
  from_ok       INTEGER NOT NULL DEFAULT 1,
  to_ok         INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL,
  expires       INTEGER NOT NULL,       -- enforced lazily, when somebody presses a button
  channel_id    TEXT,
  message_id    TEXT
);
