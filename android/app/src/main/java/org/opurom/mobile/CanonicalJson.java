package org.opurom.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Minimal canonical-JSON writer for structured storage values: object keys are
 * sorted and insignificant whitespace is dropped, so equal values yield equal
 * bytes. It handles the JSON the primitives store (objects, arrays, strings,
 * numbers, booleans, null) and returns {@code null} for input it cannot parse,
 * never a partial result.
 */
final class CanonicalJson {
    private final String src;
    private int pos;

    private CanonicalJson(String src) {
        this.src = src;
        this.pos = 0;
    }

    static String canonicalize(String json) {
        if (json == null) {
            return null;
        }
        CanonicalJson parser = new CanonicalJson(json);
        try {
            String value = parser.value();
            parser.skipWs();
            return parser.pos == parser.src.length() ? value : null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private void skipWs() {
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                pos += 1;
            } else {
                break;
            }
        }
    }

    private String value() {
        skipWs();
        if (pos >= src.length()) {
            throw new IllegalStateException("unexpected end");
        }
        char c = src.charAt(pos);
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            default: return scalar();
        }
    }

    private String object() {
        pos += 1; // '{'
        List<String[]> entries = new ArrayList<>();
        skipWs();
        if (peek() == '}') {
            pos += 1;
            return "{}";
        }
        while (true) {
            skipWs();
            String key = string(); // already a quoted JSON string
            skipWs();
            expect(':');
            String val = value();
            entries.add(new String[] {key, val});
            skipWs();
            char c = peek();
            if (c == ',') {
                pos += 1;
            } else if (c == '}') {
                pos += 1;
                break;
            } else {
                throw new IllegalStateException("expected , or }");
            }
        }
        Collections.sort(entries, (a, b) -> a[0].compareTo(b[0]));
        StringBuilder out = new StringBuilder("{");
        for (int i = 0; i < entries.size(); i += 1) {
            if (i > 0) {
                out.append(',');
            }
            out.append(entries.get(i)[0]).append(':').append(entries.get(i)[1]);
        }
        return out.append('}').toString();
    }

    private String array() {
        pos += 1; // '['
        StringBuilder out = new StringBuilder("[");
        skipWs();
        if (peek() == ']') {
            pos += 1;
            return "[]";
        }
        boolean first = true;
        while (true) {
            if (!first) {
                out.append(',');
            }
            out.append(value());
            first = false;
            skipWs();
            char c = peek();
            if (c == ',') {
                pos += 1;
            } else if (c == ']') {
                pos += 1;
                break;
            } else {
                throw new IllegalStateException("expected , or ]");
            }
        }
        return out.append(']').toString();
    }

    private String string() {
        expect('"');
        StringBuilder out = new StringBuilder("\"");
        while (pos < src.length()) {
            char c = src.charAt(pos);
            pos += 1;
            if (c == '"') {
                return out.append('"').toString();
            }
            if (c == '\\') {
                char e = src.charAt(pos);
                pos += 1;
                switch (e) {
                    case '"': out.append("\\\""); break;
                    case '\\': out.append("\\\\"); break;
                    case '/': out.append('/'); break;
                    case 'n': out.append("\\n"); break;
                    case 't': out.append("\\t"); break;
                    case 'r': out.append("\\r"); break;
                    default: throw new IllegalStateException("bad escape");
                }
            } else {
                appendEscaped(out, c);
            }
        }
        throw new IllegalStateException("unterminated string");
    }

    private String scalar() {
        int start = pos;
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E'
                    || (c >= 'a' && c <= 'z')) {
                pos += 1;
            } else {
                break;
            }
        }
        if (pos == start) {
            throw new IllegalStateException("empty scalar");
        }
        String token = src.substring(start, pos);
        if (token.equals("true") || token.equals("false") || token.equals("null")) {
            return token;
        }
        Double.parseDouble(token); // throws on a non-number
        return token;
    }

    private char peek() {
        return pos < src.length() ? src.charAt(pos) : '\0';
    }

    private void expect(char c) {
        if (peek() != c) {
            throw new IllegalStateException("expected " + c);
        }
        pos += 1;
    }

    private static void appendEscaped(StringBuilder out, char c) {
        switch (c) {
            case '"': out.append("\\\""); break;
            case '\\': out.append("\\\\"); break;
            case '\n': out.append("\\n"); break;
            case '\t': out.append("\\t"); break;
            case '\r': out.append("\\r"); break;
            default: out.append(c);
        }
    }
}
