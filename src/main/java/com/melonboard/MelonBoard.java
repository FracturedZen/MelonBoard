package com.melonboard;

import net.fabricmc.api.ClientModInitializer;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ServerboundClientCommandPacket;
import net.minecraft.world.entity.player.ProfileKeyPair;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * MelonBoard: report this player's melon statistics to the community leaderboard.
 *
 * WHAT MAKES THIS SIMPLE
 * ----------------------
 * We submit ABSOLUTE TOTALS read from the server's own statistics, not deltas we counted
 * ourselves. Three awkward problems disappear as a result:
 *
 *   - Nothing is ever lost. A crash, a kick, a closed laptop -- the counts live on the server,
 *     so the next successful submission is simply correct again. There is no local spool to
 *     protect and no "unsent points" to reconcile.
 *   - Nothing is ever double counted. Re-sending the same totals is a no-op by construction,
 *     so a retry after a timeout is always safe.
 *   - There is no prediction to get wrong. We never guess whether the server accepted a block
 *     placement; we read what the server recorded.
 *
 * The scoring baseline (what the player had when they first submitted) is held by the API, not
 * here. See {@link Config} for why that matters.
 *
 * THE CYCLE
 * ---------
 * On the tracked server: authenticate once per session, then every {@code intervalMinutes} ask
 * the server for statistics ({@code REQUEST_STATS}), wait a moment for the reply to land in the
 * player's {@code StatsCounter}, and submit if the numbers moved. Also submits on disconnect,
 * on being switched off, and on game close.
 */
public class MelonBoard implements ClientModInitializer {

    public static final Logger LOG = LoggerFactory.getLogger("MelonBoard");

    private static MelonBoard instance;

    public static MelonBoard get() {
        return instance;
    }

    /** Ticks to wait after REQUEST_STATS before trusting the counter. 2s is generous. */
    private static final int SETTLE_TICKS = 40;

    /** Ticks after joining before the first request, so login traffic settles first. */
    private static final int JOIN_GRACE_TICKS = 100;

    private enum Phase {
        /** Not on the tracked server, or switched off. */
        IDLE,
        /** Need a bearer token. */
        NEED_AUTH,
        /** Handshake in flight. */
        AUTHING,
        /** Authenticated and waiting for the next scheduled request. */
        READY,
        /** REQUEST_STATS sent; waiting {@link #SETTLE_TICKS} for the reply. */
        REQUESTED,
        /** Submission in flight. */
        SUBMITTING,
        /** Something is wrong that retrying quickly will not fix. */
        HALTED
    }

    public Config config;
    private BoardClient client;

    private Phase phase = Phase.IDLE;
    private boolean wasConnected = false;

    private int tickCounter = 0;
    private int phaseSetAt = 0;
    private int nextRequestAt = 0;

    /** Backoff for transient failures, in ticks. Doubles to a cap, resets on success. */
    private int backoffTicks = 0;
    private static final int BACKOFF_MIN = 20 * 20;      // 20s
    private static final int BACKOFF_MAX = 20 * 60 * 10; // 10 min

    /** Most recent snapshot read from the server, submitted or not. */
    private volatile MelonStats latest = null;

    /** Set true when the player asks for an immediate submission. */
    private boolean forced = false;

    /** Last standing the API told us. -1 / 0 mean "not known yet", not "zero". */
    private volatile long points = -1;
    private volatile int rank = 0;
    /** Melon slices, as last reported. -1 means not known yet. */
    private volatile long slices = -1;

    /** Edge detection for the settings-window key. */
    private boolean openKeyWasDown = false;

    /** One-shot notices, so a persistent condition does not spam chat every cycle. */
    private boolean warnedNoStats = false;
    private boolean warnedAuthFailed = false;
    private boolean warnedEndpoint = false;
    private boolean warnedOutdated = false;
    private boolean warnedNoKey = false;

    /** Mojang-certified signing key, fetched once per session. */
    private volatile ProfileKeyPair profileKeys = null;
    private boolean fetchingKeys = false;
    private boolean announcedThisSession = false;

