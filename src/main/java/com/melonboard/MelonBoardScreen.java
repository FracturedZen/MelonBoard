package com.melonboard;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;

/**
 * The settings window, opened with the configured key (grave/backtick by default).
 *
 * Deliberately hand-drawn rather than built from {@code Button} widgets. 26.2 reworked both the
 * widget and the input APIs, and a panel made of rectangles plus hit tests depends on almost none
 * of that -- it needs {@code fill}, {@code text}, and the mouse position, and nothing else. The
 * layout maths lives in one place ({@link #rowY}) so drawing and hit testing cannot disagree.
 */
public class MelonBoardScreen extends Screen {

    /** GLFW's shift bit. 26.2 dropped Screen.hasShiftDown(); events carry modifiers instead. */
    private static final int GLFW_MOD_SHIFT = 0x0001;

    private static final int PW = 236;          // panel width
    private static final int ROW = 14;          // row pitch
    private static final int HEAD = 24;         // title height

    private static final int BG = 0xE0101010;
    private static final int PANEL_EDGE = 0x50FFFFFF;
    private static final int TITLE = 0xFF3CB043;
    private static final int LABEL = 0xFFDDDDDD;
    private static final int MUTED = 0xFF888888;
    private static final int VALUE = 0xFFFFFFFF;
    private static final int ON = 0xFF3CB043;
    private static final int OFF = 0xFF803030;
    private static final int BTN = 0x40FFFFFF;
    private static final int BTN_HOVER = 0x70FFFFFF;

    // Setting rows, then a rule, then the read-only stat rows.
    private static final int R_ENABLED = 0;
    private static final int R_OVERLAY = 1;
    private static final int R_X = 2;
    private static final int R_Y = 3;
    private static final int R_KEY = 4;
    private static final int R_LINK = 5;
    private static final int SETTING_ROWS = 6;
    private static final int STAT_ROWS = 7;

    private final MelonBoard board;

    /** When true the next key press is captured as the new open key instead of acting. */
    private boolean rebinding = false;

    /** Link code being typed, and whether the box has focus. */
    private String linkCode = "";
    private boolean linkFocused = false;

    private int px, py, ph;

    public MelonBoardScreen(MelonBoard board) {
        super(Component.literal("MelonBoard"));
        this.board = board;
    }

    @Override
    protected void init() {
        ph = HEAD + ROW * (SETTING_ROWS + STAT_ROWS) + 14 + 12;
        px = (this.width - PW) / 2;
        py = (this.height - ph) / 2;
    }

    /** The game keeps running behind this; it is a settings panel, not a menu. */
    @Override
    public boolean isPauseScreen() {
        return false;
    }

    private int rowY(int index) {
        return py + HEAD + index * ROW;
    }

    // ------------------------------------------------------------------ draw

