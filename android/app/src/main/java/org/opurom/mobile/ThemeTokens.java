package org.opurom.mobile;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal, allocation-light reader for the semantic palette in a loaded IR.
 *
 * <p>The native shell draws its chrome with Android widgets, so it needs the
 * authored {@code theme.tokens.*} colours and {@code theme.accent} as ARGB ints
 * without pulling a JSON parser into the app. This scans only the top-level
 * {@code theme} object and picks the handful of string keys it maps. It is a
 * pure function of the IR text: identical input yields identical output, so a
 * node test can assert the mapping and its fallbacks directly.
 *
 * <p>Each {@code #RRGGBB} (or {@code #AARRGGBB}) value is opaque unless it
 * carries its own alpha. A missing or malformed token keeps the caller's
 * measured default, so an IR that declares no tokens leaves the palette
 * unchanged. The math is checked against the same measured reference values the
 * design-system uses for the six semantic roles.
 */
final class ThemeTokens {

    // Measured semantic defaults (opurom-spec IR_ADDITIONS.md): used when the IR
    // omits a token so the chrome never degrades to an unreadable colour.
    static final int DEFAULT_PRIMARY = 0xFF0A71FC;
    static final int DEFAULT_SECONDARY = 0xFF0DB2FF;
    static final int DEFAULT_SUCCESS = 0xFF1FB14C;
    static final int DEFAULT_WARNING = 0xFFFD960E;
    static final int DEFAULT_ERROR = 0xFFF62B35;
    static final int DEFAULT_INFO = 0xFF0A71FC;

    /** Resolved palette: the six semantic roles plus the authored accent (0 = absent). */
    static final class Palette {
        final int primary;
        final int secondary;
        final int success;
        final int warning;
        final int error;
        final int info;
        final int accent;

        Palette(int primary, int secondary, int success, int warning, int error, int info,
                int accent) {
            this.primary = primary;
            this.secondary = secondary;
            this.success = success;
            this.warning = warning;
            this.error = error;
            this.info = info;
            this.accent = accent;
        }
    }

    private static final Pattern ACCENT =
            Pattern.compile("\"accent\"\\s*:\\s*\"(#[0-9A-Fa-f]{6,8}|[A-Za-z]+)\"");
    private ThemeTokens() {
    }

    /**
     * Resolves the authored theme colours as ARGB ints. A missing or malformed
     * token is {@code 0}, never a baked default, so the caller substitutes the
     * mode-measured palette it already resolved (light and dark differ). This
     * keeps the dark palette intact for an IR that declares no tokens.
     */
    static Palette resolve(String ir) {
        Map<String, String> tokens = tokens(ir);
        int accent = parseColor(firstMatch(ACCENT, ir), 0);
        return new Palette(
                parseColor(tokens.get("primary"), 0),
                parseColor(tokens.get("secondary"), 0),
                parseColor(tokens.get("success"), 0),
                parseColor(tokens.get("warning"), 0),
                parseColor(tokens.get("error"), 0),
                parseColor(tokens.get("info"), 0),
                accent);
    }

    /**
     * Extracts every {@code "name": "#RRGGBB"} pair declared inside the
     * top-level {@code "tokens"} object. Other objects' tokens are ignored.
     */
    static Map<String, String> tokens(String ir) {
        Map<String, String> out = new HashMap<>();
        if (ir == null) return out;
        // Anchor on the theme object so a node prop literally named "tokens"
        // is never mistaken for the theme palette.
        int theme = ir.indexOf("\"theme\"");
        if (theme < 0) return out;
        int themeBrace = ir.indexOf('{', theme);
        if (themeBrace < 0) return out;
        int themeEnd = matchingBrace(ir, themeBrace);
        if (themeEnd < 0) return out;
        int start = ir.indexOf("\"tokens\"", themeBrace);
        if (start < 0 || start > themeEnd) return out;
        int brace = ir.indexOf('{', start);
        if (brace < 0) return out;
        int end = matchingBrace(ir, brace);
        if (end < 0) return out;
        Matcher matcher = Pattern.compile(
                "\"([A-Za-z0-9_-]+)\"\\s*:\\s*\"(#[0-9A-Fa-f]{6,8}|[A-Za-z]+)\"")
                .matcher(ir.substring(brace + 1, end));
        while (matcher.find()) {
            out.put(matcher.group(1), matcher.group(2));
        }
        return out;
    }

    /** Parses {@code #RRGGBB}, {@code #AARRGGBB}, or a few CSS names; returns {@code fallback} on failure. */
    static int parseColor(String value, int fallback) {
        if (value == null) return fallback;
        String text = value.trim();
        if (text.startsWith("#")) {
            try {
                long packed = Long.parseLong(text.substring(1), 16);
                int length = text.length() - 1;
                if (length == 6) return 0xFF000000 | (int) packed;
                if (length == 8) return (int) packed;
            } catch (NumberFormatException ignored) {
                return fallback;
            }
            return fallback;
        }
        switch (text.toLowerCase(java.util.Locale.ROOT)) {
            case "white": return 0xFFFFFFFF;
            case "black": return 0xFF000000;
            case "transparent": return 0;
            default: return fallback;
        }
    }

    private static String firstMatch(Pattern pattern, String ir) {
        if (ir == null) return null;
        Matcher matcher = pattern.matcher(ir);
        return matcher.find() ? matcher.group(1) : null;
    }

    // Index of the brace closing the one at {@code open}, or -1 if unbalanced.
    private static int matchingBrace(String text, int open) {
        int depth = 0;
        boolean inString = false;
        for (int i = open; i < text.length(); i += 1) {
            char c = text.charAt(i);
            if (inString) {
                if (c == '\\') i += 1;
                else if (c == '"') inString = false;
            } else if (c == '"') {
                inString = true;
            } else if (c == '{') {
                depth += 1;
            } else if (c == '}') {
                depth -= 1;
                if (depth == 0) return i;
            }
        }
        return -1;
    }
}
