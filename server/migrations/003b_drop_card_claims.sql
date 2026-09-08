-- User packs, part B: drop the bought-card-slot table.
--
-- RUN THIS AFTER DEPLOYING, not before. The OLD worker still reads card_claims in shopEmbed and
-- in openPack's bought-card pools, so dropping it first breaks /shop and /open until the deploy
-- lands. The NEW worker never mentions the table.
--
-- Verified 2026-09-08 before running: card_claims held 0 rows. No slot was ever bought, so
-- nothing is lost. If that count is ever non-zero, stop and decide what the rows mean first.
--
--   SELECT COUNT(*) FROM card_claims;

DROP TABLE IF EXISTS card_claims;
