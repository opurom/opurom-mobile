package org.opurom.mobile;

/**
 * Caller-owned press phase for the Android host. The coordinate inverse and
 * the DOWN/UP pairing are pure Java so they run on a plain JVM; no Android or
 * ABI types live here. The phase never enters the state JSON or the C ABI.
 */
final class TouchPhase {
    static final int NO_NODE = 0;

    int node;
    int x;
    int y;
    long downMs;
    boolean longPressed;
    /** Set on release; the press stays live until the fade window elapses. */
    boolean confirmed;
    long confirmTick;

    TouchPhase() {
        clear();
    }

    /** Inverse of the bitmap transform screen = canvas * scale. */
    static int toCanvas(float screen, float scale) {
        if (scale <= 0f || Float.isNaN(scale) || Float.isInfinite(scale)) {
            return 0;
        }
        return Math.round(screen / scale);
    }

    /** Opens a press; returns true when a node was hit. A new DOWN resets confirm. */
    boolean down(int hitNode, int canvasX, int canvasY, long nowMs) {
        node = hitNode;
        x = canvasX;
        y = canvasY;
        downMs = nowMs;
        longPressed = false;
        confirmed = false;
        confirmTick = 0L;
        return hitNode != NO_NODE;
    }

    /** Records the release on the caller frame clock; keeps the press live. */
    void confirm(long frameTick) {
        if (node != NO_NODE && !confirmed) {
            confirmed = true;
            confirmTick = frameTick;
        }
    }

    /** True between a confirm release and the end of the fade-out window. */
    boolean isFading() {
        return confirmed && node != NO_NODE;
    }

    /** True once the fade-out window has elapsed on the caller frame clock. */
    boolean fadeDone(long frameTick, long fadeMs) {
        return confirmed && frameTick - confirmTick >= fadeMs;
    }

    /** Sets longPressed once the held duration reaches the timeout, once only. */
    boolean markLongPressed(long nowMs, long timeoutMs) {
        if (node == NO_NODE || longPressed || nowMs - downMs < timeoutMs) {
            return false;
        }
        longPressed = true;
        return true;
    }

    boolean isPressed() {
        return node != NO_NODE;
    }

    void clear() {
        node = NO_NODE;
        x = 0;
        y = 0;
        downMs = 0L;
        longPressed = false;
        confirmed = false;
        confirmTick = 0L;
    }
}
