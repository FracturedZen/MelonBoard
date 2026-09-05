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
- Full card deck (52 + 4 holo aces + 2 jokers), 18 numbered player cards (5/5 non-holo, 1/1 holo),
  all 236 set images installed and serving
- `/open` shows all six pulled cards as art (two galleries, 4 + 2); `/collection` shows the art
  four to a page, best tier first, with first/prev/next/last buttons
- Repo `github.com/FracturedZen/MelonBoard`, clean, CI builds and releases on tag
