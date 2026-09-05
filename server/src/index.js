/**
 * MelonBoard API + Discord bot, as a single Cloudflare Worker.
 *
 * Three surfaces:
 *   /auth/challenge, /auth/verify   the Mojang ownership handshake
 *   /submit                          the mod posting absolute stat totals
 *   /discord                         Discord slash commands (HTTP interactions)
 * plus a cron handler that refreshes the pinned leaderboard message and sweeps dead rows.
 *
 * TRUST MODEL, STATED PLAINLY
 * ---------------------------
 * The client is not trustworthy and cannot be made so: a patched mod can report any numbers it
 * likes. What this design does guarantee is that every submission is bound to a Minecraft account
 * whose ownership was proven against Mojang, so a forgery is attributable to exactly one account
 * and dies the moment that account is banned here. Combined with server-owned baselines, monotonic
 * totals and rate sanity checks, that is as far as a client-side leaderboard can honestly go.
 */

import {
  DECK, BY_KEY, RARITY, CARDS_PER_PACK,
  artUrl, setArtUrl, drawCard, isNoteworthy, prettyKey,
} from "./cards.js";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Discord requires bot requests to identify themselves as `DiscordBot ($url, $version)` and
 * rejects other user agents at the edge with a 403 before the request ever reaches the API.
 * The failure is opaque -- a plain 403 with no explanation -- so this string is load bearing.
 */
const DISCORD_UA = "DiscordBot (https://github.com/FracturedZen/MelonBoard, 1.0)";

const CHALLENGE_TTL = 120;       // seconds a challenge stays claimable
const LINK_TTL = 10 * 60;        // a /link code is typed by hand, so give it room

/** No 0/O/1/I/5/S -- these get read off a screen and retyped, so ambiguity is a real cost. */
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
const LINK_LENGTH = 6;
const TOKEN_TTL = 24 * 60 * 60;  // bearer token lifetime
const BOARD_SIZE = 15;

const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Upper bound on any single submitted number, to reject garbage before it reaches SQL. Set well
 * past anything reachable -- play_time is measured in ticks, so a bound tight enough to be
 * "realistic" for melon counts would start rejecting long-lived accounts outright.
 */
const MAX_STAT = 100_000_000_000;

/**
 * Client protocol version, sent as X-MelonBoard-Protocol.
 *
 * MIN_PROTOCOL is what the API will still talk to. Raising it locks out every older jar at the
 * door, which is the point: when a security fix changes what the client must send, old builds
 * must stop being accepted rather than quietly falling back to the weaker path. A client that
 * sends no version at all predates the scheme and is treated as version 0.
 */
const CURRENT_PROTOCOL = 3;

/**
 * Mojang's public keys for player certificates, as base64 SPKI.
 *
 * Embedded rather than fetched because Mojang's session server refuses Cloudflare Workers' egress
 * IPs, and relying on a network call that might also be blocked would make authentication fail
 * closed for everyone. These rotate rarely; refreshMojangKeys() below tries the live endpoint and
 * falls back to these, so a rotation is picked up if the fetch happens to work and is survivable
 * if it does not.
 *
 * Fetched from https://api.minecraftservices.com/publickeys (playerCertificateKeys).
 */
const MOJANG_PLAYER_CERT_KEYS = [
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAylB4B6m5lz7jwrcFz6Fd/fnfUhcvlxsTSn5kIK/2aGG1C3kMy4VjhwlxF6BFUSnfxhNswPjh3ZitkBxEAFY25uzkJFRwHwVA9mdwjashXILtR6OqdLXXFVyUPIURLOSWqGNBtb08EN5fMnG8iFLgEJIBMxs9BvF3s3/FhuHyPKiVTZmXY0WY4ZyYqvoKR+XjaTRPPvBsDa4WI2u1zxXMeHlodT3lnCzVvyOYBLXL6CJgByuOxccJ8hnXfF9yY4F0aeL080Jz/3+EBNG8RO4ByhtBf4Ny8NQ6stWsjfeUIvH7bU/4zCYcYOq4WrInXHqS8qruDmIl7P5XXGcabuzQstPf/h2CRAUpP/PlHXcMlvewjmGU6MfDK+lifScNYwjPxRo4nKTGFZf/0aqHCh/EAsQyLKrOIYRE0lDG3bzBh8ogIMLAugsAfBb6M3mqCqKaTMAf/VAjh5FFJnjS+7bE+bZEV0qwax1CEoPPJL1fIQjOS8zj086gjpGRCtSy9+bTPTfTR/SJ+VUB5G2IeCItkNHpJX2ygojFZ9n5Fnj7R9ZnOM+L8nyIjPu3aePvtcrXlyLhH/hvOfIOjPxOlqW+O5QwSFP4OEcyLAUgDdUgyW36Z5mB285uKW/ighzZsOTevVUG2QwDItObIV6i8RCxFbN2oDHyPaO5j1tTaBNyVt8CAwEAAQ==",
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAt4t9NPuu7cktclnaH7eZj0omkLcJHeLz5MKsyJEntHZ0INtuBjSSul3Pp3pBeJN8k3ADdcdBLUN90bcAi7WsQqTx3Ft363q3W7TbM8j2iTEdp/0uVspoRt/DP1tkaWFs/w2WwUv9jbVoBUzfUc4pSTIxRwdjmqjZQfvjwKNDbOx3IhP2H0WXodbISejPi1wBZqNW4m1rnZAXp/EpUguxA8mobCa4vUCBkyFDyXdl69/wUSJHyCPmgcMJ364OlAhIqtwVPShBZObvrK/f0BYk6ShJD3N7TFDatSYsIIdcTKRknaIm91s+EsMrdB9U4Yw+ZJ/pyCB4S3vk8zfDCnb0DWIxYH3/EMzaxl77djmTmMzi/JDITup5z3jfWtRZmrAhU2/+W5IO5hEpo3/bCS9PXIY5xb41Lmp2ZO8dXKtyD66Chchy0W129n8vPl2GIruOdrxsjZAHnneyAb9jm0uaGaphwnEnuecX/qgHY6ZMtayvLLsPst8PO6R1vufMy8WqjK+j7LnC1krL7CPDg0NEhyQTmw5l+NCNjSlvB1juM9V4PARg0bYCOkGXm7ydRCjSSH8CJXZpwnd5cBB5WKAX3KPzutRgMi/LFwNSMZzFuUyXaYOZPpD259yqph1LmGqegEdDriACVU+dVEONFMm8eIuBofe7ljmsAFKW9BINwK0CAwEAAQ==",
];

function protocolOf(request) {
  const raw = request.headers.get("X-MelonBoard-Protocol");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Returns a 426 response when the client is too old, or null when it may proceed. */
function outdated(request, env) {
  const min = Math.max(0, Math.floor(numberFrom(env.MIN_PROTOCOL, 1)));
  const got = protocolOf(request);
  if (got >= min) return null;

  return json({
    error: "outdated client",
    detail: `This version of MelonBoard is too old. Update to continue.`,
    protocol: got,
    required: min,
    current: CURRENT_PROTOCOL,
  }, 426);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /auth/challenge": return await authChallenge(request, env);
        case "POST /auth/verify":    return await authVerify(request, env);
        case "POST /submit":         return await submit(request, env, ctx);
        case "POST /discord":        return await discordInteraction(request, env, ctx);
        case "POST /link/claim":     return await linkClaim(request, env);
        case "GET /me":              return await me(request, env);
        case "GET /board.json":      return await boardJson(env);
        case "GET /":                return new Response("MelonBoard is up.\n", { status: 200 });
        default:                     return json({ error: "not found" }, 404);
      }
    } catch (err) {
      console.error("unhandled", err && err.stack ? err.stack : String(err));
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
    ctx.waitUntil(refreshBoardMessage(env));
    ctx.waitUntil(drawExpiredLotteries(env));
  },
};

// ---------------------------------------------------------------------- auth

/**
 * Step 1. Hand out a random serverId and remember who is expected to claim it.
 *
 * This endpoint is unauthenticated by necessity -- it is what bootstraps authentication -- so it
 * must stay cheap and must not leak anything. It reveals nothing: the caller supplies the name
 * and uuid, and gets back a random string that is useless without a Mojang session.
 */
async function authChallenge(request, env) {
  const stale = outdated(request, env);
  if (stale) return stale;

  const body = await readJson(request);
  if (!body) return json({ error: "bad json" }, 400);

  const username = String(body.username ?? "");
  const uuid = String(body.uuid ?? "").toLowerCase();

  if (!USERNAME_RE.test(username)) return json({ error: "bad username" }, 400);
  if (!UUID_RE.test(uuid)) return json({ error: "bad uuid" }, 400);

  const serverId = randomHex(20);
  const expires = now() + CHALLENGE_TTL;

  await env.DB.prepare(
    "INSERT INTO challenges (server_id, username, uuid, expires) VALUES (?, ?, ?, ?)"
  ).bind(serverId, username, uuid, expires).run();

  return json({ serverId, expires });
}

/**
 * Proves the caller owns the Minecraft account, then issues a bearer token.
 *
 * There is deliberately no fallback here. An earlier build could be told to trust the client, and
 * because the endpoint is public that was enough for anyone to mint a token for any name. A
 * disabled bypass behind a config flag is still a bypass, so the trusting path is gone rather
 * than switched off, and the allowlist that stood in for it is gone with it.
 */
async function authVerify(request, env) {
  const stale = outdated(request, env);
  if (stale) return stale;

  const body = await readJson(request);
  if (!body) return json({ error: "bad json" }, 400);

  const serverId = String(body.serverId ?? "");
  if (!/^[0-9a-f]{1,64}$/.test(serverId)) return json({ error: "bad serverId" }, 400);

  const row = await env.DB.prepare(
    "SELECT username, uuid, expires FROM challenges WHERE server_id = ?"
  ).bind(serverId).first();

  // Single use: burn the challenge before doing any work, so a failed attempt cannot be retried
  // against the same one and signatures cannot be ground against a fixed target.
  await env.DB.prepare("DELETE FROM challenges WHERE server_id = ?").bind(serverId).run();

  if (!row) return json({ error: "unknown or already used challenge" }, 401);
  if (row.expires < now()) return json({ error: "challenge expired" }, 401);

  const failure = await verifyProfileSignature(env, row.uuid, serverId, body);
  if (failure) {
    console.log(`signature check failed for ${row.username} (${row.uuid}): ${failure}`);
    return json({ error: "could not verify this account", detail: failure }, 401);
  }

  const token = randomHex(32);
  const hash = await sha256Hex(token);
  const expires = now() + TOKEN_TTL;

  await env.DB.prepare(
    "INSERT OR REPLACE INTO tokens (token_hash, uuid, username, issued, expires) VALUES (?, ?, ?, ?, ?)"
  ).bind(hash, row.uuid, row.username, now(), expires).run();

  return json({ token, expires, verified: true });
}

/**
 * Ties the Discord account that ran /link to the Minecraft account holding this bearer token.
 *
 * The direction matters: the code proves "the same person is in this Discord", and the token
 * proves "the same person is in this game". Neither half is guessable from the other, and the
 * code is single use and short lived, so a code seen over someone's shoulder is worth little.
 */
async function linkClaim(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: "bad json" }, 400);

  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "that is not a link code" }, 400);

  const row = await env.DB.prepare(
    "SELECT discord_id, discord_name, expires FROM link_codes WHERE code = ?"
  ).bind(code).first();

  // Single use: burn it whether or not it turns out to be valid.
  await env.DB.prepare("DELETE FROM link_codes WHERE code = ?").bind(code).run();

  if (!row) return json({ error: "unknown or already used code" }, 404);
  if (row.expires < now()) return json({ error: "that code expired -- run /link again" }, 410);

  // A Discord account maps to exactly one Minecraft account and vice versa. Re-linking replaces
  // the old pairing rather than accumulating duplicates, so a mistake is fixed by linking again.
  await env.DB.prepare("DELETE FROM links WHERE discord_id = ? OR uuid = ?")
    .bind(row.discord_id, auth.uuid).run();

  await env.DB.prepare(
    "INSERT INTO links (discord_id, uuid, linked_at) VALUES (?, ?, ?)"
  ).bind(row.discord_id, auth.uuid, now()).run();

  console.log(`linked discord ${row.discord_id} -> ${auth.username} (${auth.uuid})`);

  return json({ ok: true, discordName: row.discord_name ?? null, username: auth.username });
}


// ----------------------------------------------------------- key signatures

function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The bytes Mojang signs when it certifies a player's profile key.
 *
 * Layout taken from ProfilePublicKey.Data#signedPayload in the game itself, big-endian:
 *   uuid most significant bits | uuid least significant bits | expiry millis | key DER
 *
 * Getting this wrong fails closed rather than open -- the signature simply will not verify -- but
 * it is the one part that must match the client byte for byte.
 */
function mojangSignedPayload(uuid, expiresAtMillis, keyDer) {
  const hex = uuid.replace(/-/g, "");
  const msb = BigInt("0x" + hex.slice(0, 16));
  const lsb = BigInt("0x" + hex.slice(16, 32));

  const out = new Uint8Array(24 + keyDer.length);
  const view = new DataView(out.buffer);

  view.setBigUint64(0, msb, false);
  view.setBigUint64(8, lsb, false);
  view.setBigInt64(16, BigInt(expiresAtMillis), false);
  out.set(keyDer, 24);

  return out;
}