    @Override
    public void onInitializeClient() {
        instance = this;
        config = Config.load();
        client = new BoardClient();

        Runtime.getRuntime().addShutdownHook(new Thread(this::flushOnExit, "MelonBoard-shutdown"));

        LOG.info("[MelonBoard] loaded; tracking '{}' -> {}", config.serverHost, config.endpoint);
    }

    // ------------------------------------------------------------------- tick

    /** Called at the end of every client tick by {@code MinecraftMixin}. */
    public void clientTick(Minecraft mc) {
        tickCounter++;

        AfkTracker.tick();
        pollOpenKey(mc);

        boolean connected = mc.getConnection() != null
            && mc.player != null
            && onTrackedServer(mc);

        if (connected != wasConnected) {
            if (connected) onJoin();
            else onLeave();
            wasConnected = connected;
        }

        if (!connected || !config.enabled) return;

        switch (phase) {
            case IDLE, NEED_AUTH -> tickAuth(mc);
            case READY -> tickReady(mc);
            case REQUESTED -> tickRequested(mc);
            case HALTED -> tickHalted();
            case AUTHING, SUBMITTING -> {
                // Waiting on the network worker; its callback moves us on.
            }
        }
    }

    /**
     * Opens the settings window on a rising edge of the configured key.
     *
     * Polling rather than hooking the keyboard handler keeps this to a few lines.
     *
     * 26.2 removed {@code Minecraft.screen}, so "is a menu open" is read from the mouse instead:
     * the cursor is grabbed during play and released whenever any screen is showing. That is the
     * distinction we actually want, and it keeps the key from being stolen out of chat, a sign or
     * an anvil. It also self-clears the edge -- opening the panel releases the mouse, so the key
     * reads as up on the next tick.
     */
    private void pollOpenKey(Minecraft mc) {
        boolean inGame = mc.mouseHandler != null && mc.mouseHandler.isMouseGrabbed();

        boolean down = inGame
            && mc.getWindow() != null
            && InputConstants.isKeyDown(mc.getWindow(), config.openKey);

        if (down && !openKeyWasDown) {
            mc.setScreenAndShow(new MelonBoardScreen(this));
        }
        openKeyWasDown = down;
    }

