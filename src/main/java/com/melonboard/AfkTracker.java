package com.melonboard;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Counts melons broken by pistons near the player.
 *
 * WHY THIS ONE IS DIFFERENT FROM EVERY OTHER STAT
 * -----------------------------------------------
 * Chopped, placed, crafted and planted are vanilla statistics the SERVER keeps -- we ask for them
 * and report what it says. Nobody breaks an AFK melon, so there is no such statistic, and this
 * number exists only because the client counted it. That means it cannot be corroborated, and a
 * lost config loses the running total. It is deliberately worth a fraction of a point.
 *
 * HOW A PISTON MELON IS TOLD APART FROM ANY OTHER
 * -----------------------------------------------
 * A melon becoming air is not enough on its own -- that also happens when the player mines one,
 * when someone else does, or when a chunk reloads. The discriminator is a piston: the server sends
 * a block event when one fires, so a melon only counts if a piston fired close by, very recently.
 * Melons the player mines themselves involve no piston and are therefore excluded for free, which
 * matters because those are already counted by the BLOCK_MINED statistic and would double count.
 *
 * Everything here runs on the client thread from {@code LevelChunkMixin}, on a hot path -- every
 * block change in the world passes through it. The melon check comes first and costs one reference
 * comparison, so the piston scan only happens for the handful of blocks that could possibly count.
 */
public final class AfkTracker {

    private AfkTracker() {}

    /** How many recent piston fires to remember. A busy farm fires many per second. */
    private static final int MEMORY = 128;

    /** A melon must vanish within this many ticks of a nearby piston firing. */
    private static final int WINDOW_TICKS = 12;

    /** ...and within this distance of it. A piston reaches one block; this is generous slack. */
    private static final int RADIUS = 6;
    private static final int RADIUS_SQ = RADIUS * RADIUS;

    private static final int[] px = new int[MEMORY];
    private static final int[] py = new int[MEMORY];
    private static final int[] pz = new int[MEMORY];
    private static final int[] pTick = new int[MEMORY];
    private static int cursor = 0;

    private static int tick = 1;

    /**
     * Called once per client tick so the window has a clock.
     *
     * Starts at 1 and never returns to 0, because 0 is the "empty slot" marker below.
     */
    public static void tick() {
        if (++tick <= 0) tick = 1;
    }

    /**
     * Reset between sessions so stale piston positions cannot credit a new world.
     *
     * Zero means "empty slot" rather than Integer.MIN_VALUE, which was a bug: {@code tick - MIN_VALUE}
     * overflows to a negative number, so every empty slot passed the staleness test and was then
     * distance-checked against coordinates it never held. Standing near those stale positions
     * credited melons that no piston broke.
     */
    public static void reset() {
        java.util.Arrays.fill(pTick, 0);
        java.util.Arrays.fill(px, 0);
        java.util.Arrays.fill(py, 0);
        java.util.Arrays.fill(pz, 0);
        cursor = 0;
        tick = 1;
    }

    public static void onPistonFired(BlockPos pos) {
        if (tick == 0) tick = 1;
        px[cursor] = pos.getX();
        py[cursor] = pos.getY();
        pz[cursor] = pos.getZ();
        pTick[cursor] = tick;
        cursor = (cursor + 1) % MEMORY;
    }

    /** Every client-side block change passes through here; keep the early exits cheap. */
    public static void onBlockChanged(BlockPos pos, BlockState oldState, BlockState newState) {
        if (oldState.getBlock() != Blocks.MELON) return;
        if (!newState.isAir()) return;

        MelonBoard board = MelonBoard.get();
        if (board == null || board.config == null) return;
        if (!board.config.enabled) return;

        if (!nearRecentPiston(pos)) return;

        board.onAfkMelon();
    }

    private static boolean nearRecentPiston(BlockPos pos) {
        final int x = pos.getX(), y = pos.getY(), z = pos.getZ();

        for (int i = 0; i < MEMORY; i++) {
            // 0 is an empty slot. Checking it explicitly avoids the subtraction underflowing and
            // making a slot that was never written look like a piston that fired a moment ago.
            if (pTick[i] == 0 || tick - pTick[i] > WINDOW_TICKS) continue;

            int dx = px[i] - x;
            int dy = py[i] - y;
            int dz = pz[i] - z;

            if (dx * dx + dy * dy + dz * dz <= RADIUS_SQ) return true;
        }

        return false;
    }
}