/** Mojang's keys, preferring a live fetch and falling back to the embedded copies. */
async function mojangKeys(env) {
  try {
    const cached = await getMeta(env, "mojang_keys");
    const cachedAt = Number(await getMeta(env, "mojang_keys_at")) || 0;

    if (cached && now() - cachedAt < 24 * 3600) return JSON.parse(cached);

    const res = await fetch("https://api.minecraftservices.com/publickeys", {
      headers: { "User-Agent": "MelonBoard/1.0" },
    });

    if (res.ok) {
      const body = await res.json();
      const keys = (body.playerCertificateKeys ?? []).map((k) => k.publicKey).filter(Boolean);

      if (keys.length) {
        await setMeta(env, "mojang_keys", JSON.stringify(keys));
        await setMeta(env, "mojang_keys_at", String(now()));
        return keys;
      }
    }
  } catch (err) {
    console.log("mojang key refresh failed, using embedded copies:", String(err));
  }

  return MOJANG_PLAYER_CERT_KEYS;
}

async function verifyRsa(keyDer, hash, signature, data) {
  try {
    const key = await crypto.subtle.importKey(
      "spki", keyDer, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]
    );
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  } catch (err) {
    console.log("rsa verify error:", String(err));
    return false;
  }
}

/**
 * Proves the caller holds the Minecraft account it claims, without contacting Mojang.
 *
 * Two signatures have to line up. Mojang signed the player's profile key (SHA-1), which binds that
 * key to this UUID and an expiry; the player then signed our one-time challenge with the matching
 * private key (SHA-256). Neither half is useful alone: the certificate is public and the challenge
 * is worthless without the private key that only the account holder has.
 *
 * Returns null on success, or a reason string.
 */
async function verifyProfileSignature(env, uuid, serverId, body) {
  const keyB64 = String(body.publicKey ?? "");
  const keySigB64 = String(body.keySignature ?? "");
  const sigB64 = String(body.signature ?? "");
  const expiresAt = Number(body.expiresAt ?? 0);

  if (!keyB64 || !keySigB64 || !sigB64 || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return "missing key material";
  }

  if (expiresAt <= Date.now()) return "profile key has expired";

  let keyDer, keySig, sig;
  try {
    keyDer = b64ToBytes(keyB64);
    keySig = b64ToBytes(keySigB64);
    sig = b64ToBytes(sigB64);
  } catch {
    return "malformed key material";
  }

  // 1. Mojang certifies that this key belongs to this UUID until this moment.
  const payload = mojangSignedPayload(uuid, expiresAt, keyDer);
  const certs = await mojangKeys(env);

  let certified = false;
  for (const cert of certs) {
    if (await verifyRsa(b64ToBytes(cert), "SHA-1", keySig, payload)) {
      certified = true;
      break;
    }
  }
  if (!certified) return "Mojang did not certify this key for that account";

  // 2. The holder of the matching private key signed the challenge we just issued. The challenge
  //    is random, single use and short lived, so a captured signature is not replayable.
  const ok = await verifyRsa(keyDer, "SHA-256", sig, new TextEncoder().encode(serverId));
  if (!ok) return "challenge signature did not verify";

  return null;
}

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;

  const hash = await sha256Hex(header.slice(7).trim());

  const row = await env.DB.prepare(
    "SELECT uuid, username, expires FROM tokens WHERE token_hash = ?"
  ).bind(hash).first();

  if (!row || row.expires < now()) return null;
  return row;
}

// -------------------------------------------------------------------- submit

async function submit(request, env, ctx) {
  const stale = outdated(request, env);
  if (stale) return stale;

  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: "bad json" }, 400);

  const t = {
    placed: statOf(body.placed),
    mined: statOf(body.mined),
    crafted: statOf(body.crafted),
    planted: statOf(body.planted),
    afk: statOf(body.afk ?? 0),
  };
  const playTime = statOf(body.playTime);

  if (t.placed === null || t.mined === null || t.crafted === null || t.planted === null
      || t.afk === null || playTime === null) {
    return json({ error: "stats must be integers in range" }, 400);
  }

  const w = weights(env);
  const ts = now();

  const existing = await env.DB.prepare(
    "SELECT * FROM players WHERE uuid = ?"
  ).bind(auth.uuid).first();

  if (!existing) {
    // FIRST SUBMISSION: totals become the baseline, so this player starts at zero no matter how
    // long they have already played. This is the only moment a baseline is ever written.
    await env.DB.prepare(
      `INSERT INTO players
         (uuid, username, first_seen, last_seen,
          t_placed, t_mined, t_crafted, t_planted,
          b_placed, b_mined, b_crafted, b_planted,
          t_afk, b_afk,
          play_time, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      auth.uuid, auth.username, ts, ts,
      t.placed, t.mined, t.crafted, t.planted,
      t.placed, t.mined, t.crafted, t.planted,
      t.afk, t.afk,
      playTime
    ).run();

    // Push the board straight away rather than waiting for the next cron tick. waitUntil lets
    // the response return immediately while the refresh finishes in the background, and
    // refreshBoardMessage is a no-op when the standings hash is unchanged, so this is cheap.
    ctx.waitUntil(refreshBoardMessage(env));

    // A player whose row was removed can be made whole here: their old progress is stored as a
    // credit and subtracted from the fresh baseline, so their first submission lands back where
    // they were instead of at zero. Their absolute totals are unknowable until this moment, which
    // is why it cannot be done before they submit.
    const credited = await applyPendingCredit(env, auth.uuid);

    ctx.waitUntil(refreshBoardMessage(env));

    const restored = credited
      ? await env.DB.prepare(`SELECT ${pointsSql(w)} AS points FROM players WHERE uuid = ?`)
          .bind(auth.uuid).first()
      : null;

    return json({
      ok: true,
      points: restored?.points ?? 0,
      rank: await rankOf(env, restored?.points ?? 0, w),
      baselined: true,
      restored: credited,
    });
  }

  if (existing.banned) return json({ error: "banned" }, 403);

  // Totals from the server's statistics only ever grow. A drop means the server's stats were
  // reset (or something is wrong). Lower the baseline by the same amount so the player keeps the
  // points they earned, rather than being punished for an operator's decision.
  const baseline = {
    placed: existing.b_placed,
    mined: existing.b_mined,
    crafted: existing.b_crafted,
    planted: existing.b_planted,
    afk: existing.b_afk,
  };

  let regressed = false;
  for (const k of ["placed", "mined", "crafted", "planted", "afk"]) {
    const previous = existing[`t_${k}`];
    if (t[k] < previous) {
      regressed = true;
      baseline[k] = Math.max(0, baseline[k] - (previous - t[k]));
    }
  }

  if (regressed) {
    await flag(env, auth.uuid, "regression",
      `was ${existing.t_placed}/${existing.t_mined}/${existing.t_crafted}/${existing.t_planted}` +
      ` now ${t.placed}/${t.mined}/${t.crafted}/${t.planted}`);
  }

  // Rate sanity. Deliberately loose: automation is allowed on this server, so any cap tight
  // enough to catch a determined forger would also punish a legitimate AFK farm. These numbers
  // are set where no amount of legitimate play can reach, and softer outliers are recorded
  // rather than rejected -- silently eating someone's honest score is the worse failure.
  // Slices accrue from play time, but only for time we actually observed. Bounding the delta by
  // real elapsed seconds stops a player who logged hours with the mod off from banking all of it
  // the moment they switch it on -- play_time keeps counting regardless of whether we are looking.
  const playDelta = Math.max(0, playTime - (existing.play_time || 0));
  const wallTicks = Math.max(0, (ts - existing.last_seen)) * 20;
  const observedTicks = Math.min(playDelta, wallTicks);
  const watchedTicks = (existing.watched_ticks || 0) + observedTicks;

  // AFK melons are excluded from this deliberately. A large farm legitimately produces thousands
  // per minute, so including them would trip the caps constantly, and at a fraction of a point
  // each they are not worth defending this way.
  const elapsed = Math.max(1, ts - existing.last_seen);
  const gained = (t.placed + t.mined + t.crafted + t.planted)
    - (existing.t_placed + existing.t_mined + existing.t_crafted + existing.t_planted);
  const rate = gained / elapsed;

  if (rate > numberFrom(env.HARD_RATE, 200)) {
    await flag(env, auth.uuid, "impossible-rate", `${gained} actions in ${elapsed}s`);
    return json({ error: "submission rejected: impossible rate" }, 429);
  }
  if (rate > numberFrom(env.SOFT_RATE, 20)) {
    await flag(env, auth.uuid, "high-rate", `${gained} actions in ${elapsed}s`);
  }

  await env.DB.prepare(
    `UPDATE players SET
       username = ?, last_seen = ?, play_time = ?, watched_ticks = ?,
       t_placed = ?, t_mined = ?, t_crafted = ?, t_planted = ?,
       b_placed = ?, b_mined = ?, b_crafted = ?, b_planted = ?,
       t_afk = ?, b_afk = ?
     WHERE uuid = ?`
  ).bind(
    auth.username, ts, playTime, watchedTicks,
    t.placed, t.mined, t.crafted, t.planted,
    baseline.placed, baseline.mined, baseline.crafted, baseline.planted,
    t.afk, baseline.afk,
    auth.uuid
  ).run();

  const points =
    (t.placed - baseline.placed) * w.placed +
    (t.mined - baseline.mined) * w.mined +
    (t.crafted - baseline.crafted) * w.crafted +
    (t.planted - baseline.planted) * w.planted +
    Math.floor((t.afk - baseline.afk) / w.afkPer);

  ctx.waitUntil(refreshBoardMessage(env));

  return json({
    ok: true,
    points,
    rank: await rankOf(env, points, w),
    slices: slicesOf(watchedTicks, env),
  });
}

/**
 * This player's own standing. Read only -- it never writes, so the client can call it freely on
 * login without touching the baseline or the totals.
 */
async function me(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const w = weights(env);
  const row = await env.DB.prepare(
    `SELECT ${pointsSql(w)} AS points, watched_ticks,
            (t_placed - b_placed)   AS placed,
            (t_mined - b_mined)     AS mined,
            (t_crafted - b_crafted) AS crafted,
            (t_planted - b_planted) AS planted,
            (t_afk - b_afk)             AS afk
       FROM players WHERE uuid = ? AND banned = 0`
  ).bind(auth.uuid).first();

  // No row yet means this account has never submitted. That is zero points, not an error.
  if (!row) return json({ ok: true, known: false, points: 0, rank: 0, slices: 0 });

  return json({
    ok: true,
    known: true,
    points: row.points,
    rank: await rankOf(env, row.points, w),
    slices: slicesOf(row.watched_ticks, env),
    placed: row.placed,
    mined: row.mined,
    crafted: row.crafted,
    planted: row.planted,
    afk: row.afk,
  });
}

/**
 * Restores progress for a player whose row was deleted.
 *
 * Lowering the freshly written baseline by what they had is the only way to do this: score is
 * derived as totals minus baseline, and their totals are not known until they submit. Runs once,
 * then the credit is discarded.
 */
async function applyPendingCredit(env, uuid) {
  const key = "credit:" + uuid;
  const raw = await getMeta(env, key);
  if (!raw) return false;

  let c;
  try {
    c = JSON.parse(raw);
  } catch {
    await env.DB.prepare("DELETE FROM meta WHERE k = ?").bind(key).run();
    return false;
  }

  await env.DB.prepare(
    `UPDATE players SET
       b_placed  = b_placed  - ?,
       b_mined   = b_mined   - ?,
       b_crafted = b_crafted - ?,
       b_planted = b_planted - ?,
       b_afk     = b_afk     - ?
     WHERE uuid = ?`
  ).bind(c.placed ?? 0, c.mined ?? 0, c.crafted ?? 0, c.planted ?? 0, c.afk ?? 0, uuid).run();

  await env.DB.prepare("DELETE FROM meta WHERE k = ?").bind(key).run();
  console.log(`restored progress for ${uuid}: ${JSON.stringify(c)}`);
  return true;
}

async function flag(env, uuid, reason, detail) {
  await env.DB.prepare(
    "INSERT INTO flags (uuid, at, reason, detail) VALUES (?, ?, ?, ?)"
  ).bind(uuid, now(), reason, detail).run();
}

// ------------------------------------------------------------------- scoring

/**
 * Weights live in configuration, and points are derived from raw counters at read time rather
 * than stored. Changing a weight therefore re-scores every player consistently and instantly,
 * with no migration and no client update.
 */
function weights(env) {
  return {
    placed: numberFrom(env.W_PLACED, 1),
    mined: numberFrom(env.W_MINED, 1),
    crafted: numberFrom(env.W_CRAFTED, 5),
    planted: numberFrom(env.W_PLANTED, 3),
    // A divisor, not a multiplier: AFK melons are worth a fraction of a point, so this many make
    // one. Guarded against zero because it lands in SQL.
    afkPer: Math.max(1, Math.floor(numberFrom(env.AFK_PER_POINT, 500))),
  };
}

/** SQL fragment for a player's score. Weights are coerced to numbers before interpolation. */
function pointsSql(w) {
  // SQLite integer division truncates, which is exactly what "500 AFK melons make a point" means.
  return `((t_placed - b_placed) * ${w.placed}` +
         ` + (t_mined - b_mined) * ${w.mined}` +
         ` + (t_crafted - b_crafted) * ${w.crafted}` +
         ` + (t_planted - b_planted) * ${w.planted}` +
         ` + (t_afk - b_afk) / ${w.afkPer})`;
}

async function rankOf(env, points, w) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS ahead FROM players WHERE banned = 0 AND ${pointsSql(w)} > ?`
  ).bind(points).first();

  return (row?.ahead ?? 0) + 1;
}

