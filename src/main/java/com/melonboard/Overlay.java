package com.melonboard;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;

/**
 * The on-screen stats panel.
 *
 * Drawn from a mixin on {@code Hud.extractRenderState}. Note that 26.2 replaced {@code GuiGraphics}
 * with {@link GuiGraphicsExtractor}: drawing calls no longer paint immediately, they record into a
 * render state that is submitted later. For plain rectangles and text the difference does not
 * matter, but it is why none of the old {@code drawString}/{@code fill} helpers exist any more.
 *
 * Everything here comes from state the mod already holds, so drawing costs no network traffic and
 * no per-frame allocation beyond the formatted strings.
 */
public final class Overlay {

    private Overlay() {}

    private static final int PAD = 4;
    private static final int ROW = 10;

    private static final int BG = 0x90000000;
    private static final int BORDER = 0x40FFFFFF;
    private static final int TITLE = 0xFF3CB043;
    private static final int LABEL = 0xFFAAAAAA;
    private static final int VALUE = 0xFFFFFFFF;
    private static final int MUTED = 0xFF888888;

    public static void render(GuiGraphicsExtractor g) {
        MelonBoard board = MelonBoard.get();
        if (board == null || board.config == null) return;
        if (!board.config.enabled || !board.config.showOverlay) return;

        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;

        // Only on the server we actually track. Everywhere else the numbers would be stale and
        // meaningless, and a panel that lies is worse than no panel.
        if (!board.onTrackedServer(mc)) return;

        Font font = mc.font;
        MelonStats s = board.latestStats();

        String rank = board.rank() > 0 ? "#" + board.rank() : "--";
        String[][] rows;

        if (s == null) {
            rows = new String[][] {
                { board.statusNote(), "" }
            };
        } else {
            // AutoFarmMelons is read live rather than from the snapshot: it ticks up as pistons
            // fire, so showing the last submitted value would look like nothing was happening.
            rows = new String[][] {
                { "chopped", num(s.mined()) },
                { "placed", num(s.placed()) },
                { "crafted", num(s.crafted()) },
                { "planted", num(s.planted()) },
                { "AutoFarmMelons", num(board.afkMelons()) },
                { "points", board.points() >= 0 ? num(board.points()) : "--" },
                { "slices", board.slices() >= 0 ? num(board.slices()) : "--" },
            };
        }

        // Width is driven by the widest row so the values line up on the right edge.
        String title = "MelonBoard";
        int labelW = font.width(title);
        int valueW = font.width(rank);

        for (String[] r : rows) {
            labelW = Math.max(labelW, font.width(r[0]));
            valueW = Math.max(valueW, font.width(r[1]));
        }

        int gap = 12;
        int w = PAD + labelW + gap + valueW + PAD;
        int h = PAD + ROW * (rows.length + 1) + PAD;

        int x = clamp(board.config.overlayX, 0, mc.getWindow().getGuiScaledWidth() - w);
        int y = clamp(board.config.overlayY, 0, mc.getWindow().getGuiScaledHeight() - h);

        g.fill(x, y, x + w, y + h, BG);
        g.outline(x, y, w, h, BORDER);

        int ty = y + PAD;
        g.text(font, title, x + PAD, ty, TITLE);
        rightAlign(g, font, rank, x + w - PAD, ty, board.rank() > 0 ? TITLE : MUTED);

        for (String[] r : rows) {
            ty += ROW;
            g.text(font, r[0], x + PAD, ty, s == null ? MUTED : LABEL);
            rightAlign(g, font, r[1], x + w - PAD, ty, VALUE);
        }
    }

    private static void rightAlign(GuiGraphicsExtractor g, Font font, String text, int right, int y, int colour) {
        if (text == null || text.isEmpty()) return;
        g.text(font, text, right - font.width(text), y, colour);
    }

    private static String num(long v) {
        return String.format("%,d", v);
    }

    private static int clamp(int v, int lo, int hi) {
        if (hi < lo) return lo;
        return Math.max(lo, Math.min(hi, v));
    }
}
