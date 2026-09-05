# Paste this after /clear

Continue work on MelonBoard at `C:\Users\Z\Desktop\MelonBoard`. Most context is in your memory
files, which load automatically — read `melonboard-project.md` before touching anything.

## What is left

Nothing is half-built. Two things are **shipped but never actually fired**, and both need a human
in Discord rather than more code:

1. **A real legendary pull announcement.** The ping role, the mention restrictions and the
   announcement embed have never run — it is 1-in-1,011 packs. Offer to raise the odds in
   `server/src/cards.js` (`ODDS.legendary`) temporarily, open a pack to prove the whole path
   works, then put them back and redeploy. Do this before anyone else starts opening packs: if it
   is broken, better to find out now than the first time somebody hits a 1/1.
2. **A trade between two people.** `/trade` has only ever been exercised one-sided. Needs a second
   linked Discord account.

## Card slots

Buy your own card into the packs: Rare 1m, Epic 10m, Legendary 100m, 1-of-1 1b points, one per
tier per player. `UNIQUE (uuid, tier)` on `card_claims` is what enforces that -- do not replace it
with a read-then-write check, which races itself.

rare/epic/legendary join their tier's pool: endless, tier odds unchanged, the bought card one more
equally likely outcome inside the tier. The 1-of-1 goes through `limited_supply`/`limited_claims`
instead, so there is one mechanism for scarce cards.

**Fulfilling an order:**

1. `/cardslot list` shows who is waiting. Buying also DMs you a ticket (falling back to the
   commands channel, because a bot DM to someone with server DMs off fails silently).
2. Draw the art, save as `assets/cards/<key>.png`. The key is lower case, digits and underscores,
   and IS the card's display name via prettyKey -- `frac_king` shows as "Frac King".
3. Run `assets/make-thumbs.ps1`, then push. Activation refuses a key whose PNG is not live in both
   `assets/cards/` and `assets/thumbs/` -- a broken 1-of-1 cannot be undone once claimed.
4. `/cardslot activate id:<n> key:<key>`. It announces the new card in the commands channel.

## Known, deliberately not done yet

From the 2026-09-04 audit. None is urgent at two players; all get worse with an audience.

- `/open` charges before it writes. `spend()` commits, then ~16 sequential D1 statements run; a
  failure after the charge means paid-and-no-cards, shown to the player as "the application did
  not respond". Nothing uses a deferred (type 5) response, so every command must finish inside
  Discord's 3 seconds. `env.DB.batch()` would make the 12 per-card writes one round trip.
- `flags` is never swept and holds 147 rows of curl test noise, with no command to read it.
- Trades expire only lazily inside `resolveTrade`; an untouched one keeps live-looking buttons.
- `meta` holds `credit:4baa6acb-b021-4a0b-8a81-e93e47a50ad3` for a UUID that is not a player,
  matching the test series. It would be awarded on that account's first submit. Decide and delete.

## Rules that have already cost time — do not relearn them

- **Register Discord commands GUILD-scoped**, never global. Pass
  `DISCORD_GUILD_ID=1537368810787442728`. Global takes an hour to propagate and looks like
  nothing happened.
- **Registering needs the bot token, which only exists as a Cloudflare secret and cannot be read
  back.** Claude cannot do this step; Z has to run `scripts/register-commands.mjs`. Until it is
  run, a new or changed command is simply absent from the picker however correct the worker is.
- **Write patch scripts to a FILE**, never a shell heredoc. Heredocs collapse `\n` inside string
  literals into real newlines and produce broken JavaScript. This happened three times.
- **Never filter `wrangler deploy` output to success lines.** A failed deploy went unnoticed
  because the grep only matched "Uploaded". Show the tail.
- **Wait ~8s after deploying before testing.** Propagation lag produced three false "the fix
  didn't work" conclusions.
- **Verify with `npx esbuild src/index.js --bundle --format=esm --outfile=NUL`** before deploying —
  it names the exact line of a syntax error, which wrangler does not.