async function topPlayers(env, limit, offset = 0) {
  const w = weights(env);

  const { results } = await env.DB.prepare(
    `SELECT username,
            ${pointsSql(w)} AS points,
            (t_placed - b_placed)   AS placed,
            (t_mined - b_mined)     AS mined,
            (t_crafted - b_crafted) AS crafted,
            (t_planted - b_planted) AS planted,
            (t_afk - b_afk)             AS afk,
            (watched_ticks / ${Math.max(1, Math.floor(numberFrom(env.TICKS_PER_SLICE, 1200)))}) AS slices
       FROM players
      WHERE banned = 0
      ORDER BY points DESC, username ASC
      LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  return results ?? [];
}

async function boardJson(env) {
  return json({ weights: weights(env), players: await topPlayers(env, BOARD_SIZE) });
}

// ------------------------------------------------------------------- discord

async function discordInteraction(request, env, ctx) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const raw = await request.text();

  if (!signature || !timestamp || !(await verifyDiscord(env, signature, timestamp, raw))) {
    return new Response("bad signature", { status: 401 });
  }

  const body = JSON.parse(raw);

  if (body.type === 1) return json({ type: 1 }); // PING

  // Button presses. Type 3 is MESSAGE_COMPONENT; the reply is ephemeral so a channel full of
  // entrants does not become a channel full of confirmations.
  if (body.type === 3) {
    const id = String(body.data?.custom_id ?? "");
    const m = /^lottery_enter:(\d+):(\d+)$/.exec(id);

    if (m) {
      const user = body.member?.user ?? body.user ?? {};
      const data = await enterLottery(env, Number(m[1]), Number(m[2]), String(user.id ?? ""));
      return json({ type: 4, data });
    }

    if (id === "combine_pick") {
      const user = body.member?.user ?? body.user ?? {};
      const choice = String(body.data?.values?.[0] ?? "");
      return json({ type: 4, data: await doCombine(env, String(user.id ?? ""), choice) });
    }

    const c = /^coll:(\d+):(\d+):\w+$/.exec(id);
    if (c) {
      const user = body.member?.user ?? body.user ?? {};
      const clicker = String(user.id ?? "");

      if (clicker !== c[1]) {
        return json({
          type: 4,
          data: ephemeral({
            color: MELON_GREY,
            title: "Not your collection",
            description: "_Run `/collection` to page through your own._",
          }),
        });
      }

      // Type 7 is UPDATE_MESSAGE: it edits the page in place, so browsing a collection does not
      // leave a trail of replies behind it.
      return json({ type: 7, data: await collectionPage(env, clicker, Number(c[2])) });
    }

    const t = /^trade_(accept|decline):(\d+)$/.exec(id);
    if (t) {
      const user = body.member?.user ?? body.user ?? {};
      const data = await resolveTrade(env, Number(t[2]), String(user.id ?? ""), t[1] === "accept");
      return json({ type: 4, data });
    }

    return json({ type: 4, data: ephemeral({ color: MELON_GREY, title: "Unknown button" }) });
  }

  if (body.type === 2) {
    const name = body.data?.name;

    // Keep the noise in one place if a channel is configured. /leaderboard is exempt so the board
    // can still be pulled up wherever a conversation is happening.
    const home = String(env.COMMANDS_CHANNEL_ID ?? "").trim();
    if (home && name !== "leaderboard" && String(body.channel_id ?? "") !== home) {
      return json({
        type: 4,
        data: ephemeral({
          color: MELON_GREY,
          title: "Wrong channel",
          description: `_Use MelonBoard commands in <#${home}>._`,
        }),
      });
    }

    if (name === "leaderboard") {
      const page = Math.max(1, Number(optionValue(body, "page") ?? 1));
      return json({ type: 4, data: { embeds: await boardEmbeds(env, page) } });
    }

    if (name === "link") {
      const user = body.member?.user ?? body.user ?? {};
      return json({
        type: 4,
        data: { embeds: [await linkEmbed(env, user)], flags: 64 },
      });
    }

    if (name === "combine") {
      return json({ type: 4, data: await combineMenu(env, body) });
    }

    if (name === "sets") {
      return json({ type: 4, data: await setsEmbed(env, body) });
    }

    if (name === "trade") {
      return json({ type: 4, data: await tradeCommand(env, body) });
    }

    if (name === "open") {
      return json({ type: 4, data: await openPack(env, body, ctx) });
    }

    if (name === "collection") {
      return json({ type: 4, data: await collectionEmbed(env, body) });
    }

    if (name === "pings") {
      return json({ type: 4, data: await togglePings(env, body) });
    }

    if (name === "wallet") {
      return json({ type: 4, data: await walletEmbed(env, body) });
    }

    if (name === "shop") {
      return json({ type: 4, data: await shopEmbed(env, body) });
    }

    if (name === "buy") {
      return json({ type: 4, data: await buyCommand(env, body) });
    }

    if (name === "lottery") {
      return json({ type: 4, data: await lotteryCommand(env, body) });
    }

    if (name === "melonstats") {
      const who = String(optionValue(body, "player") ?? "").trim();
      return json({ type: 4, data: { embeds: [await playerEmbed(env, who)], flags: 64 } });
    }
  }

  return json({ type: 4, data: { content: "Unknown command.", flags: 64 } });
}

/**
 * Issues a fresh code for whoever ran /link. Always ephemeral -- a code posted publicly could be
 * claimed by anyone reading the channel before its owner types it.
 */
async function linkEmbed(env, user) {
  const discordId = String(user.id ?? "");
  if (!discordId) return { color: MELON_PINK, title: "Could not identify you" };

  const existing = await env.DB.prepare(
    "SELECT p.username FROM links l JOIN players p ON p.uuid = l.uuid WHERE l.discord_id = ?"
  ).bind(discordId).first();

  let code = "";
  for (let i = 0; i < LINK_LENGTH; i++) {
    code += LINK_ALPHABET[Math.floor(Math.random() * LINK_ALPHABET.length)];
  }

  // One outstanding code per person; asking again replaces the old one.
  await env.DB.prepare("DELETE FROM link_codes WHERE discord_id = ?").bind(discordId).run();
  await env.DB.prepare(
    "INSERT INTO link_codes (code, discord_id, discord_name, expires) VALUES (?, ?, ?, ?)"
  ).bind(code, discordId, String(user.global_name ?? user.username ?? ""), now() + LINK_TTL).run();

  return {
    color: MELON_GREEN,
    author: { name: "LINK YOUR ACCOUNT" },
    title: `🍉  ${code}`,
    description:
      (existing ? `_Currently linked to **${escapeMd(existing.username)}**. Linking again replaces it._\n\n` : "") +
      "In Minecraft, press **`** to open MelonBoard, click the **Link code** box, " +
      "type the code above and press **Enter**.\n\n" +
      `_Expires <t:${now() + LINK_TTL}:R>. Only you can see this message._`,
  };
}

/** Reads an option out of the chosen subcommand rather than the top level. */
function subOption(sub, name) {
  const opt = (sub?.options ?? []).find((o) => o.name === name);
  return opt ? opt.value : null;
}

function optionValue(body, name) {
  const opt = (body.data?.options ?? []).find((o) => o.name === name);
  return opt ? opt.value : null;
}

/**
 * Discord signs every interaction; an endpoint that does not check the signature can be driven
 * by anyone who learns its URL, and Discord will not even finish registering it.
 *
 * Workers exposed Ed25519 under the non-standard name "NODE-ED25519" before adopting the
 * standard "Ed25519". Which one a deployment gets depends on its compatibility_date, so try the
 * standard name first and fall back rather than making the board's commands hinge on that.
 */
async function verifyDiscord(env, signature, timestamp, body) {
  if (!env.DISCORD_PUBLIC_KEY) {
    console.error("DISCORD_PUBLIC_KEY is not set; refusing all interactions");
    return false;
  }

  const message = new TextEncoder().encode(timestamp + body);
  const sig = hexToBytes(signature);
  const pub = hexToBytes(env.DISCORD_PUBLIC_KEY);

  for (const algorithm of ["Ed25519", "NODE-ED25519"]) {
    try {
      const key = await crypto.subtle.importKey(
        "raw", pub, { name: algorithm, namedCurve: "Ed25519" }, false, ["verify"]
      );

      return await crypto.subtle.verify({ name: algorithm }, key, sig, message);
    } catch (err) {
      // Only an unsupported-algorithm error is worth retrying under the other name; a genuine
      // verification failure returns false above rather than throwing.
      console.warn(`Ed25519 via ${algorithm} unavailable: ${String(err)}`);
    }
  }

  console.error("no usable Ed25519 implementation; check compatibility_date");
  return false;
}

/** Melon rind green. Used as the accent throughout so the bot reads as one thing. */
const MELON_GREEN = 0x54b435;
const MELON_PINK = 0xe8536f;
const MELON_GREY = 0x6b7280;

/**
 * Point tiers, brightest at the top. Discord can only colour text inside an ```ansi code block,
 * and only from this fixed palette -- there is no per-character colour in an embed -- so the
 * standings table lives in one, trading markdown for colour.
 *
 * Ordered high to low; the first threshold a score clears wins.
 */
const POINT_TIERS = [
  { at: 1_000_000_000, ansi: "\u001b[1;31m", name: "bright red" },
  { at: 1_000_000,     ansi: "\u001b[1;32m", name: "lime green" },
  { at: 100_000,       ansi: "\u001b[1;33m", name: "yellow" },
  { at: 10_000,        ansi: "\u001b[1;37m", name: "white" },
];

const ANSI_RESET = "\u001b[0m";

/** Wraps a formatted number in its tier colour. Below 10k it is left at the default. */
function colourPoints(points, text) {
  const tier = POINT_TIERS.find((t) => points >= t.at);
  return tier ? tier.ansi + text + ANSI_RESET : text;
}

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * Minecraft usernames may contain underscores, which are markdown. Left raw, "Melon_Lord" renders
 * as italic "MelonLord" and the board quietly shows the wrong name.
 */
