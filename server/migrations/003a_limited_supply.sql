-- User packs, part A: shrink the scarce tier to the nine holo one-of-ones.
--
-- RUN THIS BEFORE DEPLOYING. Between this and the deploy, the OLD worker is live against the NEW
-- supply map, and the only risk is somebody pulling a holo out of a MELON pack at 1/30000 per
-- card. The other order is far worse: the NEW worker reading the OLD thirty-key map would hand
-- out lore cards stamped as numbered #1/5 at 1/1000 per card and write junk into limited_claims.
--
-- Everything dropped from this map -- the twelve lore cards and the nine base signature cards --
-- becomes endless and is drawn from the user pool in code. A key left here that is not a holo
-- would quietly stay scarce, so the map is replaced wholesale rather than edited.
--
-- Note the column names: meta is (k, v), not (key, value).
--
-- Verified 2026-09-08 before running: limited_claims held 0 rows, so no numbered copy had ever
-- been pulled and nothing needed preserving.

INSERT INTO meta (k, v) VALUES ('limited_supply',
  '{"frac_1_holo":1,"frac_2_holo":1,"frac_3_holo":1,"dumzy_1_holo":1,"dumzy_2_holo":1,"dumzy_3_holo":1,"plutoren_1_holo":1,"plutoren_2_holo":1,"plutoren_3_holo":1}')
ON CONFLICT(k) DO UPDATE SET v = excluded.v;