    private void tickAuth(Minecraft mc) {
        if (backoffTicks > 0 && tickCounter - phaseSetAt < backoffTicks) return;

        if (config.tokenValid()) {
            setPhase(Phase.READY);
            nextRequestAt = tickCounter + JOIN_GRACE_TICKS;
            return;
        }

        if (mc.getUser() == null) {
            halt("no session -- cannot verify this account");
            return;
        }

        // Without this the mod would retry a placeholder URL forever and say nothing, which looks
        // exactly like "the leaderboard is broken" to someone who just installed it.
        if (config.endpoint == null || config.endpoint.isBlank()
            || config.endpoint.equals(Config.UNCONFIGURED_ENDPOINT)) {
            if (!warnedEndpoint) {
                warnedEndpoint = true;
                say(ChatFormatting.RED, "no leaderboard server is configured. Set one with: "
                    + config.commandPrefix + " endpoint <url>");
            }
            halt("endpoint not configured");
            return;
        }

        // Ownership is proven by signing with the profile key, so fetch it before authenticating.
        // It arrives asynchronously (it may need refreshing with Mojang), and a player with chat
        // signing switched off has none at all -- which is a dead end, not a retry.
        if (profileKeys == null) {
            if (!fetchingKeys) {
                fetchingKeys = true;
                mc.getProfileKeyPairManager().prepareKeyPair().thenAccept(opt -> mc.execute(() -> {
                    fetchingKeys = false;
                    opt.ifPresent(k -> profileKeys = k);

                    if (profileKeys == null) {
                        if (!warnedNoKey) {
                            warnedNoKey = true;
                            say(ChatFormatting.RED, "no Mojang signing key available, so scores "
                                + "cannot be verified. Chat signing must be enabled to take part.");
                        }
                        halt("no profile key");
                    }
                }));
            }
            return;
        }

        UUID uuid = mc.getUser().getProfileId();
        String name = mc.getUser().getName();

        setPhase(Phase.AUTHING);

        // The callback fires on the network worker. Hop back to the client thread before touching
        // any of the state the tick loop reads, so the state machine has a single writer.
        client.authenticate(config.endpoint, uuid, name, profileKeys, res -> mc.execute(() -> {
            switch (res.outcome()) {
                case OK -> {
                    config.token = res.token();
                    config.tokenExpires = res.expires();
                    config.save();
                    backoffTicks = 0;
                    warnedAuthFailed = false;
                    setPhase(Phase.READY);
                    nextRequestAt = tickCounter + JOIN_GRACE_TICKS;
                    refreshStanding();
                    LOG.info("[MelonBoard] verified with Mojang; leaderboard reporting is active");
                }
                case OUTDATED -> {
                    if (!warnedOutdated) {
                        warnedOutdated = true;
                        say(ChatFormatting.RED, "MelonBoard is out of date and cannot submit scores: "
                            + res.message() + ". Download the latest version.");
                    }
                    halt("client too old");
                }
                case AUTH_FAILED -> {
                    if (!warnedAuthFailed) {
                        warnedAuthFailed = true;
                        say(ChatFormatting.RED, "could not verify your Minecraft account: "
                            + res.message());
                    }
                    // The key may simply have expired; drop it so the next attempt fetches a fresh
                    // one rather than re-signing with something Mojang no longer certifies.
                    profileKeys = null;
                    halt("signature verification failed");
                }
                default -> {
                    LOG.warn("[MelonBoard] auth failed ({}): {}", res.outcome(), res.message());
                    bumpBackoff();
                    setPhase(Phase.NEED_AUTH);
                }
            }
        }));
    }

    /**
     * Asks the API for our current points and rank without submitting anything, so the panel has
     * real numbers immediately on login instead of dashes until the first submission.
     */
    private void refreshStanding() {
        if (!config.tokenValid()) return;

        client.me(config.endpoint, config.token, res -> {
            if (res.outcome() == BoardClient.Outcome.OK) {
                points = res.points();
                rank = res.rank();
                if (res.slices() >= 0) slices = res.slices();
            }
        });
    }

    private void tickReady(Minecraft mc) {
        if (!forced && tickCounter < nextRequestAt) return;

        if (mc.getConnection() == null) return;

        mc.getConnection().send(new ServerboundClientCommandPacket(
            ServerboundClientCommandPacket.Action.REQUEST_STATS));

        setPhase(Phase.REQUESTED);
    }