function escapeMd(s) {
  return String(s).replace(/([_*~`|\\])/g, "\\$1");
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

/**
 * Compact form for display: 10.1K, 2.4M, 1.3B.
 *
 * Panels are width-constrained -- a code block inside an embed wraps rather than scrolls -- and a
 * seven-digit score eats a third of the available room. One decimal keeps the magnitude readable
 * without pretending to a precision nobody needs at a glance. A trailing .0 is dropped, so a flat
 * ten thousand reads 10K rather than 10.0K.
 *
 * Exact values still appear wherever precision matters, such as balances and prices.
 */
function compact(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v);

  if (abs < 1000) return String(Math.round(v));

  // Descending, so the next larger unit is the PRECEDING entry -- searching forwards for a
  // bigger divisor jumps straight past M to B.
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  let i = units.findIndex(([d]) => abs >= d);
  let [div, suffix] = units[i];

  let scaled = Math.round((v / div) * 10) / 10;

  // Rounding can push a value past its own unit: 999,999 rounds to 1000.0K, which should read 1M.
  if (Math.abs(scaled) >= 1000 && i > 0) {
    [div, suffix] = units[--i];
    scaled = Math.round((v / div) * 10) / 10;
  }

  return (Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)) + suffix;
}

/** Proportional bar for the podium. Always shows at least one segment for a nonzero score. */
function bar(value, max, width = 14) {
  if (!max || max <= 0 || value <= 0) return "▱".repeat(width);
  const filled = Math.min(width, Math.max(1, Math.round((value / max) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/**
 * Passive melon slices, derived from observed play time rather than stored.
 *
 * Same reasoning as points: keeping the raw tick count and computing the currency at read time
 * means changing the rate re-values everyone consistently, with no migration.
 */
function slicesOf(watchedTicks, env) {
  const per = Math.max(1, numberFrom(env.TICKS_PER_SLICE, 1200));
  return Math.floor(Math.max(0, watchedTicks || 0) / per);
}

/**
 * A linked player's spendable balances, or null if this Discord account is not linked.
 *
 * Balance is deliberately NOT the leaderboard score: lifetime points rank you and never fall,
 * while this is what you may spend. Selling duplicates adds to it, buying subtracts.
 */
async function balanceOf(env, discordId) {
  const w = weights(env);

  const row = await env.DB.prepare(
    `SELECT p.uuid, p.username, p.watched_ticks, p.points_spent, p.slices_spent, p.bonus_points,
            ${pointsSql(w)} AS lifetime
       FROM links l JOIN players p ON p.uuid = l.uuid
      WHERE l.discord_id = ? AND p.banned = 0`
  ).bind(discordId).first();

  if (!row) return null;

  return {
    uuid: row.uuid,
    username: row.username,
    lifetime: row.lifetime,
    points: Math.max(0, row.lifetime + row.bonus_points - row.points_spent),
    slices: Math.max(0, slicesOf(row.watched_ticks, env) - row.slices_spent),
  };
}

/** Charges a balance. Returns false when they cannot afford it; never lets a balance go negative. */
async function spend(env, uuid, currency, amount, item, discordId) {
  const column = currency === "slices" ? "slices_spent" : "points_spent";

  // Guarded in SQL rather than in JS so two commands racing cannot both pass an affordability
  // check and overdraw -- the UPDATE only applies if the balance still covers it.
  const w = weights(env);
  const available = currency === "slices"
    ? `(${slicesSql(env)} - slices_spent)`
    : `(${pointsSql(w)} + bonus_points - points_spent)`;

  const res = await env.DB.prepare(
    `UPDATE players SET ${column} = ${column} + ?
      WHERE uuid = ? AND ${available} >= ?`
  ).bind(amount, uuid, amount).run();

  const changed = res?.meta?.changes ?? 0;
  if (!changed) return false;

  await env.DB.prepare(
    "INSERT INTO purchases (uuid, discord_id, item, cost, currency, at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(uuid, discordId ?? null, item, amount, currency, now()).run();

  return true;
}

/** SQL for a player's lifetime slices, mirroring slicesOf so the two cannot drift. */
function slicesSql(env) {
  const per = Math.max(1, Math.floor(numberFrom(env.TICKS_PER_SLICE, 1200)));
  return `(watched_ticks / ${per})`;
}

function scoringLine(w) {
  return `chop ${w.mined}  ·  place ${w.placed}  ·  plant ${w.planted}  ·  craft ${w.crafted}`;
}

/**
 * Shared style. Everything is padded BEFORE colour is applied -- escape codes are zero width on
 * screen but count in String.length, so padding a coloured string shreds the alignment.
 *
 * ASCII only, and narrow. A code block inside an embed WRAPS rather than scrolls, and an embed is
 * narrower than a normal message, so anything much past 40 columns folds and looks broken. That
 * is why the stats are two three-column tables rather than one six-column one.
 */
const HEAD = "\u001b[1;37m";
const RULE = "\u001b[0;32m";

/**
 * One self-contained block per player, rather than a wide table.
 *
 * Six stat columns cannot fit an embed's width, and splitting them across two tables reads as one
 * table cut in half and stacked underneath itself. A block per player keeps each person's numbers
 * together, stays about 32 columns wide, and grows downwards instead of sideways.
 *
 * Values share a width across every player so the columns line up down the whole panel, and each
 * is colour-tiered on the same thresholds as the score.
 */
function playerCards(players, offset) {
  const LEFT = [
    { key: "mined", label: "chop" },
    { key: "placed", label: "place" },
    { key: "crafted", label: "craft" },
  ];
  const RIGHT = [
    { key: "planted", label: "plant" },
    { key: "afk", label: "afk" },
    { key: "slices", label: "slices" },
  ];

  const labelW = Math.max(...[...LEFT, ...RIGHT].map((c) => c.label.length));
  const widthOf = (set) => Math.max(
    ...set.flatMap((c) => players.map((p) => compact(p[c.key] ?? 0).length))
  );
  const leftW = widthOf(LEFT);
  const rightW = widthOf(RIGHT);

  const cards = players.map((p, i) => {
    const heading = HEAD + String(offset + i + 1) + ". " +
      p.username.slice(0, 16) + ANSI_RESET;

    const lines = LEFT.map((l, n) => {
      const r = RIGHT[n];
      const lv = p[l.key] ?? 0;
      const rv = p[r.key] ?? 0;

      return "  " + l.label.padEnd(labelW) + " " +
        colourPoints(lv, compact(lv).padStart(leftW)) +
        "   " + r.label.padEnd(labelW) + " " +
        colourPoints(rv, compact(rv).padStart(rightW));
    });

    return heading + "\n" + lines.join("\n");
  });

  return "```ansi\n" + cards.join("\n\n") + "\n```";
}

/**
 * The board, as two panels in one message: ranking, then per-player stats.
 *
 * Six stat columns cannot fit an embed's width, so they are split across two tables rather than
 * abbreviated into illegibility or dropped.
 */
async function boardEmbeds(env, page = 1) {
  const offset = (page - 1) * BOARD_SIZE;
  const players = await topPlayers(env, BOARD_SIZE, offset);
  const w = weights(env);

  if (players.length === 0) {
    return [{
      color: MELON_GREY,
      author: { name: "MELON LEADERBOARD" },
      title: "🍉  No scores yet",
      description: page > 1
        ? "_Nothing on this page._"
        : "_Install the mod, chop a few melons, and you'll show up here._",
      footer: { text: scoringLine(w) },
    }];
  }

  // ---- panel one: the ranking -------------------------------------------
  const nameW = Math.min(16, Math.max("FARMER".length,
    ...players.map((p) => p.username.length)));
  const ptsW = Math.max("POINTS".length, ...players.map((p) => compact(p.points).length));
  const rankW = Math.max(1, String(offset + players.length).length);

  const rankHeader = HEAD + "#".padStart(rankW) + "  " + "FARMER".padEnd(nameW) +
    "  " + "POINTS".padStart(ptsW) + ANSI_RESET;
  const rankWidth = rankW + 2 + nameW + 2 + ptsW;

  const rankRows = players.map((p, i) => {
    const rank = offset + i + 1;
    const cell = String(rank).padStart(rankW);
    return (rank <= 3 ? "\u001b[1;33m" + cell + ANSI_RESET : cell) +
      "  " + p.username.slice(0, nameW).padEnd(nameW) +
      "  " + colourPoints(p.points, compact(p.points).padStart(ptsW));
  });

  // Medals and bold render only OUTSIDE a code block; colour only inside one.
  const podium = players.slice(0, 3).map((p, n) =>
    MEDALS[n] + " **" + escapeMd(p.username) + "** `" + compact(p.points) + "`"
  ).join("  ");

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS players,
            SUM(t_mined - b_mined)     AS mined,
            SUM(t_placed - b_placed)   AS placed,
            SUM(t_crafted - b_crafted) AS crafted,
            SUM(t_planted - b_planted) AS planted
       FROM players WHERE banned = 0`
  ).first();

  const harvested = (totals?.mined ?? 0) + (totals?.placed ?? 0)
    + (totals?.crafted ?? 0) + (totals?.planted ?? 0);

  const ranking = {
    color: MELON_GREEN,
    author: { name: "MELON LEADERBOARD" },
    title: page > 1 ? `🍉  Melon Farmers · page ${page}` : "🍉  Top Melon Farmers",
    description:
      (offset === 0 && podium ? podium + "\n\n" : "") +
      "```ansi\n" + rankHeader + "\n" +
      RULE + "-".repeat(rankWidth) + ANSI_RESET + "\n" +
      rankRows.join("\n") + "\n```",
    fields: [
      { name: "Scoring", value: scoringLine(w), inline: true },
      {
        name: "Community",
        value: `${fmt(totals?.players ?? 0)} farmers · ${compact(harvested)} melon actions`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  // ---- panel two: the stats ---------------------------------------------
  const stats = {
    color: MELON_PINK,
    title: "🍈  Player Stats",
    description: playerCards(players, offset),
  };

  return [ranking, stats];
}

/** Kept for callers that want a single embed, such as the empty-board case. */
async function boardEmbed(env, page = 1) {
  return (await boardEmbeds(env, page))[0];
}

async function playerEmbed(env, username) {
  if (!USERNAME_RE.test(username)) {
    return {
      color: MELON_PINK,
      title: "🍉  Not a Minecraft username",
      description: "_Names are 1–16 characters, letters, numbers and underscores._",
    };
  }

  const w = weights(env);
  const row = await env.DB.prepare(
    `SELECT username, ${pointsSql(w)} AS points, watched_ticks,
            (t_placed - b_placed) AS placed, (t_mined - b_mined) AS mined,
            (t_crafted - b_crafted) AS crafted, (t_planted - b_planted) AS planted,
            (t_afk - b_afk) AS afk, last_seen
       FROM players WHERE banned = 0 AND username = ? COLLATE NOCASE`
  ).bind(username).first();

  if (!row) {
    return {
      color: MELON_GREY,
      author: { name: "MELON STATS" },
      title: `🍉  ${escapeMd(username)}`,
      description: "_No score yet. Install the mod and start harvesting._",
    };
  }

  const rank = await rankOf(env, row.points, w);
  const best = (await topPlayers(env, 1))[0]?.points ?? row.points;
  const medal = rank <= 3 ? MEDALS[rank - 1] + "  " : "";

  // Contribution of each action to this player's own total, so the split is legible at a glance.
  const breakdown = [
    ["Chopped", row.mined, w.mined],
    ["Placed", row.placed, w.placed],
    ["Planted", row.planted, w.planted],
    ["Crafted", row.crafted, w.crafted],
  ].map(([label, count, weight]) =>
    `**${label}** \`${fmt(count)}\` → ${fmt(count * weight)} pts`
  ).concat(
    row.afk > 0
      ? [`**AutoFarmMelons** \`${fmt(row.afk)}\` → ${fmt(Math.floor(row.afk / w.afkPer))} pts  _(${fmt(w.afkPer)} per point)_`]
      : []
  ).join("\n");

  return {
    color: MELON_GREEN,
    author: { name: "MELON STATS" },
    title: `🍉  ${escapeMd(row.username)}`,
    description:
      `${medal}**Rank #${rank}**  ·  \`${fmt(row.points)} pts\`\n` +
      `\`${bar(row.points, best)}\`  ${rank === 1 ? "leading the board" : `${fmt(Math.max(0, best - row.points))} behind first`}\n\n` +
      breakdown,
    fields: [
      {
        name: "🍈 Melon slices",
        value: `\`${fmt(slicesOf(row.watched_ticks, env))}\`  _earned passively while playing_`,
        inline: false,
      },
      { name: "Last submission", value: `<t:${row.last_seen}:R>`, inline: true },
      { name: "Scoring", value: scoringLine(w), inline: true },
    ],
    footer: { text: "MelonBoard" },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------- shop

/**
 * Purely cosmetic roles, bought with points.
 *
 * Keyed by role ID rather than name so renaming a role in Discord cannot break purchases; only
 * the label shown in /shop lives here. Prices are lifetime-point balances, not rank -- buying
 * never moves anyone on the leaderboard.
 */
const SHOP_ROLES = [
  { key: "sprout",   roleId: "1545515813639819367", label: "Melon Sprout",   price: 100000 },
  { key: "farmer",   roleId: "1545515815384912005", label: "Melon Farmer",   price: 1000000 },
  { key: "baron",    roleId: "1545515819725754418", label: "Melon Baron",    price: 10000000 },
  { key: "tycoon",   roleId: "1545515822129225799", label: "Melon Tycoon",   price: 100000000 },
  { key: "overlord", roleId: "1545515823374794754", label: "Melon Overlord", price: 1000000000 },
];

/**
 * A player's own balances. Points appear twice on purpose: lifetime is what ranks you and never
 * falls, spendable is what the shop charges. Showing only one of them makes buying something look
 * like losing progress.
 */
async function walletEmbed(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const bal = await balanceOf(env, String(user.id ?? ""));

  if (!bal) {
    return ephemeral({
      color: MELON_GREY,
      author: { name: "MELON WALLET" },
      title: "🍉  Not linked",
      description: "_Run `/link`, then type the code in game to connect your accounts._",
    });
  }

  const w = weights(env);
  const rank = await rankOf(env, bal.lifetime, w);
  const owned = new Set(body.member?.roles ?? []);
  const roles = SHOP_ROLES.filter((r) => owned.has(r.roleId)).map((r) => r.label);

  return ephemeral({
    color: MELON_GREEN,
    author: { name: "MELON WALLET" },
    title: `🍉  ${escapeMd(bal.username)}`,
    description:
      "```ansi\n" +
      "Spendable points  " + colourPoints(bal.points, fmt(bal.points)) + "\n" +
      "Melon slices      " + fmt(bal.slices) + "\n" +
      "```",
    fields: [
      {
        name: "Lifetime points",
        value: `\`${fmt(bal.lifetime)}\`  ·  rank **#${rank}**\n_ranks you; never falls_`,
        inline: true,
      },
      {
        name: "Owned roles",
        value: roles.length ? roles.join("\n") : "_none yet — see `/shop`_",
        inline: true,
      },
    ],
    footer: { text: "Slices accrue while you play with the mod on" },
  });
}

async function shopEmbed(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const bal = await balanceOf(env, String(user.id ?? ""));

  const owned = new Set(body.member?.roles ?? []);

  const lines = SHOP_ROLES.map((r) => {
    const has = owned.has(r.roleId);
    const affordable = bal && bal.points >= r.price;
    const mark = has ? "✅" : affordable ? "🟢" : "🔒";
    return `${mark}  **${r.label}** — \`${fmt(r.price)}\` points  ·  \`/buy ${r.key}\``;
  }).join("\n");

  const balanceLine = bal
    ? `\`${fmt(bal.points)}\` points  ·  \`${fmt(bal.slices)}\` 🍈 slices`
    : "_Not linked. Run `/link` and enter the code in game._";

  return {
    embeds: [{
      color: MELON_GREEN,
      author: { name: "MELON SHOP" },
      title: "🍉  Cosmetic roles",
      description: lines +
        "\n\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n" +
        "**Your balance**\n" + balanceLine,
      footer: {
        text: "Spending never lowers your leaderboard score — that ranks lifetime points.",
      },
    }],
    flags: 64,
  };
}

async function buyCommand(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const discordId = String(user.id ?? "");
  const key = String(optionValue(body, "item") ?? "").toLowerCase();

  const item = SHOP_ROLES.find((r) => r.key === key);
  if (!item) {
    return ephemeral({
      color: MELON_PINK,
      title: "No such item",
      description: "_Run `/shop` to see what is for sale._",
    });
  }

  if ((body.member?.roles ?? []).includes(item.roleId)) {
    return ephemeral({
      color: MELON_GREY,
      title: "You already own that",
      description: `_You already have **${item.label}**. Nothing was charged._`,
    });
  }

  const bal = await balanceOf(env, discordId);
  if (!bal) {
    return ephemeral({
      color: MELON_PINK,
      title: "Link your account first",
      description: "_Run `/link`, then enter the code in game._",
    });
  }

  const paid = await spend(env, bal.uuid, "points", item.price, "role:" + item.key, discordId);
  if (!paid) {
    return ephemeral({
      color: MELON_PINK,
      title: "Not enough points",
      description: `_**${item.label}** costs ${fmt(item.price)} and you have ${fmt(bal.points)}._`,
    });
  }

  const granted = await grantRole(env, discordId, item.roleId);

  if (!granted) {
    // Hand the points back rather than leaving someone charged for a role they never got.
    await env.DB.prepare(
      "UPDATE players SET points_spent = MAX(0, points_spent - ?) WHERE uuid = ?"
    ).bind(item.price, bal.uuid).run();

    await env.DB.prepare(
      "INSERT INTO purchases (uuid, discord_id, item, cost, currency, at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(bal.uuid, discordId, "refund:role:" + item.key, -item.price, "points", now()).run();

    return ephemeral({
      color: MELON_PINK,
      title: "Could not grant the role",
      description: "_You have been refunded. Tell an admin the bot could not assign the role._",
    });
  }

  return ephemeral({
    color: MELON_GREEN,
    title: "🍉  " + item.label + " unlocked",
    description: `_Spent **${fmt(item.price)}** points. Balance: **${fmt(bal.points - item.price)}**._\n\n` +
      "_Your leaderboard score is unchanged — that ranks lifetime points._",
  });
}

/** Adds a role to a member. Returns false on any failure so the caller can refund. */
async function grantRole(env, discordId, roleId) {
  if (!env.DISCORD_BOT_TOKEN || !env.GUILD_ID) {
    console.error("grantRole: GUILD_ID or bot token missing");
    return false;
  }

  const res = await fetch(
    `${DISCORD_API}/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: {
        "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
        "User-Agent": DISCORD_UA,
        "Content-Length": "0",
      },
    }
  );

  if (!res.ok) console.error("grantRole failed", res.status, await res.text());
  return res.ok;
}

// ------------------------------------------------------------------- lottery

const PERM_ADMIN = 8n;
const PERM_MANAGE_GUILD = 32n;

/**
 * Whether this member may run the admin subcommands.
 *
 * Checked against the permissions Discord computes for the interaction, which already accounts for
 * the guild owner. Deliberately does NOT look for a role named "Admin": this server's Admin role
 * carries no Administrator flag, so a name check would be both wrong and trivially spoofed by
 * anyone who can create a role.
 */
function isLotteryAdmin(body) {
  try {
    const perms = BigInt(body.member?.permissions ?? "0");
    return (perms & (PERM_ADMIN | PERM_MANAGE_GUILD)) !== 0n;
  } catch {
    return false;
  }
}

function ephemeral(embed) {
  return { embeds: [embed], flags: 64 };
}

async function lotteryCommand(env, body) {
  const sub = (body.data?.options ?? [])[0];
  const kind = sub?.name;
  const user = body.member?.user ?? body.user ?? {};
  const discordId = String(user.id ?? "");

  if (kind === "create") return await lotteryCreate(env, body, sub, discordId);
  if (kind === "enter") return await lotteryEnter(env, sub, discordId);

  const open = await openLottery(env);
  if (!open) return ephemeral({ color: MELON_GREY, title: "No giveaway running" });
  return ephemeral(await giveawayEmbed(env, open));
}

function openLottery(env) {
  return env.DB.prepare(
    "SELECT * FROM lotteries WHERE status = 'open' AND ends_at > ? ORDER BY id DESC LIMIT 1"
  ).bind(now()).first();
}

async function lotteryCreate(env, body, sub, discordId) {
  if (!isLotteryAdmin(body)) {
    return ephemeral({
      color: MELON_PINK,
      title: "Not allowed",
      description: "_Only server admins can start a giveaway._",
    });
  }

  const prize = String(subOption(sub, "prize") ?? "").trim().slice(0, 200);
  const cost = Math.max(1, Math.floor(Number(subOption(sub, "cost") ?? 0)));
  const currency = subOption(sub, "currency") === "slices" ? "slices" : "points";
  const hours = Math.min(720, Math.max(1, Math.floor(Number(subOption(sub, "hours") ?? 24))));

  if (!prize) return ephemeral({ color: MELON_PINK, title: "Need a prize" });

  const endsAt = now() + hours * 3600;

  const res = await env.DB.prepare(
    "INSERT INTO lotteries (prize, entry_cost, currency, ends_at, channel_id, created_by, status)" +
    " VALUES (?, ?, ?, ?, ?, ?, 'open')"
  ).bind(prize, cost, currency, endsAt, env.GIVEAWAY_CHANNEL_ID ?? null, discordId).run();

  const id = res?.meta?.last_row_id;
  await postGiveaway(env, id);

  return ephemeral({
    color: MELON_GREEN,
    title: "\ud83c\udf9f\ufe0f  Giveaway #" + id + " started",
    description: "**" + escapeMd(prize) + "**\n" + fmt(cost) + " " + currency +
      " per entry \u00b7 ends <t:" + endsAt + ":R>",
  });
}

async function lotteryEnter(env, sub, discordId) {
  const count = Math.min(10000, Math.max(1, Math.floor(Number(subOption(sub, "entries") ?? 1))));
  return await enterLottery(env, null, count, discordId);
}

/**
 * Shared by the /lottery enter command and the buttons on the giveaway message, so the two can
 * never drift apart on affordability, weighting or bookkeeping.
 *
 * @param lotteryId the giveaway a button belongs to, or null to use whichever is currently open.
 *                  Buttons carry their own id because an old message must not enter a new draw.
 */
async function enterLottery(env, lotteryId, count, discordId) {
  const open = lotteryId
    ? await env.DB.prepare(
        "SELECT * FROM lotteries WHERE id = ? AND status = 'open' AND ends_at > ?"
      ).bind(lotteryId, now()).first()
    : await openLottery(env);

  if (!open) return ephemeral({ color: MELON_GREY, title: "That giveaway has ended" });

  const bal = await balanceOf(env, discordId);
  if (!bal) {
    return ephemeral({
      color: MELON_PINK,
      title: "Link your account first",
      description: "_Run `/link`, then enter the code in game._",
    });
  }

  const total = open.entry_cost * count;

  // spend() re-checks affordability inside the UPDATE, so two commands racing cannot both pass
  // and overdraw the balance.
  const ok = await spend(env, bal.uuid, open.currency, total, "lottery:" + open.id, discordId);
  if (!ok) {
    const have = open.currency === "slices" ? bal.slices : bal.points;
    return ephemeral({
      color: MELON_PINK,
      title: "Not enough " + open.currency,
      description: "_That costs " + fmt(total) + " and you have " + fmt(have) + "._",
    });
  }

  await env.DB.prepare(
    "INSERT INTO lottery_entries (lottery_id, discord_id, entries) VALUES (?, ?, ?)" +
    " ON CONFLICT(lottery_id, discord_id) DO UPDATE SET entries = entries + ?"
  ).bind(open.id, discordId, count, count).run();

  await postGiveaway(env, open.id);

  const mine = await env.DB.prepare(
    "SELECT entries FROM lottery_entries WHERE lottery_id = ? AND discord_id = ?"
  ).bind(open.id, discordId).first();

  return ephemeral({
    color: MELON_GREEN,
    title: "\ud83c\udf9f\ufe0f  " + fmt(count) + " entries bought",
    description: "_You now hold **" + fmt(mine?.entries ?? count) + "** entries in giveaway #" +
      open.id + "._",
  });
}

async function giveawayEmbed(env, lot) {
  const totals = await env.DB.prepare(
    "SELECT COUNT(*) AS people, COALESCE(SUM(entries), 0) AS entries" +
    " FROM lottery_entries WHERE lottery_id = ?"
  ).bind(lot.id).first();

  const closed = lot.status !== "open";

  const body = closed
    ? (lot.winner_discord_id
        ? "**Winner: <@" + lot.winner_discord_id + ">**\n\n_" + fmt(totals.entries) +
          " entries from " + fmt(totals.people) + " people._"
        : "_Nobody entered._")
    : "**" + fmt(lot.entry_cost) + " " + lot.currency + "** per entry\n\n" +
      "**" + fmt(totals.entries) + "** entries from **" + fmt(totals.people) + "** people\n" +
      "Ends <t:" + lot.ends_at + ":R>\n\n" +
      "__How to enter__\n" +
      "Press a button below, or run `/lottery enter entries:<number>`.\n" +
      "You must have run `/link` first. More entries, better odds — no limit.";

  return {
    color: closed ? MELON_GREY : MELON_GREEN,
    author: { name: closed ? "GIVEAWAY ENDED" : "MELON GIVEAWAY" },
    title: "\ud83c\udf9f\ufe0f  " + escapeMd(lot.prize),
    description: body,
    footer: { text: "Giveaway #" + lot.id + " \u00b7 more entries, better odds" },
  };
}

/** Posts the giveaway message, or edits it in place as entries come in. */
async function postGiveaway(env, id) {
  const channel = env.GIVEAWAY_CHANNEL_ID;
  if (!channel || !env.DISCORD_BOT_TOKEN || !id) return;

  const lot = await env.DB.prepare("SELECT * FROM lotteries WHERE id = ?").bind(id).first();
  if (!lot) return;

  const headers = {
    "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
    "Content-Type": "application/json",
    "User-Agent": DISCORD_UA,
  };
  // Buttons carry the giveaway id, so a button on an old message can never enter a newer draw.
  // Closed giveaways get no buttons at all rather than buttons that reject every press.
  const components = lot.status === "open"
    ? [{
        type: 1,
        components: [1, 10, 100].map((n) => ({
          type: 2,
          style: n === 1 ? 3 : 2,
          label: n === 1 ? "Enter (1)" : "Buy " + n,
          custom_id: "lottery_enter:" + lot.id + ":" + n,
        })),
      }]
    : [];

  const payload = JSON.stringify({
    embeds: [await giveawayEmbed(env, lot)],
    components,
  });

  if (lot.message_id) {
    const res = await fetch(DISCORD_API + "/channels/" + channel + "/messages/" + lot.message_id,
      { method: "PATCH", headers, body: payload });
    if (res.ok) return;
    if (res.status !== 404) {
      console.error("giveaway edit failed", res.status, await res.text());
      return;
    }
    // 404 means somebody deleted it; fall through and post a fresh one.
  }

  const created = await fetch(DISCORD_API + "/channels/" + channel + "/messages",
    { method: "POST", headers, body: payload });

  if (!created.ok) {
    console.error("giveaway post failed", created.status, await created.text());
    return;
  }

  const msg = await created.json();
  await env.DB.prepare("UPDATE lotteries SET message_id = ? WHERE id = ?").bind(msg.id, id).run();
}

/**
 * Draws any giveaway whose time is up.
 *
 * Weighted by entries, so buying more genuinely improves the odds. A single entrant simply wins;
 * there are no refunds and no void draws, by choice.
 */
async function drawExpiredLotteries(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM lotteries WHERE status = 'open' AND ends_at <= ?"
  ).bind(now()).all();

  for (const lot of results ?? []) {
    const { results: entries } = await env.DB.prepare(
      "SELECT discord_id, entries FROM lottery_entries WHERE lottery_id = ? AND entries > 0"
    ).bind(lot.id).all();

    const pool = entries ?? [];
    const total = pool.reduce((n, e) => n + e.entries, 0);

    let winner = null;
    if (total > 0) {
      // Weighted pick without materialising one slot per entry -- somebody may hold thousands.
      let roll = Math.floor(Math.random() * total);
      for (const e of pool) {
        roll -= e.entries;
        if (roll < 0) {
          winner = e.discord_id;
          break;
        }
      }
    }

    await env.DB.prepare(
      "UPDATE lotteries SET status = 'drawn', winner_discord_id = ?, drawn_at = ? WHERE id = ?"
    ).bind(winner, now(), lot.id).run();

    await postGiveaway(env, lot.id);

    if (winner && env.GIVEAWAY_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
      await fetch(DISCORD_API + "/channels/" + env.GIVEAWAY_CHANNEL_ID + "/messages", {
        method: "POST",
        headers: {
          "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
          "Content-Type": "application/json",
          "User-Agent": DISCORD_UA,
        },
        body: JSON.stringify({
          content: "\ud83c\udf89 <@" + winner + "> wins **" + lot.prize + "**! (giveaway #" +
            lot.id + ")",
        }),
      });
    }
  }
}

// ---------------------------------------------------------------------- cards

const PACK_SLICES = 120;
const PACK_POINTS = 3000;

/**
 * Opens a pack.
 *
 * Payment is taken through spend(), which re-checks affordability inside the UPDATE, so somebody
 * spamming the command cannot open two packs on one balance.
 *
 * 1-of-1 cards are claimed by an INSERT against a primary key rather than a read-then-write. Two
 * people opening simultaneously cannot both be handed the same card: the second insert fails and
 * that draw falls back to an ordinary card.
 */
async function openPack(env, body, ctx) {
  const user = body.member?.user ?? body.user ?? {};
  const discordId = String(user.id ?? "");

  const bal = await balanceOf(env, discordId);
  if (!bal) {
    return ephemeral({
      color: MELON_PINK,
      title: "Link your account first",
      description: "_Run `/link`, then type the code in game._",
    });
  }

  const currency = optionValue(body, "pay") === "points" ? "points" : "slices";
  const cost = currency === "points" ? PACK_POINTS : PACK_SLICES;

  const paid = await spend(env, bal.uuid, currency, cost, "pack", discordId);
  if (!paid) {
    const have = currency === "slices" ? bal.slices : bal.points;
    return ephemeral({
      color: MELON_PINK,
      title: `Not enough ${currency}`,
      description: `_A pack costs ${fmt(cost)} and you have ${fmt(have)}._`,
    });
  }

  // Numbered cards with copies left. Supply is per card; each claimed copy is a row.
  const supply = await limitedSupply(env);
  const { results: claimed } = await env.DB.prepare(
    "SELECT card, COUNT(*) AS taken FROM limited_claims GROUP BY card"
  ).all();

  const takenBy = new Map((claimed ?? []).map((r) => [r.card, r.taken]));
  const availableUniques = Object.entries(supply)
    .map(([key, total]) => ({ key, total, remaining: total - (takenBy.get(key) ?? 0) }))
    .filter((u) => u.remaining > 0);

  const pulled = [];
  for (let i = 0; i < CARDS_PER_PACK; i++) {
    let card = drawCard(availableUniques);

    if (card.unique) {
      // Claim a specific copy. The composite key makes this atomic: if somebody took that copy a
      // moment ago the insert changes nothing and we try the next, falling back to an ordinary
      // card only once every copy is gone.
      const entry = availableUniques.find((u) => u.key === card.key);
      const total = entry?.total ?? 1;
      let claimedCopy = 0;

      for (let copy = 1; copy <= total; copy++) {
        const ok = await env.DB.prepare(
          "INSERT OR IGNORE INTO limited_claims (card, copy_no, uuid, claimed_at) VALUES (?, ?, ?, ?)"
        ).bind(card.key, copy, bal.uuid, now()).run();

        if (ok?.meta?.changes) {
          claimedCopy = copy;
          break;
        }
      }

      if (!claimedCopy) {
        card = drawCard([]);
      } else {
        card = { ...card, copyNo: claimedCopy, ofTotal: total };
        if (entry) {
          entry.remaining -= 1;
          if (entry.remaining <= 0) {
            availableUniques.splice(availableUniques.indexOf(entry), 1);
          }
        }
      }
    }

    pulled.push(card);

    await env.DB.prepare(
      `INSERT INTO collection (uuid, card, count, first_pulled) VALUES (?, ?, 1, ?)
       ON CONFLICT(uuid, card) DO UPDATE SET count = count + 1`
    ).bind(bal.uuid, card.key, now()).run();

    await env.DB.prepare(
      "INSERT INTO pulls (uuid, card, rarity, at) VALUES (?, ?, ?, ?)"
    ).bind(bal.uuid, card.key, card.rarity, now()).run();
  }

  // Announce the good ones, in the background so the reply is not held up.
  const best = pulled.filter((c) => isNoteworthy(c.rarity));
  if (best.length) {
    ctx.waitUntil(announcePulls(env, bal.username, discordId, best));
  }

  const lines = pulled.map((c) => {
    const stamp = c.copyNo ? ` _#${c.copyNo}/${c.ofTotal}_` : "";
    return `${rarityMark(c.rarity)} **${cardName(c)}**${stamp} — _${RARITY[c.rarity].label}_`;
  });

  const headline = pulled.reduce((acc, c) =>
    rarityRank(c.rarity) > rarityRank(acc.rarity) ? c : acc, pulled[0]);

  // All six cards, four to a gallery -- so one group of four then one of two -- kept in the order
  // they were pulled so the pictures line up with the list above them. The colour of the whole
  // message is still the best card's, which is what makes a good pack readable at a glance.
  const colour = RARITY[headline.rarity].colour;
  const embeds = [];
  let last = null;

  for (let i = 0; i < pulled.length; i += GALLERY_SIZE) {
    const group = cardGallery(pulled.slice(i, i + GALLERY_SIZE), `pack-${i}`, i === 0
      ? {
        color: colour,
        author: { name: "PACK OPENED" },
        title: `🍉  ${escapeMd(bal.username)} opened a pack`,
        description: lines.join("\n"),
      }
      : { color: colour });

    last = group[0];
    embeds.push(...group);
  }

  // The receipt goes on the final group so it reads as the last line of the message.
  last.footer = { text: `-${fmt(cost)} ${currency} · /collection to see everything` };

  return { embeds };
}

function rarityRank(r) {
  return ["common", "rare", "epic", "legendary", "unique"].indexOf(r);
}

function cardName(card) {
  return card.name ?? BY_KEY.get(card.key)?.name ?? prettyKey(card.key);
}

/** Tier marker, shared by every list that names cards, so the tiers read the same everywhere. */
function rarityMark(rarity) {
  return rarity === "unique" ? "🌟"
    : rarity === "legendary" ? "✨"
    : rarity === "epic" ? "🔷"
    : rarity === "rare" ? "🟩"
    : "▫️";
}

/**
 * SHOWING SEVERAL CARD IMAGES IN ONE MESSAGE
 *
 * An embed carries exactly one image and a Worker has no canvas to composite with, so the only
 * way to show a handful of cards is Discord's own gallery: consecutive embeds that share the SAME
 * `url` are merged into a single image grid. That grid holds at most FOUR images -- which is why
 * six pulled cards arrive as two groups, and why a collection is paged four at a time rather than
 * rendered whole.
 *
 * Only the first embed of a group shows text; the rest are a url and an image and nothing else.
 * The url must be a real one and it also becomes the link on the group's title, so it points at
 * the repo, with a per-group fragment that keeps two galleries in one message from merging into
 * each other.
 */
const GALLERY_SIZE = 4;
const GALLERY_LINK = "https://github.com/FracturedZen/MelonBoard";

function cardGallery(cards, tag, lead) {
  return cards.map((card, i) => ({
    ...(i === 0 ? lead : {}),
    url: `${GALLERY_LINK}#${tag}`,
    image: { url: artUrl(card) },
  }));
}

/**
 * Print runs for numbered cards, as {cardKey: copies}. Held in meta rather than in code so cards
 * and print runs can change without a deploy.
 */
async function limitedSupply(env) {
  const raw = await getMeta(env, "limited_supply");
  if (!raw) return {};
  try {
    const map = JSON.parse(raw);
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

async function announcePulls(env, username, discordId, cards) {
  const channel = env.COMMANDS_CHANNEL_ID;
  if (!channel || !env.DISCORD_BOT_TOKEN) return;

  const role = env.PING_ROLE_ID;
  const mention = role ? `<@&${role}> ` : "";

  for (const card of cards) {
    const r = RARITY[card.rarity];
    await fetch(`${DISCORD_API}/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
        "Content-Type": "application/json",
        "User-Agent": DISCORD_UA,
      },
      body: JSON.stringify({
        content: `${mention}<@${discordId}> pulled **${cardName(card)}**!`,
        embeds: [{
          color: r.colour,
          author: { name: card.rarity === "unique" ? "ONE OF ONE" : "LEGENDARY PULL" },
          title: `${card.rarity === "unique" ? "🌟" : "✨"}  ${cardName(card)}` +
            (card.copyNo ? `  #${card.copyNo}/${card.ofTotal}` : ""),
          description: `_pulled by **${escapeMd(username)}**_`,
          image: { url: artUrl(card) },
        }],
        // Only the ping role is allowed to be pinged, so a username can never mass-mention.
        allowed_mentions: { parse: [], roles: role ? [role] : [], users: [discordId] },
      }),
    });
  }
}

async function collectionEmbed(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  return await collectionPage(env, String(user.id ?? ""), 1);
}

/** One gallery's worth of cards -- see cardGallery for why four and not more. */
const COLLECTION_PAGE = GALLERY_SIZE;

/** What ownedCards holds, as a list sorted best tier first, so paging through it is predictable. */
async function collectionList(env, uuid) {
  const owned = await ownedCards(env, uuid);

  return [...owned]
    .map(([key, count]) => {
      // Numbered cards are not in the deck, so an unknown key is one of those.
      const card = BY_KEY.get(key) ?? { key, rarity: "unique" };
      return { key, rarity: card.rarity, name: cardName(card), count };
    })
    .sort((a, b) =>
      rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name));
}

/** Renders one page of a collection as a four-card gallery with its navigation row. */
async function collectionPage(env, discordId, page) {
  const bal = await balanceOf(env, discordId);

  if (!bal) {
    return ephemeral({
      color: MELON_PINK,
      title: "Link your account first",
      description: "_Run `/link`, then type the code in game._",
    });
  }

  const cards = await collectionList(env, bal.uuid);

  if (!cards.length) {
    return ephemeral({
      color: MELON_GREY,
      author: { name: "COLLECTION" },
      title: `🍉  ${escapeMd(bal.username)}`,
      description: "_No cards yet. Try `/open`._",
    });
  }

  const pages = Math.ceil(cards.length / COLLECTION_PAGE);
  const at = Math.min(Math.max(1, page), pages);
  const shown = cards.slice((at - 1) * COLLECTION_PAGE, at * COLLECTION_PAGE);
  const held = cards.reduce((n, c) => n + c.count, 0);

  const lines = shown.map((c) => {
    const copies = c.count > 1 ? ` \u00d7${c.count}` : "";
    return `${rarityMark(c.rarity)} **${c.name}**${copies} — _${RARITY[c.rarity].label}_`;
  });

  // The page number sits in the description rather than a footer: a merged gallery puts the lead
  // embed's text above the grid, which is where a reader looks for "where am I".
  const embeds = cardGallery(shown, `collection-${at}`, {
    color: MELON_GREEN,
    author: { name: "COLLECTION" },
    title: `🍉  ${escapeMd(bal.username)}`,
    description:
      `**${cards.length}** of **${DECK.length}** distinct · **${fmt(held)}** held` +
      ` · page **${at}/${pages}**\n\n` + lines.join("\n"),
  });

  return { embeds, components: pages > 1 ? [collectionNav(discordId, at, pages)] : [], flags: 64 };
}

/**
 * The page buttons. The owner's id is baked into every custom_id so a button cannot page a
 * collection that is not its owner's -- the reply is ephemeral, so this is a second lock on an
 * already shut door, but the ids outlive the message and cost nothing to check.
 */
function collectionNav(discordId, page, pages) {
  // The slot name is part of the id because two buttons can legitimately point at the same page --
  // on page 2 of 3, "<<" and "<" both mean page 1 -- and Discord rejects a message whose
  // components share a custom_id.
  const jump = (label, slot, target, disabled) => ({
    type: 2,
    style: 2,
    label,
    custom_id: `coll:${discordId}:${target}:${slot}`,
    disabled,
  });

  return {
    type: 1,
    components: [
      jump("<<", "first", 1, page <= 1),
      jump("<", "prev", page - 1, page <= 1),
      { type: 2, style: 2, label: `${page} / ${pages}`, custom_id: "coll_page", disabled: true },
      jump(">", "next", page + 1, page >= pages),
      jump(">>", "last", pages, page >= pages),
    ],
  };
}

/** Toggles the rare-pull ping role. */
async function togglePings(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const discordId = String(user.id ?? "");
  const role = env.PING_ROLE_ID;

  if (!role || !env.GUILD_ID) {
    return ephemeral({ color: MELON_GREY, title: "Pings are not configured" });
  }

  const has = (body.member?.roles ?? []).includes(role);
  const method = has ? "DELETE" : "PUT";

  const res = await fetch(
    `${DISCORD_API}/guilds/${env.GUILD_ID}/members/${discordId}/roles/${role}`,
    {
      method,
      headers: {
        "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
        "User-Agent": DISCORD_UA,
        "Content-Length": "0",
      },
    }
  );

  if (!res.ok) {
    console.error("ping role toggle failed", res.status, await res.text());
    return ephemeral({ color: MELON_PINK, title: "Could not change that" });
  }

  return ephemeral({
    color: has ? MELON_GREY : MELON_GREEN,
    title: has ? "🔕  Pings off" : "🔔  Pings on",
    description: has
      ? "_You will no longer be pinged for legendary and 1-of-1 pulls._"
      : "_You will be pinged when anyone pulls a legendary or a 1-of-1._",
  });
}

// -------------------------------------------------------------------- combine

const HAND_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const HAND_SUITS = ["clubs", "diamonds", "hearts", "spades"];
const RANK_INDEX = new Map(HAND_RANKS.map((r, i) => [r, i]));

/**
 * The ten straights, each named by its HIGHEST card.
 *
 * Includes the wheel -- A-2-3-4-5, where the ace plays low -- which is why there are ten runs and
 * not nine. An ace-high run is a Royal Flush when suited.
 */
function straightRuns() {
  const runs = [["A", "2", "3", "4", "5"]];
  for (let i = 0; i + 4 < HAND_RANKS.length; i++) runs.push(HAND_RANKS.slice(i, i + 5));
  return runs;
}

/**
 * Every hand a collection can currently make.
 *
 * Poker rules on suits: Three of a Kind needs three DIFFERENT suits, Four of a Kind all four, and
 * a Flush five different ranks in one suit. Duplicate copies of the same card do not stack towards
 * a hand -- three copies of the King of Hearts is one King as far as combining goes.
 *
 * Overlapping hands are all listed rather than resolved automatically: five consecutive cards in
 * one suit qualify as a Straight, a Flush and a Straight Flush, and which is worth making is the
 * player's call.
 */
function availableHands(owned) {
  // Only real playing cards take part; numbered player cards have no rank or suit and are
  // collectibles only. A holo ace counts as its suit, so it cannot pair with the plain ace of the
  // same suit -- they are the same suit.
  const suitsOfRank = new Map();   // rank -> Set(suit)
  const ranksOfSuit = new Map();   // suit -> Set(rank)

  for (const [key, count] of owned) {
    if (count <= 0) continue;
    const card = BY_KEY.get(key);
    if (!card || !card.rank) continue;

    if (!suitsOfRank.has(card.rank)) suitsOfRank.set(card.rank, new Set());
    suitsOfRank.get(card.rank).add(card.suit);

    if (!ranksOfSuit.has(card.suit)) ranksOfSuit.set(card.suit, new Set());
    ranksOfSuit.get(card.suit).add(card.rank);
  }

  const suitCount = (rank) => suitsOfRank.get(rank)?.size ?? 0;
  const hands = [];

  for (const rank of HAND_RANKS) {
    if (suitCount(rank) >= 3) {
      hands.push({ key: `trips_${rank}`, label: `Three of a Kind — ${rank}s`, need: [[rank, 3]] });
    }
    if (suitCount(rank) >= 4) {
      hands.push({ key: `quads_${rank}`, label: `Four of a Kind — ${rank}s`, need: [[rank, 4]] });
    }
  }

  for (const trips of HAND_RANKS) {
    if (suitCount(trips) < 3) continue;
    for (const pair of HAND_RANKS) {
      if (pair === trips || suitCount(pair) < 2) continue;
      hands.push({
        key: `full_house_${trips}_over_${pair}`,
        label: `Full House — ${trips}s over ${pair}s`,
        need: [[trips, 3], [pair, 2]],
      });
    }
  }

  for (const run of straightRuns()) {
    if (run.every((r) => suitCount(r) >= 1)) {
      const high = run[4];
      hands.push({
        key: `straight_${high}`,
        label: `Straight — ${high} high`,
        need: run.map((r) => [r, 1]),
      });
    }
  }

  for (const suit of HAND_SUITS) {
    if ((ranksOfSuit.get(suit)?.size ?? 0) >= 5) {
      hands.push({ key: `flush_${suit}`, label: `Flush — ${suit}`, suit, need: null });
    }
  }

  for (const suit of HAND_SUITS) {
    const ranks = ranksOfSuit.get(suit);
    if (!ranks) continue;

    for (const run of straightRuns()) {
      if (!run.every((r) => ranks.has(r))) continue;

      const high = run[4];
      const royal = high === "A";
      hands.push({
        key: royal ? `royal_flush_${suit}` : `straight_flush_${high}_${suit}`,
        label: royal ? `Royal Flush — ${suit}` : `Straight Flush — ${high} high, ${suit}`,
        suited: suit,
        need: run.map((r) => [r, 1]),
      });
    }
  }

  // Best first, so the menu leads with what is worth making.
  const worth = (k) => k.startsWith("royal") ? 7 : k.startsWith("straight_flush") ? 6
    : k.startsWith("quads") ? 5 : k.startsWith("full_house") ? 4
    : k.startsWith("flush") ? 3 : k.startsWith("straight") ? 2 : 1;

  hands.sort((a, b) => worth(b.key) - worth(a.key) || a.label.localeCompare(b.label));
  return hands;
}

/**
 * Chooses which physical cards to spend.
 *
 * Each card in a hand must come from a DIFFERENT suit (for rank hands) or a different rank (for a
 * flush), so this picks one card per slot and never takes two from the same. Among equals it
 * prefers whichever the player holds most of, so a combine eats a duplicate before it eats the
 * last copy of something.
 *
 * Returns null when the holding cannot actually cover the hand.
 */
function chooseCards(owned, hand) {
  const pool = [...owned.entries()]
    .map(([key, count]) => ({ key, count, card: BY_KEY.get(key) }))
    .filter((e) => e.card && e.card.rank && e.count > 0)
    .sort((a, b) => b.count - a.count);

  const spend = {};

  /** Takes one card matching the predicate, from a suit/rank not already used for this hand. */
  const takeOne = (predicate, usedKey, used) => {
    for (const e of pool) {
      if (!predicate(e.card)) continue;

      const dimension = usedKey(e.card);
      if (used.has(dimension)) continue;

      const already = spend[e.key] ?? 0;
      if (e.count - already <= 0) continue;

      spend[e.key] = already + 1;
      used.add(dimension);
      return true;
    }
    return false;
  };

  if (hand.suited) {
    // Straight flush / royal: one card per rank, all in the named suit.
    const usedRanks = new Set();
    for (const [rank] of hand.need) {
      if (!takeOne((c) => c.rank === rank && c.suit === hand.suited, (c) => c.rank, usedRanks)) {
        return null;
      }
    }
    return spend;
  }

  if (hand.suit) {
    // Flush: five DIFFERENT ranks in one suit.
    const usedRanks = new Set();
    for (let i = 0; i < 5; i++) {
      if (!takeOne((c) => c.suit === hand.suit, (c) => c.rank, usedRanks)) return null;
    }
    return spend;
  }

  // Rank hands: each copy must be a different suit. A straight needs one card per rank, so its
  // suit constraint is tracked per rank rather than across the whole hand.
  for (const [rank, n] of hand.need) {
    const usedSuits = new Set();
    for (let i = 0; i < n; i++) {
      if (!takeOne((c) => c.rank === rank, (c) => c.suit, usedSuits)) return null;
    }
  }
  return spend;
}

async function ownedCards(env, uuid) {
  const { results } = await env.DB.prepare(
    "SELECT card, count FROM collection WHERE uuid = ? AND count > 0"
  ).bind(uuid).all();
  return new Map((results ?? []).map((r) => [r.card, r.count]));
}

async function combineMenu(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const bal = await balanceOf(env, String(user.id ?? ""));

  if (!bal) {
    return ephemeral({
      color: MELON_PINK, title: "Link your account first",
      description: "_Run `/link`, then type the code in game._",
    });
  }

  const owned = await ownedCards(env, bal.uuid);
  const hands = availableHands(owned);

  if (!hands.length) {
    return ephemeral({
      color: MELON_GREY,
      author: { name: "COMBINE" },
      title: "🃏  Nothing to combine yet",
      description: "_You need at least three of a kind. Try `/open`._",
    });
  }

  // Discord allows 25 options in a select. Sorted best-first, so the cut falls on the dullest.
  const options = hands.slice(0, 25).map((h) => ({
    label: h.label.slice(0, 100),
    value: h.key,
    description: `spends ${h.suit ? 5 : h.need.reduce((n, [, c]) => n + c, 0)} cards`,
  }));

  return ephemeral({
    color: MELON_GREEN,
    author: { name: "COMBINE" },
    title: "🃏  Make a set",
    description:
      `**${hands.length}** hand${hands.length === 1 ? "" : "s"} available.\n` +
      "_The cards are spent. Overlapping hands are all listed — pick the one you want._",
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: "combine_pick",
        placeholder: "Choose a hand to make",
        options,
      }],
    }],
  });
}

