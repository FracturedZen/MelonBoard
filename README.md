# MelonBoard

A melon leaderboard for simpcraft.com: a small Fabric mod reports your melon statistics, and a
Discord bot keeps the standings.

```
Fabric mod  ──POST──▶  Cloudflare Worker  ──▶  D1 (SQLite)
                              │
                              └──▶  Discord: /leaderboard + a pinned live board
```

- `src/` — the Fabric client mod
- `server/` — the Worker, the database schema, and the bot. See [server/README.md](server/README.md)
  for deployment.

## What it tracks

| Action | Points |
|---|---|
| Chop a melon | 1 |
| Place a melon block | 1 |
| Plant a melon seed | 3 |
| Craft a melon block | 5 |

Weights are server-side configuration; changing one re-scores everybody without a mod update.

## How it works, and why it is built this way

**It reads the server's own statistics rather than watching your actions.** Vanilla Minecraft
already counts all four of these, server-side, in the same statistics the in-game Statistics
screen shows. The mod asks for them with `REQUEST_STATS` and reports the totals.

That choice removes most of the ways a tracker like this normally goes wrong. There is no
guessing whether the server accepted a block placement, so nothing is over- or under-counted.
Totals are absolute rather than incremental, so a resend after a timeout changes nothing and a
crash loses nothing — the counts live on the server, and the next submission is simply correct
again. It also means automation counts exactly like manual play, which is the intent here.

**Everyone starts at zero.** On your first submission the API records your current totals as a
baseline and scores you on growth from there, so a player who joined last week is not competing
against someone's five-year melon history. The baseline is written once, server-side, and is
never accepted from the client — if it lived in the config file, deleting that file would award
you your entire lifetime history.

**Your username is proven, not claimed.** The endpoint URL is readable by anyone who opens the
jar, so a self-reported username would let anyone post any score as anyone. Instead the mod signs
a one-time challenge with the private half of the key pair Mojang issues for chat signing, and
sends its public key along with Mojang's certificate of that key. The API checks Mojang's
signature over the key — which binds it to your UUID — and then your signature over the
challenge.

It never contacts Mojang to do this, which is what makes it possible: Mojang's session server
refuses requests from the hosting the API runs on, so the usual `joinServer`/`hasJoined` handshake
could not work at all. It needs a premium account with chat signing enabled, and your access token
is never read or sent anywhere.

Clients also send a protocol version, and the API refuses anything older than its minimum. When a
security change alters what the client must send, older builds are rejected outright rather than
quietly continuing on a weaker path.

This does not make scores unforgeable — a patched mod can report any numbers, and no client-side
tracker can prevent that. It makes every submission attributable to one proven account, which can
be banned. Rate sanity checks catch the crude attempts and record the borderline ones.

## Installing (players)

1. Install [Fabric Loader](https://fabricmc.net/use/installer) for the matching Minecraft version.
2. Download the latest jar from [Releases](https://github.com/FracturedZen/MelonBoard/releases)
   and drop it into `.minecraft/mods/`.

Keep only one MelonBoard jar in the folder -- two copies declare the same mod id and Fabric will
refuse to start.

**Old builds stop working.** The API refuses any client below its minimum protocol version, so a
jar from before a security change is rejected with a message telling you to update rather than
silently failing.

No Fabric API and no other dependencies. Join simpcraft.com and it starts reporting; it does
nothing on any other server or in singleplayer.

## Commands

| Command | Effect |
|---|---|
| `.mb` | status |
| `.mb on` / `.mb off` | start or stop tracking |
| `.mb now` | submit immediately |
| `.mb interval <minutes>` | how often to submit (default 3) |
| `.mb server <host>` | which server to track (default simpcraft.com) |
| `.mb endpoint <url>` | the leaderboard API |
| `.mb prefix <chars>` | change the command prefix if another mod claims `.mb` |

Settings live in `.minecraft/config/melonboard.json`.

## Building

```powershell
.\gradlew.bat build "-Dorg.gradle.java.home=C:\Users\Z\.gradle\jdks\eclipse_adoptium-25-amd64-windows.2"
```

The quotes around `-D` matter in PowerShell — without them it splits on the colon in the path and
Gradle reads the fragments as task names.

Output: `build/libs/MelonBoard-1.0.0.jar`.
