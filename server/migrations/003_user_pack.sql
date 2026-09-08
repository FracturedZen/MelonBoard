-- User packs, and the end of bought card slots.
--
-- Two changes, one structural and one to data:
--
-- 1. card_claims is dropped. Buying your own card into the packs is gone; the table was only ever
--    written by that flow and no purchase was ever completed, so nothing is lost. Run the DROP
--    only after confirming the table is empty -- see the SELECT below.
--
-- 2. limited_supply is rewritten to hold ONLY the nine holo one-of-ones. Everything else that was
--    numbered -- the nine base signature cards and the twelve lore cards -- becomes endless and is
--    drawn from the user pool in code, so leaving a key in this map would quietly keep it scarce.
--
-- Existing rows in limited_claims are LEFT ALONE on purpose. A claim on a card that is no longer
-- numbered is harmless (nothing reads it once the key leaves limited_supply) and it is the only
-- record of who pulled which numbered copy. Claims on the holos still count, so a holo somebody
-- already owns stays owned and cannot be pulled again.

-- Check first. This must return 0 before running the DROP.
--   SELECT COUNT(*) FROM card_claims;

DROP TABLE IF EXISTS card_claims;

-- The whole of the scarce tier, after this change. Note the column names: meta is (k, v), not
-- (key, value) -- an UPDATE naming the wrong columns fails loudly, but a SELECT does not.
INSERT INTO meta (k, v) VALUES ('limited_supply',
  '{"frac_1_holo":1,"frac_2_holo":1,"frac_3_holo":1,"dumzy_1_holo":1,"dumzy_2_holo":1,"dumzy_3_holo":1,"plutoren_1_holo":1,"plutoren_2_holo":1,"plutoren_3_holo":1}')
ON CONFLICT(k) DO UPDATE SET v = excluded.v;