    private void tickRequested(Minecraft mc) {
        if (tickCounter - phaseSetAt < SETTLE_TICKS) return;
        if (mc.player == null) return;

        MelonStats now = MelonStats.read(mc.player, config.afkMelons);
        latest = now;

        boolean wasForced = forced;
        forced = false;

        if (!now.isLive()) {
            // play_time of zero after a settled request means the server did not answer with a
            // populated stat map. Reporting that as "you have zero melons" would be a lie, and
            // submitting it would set a bogus baseline for a first-time player.
            if (!warnedNoStats) {
                warnedNoStats = true;
                say(ChatFormatting.RED, "this server is not serving statistics, so scores cannot "
                    + "be tracked here. Nothing has been submitted.");
            }
            halt("server returned an empty stat map");
            return;
        }
        warnedNoStats = false;

        if (!wasForced && now.sameCountsAs(config.lastSubmitted())) {
            // Nothing moved: skip the request entirely rather than spend it re-sending totals.
            scheduleNext();
            setPhase(Phase.READY);
            return;
        }

        setPhase(Phase.SUBMITTING);
        boolean announce = wasForced || !announcedThisSession;

        // As above: mutate the state machine only from the client thread.
        client.submit(config.endpoint, config.token, now, res -> mc.execute(() -> {
            switch (res.outcome()) {
                case OK -> {
                    config.rememberSubmitted(now);
                    config.save();
                    points = res.points();
                    rank = res.rank();
                    if (res.slices() >= 0) slices = res.slices();
                    backoffTicks = 0;
                    if (announce) {
                        announcedThisSession = true;
                        say(ChatFormatting.GREEN, "submitted -- " + res.points() + " points"
                            + (res.rank() > 0 ? ", rank #" + res.rank() : ""));
                    }
                    scheduleNext();
                    setPhase(Phase.READY);
                }
                case UNAUTHORIZED -> {
                    LOG.info("[MelonBoard] token rejected, re-verifying");
                    config.clearToken();
                    config.save();
                    setPhase(Phase.NEED_AUTH);
                }
                case OUTDATED -> {
                    if (!warnedOutdated) {
                        warnedOutdated = true;
                        say(ChatFormatting.RED, "MelonBoard is out of date and cannot submit scores: "
                            + res.message() + ". Download the latest version.");
                    }
                    halt("client too old");
                }
                case REJECTED -> {
                    LOG.warn("[MelonBoard] submission rejected: {}", res.message());
                    if (wasForced) say(ChatFormatting.RED, "submission rejected: " + res.message());
                    bumpBackoff();
                    scheduleNext();
                    setPhase(Phase.READY);
                }
                default -> {
                    LOG.warn("[MelonBoard] submission failed: {}", res.message());
                    bumpBackoff();
                    nextRequestAt = tickCounter + backoffTicks;
                    setPhase(Phase.READY);
                }
            }
        }));
    }

    private void tickHalted() {
        // Halted conditions are rechecked rarely; a server that has statistics switched off is
        // not going to switch them on mid-session, but a Mojang outage will pass.
        if (tickCounter - phaseSetAt > BACKOFF_MAX) setPhase(Phase.NEED_AUTH);
    }

    // ----------------------------------------------------------- transitions

    private void onJoin() {
        AfkTracker.reset();
        warnedNoKey = false;
        announcedThisSession = false;
        warnedNoStats = false;
        warnedEndpoint = false;
        backoffTicks = 0;
        latest = null;
        setPhase(Phase.NEED_AUTH);
        LOG.info("[MelonBoard] joined tracked server");
    }

    private void onLeave() {
        // Best effort. Nothing depends on it: totals live on the server, so whatever we miss here
        // is simply picked up by the first submission of the next session.
        submitLatestIfChanged("disconnect");
        setPhase(Phase.IDLE);
    }

