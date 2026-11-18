package org.opurom.mobile;

/** Deterministic mapping from Choreographer frame timestamps to logical ms. */
public final class FrameClock {
    private FrameClock() {
    }

    /** Elapsed animation ms since `originNanos`; 0 on the origin frame. */
    public static long elapsedMs(long frameTimeNanos, long originNanos) {
        if (originNanos == Long.MIN_VALUE) {
            return 0L;
        }
        long raw = (frameTimeNanos - originNanos) / 1_000_000L;
        return raw < 0L ? 0L : raw;
    }

    /** Strictly increasing tick ms derived from real vsync time. */
    public static long tickMs(long frameTimeNanos, long originNanos, long lastMs) {
        long raw = (frameTimeNanos - originNanos) / 1_000_000L;
        if (raw < 0L) {
            raw = 0L;
        }
        long next = lastMs >= 0L ? lastMs + 1L : 0L;
        return raw > next ? raw : next;
    }
}
