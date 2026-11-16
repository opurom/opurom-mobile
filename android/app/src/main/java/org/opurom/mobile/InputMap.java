package org.opurom.mobile;

/**
 * Pure input-field mapping rules for the Android host, mirroring the
 * opurom-platform input_map.rs contract variant for variant: a press emits
 * {@code Tap} with the host hit-test node id, a move inside the press bracket
 * is a {@code PointerDrag}, a move without one is a {@code PointerMove}, a
 * release (or the platform's ACTION_CANCEL, which the event stream cannot
 * tell apart) is a {@code PointerUp}, and scroll axes carry notch-unit wheel
 * deltas. The adapter layer converts raw fields and delegates every decision
 * here; the adapter is also the single place that converts pixel coordinates
 * to logical pixels (see {@link #toLogical}).
 */
public final class InputMap {
    /** Tap node id: hit-testing happens host-side, so the id defers (u32::MAX). */
    public static final long NODE_ID_HOST = 0xFFFFFFFFL;

    /** Kind of one mapped input event, matching the shared ABI variants. */
    public static final String TAP = "tap";
    public static final String POINTER_MOVE = "move";
    public static final String POINTER_DRAG = "drag";
    public static final String POINTER_UP = "up";
    public static final String WHEEL = "wheel";

    /** One mapped input event: the Java shape of an ABI InputEvent variant. */
    public static final class Event {
        public final String kind;
        public final float x;
        public final float y;
        public final float delta;
        public final long nodeId;

        private Event(String kind, float x, float y, float delta, long nodeId) {
            this.kind = kind;
            this.x = x;
            this.y = y;
            this.delta = delta;
            this.nodeId = nodeId;
        }

        @Override
        public boolean equals(Object other) {
            if (!(other instanceof Event)) {
                return false;
            }
            Event event = (Event) other;
            return kind.equals(event.kind) && x == event.x && y == event.y
                    && delta == event.delta && nodeId == event.nodeId;
        }

        @Override
        public int hashCode() {
            return kind.hashCode();
        }

        @Override
        public String toString() {
            return kind + "(" + x + "," + y + (kind.equals(WHEEL) ? "," + delta : "")
                    + (kind.equals(TAP) ? ",node " + nodeId : "") + ")";
        }
    }

    /** Pixel to logical-pixel conversion: the adapter calls this in one place. */
    public static float toLogical(float pixels, float density) {
        return pixels / density;
    }

    /** A press: Tap fires immediately, matching the desktop wire mapping. */
    public static Event tap(float x, float y) {
        return new Event(TAP, x, y, 0f, NODE_ID_HOST);
    }

    /** A pointer moved: a held button means a drag, otherwise a free move. */
    public static Event pointerMove(boolean pressed, float x, float y) {
        return new Event(pressed ? POINTER_DRAG : POINTER_MOVE, x, y, 0f, 0L);
    }

    /** A release; the stream cannot tell a real release from a cancel. */
    public static Event pointerUp(float x, float y) {
        return new Event(POINTER_UP, x, y, 0f, 0L);
    }

    /**
     * A wheel scroll in notch units: {@code AXIS_VSCROLL} already reports 1.0
     * per notch with positive away from the user (measured on a device: one
     * wheel notch reports exactly 1.0), so the value passes through unchanged.
     * Trackpad and inertia fractions are kept, never rounded.
     */
    public static Event wheel(float x, float y, float delta) {
        return new Event(WHEEL, x, y, delta, 0L);
    }

    /**
     * The press bracket shared with the desktop wire mapping: {@code pressed}
     * starts false, turns true at the first pointer's down and clears at its
     * up, so a move inside the bracket is a drag. Extra pointers are ignored
     * (the ABI is single-pointer; the first pointer wins).
     */
    public static final class Bracket {
        private boolean pressed;
        private int pointerId = Integer.MIN_VALUE;

        /** ACTION_DOWN: adopt the first pointer and emit Tap. */
        public Event down(int pointerId, float x, float y) {
            this.pressed = true;
            this.pointerId = pointerId;
            return tap(x, y);
        }

        /**
         * ACTION_MOVE or ACTION_HOVER_MOVE: a drag when this pointer owns the
         * bracket, otherwise a free move; foreign pointers emit nothing.
         */
        public Event move(int pointerId, float x, float y) {
            if (pressed && pointerId != this.pointerId) {
                return null;
            }
            return pointerMove(pressed, x, y);
        }

        /** ACTION_UP (and ACTION_CANCEL, same shape): close the bracket. */
        public Event up(int pointerId, float x, float y) {
            if (!pressed || pointerId != this.pointerId) {
                return null;
            }
            pressed = false;
            this.pointerId = Integer.MIN_VALUE;
            return pointerUp(x, y);
        }

        /** True between down and up of the adopted pointer. */
        public boolean isPressed() {
            return pressed;
        }
    }

    private InputMap() {
    }
}
