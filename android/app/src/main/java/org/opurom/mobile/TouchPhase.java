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

    /** Opens a press; returns true when a node was hit. */
    boolean down(int hitNode, int canvasX, int canvasY, long nowMs) {
        node = hitNode;
        x = canvasX;
        y = canvasY;
        downMs = nowMs;
        longPressed = false;
        return hitNode != NO_NODE;
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
    }
}