    private void flushOnExit() {
        if (config == null || !config.enabled || latest == null) return;
        if (latest.sameCountsAs(config.lastSubmitted())) return;
        if (!config.tokenValid()) return;

        CountDownLatch latch = new CountDownLatch(1);
        client.submit(config.endpoint, config.token, latest, res -> {
            if (res.outcome() == BoardClient.Outcome.OK) {
                config.rememberSubmitted(latest);
                config.save();
            }
            latch.countDown();
        });

        try {
            // Bounded: never hold up the game closing for a leaderboard update.
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void submitLatestIfChanged(String why) {
        MelonStats snapshot = latest;
        if (snapshot == null || !config.enabled || !config.tokenValid()) return;
        if (snapshot.sameCountsAs(config.lastSubmitted())) return;

        client.submit(config.endpoint, config.token, snapshot, res -> {
            if (res.outcome() == BoardClient.Outcome.OK) {
                config.rememberSubmitted(snapshot);
                config.save();
                LOG.info("[MelonBoard] flushed on {} -- {} points", why, res.points());
            } else {
                LOG.info("[MelonBoard] flush on {} failed ({}); the next session will catch up",
                    why, res.outcome());
            }
        });
    }

    // -------------------------------------------------------------- commands

    /** Switch tracking on or off, flushing on the way out. */
    public void setEnabled(boolean on) {
        if (config.enabled == on) return;

        if (!on) submitLatestIfChanged("switched off");

        config.enabled = on;
        config.save();

        if (on) {
            setPhase(Phase.NEED_AUTH);
            backoffTicks = 0;
        } else {
            setPhase(Phase.IDLE);
        }
    }

    /**
     * A melon was broken by a piston nearby.
     *
     * Deliberately does NOT save the config: at a working farm this fires many times a second, and
     * writing the file each time would be a steady stream of disk I/O for no benefit. The total is
     * persisted on the normal save points -- every submission, on disconnect, and on exit -- so the
     * worst case is losing one interval's worth after a crash.
     */
    public void onAfkMelon() {
        config.afkMelons++;
    }

    public long afkMelons() {
        return config == null ? 0 : config.afkMelons;
    }

    /**
     * Claims a /link code typed in the settings window.
     *
     * Requires a bearer token, which is what proves the game side of the pairing -- so this can
     * only run once the session has verified. Feedback goes to chat rather than the window,
     * because the answer arrives after a network round trip and the player may have closed it.
     */
    public void claimLinkCode(String code) {
        if (!config.tokenValid()) {
            say(ChatFormatting.RED, "not verified with the leaderboard yet -- try again in a moment");
            return;
        }

        client.link(config.endpoint, config.token, code, res -> Minecraft.getInstance().execute(() -> {
            switch (res.outcome()) {
                case OK -> say(ChatFormatting.GREEN, res.discordName() != null
                    ? "linked to Discord as " + res.discordName()
                    : "linked to Discord");
                case UNAUTHORIZED -> {
                    config.clearToken();
                    config.save();
                    say(ChatFormatting.RED, "session expired -- rejoin and try again");
                }
                default -> say(ChatFormatting.RED, "link failed: " + res.message());
            }
        }));
    }

    /** Force a stats request and submission on the next tick. */
    public void submitNow() {
        forced = true;
        if (phase == Phase.HALTED || phase == Phase.IDLE) setPhase(Phase.NEED_AUTH);
        if (phase == Phase.READY) nextRequestAt = 0;
        backoffTicks = 0;
    }

    public MelonStats latestStats() {
        return latest;
    }

    public long points() {
        return points;
    }

    public int rank() {
        return rank;
    }

    public long slices() {
        return slices;
    }

    /** One short line explaining why there are no numbers yet. */
    public String statusNote() {
        if (!config.enabled) return "tracking off";

        return switch (phase) {
            case IDLE -> "not connected";
            case NEED_AUTH, AUTHING -> "verifying...";
            case HALTED -> "unavailable here";
            default -> "reading stats...";
        };
    }

    public String statusLine() {
        MelonStats s = latest;
        String counts = s == null
            ? "no snapshot yet"
            : s.placed() + " placed, " + s.mined() + " chopped, "
              + s.crafted() + " crafted, " + s.planted() + " planted, "
              + config.afkMelons + " AutoFarmMelons";

        return (config.enabled ? "on" : "off")
            + " | " + phase.name().toLowerCase()
            + " | server " + config.serverHost
            + " | every " + config.intervalMinutes + " min"
            + " | " + counts;
    }

    // -------------------------------------------------------------- plumbing

    public boolean onTrackedServer(Minecraft mc) {
        if (mc.hasSingleplayerServer()) return false;

        ServerData data = mc.getCurrentServer();
        return data != null && config.matchesServer(data.ip);
    }

    private void setPhase(Phase p) {
        phase = p;
        phaseSetAt = tickCounter;
    }

    private void scheduleNext() {
        nextRequestAt = tickCounter + Math.max(1, config.intervalMinutes) * 60 * 20;
    }

    private void bumpBackoff() {
        backoffTicks = backoffTicks == 0 ? BACKOFF_MIN : Math.min(backoffTicks * 2, BACKOFF_MAX);
    }

    private void halt(String why) {
        LOG.warn("[MelonBoard] halted: {}", why);
        setPhase(Phase.HALTED);
    }

    public void say(ChatFormatting colour, String text) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            if (mc.player == null) return;
            mc.player.sendSystemMessage(
                Component.literal("[MelonBoard] ").withStyle(ChatFormatting.YELLOW)
                    .append(Component.literal(text).withStyle(colour)));
        });
    }
}
