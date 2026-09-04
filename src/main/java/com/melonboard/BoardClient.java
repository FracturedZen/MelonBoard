package com.melonboard;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.minecraft.world.entity.player.ProfileKeyPair;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.Signature;
import java.time.Duration;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * All network traffic, off the render thread.
 *
 * AUTHENTICATION
 * --------------
 * Usernames are self-reported and the endpoint is readable by anyone who opens the jar, so
 * "trust the name in the request body" lets anyone post any score as anyone. Ownership is instead
 * proven with the key pair Mojang issues for chat signing:
 *
 *   1. ask our API for a challenge  -> it invents a random one-time serverId
 *   2. sign that challenge with our profile private key
 *   3. send the signature, our public key, and Mojang's certificate of that key
 *
 * The API checks Mojang's signature over the key (which binds it to our UUID) and then our
 * signature over the challenge. It never contacts Mojang, which matters because Mojang's session
 * server refuses Cloudflare's egress IPs -- the earlier joinServer/hasJoined handshake could not
 * work from there at all.
 *
 * The access token is never used and never leaves the machine. A successful verify returns a
 * bearer token good for a day, so this runs about once per session, not once per submission.
 */
public final class BoardClient {

    private static final Logger LOG = LoggerFactory.getLogger("MelonBoard");
    private static final Gson GSON = new Gson();

    /**
     * Protocol version sent on every request.
     *
     * The API refuses anything below its own minimum with a 426. That is deliberate: when a
     * security fix changes what the client must send, old builds have to stop being accepted
     * rather than silently continuing on the weaker path. Bump this whenever the wire format or
     * the authentication handshake changes.
     */
    public static final int PROTOCOL = 3;

    public enum Outcome {
        /** Everything worked. */
        OK,
        /** The Mojang handshake failed: offline account, expired session, or Mojang down. */
        AUTH_FAILED,
        /** Our bearer token was rejected; re-run the handshake. */
        UNAUTHORIZED,
        /** The API refused the payload (rate cap, malformed, banned). Do not retry blindly. */
        REJECTED,
        /** Could not reach the API. Retry with backoff. */
        NETWORK_ERROR,
        /** This build is older than the API will talk to. Retrying will never help. */
        OUTDATED
    }

    public record AuthResult(Outcome outcome, String token, long expires, String message) {}

    public record SubmitResult(Outcome outcome, long points, int rank, String message) {}

    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();

