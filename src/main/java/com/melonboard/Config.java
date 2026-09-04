package com.melonboard;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * config/melonboard.json.
 *
 * Holds settings plus the cached bearer token. Note what is NOT here: the player's score
 * baseline. That is owned by the server and recorded on the first submission from a UUID.
 * If the baseline lived in this file, deleting the file would rebaseline the player to zero
 * and hand them their entire lifetime melon history as points on the next submit.
 */
public class Config {

    private static final Logger LOG = LoggerFactory.getLogger("MelonBoard");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /**
     * The placeholder that means "nobody has pointed this build at a real deployment yet".
     * Kept separate from {@link #DEFAULT_ENDPOINT} so that setting the default below to a real
     * URL does not make the unconfigured-endpoint check start rejecting that real URL.
     */
    public static final String UNCONFIGURED_ENDPOINT = "https://melonboard.example.workers.dev";

    /**
     * The deployed leaderboard API. Players get this out of the box; no setup on their side.
     *
     * Keep this hostname free of anything personal: it ships inside every jar, so whatever is
     * here is public to everyone who downloads the mod and cannot be recalled afterwards.
     */
    public static final String DEFAULT_ENDPOINT = "https://melonboard.creationplunder.workers.dev";

    public boolean enabled = true;
    public String endpoint = DEFAULT_ENDPOINT;

    /**
     * Suffix-matched against the address you connected to, case-insensitively and with the port
     * stripped, so "simpcraft.com" also matches "mc.simpcraft.com" and "simpcraft.com:25565".
     * Tracking is off everywhere else, including singleplayer.
     */
    public String serverHost = "simpcraft.com";

    /**
     * Minutes between automatic submissions while connected.
     *
     * Each cycle asks the server for the player's whole stat map, so this is not free -- but the
     * board is only ever as fresh as the last submission, and the Worker pushes to Discord the
     * moment one lands. Three minutes keeps it feeling live without being chatty.
     */
    public static final int DEFAULT_INTERVAL_MINUTES = 3;

    public int intervalMinutes = DEFAULT_INTERVAL_MINUTES;

    /** Chat command prefix. Configurable because another mod may claim the same one. */
    public String commandPrefix = ".mb";

    /** Draw the on-screen stats panel while playing. */
    public boolean showOverlay = true;

    /** Overlay position, in GUI-scaled pixels from the top-left. */
    public int overlayX = 4;
    public int overlayY = 4;

    /**
     * Key that opens the settings window. Defaults to grave/backtick.
     *
     * Stored as a GLFW key code. Zero is not a valid key, so it doubles as "unset" for a config
     * written before this field existed -- see the guard in {@link #load()}.
     */
    public int openKey = InputConstants.KEY_GRAVE;

    /** Cached bearer token from the Mojang handshake, and its expiry (epoch seconds). */
    public String token = null;
    public long tokenExpires = 0;

    /**
     * Running count of melons broken by pistons near us.
     *
     * Unlike every other counter this one lives here rather than on the server, because no vanilla
     * statistic tracks it. Losing this file loses the count -- the API lowers the baseline to match
     * so earned points survive, but the raw total restarts.
     */
    public long afkMelons = 0;

    /** Last totals we successfully submitted, so an unchanged snapshot costs no request. */
    public long lastPlaced = -1, lastMined = -1, lastCrafted = -1, lastPlanted = -1;
    public long lastAfk = -1;

    private static Path path() {
        return FabricLoader.getInstance().getConfigDir().resolve("melonboard.json");
    }

    public static Config load() {
        Path p = path();

        if (Files.exists(p)) {
            try {
                Config c = GSON.fromJson(Files.readString(p, StandardCharsets.UTF_8), Config.class);
                if (c != null) {
                    // A config written by an older build can be missing fields entirely; Gson
                    // leaves those null/0 rather than applying the field initialisers.
                    if (c.endpoint == null || c.endpoint.isBlank()) c.endpoint = DEFAULT_ENDPOINT;
                    if (c.serverHost == null || c.serverHost.isBlank()) c.serverHost = "simpcraft.com";
                    if (c.intervalMinutes <= 0) c.intervalMinutes = DEFAULT_INTERVAL_MINUTES;
                    if (c.commandPrefix == null || c.commandPrefix.isBlank()) c.commandPrefix = ".mb";
                    if (c.openKey == 0) c.openKey = InputConstants.KEY_GRAVE;
                    return c;
                }
            } catch (Exception e) {
                LOG.warn("[MelonBoard] could not read {}, using defaults: {}", p, e.toString());
            }
        }

        Config c = new Config();
        c.save();
        return c;
    }

    // Synchronized: the disconnect and shutdown paths save from the network thread, and two
    // interleaved writes to the same file would leave a truncated config behind.
    public synchronized void save() {
        Path p = path();
        try {
            Files.createDirectories(p.getParent());
            Files.writeString(p, GSON.toJson(this), StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.warn("[MelonBoard] could not write {}: {}", p, e.toString());
        }
    }

    /** True when {@code address} is the tracked server. */
    public boolean matchesServer(String address) {
        if (address == null || serverHost == null || serverHost.isBlank()) return false;

        String host = address.toLowerCase(Locale.ROOT).trim();

        // Strip the port. IPv6 literals are bracketed, so only cut at a colon outside brackets.
        int close = host.lastIndexOf(']');
        int colon = host.lastIndexOf(':');
        if (colon > close) host = host.substring(0, colon);

        String want = serverHost.toLowerCase(Locale.ROOT).trim();
        return host.equals(want) || host.endsWith("." + want);
    }

    public boolean tokenValid() {
        return token != null && !token.isBlank()
            && tokenExpires > (System.currentTimeMillis() / 1000L) + 60;
    }

    public void clearToken() {
        token = null;
        tokenExpires = 0;
    }

    public void rememberSubmitted(MelonStats s) {
        lastPlaced = s.placed();
        lastMined = s.mined();
        lastCrafted = s.crafted();
        lastPlanted = s.planted();
        lastAfk = s.afk();
    }

    public MelonStats lastSubmitted() {
        if (lastPlaced < 0) return null;
        return new MelonStats(lastPlaced, lastMined, lastCrafted, lastPlanted, 1,
            Math.max(0, lastAfk));
    }
}
