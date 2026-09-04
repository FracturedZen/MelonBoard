# MelonBoard server

One Cloudflare Worker doing three jobs: the Mojang ownership handshake, the stat ingest API, and
the Discord bot. State lives in D1 (Cloudflare's SQLite). Everything below fits in the free tier.

## Prerequisites

**This machine has no Node.js**, and `wrangler` needs it:

```powershell
winget install OpenJS.NodeJS.LTS
```

Open a new terminal afterwards so `node` and `npm` are on PATH, then:

```powershell
npm install -g wrangler
wrangler login
```

## 1. Create the database

```powershell
cd C:\Users\Z\Desktop\MelonBoard\server
wrangler d1 create melonboard
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_THE_ID_WRANGLER_PRINTS`. Then create the tables:

```powershell
wrangler d1 execute melonboard --remote --file=./schema.sql
```

## 2. Create the Discord application

At <https://discord.com/developers/applications> → **New Application**.

- **General Information** → copy **Application ID** and **Public Key** into the `[vars]` block
  of `wrangler.toml` as `DISCORD_APP_ID` and `DISCORD_PUBLIC_KEY`.
- **Bot** → **Reset Token**, copy it, and store it as a secret (never in `wrangler.toml`):

```powershell
wrangler secret put DISCORD_BOT_TOKEN
```

## 3. Deploy

```powershell
wrangler deploy
```

Note the URL it prints, e.g. `https://melonboard.<your-subdomain>.workers.dev`.

Back in the Discord portal, **General Information** → **Interactions Endpoint URL** →
`https://melonboard.<your-subdomain>.workers.dev/discord` → Save. Discord immediately sends a
signed PING; if it saves without complaint, the signature check is working.

## 4. Register the slash commands

```powershell
$env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; node scripts/register-commands.mjs
```

Global commands can take up to an hour to appear. Add `$env:DISCORD_GUILD_ID="..."` to register
them to one server instantly while testing.

## 5. Invite the bot and point it at a channel

Invite URL — replace `APP_ID`:

```
https://discord.com/api/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=76800
```

That permission integer is Send Messages + Embed Links + Manage Messages. Manage Messages is only
needed so the board can pin itself; without it everything else still works.

Turn on **User Settings → Advanced → Developer Mode**, right-click the channel the board should
live in → **Copy Channel ID**, put it in `wrangler.toml` as `BOARD_CHANNEL_ID`, and redeploy:

```powershell
wrangler deploy
```

Leave `BOARD_CHANNEL_ID` empty if you only want the `/leaderboard` command and no pinned board.

## 6. Point the mod at it

In game, once:

```
.mb endpoint https://melonboard.<your-subdomain>.workers.dev
```

For a jar other people will download, set `DEFAULT_ENDPOINT` in
`src/main/java/com/melonboard/Config.java` to that URL and rebuild, so it works out of the box.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /auth/challenge` | issues a random `serverId` for the Mojang handshake |
| `POST /auth/verify` | checks Mojang's `hasJoined`, returns a 24h bearer token |
| `POST /submit` | absolute stat totals; returns points and rank |
| `POST /discord` | Discord interactions (signature-verified) |
| `GET /board.json` | current standings as JSON, handy for debugging |

## Changing the point values

Edit `W_MINED` / `W_PLACED` / `W_CRAFTED` / `W_PLANTED` in `wrangler.toml` and redeploy. Points
are computed from raw counters at query time, so a weight change re-scores everyone consistently
and immediately. No migration, and nobody has to update the mod.

## Operating notes

- **Reviewing suspicious submissions.** Anything above `SOFT_RATE` is recorded, not rejected:

  ```powershell
  wrangler d1 execute melonboard --remote --command "SELECT * FROM flags ORDER BY at DESC LIMIT 20"
  ```

- **Banning someone.** Their score disappears from the board and further submissions get a 403:

  ```powershell
  wrangler d1 execute melonboard --remote --command "UPDATE players SET banned=1 WHERE username='Someone'"
  ```

- **What the trust model actually guarantees.** A patched mod can report any numbers it likes —
  no client-side leaderboard can prevent that. What it does guarantee is that every submission is
  bound to a Minecraft account whose ownership was proven against Mojang, so forgery is
  attributable to one account and ends when that account is banned. Only a server-side plugin
  could make scores genuinely unforgeable.