async function doCombine(env, discordId, setKey) {
  const bal = await balanceOf(env, discordId);
  if (!bal) return ephemeral({ color: MELON_PINK, title: "Link your account first" });

  const owned = await ownedCards(env, bal.uuid);
  const hand = availableHands(owned).find((h) => h.key === setKey);

  if (!hand) {
    return ephemeral({
      color: MELON_PINK,
      title: "You cannot make that any more",
      description: "_Those cards have moved since the menu was built._",
    });
  }

  const spend = chooseCards(owned, hand);
  if (!spend) {
    return ephemeral({ color: MELON_PINK, title: "You cannot make that any more" });
  }

  // Take the cards one at a time, each guarded so a count can never go negative. If any step
  // fails the earlier ones are handed straight back rather than leaving a half-eaten hand.
  const taken = [];
  for (const [key, n] of Object.entries(spend)) {
    const res = await env.DB.prepare(
      "UPDATE collection SET count = count - ? WHERE uuid = ? AND card = ? AND count >= ?"
    ).bind(n, bal.uuid, key, n).run();

    if (!(res?.meta?.changes)) {
      for (const [rk, rn] of taken) {
        await env.DB.prepare(
          "UPDATE collection SET count = count + ? WHERE uuid = ? AND card = ?"
        ).bind(rn, bal.uuid, rk).run();
      }
      return ephemeral({
        color: MELON_PINK,
        title: "Something changed mid-combine",
        description: "_Nothing was spent. Try again._",
      });
    }
    taken.push([key, n]);
  }

  const cardList = Object.entries(spend)
    .flatMap(([key, n]) => Array(n).fill(key));

  const res = await env.DB.prepare(
    "INSERT INTO sets (uuid, set_key, cards, made_at) VALUES (?, ?, ?, ?)"
  ).bind(bal.uuid, setKey, JSON.stringify(cardList), now()).run();

  const id = res?.meta?.last_row_id;

  return {
    embeds: [{
      color: MELON_GREEN,
      author: { name: "SET COMPLETE" },
      title: `🃏  ${hand.label}`,
      description:
        `**${escapeMd(bal.username)}** made set **#${id}**\n\n` +
        cardList.map((k) => "· " + (BY_KEY.get(k)?.name ?? k)).join("\n"),
      // Falls back silently to no image when the art does not exist yet.
      image: { url: setArtUrl(setKey) },
      footer: { text: `${cardList.length} cards spent · /sets to see yours` },
    }],
  };
}

