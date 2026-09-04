package com.melonboard;

import net.minecraft.ChatFormatting;

import java.util.Locale;

/**
 * The {@code .mb} chat commands. Returns true when a message was a command and must not be sent
 * to the server as chat.
 */
public final class Commands {

    private Commands() {}

    public static boolean handle(MelonBoard board, String message) {
        Config cfg = board.config;

        String prefix = cfg.commandPrefix;
        if (prefix == null || prefix.isBlank()) return false;

        String trimmed = message.strip();
        if (!trimmed.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT))) return false;

        // "mbsomething" must not be read as the "mb" command with an argument glued on.
        String rest = trimmed.substring(prefix.length());
        if (!rest.isEmpty() && !Character.isWhitespace(rest.charAt(0))) return false;

        String[] parts = rest.strip().split("\\s+");
        String verb = parts.length > 0 ? parts[0].toLowerCase(Locale.ROOT) : "";
        String arg = parts.length > 1 ? parts[1] : null;

        switch (verb) {
            case "" -> board.say(ChatFormatting.WHITE, board.statusLine());

            case "on" -> {
                board.setEnabled(true);
                board.say(ChatFormatting.GREEN, "tracking on");
            }

            case "off" -> {
                board.setEnabled(false);
                board.say(ChatFormatting.GRAY, "tracking off (flushing what we have)");
            }

            case "now" -> {
                board.submitNow();
                board.say(ChatFormatting.WHITE, "requesting statistics and submitting...");
            }

            case "interval" -> {
                Integer minutes = parseInt(arg);
                if (minutes == null || minutes < 1 || minutes > 240) {
                    board.say(ChatFormatting.RED, "usage: " + prefix + " interval <1-240 minutes>");
                } else {
                    cfg.intervalMinutes = minutes;
                    cfg.save();
                    board.say(ChatFormatting.GREEN, "submitting every " + minutes + " min");
                }
            }

            case "endpoint" -> {
                if (arg == null || !(arg.startsWith("http://") || arg.startsWith("https://"))) {
                    board.say(ChatFormatting.RED, "usage: " + prefix + " endpoint <https://...>");
                } else {
                    cfg.endpoint = stripTrailingSlash(arg);
                    // A different API has no idea about the token this one issued.
                    cfg.clearToken();
                    cfg.save();
                    board.say(ChatFormatting.GREEN, "endpoint set to " + cfg.endpoint);
                    board.submitNow();
                }
            }

            case "server" -> {
                if (arg == null || arg.isBlank()) {
                    board.say(ChatFormatting.RED, "usage: " + prefix + " server <hostname>");
                } else {
                    cfg.serverHost = arg.strip();
                    cfg.save();
                    board.say(ChatFormatting.GREEN, "now tracking on " + cfg.serverHost
                        + " (rejoin to take effect)");
                }
            }

            case "prefix" -> {
                if (arg == null || arg.isBlank() || arg.length() > 8) {
                    board.say(ChatFormatting.RED, "usage: " + prefix + " prefix <1-8 chars>");
                } else {
                    cfg.commandPrefix = arg.strip();
                    cfg.save();
                    board.say(ChatFormatting.GREEN, "commands now start with " + cfg.commandPrefix);
                }
            }

            case "help" -> {
                board.say(ChatFormatting.WHITE, "commands:");
                board.say(ChatFormatting.GRAY, prefix + "                 status");
                board.say(ChatFormatting.GRAY, prefix + " on | off        start or stop tracking");
                board.say(ChatFormatting.GRAY, prefix + " now             submit immediately");
                board.say(ChatFormatting.GRAY, prefix + " interval <min>  how often to submit");
                board.say(ChatFormatting.GRAY, prefix + " server <host>   which server to track");
                board.say(ChatFormatting.GRAY, prefix + " endpoint <url>  leaderboard API");
                board.say(ChatFormatting.GRAY, prefix + " prefix <chars>  change this prefix");
            }

            default -> board.say(ChatFormatting.RED,
                "unknown command '" + verb + "'. Try " + prefix + " help");
        }

        return true;
    }

    private static Integer parseInt(String s) {
        if (s == null) return null;
        try {
            return Integer.parseInt(s.strip());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String stripTrailingSlash(String s) {
        String out = s.strip();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }
}
