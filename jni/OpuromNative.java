package org.opurom.mobile;

/**
 * Java-side declaration of the OPUROM mobile C ABI.
 *
 * <p>The opaque Rust state is passed as a raw {@code long}. Ownership: {@link #opuStateNew}
 * returns a nonzero handle owned by the Java caller and {@link #opuStateFree} must release it
 * exactly once; a zero handle, double free, or concurrent use of one handle is undefined. The
 * native method must copy the RGBA frame into the Java array during the call.
 *
 * <p>This repository does NOT build an Android {@code .so}: no Android NDK exists on this host.
 * The class and jni/opurom_jni.h are compile-checked only; linking happens in R7+ on an NDK host.
 */
public final class OpuromNative {
    public static final int OK = 0;
    public static final int ERR_NULL = 1;
    public static final int ERR_EVENT = 2;
    public static final int ERR_DIMENSION = 3;
    public static final int ERR_OVERFLOW = 4;
    public static final int ERR_PANIC = 5;

    public static final int EVENT_TAP = 1;
    public static final int EVENT_RESET = 2;

    private OpuromNative() {
    }

    /** Returns zero on allocation failure, otherwise one opaque handle with counter zero. */
    public static native long opuStateNew();

    /** Applies a tap or reset event; nonzero status leaves the state unchanged. */
    public static native int opuDispatch(long state, int eventId);

    /** Writes width * height * 4 row-major RGBA8 bytes into {@code out}. */
    public static native int opuFrame(long state, byte[] out, int width, int height);

    /** Frees one handle from {@link #opuStateNew}; zero is a no-op. */
    public static native void opuStateFree(long state);
}