async function setsEmbed(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const bal = await balanceOf(env, String(user.id ?? ""));

  if (!bal) return ephemeral({ color: MELON_PINK, title: "Link your account first" });

  const { results } = await env.DB.prepare(
    "SELECT id, set_key, made_at FROM sets WHERE uuid = ? ORDER BY id DESC LIMIT 40"
  ).bind(bal.uuid).all();

  if (!results?.length) {
    return ephemeral({
      color: MELON_GREY,
      author: { name: "SETS" },
      title: `🃏  ${escapeMd(bal.username)}`,
      description: "_No sets yet. Try `/combine`._",
    });
  }

  const lines = results.map((r) =>
    `\`#${r.id}\` **${prettySetKey(r.set_key)}** — <t:${r.made_at}:R>`
  );

  return ephemeral({
    color: MELON_GREEN,
    author: { name: "SETS" },
    title: `🃏  ${escapeMd(bal.username)}`,
    description: `**${results.length}** set${results.length === 1 ? "" : "s"}\n\n` +
      lines.join("\n").slice(0, 3800),
  });
}

/** "full_house_K_over_7" -> "Full House — Ks over 7s". */
function prettySetKey(key) {
  let m;
  if ((m = /^trips_(.+)$/.exec(key))) return `Three of a Kind — ${m[1]}s`;
  if ((m = /^quads_(.+)$/.exec(key))) return `Four of a Kind — ${m[1]}s`;
  if ((m = /^full_house_(.+)_over_(.+)$/.exec(key))) return `Full House — ${m[1]}s over ${m[2]}s`;
  if ((m = /^royal_flush_(.+)$/.exec(key))) return `Royal Flush — ${m[1]}`;
  if ((m = /^straight_flush_(.+)_(clubs|diamonds|hearts|spades)$/.exec(key))) {
    return `Straight Flush — ${m[1]} high, ${m[2]}`;
  }
  if ((m = /^straight_(.+)$/.exec(key))) return `Straight — ${m[1]} high`;
  if ((m = /^flush_(.+)$/.exec(key))) return `Flush — ${m[1]}`;
  return key.replace(/_/g, " ");
}

