# Paste this after /clear

Continue work on MelonBoard at `C:\Users\Z\Desktop\MelonBoard`. Most context is in your memory
files, which load automatically — read `melonboard-project.md` before touching anything.

## Not yet live — do these in this order

The user pack is written, bundle-checked and exercised offline, but nothing has been deployed.
**The order matters**; see "Why this order" below.

1. **Push the assets first.** Art is served from GitHub, so a worker that references a PNG which
   is not pushed yet renders a broken embed.
2. **Rewrite `limited_supply`** to the nine holos. From `server/`:
   ```bash
   npx wrangler d1 execute melonboard --remote --command "INSERT INTO meta (k, v) VALUES ('limited_supply', '{\"frac_1_holo\":1,\"frac_2_holo\":1,\"frac_3_holo\":1,\"dumzy_1_holo\":1,\"dumzy_2_holo\":1,\"dumzy_3_holo\":1,\"plutoren_1_holo\":1,\"plutoren_2_holo\":1,\"plutoren_3_holo\":1}') ON CONFLICT(k) DO UPDATE SET v = excluded.v"
   ```
   D1 auth was EXPIRED as of 2026-09-08 (`code: 7403`, "account is not valid or is not authorized").
   Fix with `wrangler login --browser false` and open the printed URL in Chrome explicitly.
   **`meta` is `(k, v)`, not `(key, value)`** — a wrong-column UPDATE is how the first draft of
   `migrations/003_user_pack.sql` was written, and only the offline probe caught it.
3. **Deploy** the worker. Show the tail of the output; never grep it for success lines.
4. **Drop `card_claims`** once `SELECT COUNT(*) FROM card_claims` returns 0 (it should — no slot
   was ever bought). `migrations/003_user_pack.sql` has both statements written down.
5. **Register commands.** `/open` gained a `type` option and `/cardslot` is gone, so until this
   runs the picker still shows the old set. Only Z can do this — the bot token exists solely as a
   Cloudflare secret and cannot be read back:
   ```powershell
   cd C:\Users\Z\Desktop\MelonBoard\server
   $env:DISCORD_APP_ID    = "1545309849594892288"
   $env:DISCORD_GUILD_ID  = "1537368810787442728"
   $env:DISCORD_BOT_TOKEN = "<paste bot token>"
   node scripts/register-commands.mjs
   Remove-Item Env:DISCORD_BOT_TOKEN
   ```
6. **Then verify in Discord:** `/open` and `/open type:user`, `/shop`, `/collection`, and a
   `/trade` naming a user card by its written name (`HvH #1`).

**Why this order.** Between step 2 and step 3 there is a window where the OLD worker is live
against the NEW supply map: the only risk is somebody pulling a holo out of a *melon* pack, at
1/30000 per card. Doing it the other way round — deploying first — leaves the NEW worker reading
the OLD 30-key map, which would hand out lore cards stamped as numbered `#1/5` at 1/1000 per card
and write junk into `limited_claims`. That is a hundred times likelier and it does not clean up.

## The two packs

`/open` is the melon pack and `/open type:user` is the user pack. Same price (3,000 points or
120 slices), same six cards, and they **share no cards at all**, so a pull always says which pack
it came from. Odds live in `ODDS` and `USER_ODDS` in `server/src/cards.js`.

| | melon pack | user pack |
|---|---|---|
| common | 2–10 of each suit | 12 lore cards + poses 1 and 2 of each person (34) |
| rare | J/Q/K (12) | pose 3 of each of the 11 new people (11) |
| epic | the four aces | — |
| legendary | holo aces + 2 jokers, 1/6000 per card | frac/dumzy/plutoren, all poses, 1/50 per card (9) |
| 1-of-1 | — | the 9 frac/dumzy/plutoren holos, 1/1000 per card |
| can it run dry | no | only the holo tier; the pack itself always delivers |

Measured over 600k draws: melon 84.9/13.0/2.0/0.02, user 64.8/33.1/2.0/0.10. All 58 and all 63
cards respectively are reachable, and with the holos exhausted the branch is skipped rather than
rolled and discarded.

**A user-pack legendary does not ping.** `isNoteworthy(rarity, pack)` announces every 1-of-1 but
only announces a legendary from the MELON pack, where it is 1 in 1,000 packs. The user pack's
legendary tier is 1 in 9 — pinging `PING_ROLE_ID` that often would train everyone to mute it.

## Adding a person to the user pack

No deploy is needed for art, but a new person IS a code change — one entry in `USER_PEOPLE`.

1. Save three PNGs as `assets/cards/<slug>_1.png`, `_2`, `_3`. The slug is lower case, and the
   art is 512x716 like everything else.
2. Run `assets/make-thumbs.ps1`, then push. Activation of anything scarce refuses a key whose PNG
   is not live in **both** `cards/` and `thumbs/`.
3. Add `{ slug: "...", name: "..." }` to `USER_PEOPLE` in `server/src/cards.js`. **`name` carries
   the real casing** — keys cannot, and prettyKey would render `hvh_1` as "Hvh 1" rather than
   "HvH #1". Poses 1 and 2 become common and pose 3 rare automatically.
