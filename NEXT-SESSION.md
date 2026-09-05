# Paste this after /clear

Continue work on MelonBoard at `C:\Users\Z\Desktop\MelonBoard`. Most context is in your memory
files, which load automatically — read `melonboard-project.md` before touching anything.

## The task

**Show card images as thumbnails in `/open` and `/collection`.**

Discord embeds hold ONE image each. The only way to show several is to give multiple embeds the
**same `url` value**, which Discord merges into one gallery — **max 4 images per group**.

- **`/open`** currently shows one large image of the best card. It should show all 6 pulled cards
  as small images. That needs two gallery groups (4 + 2), or a rethink.
- **`/collection`** currently lists card names as text. It should show small images of the cards.
  With dozens of cards this needs pagination — next/prev buttons, 4 per page — since the whole
  collection cannot render at once.

Card art URLs are already derived from the card key:
`https://raw.githubusercontent.com/FracturedZen/MelonBoard/main/assets/cards/<key>.png`

Both commands live in `server/src/index.js` (`openPack`, `collectionEmbed`).

## Rules that have already cost time — do not relearn them

- **Register Discord commands GUILD-scoped**, never global. Pass
  `DISCORD_GUILD_ID=1537368810787442728`. Global takes an hour to propagate and looks like
  nothing happened.
- **Write patch scripts to a FILE**, never a shell heredoc. Heredocs collapse `\n` inside string
  literals into real newlines and produce broken JavaScript. This happened three times.
- **Never filter `wrangler deploy` output to success lines.** A failed deploy went unnoticed
  because the grep only matched "Uploaded". Show the tail.
- **Wait ~8s after deploying before testing.** Propagation lag produced three false "the fix
  didn't work" conclusions.
- **Verify with `npx esbuild src/index.js --bundle --outfile=/dev/null`** before deploying — it
  names the exact line of a syntax error, which wrangler does not.
- **Embed code blocks WRAP rather than scroll and are narrow.** Character-count checks pass while
  the render is broken. Keep panels under ~40 columns.
- **Commit only as** `FracturedZen <140035389+FracturedZen@users.noreply.github.com>`. Never pass
  `-c user.email=`; the session's userEmail context is his real name and must never reach a
  commit, file, or hostname.
- **Never deploy a jar into a RUNNING MultiMC instance.** Check first, skip that instance.

## State

Everything below is built, deployed and working:

- Fabric mod reporting melon stats, protocol 3, Mojang profile-key signature auth
- Worker at `https://melonboard.creationplunder.workers.dev`, D1 database, cron every 2 min
- 13 guild commands: `/leaderboard /melonstats /wallet /shop /buy /link /lottery /open
  /collection /combine /sets /trade /pings`
- Full card deck (52 + 4 holo aces + 2 jokers), 18 numbered player cards (5/5 non-holo, 1/1 holo),
  all 236 set images installed and serving
- Repo `github.com/FracturedZen/MelonBoard`, clean, CI builds and releases on tag

## Untested

- **A real legendary pull announcement.** The ping role, mention restrictions and announcement
  embed have never fired — 1-in-1,011 packs. Offer to raise the odds temporarily to prove it
  works, then set them back.
- **A trade between two people.** Needs a second linked Discord account.