// ---------------------------------------------------------------------- trade

const TRADE_TTL = 10 * 60;

/**
 * Parses "3 of hearts x2, frac_1, 500 slices" into a normalised offer.
 *
 * Returns { cards: {key: n}, sets: [ids], slices: n } or an error string. Deliberately strict:
 * an unrecognised item is refused outright rather than silently dropped, because a trade that
 * quietly hands over less than it appeared to is the worst possible failure here.
 */
function parseOffer(text) {
  const offer = { cards: {}, sets: [], slices: 0 };
  if (!text || !text.trim()) return offer;

  for (const rawPart of text.split(",")) {
    const part = rawPart.trim().toLowerCase();
    if (!part) continue;

    let m = /^(\d+)\s*slices?$/.exec(part);
    if (m) {
      offer.slices += Number(m[1]);
      continue;
    }

    m = /^set\s*#?(\d+)$/.exec(part);
    if (m) {
      offer.sets.push(Number(m[1]));
      continue;
    }

    // "<card> xN" or bare "<card>"
    let count = 1;
    let name = part;
    m = /^(.*?)\s*[x*]\s*(\d+)$/.exec(part);
    if (m) {
      name = m[1].trim();
      count = Number(m[2]);
    }

    const key = resolveCardKey(name);
    if (!key) return `couldn't recognise "${rawPart.trim()}"`;
    if (count < 1 || count > 999) return `silly quantity in "${rawPart.trim()}"`;

    offer.cards[key] = (offer.cards[key] ?? 0) + count;
  }

  return offer;
}