4. Setting `signature: true` instead makes all three poses legendary and expects three more PNGs,
   `<slug>_<n>_holo.png`. Those are 1-of-1s: add their keys to the `limited_supply` meta JSON, at
   one copy each, or they will never be drawn.

`server/src/cards.js` builds both decks and both pools from those two lists, and `BY_KEY` covers
every card either pack can produce — which is what makes `/collection`, `/trade` and the pull
announcement name a user card without any of them knowing it exists.

## Removed: bought card slots

`/cardslot`, `SHOP_CARDS`, `buyCardSlot`, `tellOwner`, the bought-card pools and lookups, the
`card_claims` table and `OWNER_DISCORD_ID` are all gone. Nobody ever completed a purchase, so
nothing was stranded. Do not reintroduce "buy your way into the pool" without deciding first what
it means now that the user pack exists — the two ideas overlap.

## Known, deliberately not done

From the 2026-09-04 audit; none of it was touched by the user-pack work.

- **`/open` charges before it writes.** `spend()` commits, then ~13 sequential D1 statements run;
  a failure after the charge means paid-and-no-cards, shown as "the application did not respond".
  Nothing anywhere uses a deferred (type 5) response, so every command must finish inside
  Discord's 3 seconds. `env.DB.batch()` would make the per-card writes one round trip. This is the
  most worthwhile thing left.
- `flags` is never swept and holds 147 rows of curl test noise, with no command to read it.
- Trades expire only lazily inside `resolveTrade`; an untouched one keeps live-looking buttons.
- `meta` holds `credit:4baa6acb-b021-4a0b-8a81-e93e47a50ad3` for a UUID that is not a player,
  matching the test series. It would be awarded on that account's first submit. Decide and delete.
- Old `limited_claims` rows for cards that are no longer numbered (the lore cards and the base
  signature cards) are left in place on purpose: nothing reads them once the key leaves
  `limited_supply`, and they are the only record of who pulled which copy.
- A two-sided `/trade` has still never been exercised; it needs a second linked Discord account.

## Rules that have already cost time — do not relearn them

- **Register Discord commands GUILD-scoped**, never global. Pass
  `DISCORD_GUILD_ID=1537368810787442728`. Global takes an hour to propagate and looks like
  nothing happened.
- **Registering needs the bot token, which only exists as a Cloudflare secret and cannot be read
  back.** Claude cannot do this step. Until Z runs it, a new or changed command is simply absent
  from the picker however correct the worker is.
- **Write patch scripts to a FILE**, never a shell heredoc. Heredocs collapse `\n` inside string
  literals into real newlines and produce broken JavaScript. This happened three times. (Also:
  there is no `python` on this box, and `node`/`npx` are absent from the Bash tool's PATH — use
  PowerShell with the PATH refresh from the memory file.)
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

## Exercising the worker offline

This is how the `meta (k, v)` bug and the duplicate-`custom_id` bug were both caught before a
deploy. Copy `src/index.js` to `src/_probe.mjs`, append an `export { ... }` line naming what you
want, and import it with a stub whose `prepare(sql)` answers by matching on the SQL text —
`.bind()` returning itself, and `.all()`/`.first()`/`.run()` returning the shape each call site
expects. **Delete the copy afterwards.** Watch for the real column names: `meta` is `(k, v)`, and
`balanceOf` selects `FROM links l JOIN players p`, not from `players` alone.

## Showing card images — read this before touching an embed

A Discord embed holds ONE image, and a Worker has no canvas to composite with. Several images
means Discord's **gallery**: consecutive embeds sharing the **same `url`** merge into one grid of
**at most 4**. `cardGallery()` in `server/src/index.js` is the single place that knows this.

- Discord CROPS gallery tiles to fill them, and THE TILE SHAPE CHANGES WITH HOW MANY IMAGES ARE
  IN THE GROUP. Square art from `assets/thumbs/` fixes a 2x2 but not a row of two, so chasing the
  art shape per group size does not converge — Discord owns the layout. One image per embed is
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

## State

Built and working, but see "Not yet live" — the user pack has not been deployed:

- Fabric mod reporting melon stats, protocol 3, Mojang profile-key signature auth
- Worker at `https://melonboard.creationplunder.workers.dev`, D1 database, cron every 2 min
- 12 guild commands: `/leaderboard /melonstats /wallet /shop /buy /link /lottery /open
  /collection /combine /sets /trade /pings`
- **121 cards across two packs.** Melon: 52 playing cards + 4 holo aces + 2 jokers = 58.
  User: 12 lore + 14 people × 3 poses + 9 holo 1-of-1s = 63. All 236 set images still serving
- `schema.sql` rebuilds the whole database; `server/scripts/backup.ps1` exports it to
  `~/Desktop/MelonBoard-backups` (never into the repo — it holds Discord ids)
- Repo `github.com/FracturedZen/MelonBoard`, clean, CI builds and releases on tag