    /** One worker, so at most one request is ever in flight and ordering is guaranteed. */
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "MelonBoard-net");
        t.setDaemon(true);
        return t;
    });

    public void shutdown() {
        worker.shutdown();
    }

    // ------------------------------------------------------------------- auth

    public void authenticate(String endpoint, UUID uuid, String username, ProfileKeyPair keys,
                             Consumer<AuthResult> done) {
        worker.execute(() -> {
            try {
                done.accept(doAuthenticate(endpoint, uuid, username, keys));
            } catch (Throwable t) {
                LOG.warn("[MelonBoard] auth threw", t);
                done.accept(new AuthResult(Outcome.NETWORK_ERROR, null, 0, t.toString()));
            }
        });
    }

    private AuthResult doAuthenticate(String endpoint, UUID uuid, String username, ProfileKeyPair keys) {
        JsonObject ask = new JsonObject();
        ask.addProperty("username", username);
        ask.addProperty("uuid", uuid.toString());

        HttpResponse<String> challengeRes;
        try {
            challengeRes = post(endpoint + "/auth/challenge", GSON.toJson(ask), null);
        } catch (Exception e) {
            return new AuthResult(Outcome.NETWORK_ERROR, null, 0, "challenge: " + e);
        }

        if (challengeRes.statusCode() == 426) {
            return new AuthResult(Outcome.OUTDATED, null, 0, describeOutdated(challengeRes.body()));
        }

        if (challengeRes.statusCode() != 200) {
            return new AuthResult(Outcome.REJECTED, null, 0,
                "challenge returned " + challengeRes.statusCode() + ": " + brief(challengeRes.body()));
        }

        String serverId;
        try {
            serverId = GSON.fromJson(challengeRes.body(), JsonObject.class).get("serverId").getAsString();
        } catch (Exception e) {
            return new AuthResult(Outcome.REJECTED, null, 0, "challenge reply unreadable: " + e);
        }

        // The step only the account holder can perform: sign the challenge with the private half
        // of the key Mojang certified. SHA256withRSA matches Crypt.SIGNING_ALGORITHM in the game.
        String signature;
        try {
            Signature signer = Signature.getInstance("SHA256withRSA");
            signer.initSign(keys.privateKey());
            signer.update(serverId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            signature = Base64.getEncoder().encodeToString(signer.sign());
        } catch (Exception e) {
            return new AuthResult(Outcome.AUTH_FAILED, null, 0, "could not sign challenge: " + e);
        }

        var data = keys.publicKey().data();

        JsonObject verify = new JsonObject();
        verify.addProperty("serverId", serverId);
        verify.addProperty("signature", signature);
        verify.addProperty("publicKey",
            Base64.getEncoder().encodeToString(data.key().getEncoded()));
        verify.addProperty("keySignature",
            Base64.getEncoder().encodeToString(data.keySignature()));
        verify.addProperty("expiresAt", data.expiresAt().toEpochMilli());

        HttpResponse<String> verifyRes;
        try {
            verifyRes = post(endpoint + "/auth/verify", GSON.toJson(verify), null);
        } catch (Exception e) {
            return new AuthResult(Outcome.NETWORK_ERROR, null, 0, "verify: " + e);
        }

        if (verifyRes.statusCode() != 200) {
            return new AuthResult(Outcome.AUTH_FAILED, null, 0,
                "verify returned " + verifyRes.statusCode() + ": " + brief(verifyRes.body()));
        }

        try {
            JsonObject body = GSON.fromJson(verifyRes.body(), JsonObject.class);
            return new AuthResult(Outcome.OK,
                body.get("token").getAsString(),
                body.get("expires").getAsLong(),
                null);
        } catch (Exception e) {
            return new AuthResult(Outcome.AUTH_FAILED, null, 0, "verify reply unreadable: " + e);
        }
    }

    // ----------------------------------------------------------------- submit

    public void submit(String endpoint, String token, MelonStats stats, Consumer<SubmitResult> done) {
        worker.execute(() -> {
            try {
                done.accept(doSubmit(endpoint, token, stats));
            } catch (Throwable t) {
                LOG.warn("[MelonBoard] submit threw", t);
                done.accept(new SubmitResult(Outcome.NETWORK_ERROR, 0, 0, t.toString()));
            }
        });
    }

    private SubmitResult doSubmit(String endpoint, String token, MelonStats stats) {
        // Absolute totals, never deltas. The API subtracts the baseline it recorded on this
        // player's first submission, so a dropped or duplicated request cannot skew a score.
        JsonObject body = new JsonObject();
        body.addProperty("placed", stats.placed());
        body.addProperty("mined", stats.mined());
        body.addProperty("crafted", stats.crafted());
        body.addProperty("planted", stats.planted());
        body.addProperty("playTime", stats.playTime());
        body.addProperty("afk", stats.afk());

        HttpResponse<String> res;
        try {
            res = post(endpoint + "/submit", GSON.toJson(body), token);
        } catch (Exception e) {
            return new SubmitResult(Outcome.NETWORK_ERROR, 0, 0, e.toString());
        }

        if (res.statusCode() == 426) {
            return new SubmitResult(Outcome.OUTDATED, 0, 0, describeOutdated(res.body()));
        }
        if (res.statusCode() == 401 || res.statusCode() == 403) {
            return new SubmitResult(Outcome.UNAUTHORIZED, 0, 0, brief(res.body()));
        }
        if (res.statusCode() != 200) {
            return new SubmitResult(Outcome.REJECTED, 0, 0,
                res.statusCode() + ": " + brief(res.body()));
        }

        try {
            JsonObject j = GSON.fromJson(res.body(), JsonObject.class);
            long points = j.has("points") ? j.get("points").getAsLong() : 0;
            int rank = j.has("rank") ? j.get("rank").getAsInt() : 0;
            return new SubmitResult(Outcome.OK, points, rank, null);
        } catch (Exception e) {
            return new SubmitResult(Outcome.REJECTED, 0, 0, "reply unreadable: " + e);
        }
    }

    // --------------------------------------------------------------------- me

    /**
     * Reads our current points and rank without submitting anything. Lets the panel show real
     * numbers the moment we log in, rather than dashes until the first submission lands.
     */
    public void me(String endpoint, String token, Consumer<SubmitResult> done) {
        worker.execute(() -> {
            try {
                done.accept(doMe(endpoint, token));
            } catch (Throwable t) {
                done.accept(new SubmitResult(Outcome.NETWORK_ERROR, 0, 0, t.toString()));
            }
        });
    }

    private SubmitResult doMe(String endpoint, String token) {
        HttpResponse<String> res;
        try {
            res = get(endpoint + "/me", token);
        } catch (Exception e) {
            return new SubmitResult(Outcome.NETWORK_ERROR, 0, 0, e.toString());
        }

        if (res.statusCode() == 401 || res.statusCode() == 403) {
            return new SubmitResult(Outcome.UNAUTHORIZED, 0, 0, brief(res.body()));
        }
        if (res.statusCode() != 200) {
            return new SubmitResult(Outcome.REJECTED, 0, 0, res.statusCode() + ": " + brief(res.body()));
        }

        try {
            JsonObject j = GSON.fromJson(res.body(), JsonObject.class);
            return new SubmitResult(Outcome.OK,
                j.has("points") ? j.get("points").getAsLong() : 0,
                j.has("rank") ? j.get("rank").getAsInt() : 0,
                null);
        } catch (Exception e) {
            return new SubmitResult(Outcome.REJECTED, 0, 0, "reply unreadable: " + e);
        }
    }

    // -------------------------------------------------------------- linking

    /** Result of claiming a /link code. {@code message} carries the reason on failure. */
    public record LinkResult(Outcome outcome, String discordName, String message) {}

    public void link(String endpoint, String token, String code, Consumer<LinkResult> done) {
        worker.execute(() -> {
            try {
                done.accept(doLink(endpoint, token, code));
            } catch (Throwable t) {
                done.accept(new LinkResult(Outcome.NETWORK_ERROR, null, t.toString()));
            }
        });
    }

    private LinkResult doLink(String endpoint, String token, String code) {
        JsonObject body = new JsonObject();
        body.addProperty("code", code);

        HttpResponse<String> res;
        try {
            res = post(endpoint + "/link/claim", GSON.toJson(body), token);
        } catch (Exception e) {
            return new LinkResult(Outcome.NETWORK_ERROR, null, e.toString());
        }

        if (res.statusCode() == 401 || res.statusCode() == 403) {
            return new LinkResult(Outcome.UNAUTHORIZED, null, "not verified yet");
        }

        String message = null;
        try {
            JsonObject j = GSON.fromJson(res.body(), JsonObject.class);
            if (j != null && j.has("error")) message = j.get("error").getAsString();

            if (res.statusCode() == 200) {
                String who = j != null && j.has("discordName") && !j.get("discordName").isJsonNull()
                    ? j.get("discordName").getAsString()
                    : null;
                return new LinkResult(Outcome.OK, who, null);
            }
        } catch (Exception ignored) {
            // fall through to the generic message below
        }

        return new LinkResult(Outcome.REJECTED, null,
            message != null ? message : "link failed (" + res.statusCode() + ")");
    }

    // --------------------------------------------------------------- plumbing

    private HttpResponse<String> post(String url, String json, String bearer) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .header("User-Agent", "MelonBoard/1.0")
            .header("X-MelonBoard-Protocol", Integer.toString(PROTOCOL))
            .POST(HttpRequest.BodyPublishers.ofString(json));

        if (bearer != null) b.header("Authorization", "Bearer " + bearer);

        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(String url, String bearer) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(15))
            .header("User-Agent", "MelonBoard/1.0")
            .header("X-MelonBoard-Protocol", Integer.toString(PROTOCOL))
            .GET();

        if (bearer != null) b.header("Authorization", "Bearer " + bearer);

        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** Pulls the required version out of a 426 so the player is told what to do, not just "no". */
    private static String describeOutdated(String body) {
        try {
            JsonObject j = GSON.fromJson(body, JsonObject.class);
            if (j != null && j.has("required")) {
                return "this build speaks protocol " + PROTOCOL + ", the leaderboard needs "
                    + j.get("required").getAsInt() + " or newer";
            }
        } catch (Exception ignored) {
            // fall through
        }
        return "this build is too old for the leaderboard";
    }

    private static String brief(String s) {
        if (s == null) return "";
        s = s.strip();
        return s.length() > 200 ? s.substring(0, 200) + "..." : s;
    }
}