/** Accepts a card key, or a human spelling like "3 of hearts" / "holo ace of spades". */
function resolveCardKey(input) {
  const flat = input.replace(/\s+/g, "_");
  if (BY_KEY.has(flat)) return flat;

  const uniques = input.replace(/\s+/g, "_");
  if (/^[a-z0-9_]+$/.test(uniques)) {
    // 1-of-1 keys are not in the base deck, so accept them by shape.
    if (/^(dumzy|frac|plutoren)_\d(_holo)?$/.test(uniques)) return uniques;
  }

  const holo = /\bholo\b/.test(input);
  const cleaned = input.replace(/\bholo(graphic)?\b/g, " ").trim();

  const m = /^(10|[2-9]|j|q|k|a|jack|queen|king|ace)\s*(?:of\s*)?(clubs?|diamonds?|hearts?|spades?)$/
    .exec(cleaned);
  if (!m) return null;

  const rankMap = { jack: "J", queen: "Q", king: "K", ace: "A", j: "J", q: "Q", k: "K", a: "A" };
  const rank = rankMap[m[1]] ?? m[1].toUpperCase();
  const suit = m[2].endsWith("s") ? m[2] : m[2] + "s";

  const key = `${rank}_of_${suit}` + (holo ? "_holo" : "");
  return BY_KEY.has(key) ? key : null;
}

function describeOffer(offer) {
  const bits = [];
  for (const [key, n] of Object.entries(offer.cards)) {
    const card = BY_KEY.get(key);
    bits.push(`${card ? card.name : key.replace(/_/g, " ")}${n > 1 ? ` \u00d7${n}` : ""}`);
  }
  for (const id of offer.sets) bits.push(`set #${id}`);
  if (offer.slices) bits.push(`${fmt(offer.slices)} 🍈`);
  return bits.length ? bits.join(", ") : "_nothing_";
}

/** Whether a player actually holds everything in an offer, right now. */
async function canDeliver(env, uuid, offer) {
  for (const [key, n] of Object.entries(offer.cards)) {
    const row = await env.DB.prepare(
      "SELECT count FROM collection WHERE uuid = ? AND card = ?"
    ).bind(uuid, key).first();

    if ((row?.count ?? 0) < n) {
      const card = BY_KEY.get(key);
      return `missing ${card ? card.name : key} (has ${row?.count ?? 0}, needs ${n})`;
    }
  }

  for (const id of offer.sets) {
    const row = await env.DB.prepare(
      "SELECT id FROM sets WHERE id = ? AND uuid = ?"
    ).bind(id, uuid).first();
    if (!row) return `set #${id} is not theirs`;
  }

  if (offer.slices) {
    const bal = await balanceOfUuid(env, uuid);
    if (!bal || bal.slices < offer.slices) {
      return `not enough slices (has ${fmt(bal?.slices ?? 0)}, needs ${fmt(offer.slices)})`;
    }
  }

  return null;
}

async function balanceOfUuid(env, uuid) {
  const row = await env.DB.prepare(
    "SELECT discord_id FROM links WHERE uuid = ?"
  ).bind(uuid).first();
  return row ? await balanceOf(env, row.discord_id) : null;
}

/** Moves one side's goods. Called only after both sides have been re-verified. */
async function deliver(env, fromUuid, toUuid, offer) {
  for (const [key, n] of Object.entries(offer.cards)) {
    await env.DB.prepare(
      "UPDATE collection SET count = count - ? WHERE uuid = ? AND card = ? AND count >= ?"
    ).bind(n, fromUuid, key, n).run();

    await env.DB.prepare(
      `INSERT INTO collection (uuid, card, count, first_pulled) VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid, card) DO UPDATE SET count = count + ?`
    ).bind(toUuid, key, n, now(), n).run();
  }

  for (const id of offer.sets) {
    await env.DB.prepare("UPDATE sets SET uuid = ? WHERE id = ? AND uuid = ?")
      .bind(toUuid, id, fromUuid).run();
  }

  if (offer.slices) {
    // Slices are derived from watched_ticks, so a transfer is recorded as spend on one side and
    // a matching reduction in spend on the other, keeping both balances honest without inventing
    // playtime nobody earned.
    await env.DB.prepare("UPDATE players SET slices_spent = slices_spent + ? WHERE uuid = ?")
      .bind(offer.slices, fromUuid).run();
    await env.DB.prepare("UPDATE players SET slices_spent = slices_spent - ? WHERE uuid = ?")
      .bind(offer.slices, toUuid).run();
  }
}

async function tradeCommand(env, body) {
  const user = body.member?.user ?? body.user ?? {};
  const fromDiscord = String(user.id ?? "");

  const targetId = String(optionValue(body, "player") ?? "");
  const giveText = String(optionValue(body, "give") ?? "");
  const wantText = String(optionValue(body, "want") ?? "");

  if (targetId === fromDiscord) {
    return ephemeral({ color: MELON_PINK, title: "You cannot trade with yourself" });
  }

  const from = await balanceOf(env, fromDiscord);
  const to = await balanceOf(env, targetId);

  if (!from) {
    return ephemeral({
      color: MELON_PINK, title: "Link your account first",
      description: "_Run `/link`, then type the code in game._",
    });
  }
  if (!to) {
    return ephemeral({
      color: MELON_PINK, title: "They have not linked",
      description: "_They need to run `/link` before they can trade._",
    });
  }

  const give = parseOffer(giveText);
  if (typeof give === "string") return ephemeral({ color: MELON_PINK, title: "Your side", description: `_${give}_` });
  const want = parseOffer(wantText);
  if (typeof want === "string") return ephemeral({ color: MELON_PINK, title: "Their side", description: `_${want}_` });

  const mine = await canDeliver(env, from.uuid, give);
  if (mine) return ephemeral({ color: MELON_PINK, title: "You cannot cover that", description: `_${mine}_` });

  const theirs = await canDeliver(env, to.uuid, want);
  if (theirs) return ephemeral({ color: MELON_PINK, title: "They cannot cover that", description: `_${theirs}_` });

  const expires = now() + TRADE_TTL;

  const res = await env.DB.prepare(
    `INSERT INTO trades (from_uuid, from_discord, to_uuid, to_discord, give, want,
                         status, from_ok, to_ok, created, expires, channel_id)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 1, 0, ?, ?, ?)`
  ).bind(
    from.uuid, fromDiscord, to.uuid, targetId,
    JSON.stringify(give), JSON.stringify(want),
    now(), expires, String(body.channel_id ?? "")
  ).run();

  const id = res?.meta?.last_row_id;

  return {
    content: `<@${targetId}>`,
    allowed_mentions: { parse: [], users: [targetId] },
    embeds: [{
      color: MELON_GREEN,
      author: { name: "TRADE OFFER" },
      title: `🤝  Trade #${id}`,
      description:
        `**${escapeMd(from.username)}** gives\n${describeOffer(give)}\n\n` +
        `**${escapeMd(to.username)}** gives\n${describeOffer(want)}\n\n` +
        `_Only <@${targetId}> can accept. Expires <t:${expires}:R>._`,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "Accept", custom_id: `trade_accept:${id}` },
        { type: 2, style: 4, label: "Decline", custom_id: `trade_decline:${id}` },
      ],
    }],
  };
}

/**
 * Accepts or declines. Everything is re-verified at this moment, not at proposal time -- the
 * cards may have been traded away, spent in a combine, or sold in the minutes since.
 */
async function resolveTrade(env, id, discordId, accept) {
  const trade = await env.DB.prepare("SELECT * FROM trades WHERE id = ?").bind(id).first();

  if (!trade) return ephemeral({ color: MELON_GREY, title: "That trade is gone" });
  if (trade.status !== "open") {
    return ephemeral({ color: MELON_GREY, title: `That trade was already ${trade.status}` });
  }
  if (trade.expires < now()) {
    await env.DB.prepare("UPDATE trades SET status = 'expired' WHERE id = ?").bind(id).run();
    return ephemeral({ color: MELON_GREY, title: "That trade expired" });
  }

  // Either party may decline; only the recipient may accept.
  if (!accept) {
    if (discordId !== trade.to_discord && discordId !== trade.from_discord) {
      return ephemeral({ color: MELON_PINK, title: "Not your trade" });
    }
    await env.DB.prepare("UPDATE trades SET status = 'declined' WHERE id = ?").bind(id).run();
    return { embeds: [{ color: MELON_GREY, title: `🤝  Trade #${id} declined` }] };
  }

  if (discordId !== trade.to_discord) {
    return ephemeral({
      color: MELON_PINK,
      title: "Not yours to accept",
      description: `_Only <@${trade.to_discord}> can accept this._`,
    });
  }

  const give = JSON.parse(trade.give);
  const want = JSON.parse(trade.want);

  // Claim the trade before moving anything. If two clicks land together, only one changes a row,
  // so goods cannot move twice.
  const claim = await env.DB.prepare(
    "UPDATE trades SET status = 'settling' WHERE id = ? AND status = 'open'"
  ).bind(id).run();

  if (!(claim?.meta?.changes)) {
    return ephemeral({ color: MELON_GREY, title: "That trade is already being settled" });
  }

  const failA = await canDeliver(env, trade.from_uuid, give);
  const failB = await canDeliver(env, trade.to_uuid, want);

  if (failA || failB) {
    await env.DB.prepare("UPDATE trades SET status = 'failed' WHERE id = ?").bind(id).run();
    return {
      embeds: [{
        color: MELON_PINK,
        title: `🤝  Trade #${id} fell through`,
        description: `_${failA ?? failB}. Nothing changed hands._`,
      }],
    };
  }

  await deliver(env, trade.from_uuid, trade.to_uuid, give);
  await deliver(env, trade.to_uuid, trade.from_uuid, want);

  await env.DB.prepare(
    "UPDATE trades SET status = 'done', to_ok = 1 WHERE id = ?"
  ).bind(id).run();

  return {
    embeds: [{
      color: MELON_GREEN,
      author: { name: "TRADE COMPLETE" },
      title: `🤝  Trade #${id}`,
      description:
        `<@${trade.from_discord}> gave ${describeOffer(give)}\n` +
        `<@${trade.to_discord}> gave ${describeOffer(want)}`,
      footer: { text: "Check /collection" },
    }],
    allowed_mentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------- cron

/**
 * Refresh the pinned board, but only when the standings actually changed. Discord rate limits
 * edits, and a message that visibly rewrites itself every few minutes for no reason is worse
 * than one that updates when there is news.
 */
async function refreshBoardMessage(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.BOARD_CHANNEL_ID) return;

  const embeds = await boardEmbeds(env, 1);

  // Hash the parts that carry meaning, but never the timestamp -- including it would make every
  // tick look like a change and rewrite the message every five minutes forever.
  // Hash every panel's meaningful content, but never the timestamp -- including it would make
  // each tick look like a change and rewrite the message forever.
  const hash = await sha256Hex(JSON.stringify(
    embeds.map((e) => ({ title: e.title, description: e.description, fields: e.fields }))
  ));

  const previous = await getMeta(env, "board_hash");
  if (previous === hash) return;

  const messageId = await getMeta(env, "board_message_id");
  const payload = JSON.stringify({ embeds });

  const headers = {
    "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": DISCORD_UA,
  };

  if (messageId) {
    const res = await fetch(
      `${DISCORD_API}/channels/${env.BOARD_CHANNEL_ID}/messages/${messageId}`,
      { method: "PATCH", headers, body: payload }
    );

    if (res.ok) {
      await setMeta(env, "board_hash", hash);
      return;
    }
    // 404 means somebody deleted it; fall through and post a fresh one.
    if (res.status !== 404) {
      console.error("board edit failed", res.status, await res.text());
      return;
    }
  }

  const created = await fetch(
    `${DISCORD_API}/channels/${env.BOARD_CHANNEL_ID}/messages`,
    { method: "POST", headers, body: payload }
  );

  if (!created.ok) {
    console.error("board post failed", created.status, await created.text());
    return;
  }

  const message = await created.json();
  await setMeta(env, "board_message_id", message.id);
  await setMeta(env, "board_hash", hash);

  // Best effort; a board that is not pinned still works.
  await fetch(`${DISCORD_API}/channels/${env.BOARD_CHANNEL_ID}/pins/${message.id}`,
    { method: "PUT", headers });
}

async function sweep(env) {
  const ts = now();
  await env.DB.prepare("DELETE FROM challenges WHERE expires < ?").bind(ts).run();
  await env.DB.prepare("DELETE FROM tokens WHERE expires < ?").bind(ts).run();
  await env.DB.prepare("DELETE FROM link_codes WHERE expires < ?").bind(ts).run();
}

async function getMeta(env, k) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first();
  return row?.v ?? null;
}

async function setMeta(env, k, v) {
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(k, v).run();
}

// ------------------------------------------------------------------ plumbing

function now() {
  return Math.floor(Date.now() / 1000);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Returns a non-negative integer within bounds, or null if the input is not one. */
function statOf(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_STAT) return null;
  return n;
}

function numberFrom(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = String(hex).trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function dashed(undashedUuid) {
  const u = undashedUuid;
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
}
