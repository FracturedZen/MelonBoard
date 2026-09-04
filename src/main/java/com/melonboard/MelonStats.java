package com.melonboard;

import net.minecraft.client.player.LocalPlayer;
import net.minecraft.stats.Stats;
import net.minecraft.stats.StatsCounter;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;

/**
 * A snapshot of the four melon statistics the SERVER keeps for this player.
 *
 * WHY STATISTICS AND NOT PACKET SNIFFING
 * --------------------------------------
 * Every action we want to score is already counted by vanilla, server-side, in the same
 * statistics the in-game Statistics screen shows:
 *
 *   place a melon block   -> ITEM_USED    minecraft:melon
 *   chop a melon          -> BLOCK_MINED  minecraft:melon
 *   craft a melon block   -> ITEM_CRAFTED minecraft:melon
 *   plant a melon seed    -> ITEM_USED    minecraft:melon_seeds
 *
 * Note {@code Items.MELON} is the melon BLOCK's item form; {@code Items.MELON_SLICE} is the food.
 * Eating a slice therefore cannot be mistaken for placing a melon -- they are different stats.
 *
 * Reading these instead of watching packets removes the entire class of problems that comes with
 * client-side prediction: no pending map, no rollback handling, no missed events when the server
 * silently rejects a placement, and no double counting. It is also exact rather than inferred,
 * and it survives relogs, crashes and reinstalls, because the count lives on the server.
 *
 * The client only ever receives these; it never sets them.
 */
public record MelonStats(long placed, long mined, long crafted, long planted, long playTime,
                         long afk) {

    public static final MelonStats ZERO = new MelonStats(0, 0, 0, 0, 0, 0);

    /**
     * Reads the player's current stat counter. Requires that a {@code REQUEST_STATS} has been
     * sent and its reply processed -- see {@link MelonBoard} for the request/settle cycle.
     */
    /**
     * @param afk piston-broken melons counted by the client. Passed in rather than read here,
     *            because unlike the other four it is not a statistic the server keeps.
     */
    public static MelonStats read(LocalPlayer player, long afk) {
        StatsCounter s = player.getStats();

        return new MelonStats(
            s.getValue(Stats.ITEM_USED, Items.MELON),
            s.getValue(Stats.BLOCK_MINED, Blocks.MELON),
            s.getValue(Stats.ITEM_CRAFTED, Items.MELON),
            s.getValue(Stats.ITEM_USED, Items.MELON_SEEDS),
            // Liveness probe. Any player who has spent a single tick on the server has a nonzero
            // play time, so play_time == 0 after a settled stats request means the server is not
            // serving statistics at all -- which is very different from "you have zero melons",
            // and the two must not be reported the same way.
            s.getValue(Stats.CUSTOM, Stats.PLAY_TIME),
            afk
        );
    }

    /** True when the server answered with a populated stat map. */
    public boolean isLive() {
        return playTime > 0;
    }

    /** Totals only ever grow, so an unchanged snapshot is not worth a request. */
    public boolean sameCountsAs(MelonStats other) {
        return other != null
            && placed == other.placed
            && mined == other.mined
            && crafted == other.crafted
            && planted == other.planted
            && afk == other.afk;
    }

    public long total() {
        return placed + mined + crafted + planted;
    }

    /** AFK melons are excluded above on purpose: they are worth a fraction and would swamp it. */
}