- **Embed code blocks WRAP rather than scroll and are narrow.** Character-count checks pass while
  the render is broken. Keep panels under ~40 columns.
- **Commit only as** `FracturedZen <140035389+FracturedZen@users.noreply.github.com>`. Never pass
  `-c user.email=`; the session's userEmail context is his real name and must never reach a
  commit, file, or hostname.
- **Never deploy a jar into a RUNNING MultiMC instance.** Check first, skip that instance.

## Showing card images — read this before touching an embed

A Discord embed holds ONE image, and a Worker has no canvas to composite with. Several images
means Discord's **gallery**: consecutive embeds sharing the **same `url`** merge into one grid of
**at most 4**. `cardGallery()` in `server/src/index.js` is the single place that knows this.

- Discord CROPS gallery tiles to fill them, and THE TILE SHAPE CHANGES WITH HOW MANY IMAGES ARE
  IN THE GROUP. Square art from `assets/thumbs/` fixes a 2x2 but not a row of two, so chasing the
  art shape per group size does not converge -- Discord owns the layout. One image per embed is
  never cropped and is the only safe size: `CARD_GALLERY_SIZE = "1"` for /open. /collection stays
  at 4, where the square art does work.
- `cardGallery()` picks art by group size: solo -> portrait `artUrl`, 2+ -> square `thumbUrl`
  (built by `assets/make-thumbs.ps1`, a pad onto a #14101C mat, not a scale). Re-run that script
  after adding a card, and push assets BEFORE deploying the worker that references them. Keep the
  code default and the wrangler var in step.
- Only the first embed of a group renders text; the rest are a url and an image.
- The url has to be real and becomes the link on that group's title, so it points at the repo with
  a per-group `#fragment` — without distinct fragments two galleries in one message merge.
- Nav buttons can point at the same page (on page 2 of 3, `<<` and `<` both mean page 1) and
  Discord rejects duplicate `custom_id`s, so the slot name is part of the id.
- Paging replies with interaction type **7** (UPDATE_MESSAGE), not 4.

To exercise a renderer offline: copy `index.js` to a `.mjs`, append an `export { ... }` line, and
import it with a stubbed `env.DB.prepare().bind().all()/.first()`. Delete the copy afterwards.

## State

Everything below is built, deployed and working:

- Fabric mod reporting melon stats, protocol 3, Mojang profile-key signature auth
- Worker at `https://melonboard.creationplunder.workers.dev`, D1 database, cron every 2 min
- 13 guild commands: `/leaderboard /melonstats /wallet /shop /buy /link /lottery /open
  /collection /combine /sets /trade /pings`
- Full card deck (52 + 4 holo aces + 2 jokers), plus 30 numbered cards / 114 copies: 18 player
  cards (5/5 non-holo, 1/1 holo) and 12 Minecraft lore cards at 5 each. All 236 set images serving
- Adding a numbered card needs NO deploy: PNG into `assets/cards/`, run `assets/make-thumbs.ps1`,
  push, then merge the key into the `limited_supply` meta JSON. More numbered cards do not mean
  more numbered drops -- `ODDS.unique` is per draw and independent of supply
- `/open` shows all six pulled cards as art, `CARD_GALLERY_SIZE` (default 2) per gallery;
  `/collection` shows the art `COLLECTION_PAGE_SIZE` (default 4) to a page, best tier first, with
  first/prev/next/last buttons. Fewer per gallery = each card drawn bigger; that is the only lever,
  since Discord sizes tiles from the layout and stretches whatever art it is given.
- `schema.sql` rebuilds the whole database again, verified against live; `server/scripts/backup.ps1`
  exports it to `~/Desktop/MelonBoard-backups` (never into the repo -- it holds Discord ids)
- Repo `github.com/FracturedZen/MelonBoard`, clean, CI builds and releases on tag