    @Override
    public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float partialTick) {
        super.extractRenderState(g, mouseX, mouseY, partialTick);

        Font f = this.font;

        g.fill(px, py, px + PW, py + ph, BG);
        g.outline(px, py, PW, ph, PANEL_EDGE);

        g.text(f, "MelonBoard", px + 8, py + 8, TITLE);
        String host = board.config.serverHost;
        g.text(f, host, px + PW - 8 - f.width(host), py + 8, MUTED);

        toggleRow(g, f, R_ENABLED, "Enabled", board.config.enabled, mouseX, mouseY);
        toggleRow(g, f, R_OVERLAY, "Show overlay", board.config.showOverlay, mouseX, mouseY);
        spinnerRow(g, f, R_X, "Overlay X", board.config.overlayX, mouseX, mouseY);
        spinnerRow(g, f, R_Y, "Overlay Y", board.config.overlayY, mouseX, mouseY);

        String keyName = rebinding ? "press a key..." : keyLabel(board.config.openKey);
        buttonRow(g, f, R_KEY, "Open key", keyName, mouseX, mouseY, rebinding ? TITLE : VALUE);

        // The /link code box. Shows a caret while focused so it is obvious typing goes here.
        String shown = linkCode.isEmpty() && !linkFocused ? "/link in Discord" : linkCode;
        if (linkFocused) shown = shown + "_";
        buttonRow(g, f, R_LINK, "Link code", shown, mouseX, mouseY,
            linkFocused ? TITLE : (linkCode.isEmpty() ? MUTED : VALUE));

        int ruleY = rowY(SETTING_ROWS) + 4;
        g.fill(px + 8, ruleY, px + PW - 8, ruleY + 1, 0x30FFFFFF);

        MelonStats s = board.latestStats();
        int base = SETTING_ROWS;

        if (s == null) {
            g.text(f, board.statusNote(), px + 8, rowY(base) + 6, MUTED);
        } else {
            statRow(g, f, base,     "chopped", num(s.mined()));
            statRow(g, f, base + 1, "placed",  num(s.placed()));
            statRow(g, f, base + 2, "crafted", num(s.crafted()));
            statRow(g, f, base + 3, "planted", num(s.planted()));
            statRow(g, f, base + 4, "AutoFarmMelons", num(board.afkMelons()));
            statRow(g, f, base + 5, "points",  board.points() >= 0 ? num(board.points()) : "--");
            statRow(g, f, base + 6, "rank",    board.rank() > 0 ? "#" + board.rank() : "--");
        }

        // Footer button.
        int by = py + ph - 24;
        boolean hot = in(mouseX, mouseY, px + 8, by, PW - 16, 16);
        g.fill(px + 8, by, px + PW - 8, by + 16, hot ? BTN_HOVER : BTN);
        String label = "Submit now";
        g.text(f, label, px + (PW - f.width(label)) / 2, by + 4, VALUE);
    }

    private void toggleRow(GuiGraphicsExtractor g, Font f, int row, String name, boolean on,
                           int mx, int my) {
        int y = rowY(row);
        g.text(f, name, px + 8, y + 3, LABEL);

        int bx = px + PW - 8 - 40;
        boolean hot = in(mx, my, bx, y, 40, 12);
        g.fill(bx, y, bx + 40, y + 12, on ? ON : OFF);
        if (hot) g.outline(bx, y, 40, 12, 0x80FFFFFF);

        String t = on ? "ON" : "OFF";
        g.text(f, t, bx + (40 - f.width(t)) / 2, y + 2, VALUE);
    }

    private void spinnerRow(GuiGraphicsExtractor g, Font f, int row, String name, int value,
                            int mx, int my) {
        int y = rowY(row);
        g.text(f, name, px + 8, y + 3, LABEL);

        int right = px + PW - 8;
        drawSmall(g, f, right - 12, y, "+", in(mx, my, right - 12, y, 12, 12));
        drawSmall(g, f, right - 56, y, "-", in(mx, my, right - 56, y, 12, 12));

        String v = String.valueOf(value);
        g.text(f, v, right - 34 - f.width(v) / 2, y + 2, VALUE);
    }

    private void buttonRow(GuiGraphicsExtractor g, Font f, int row, String name, String value,
                           int mx, int my, int colour) {
        int y = rowY(row);
        g.text(f, name, px + 8, y + 3, LABEL);

        int bw = 70;
        int bx = px + PW - 8 - bw;
        boolean hot = in(mx, my, bx, y, bw, 12);
        g.fill(bx, y, bx + bw, y + 12, hot ? BTN_HOVER : BTN);
        g.text(f, value, bx + Math.max(2, (bw - f.width(value)) / 2), y + 2, colour);
    }

    private void statRow(GuiGraphicsExtractor g, Font f, int row, String name, String value) {
        int y = rowY(row) + 6;
        g.text(f, name, px + 8, y, MUTED);
        g.text(f, value, px + PW - 8 - f.width(value), y, VALUE);
    }

    private void drawSmall(GuiGraphicsExtractor g, Font f, int x, int y, String glyph, boolean hot) {
        g.fill(x, y, x + 12, y + 12, hot ? BTN_HOVER : BTN);
        g.text(f, glyph, x + (12 - f.width(glyph)) / 2, y + 2, VALUE);
    }

    // ----------------------------------------------------------------- input

    @Override
    public boolean mouseClicked(MouseButtonEvent event, boolean doubled) {
        int mx = (int) event.x();
        int my = (int) event.y();

        int yEnabled = rowY(R_ENABLED);
        int yOverlay = rowY(R_OVERLAY);
        int toggleX = px + PW - 8 - 40;

        if (in(mx, my, toggleX, yEnabled, 40, 12)) {
            board.setEnabled(!board.config.enabled);
            return true;
        }

        if (in(mx, my, toggleX, yOverlay, 40, 12)) {
            board.config.showOverlay = !board.config.showOverlay;
            board.config.save();
            return true;
        }

        boolean shift = (event.modifiers() & GLFW_MOD_SHIFT) != 0;
        if (spinner(mx, my, R_X, true, shift)) return true;
        if (spinner(mx, my, R_Y, false, shift)) return true;

        int yKey = rowY(R_KEY);
        if (in(mx, my, px + PW - 8 - 70, yKey, 70, 12)) {
            rebinding = true;
            linkFocused = false;
            return true;
        }

        int yLink = rowY(R_LINK);
        if (in(mx, my, px + PW - 8 - 70, yLink, 70, 12)) {
            linkFocused = true;
            rebinding = false;
            return true;
        }

        // Clicking anywhere else drops focus, so the open key works again.
        linkFocused = false;

        int by = py + ph - 24;
        if (in(mx, my, px + 8, by, PW - 16, 16)) {
            board.submitNow();
            return true;
        }

        return super.mouseClicked(event, doubled);
    }

    /** Returns true when the click landed on one of this row's arrows. */
    private boolean spinner(int mx, int my, int row, boolean isX, boolean shift) {
        int y = rowY(row);
        int right = px + PW - 8;
        int step = shift ? 10 : 1;

        int delta = 0;
        if (in(mx, my, right - 12, y, 12, 12)) delta = step;
        else if (in(mx, my, right - 56, y, 12, 12)) delta = -step;
        if (delta == 0) return false;

        if (isX) board.config.overlayX = Math.max(0, board.config.overlayX + delta);
        else board.config.overlayY = Math.max(0, board.config.overlayY + delta);

        board.config.save();
        return true;
    }

    /** Typed characters go to the link box when it has focus, and nowhere otherwise. */
    @Override
    public boolean charTyped(CharacterEvent event) {
        if (!linkFocused) return super.charTyped(event);

        String ch = event.codepointAsString();
        if (ch != null && !ch.isEmpty() && linkCode.length() < 12) {
            char c = ch.charAt(0);
            if (Character.isLetterOrDigit(c)) {
                linkCode += Character.toUpperCase(c);
            }
        }

        return true;
    }

    @Override
    public boolean keyPressed(KeyEvent event) {
        if (rebinding) {
            // Escape cancels the rebind rather than binding escape, which would be unrecoverable
            // without editing the config by hand.
            if (event.key() != InputConstants.KEY_ESCAPE) {
                board.config.openKey = event.key();
                board.config.save();
            }
            rebinding = false;
            return true;
        }

        // While the box has focus it swallows keys, so typing a code cannot trip the open key or
        // any other binding.
        if (linkFocused) {
            if (event.key() == InputConstants.KEY_RETURN) {
                if (linkCode.length() >= 4) {
                    board.claimLinkCode(linkCode);
                    linkCode = "";
                    linkFocused = false;
                    this.onClose();
                }
                return true;
            }
            if (event.key() == InputConstants.KEY_BACKSPACE) {
                if (!linkCode.isEmpty()) linkCode = linkCode.substring(0, linkCode.length() - 1);
                return true;
            }
            if (event.key() == InputConstants.KEY_ESCAPE) {
                linkFocused = false;
                return true;
            }
            return true;
        }

        if (event.key() == board.config.openKey) {
            this.onClose();
            return true;
        }

        return super.keyPressed(event);
    }

    // -------------------------------------------------------------- plumbing

    private static boolean in(int mx, int my, int x, int y, int w, int h) {
        return mx >= x && mx < x + w && my >= y && my < y + h;
    }

    private static String num(long v) {
        return String.format("%,d", v);
    }

    private static String keyLabel(int key) {
        if (key == InputConstants.KEY_GRAVE) return "`";
        try {
            String name = InputConstants.Type.KEYSYM.getOrCreate(key).getDisplayName().getString();
            return name == null || name.isBlank() ? String.valueOf(key) : name;
        } catch (Exception e) {
            return String.valueOf(key);
        }
    }
}
