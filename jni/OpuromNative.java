package org.opurom.mobile;

/**
 * Java-side declaration of the OPUROM mobile C ABI.
 *
 * <p>The opaque Rust state is passed as a raw {@code long}. Ownership: {@link #opuStateNew}
 * returns a nonzero handle owned by the Java caller and {@link #opuStateFree} must release it
 * exactly once; a zero handle, double free, or concurrent use of one handle is undefined. The
 * native method must copy the RGBA frame into the Java array during the call.
 *
 * <p>The IR methods parse OPUIR v0.1 plus a JSON object of state overrides and render real
 * OPUROM UI with the shared software renderer. {@code "{}"} uses the IR initial state.
 * {@link #opuRendererNew} returns a reusable handle for one viewport; release it exactly once
 * with {@link #opuRendererFree}.
 *
 * <p>The Android shared objects are built by {@code verify.mjs} with the Android NDK clang from
 * {@code jni/opurom_jni.c} plus the Rust static library, for {@code aarch64-linux-android} and
 * {@code x86_64-linux-android}. Those shared objects are never loaded on a device here: no
 * emulator or system image is installed on this host.
 */
public final class OpuromNative {
    public static final int OK = 0;
    public static final int ERR_NULL = 1;
    public static final int ERR_EVENT = 2;
    public static final int ERR_DIMENSION = 3;
    public static final int ERR_OVERFLOW = 4;
    public static final int ERR_PANIC = 5;
    public static final int ERR_IR = 6;
    public static final int ERR_STATE = 7;

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

    /** Creates one renderer for a viewport; returns zero on failure. */
    public static native long opuRendererNew(int width, int height);

    /** Frees one handle from {@link #opuRendererNew}; zero is a no-op. */
    public static native void opuRendererFree(long renderer);

    /** Renders IR plus state overrides through a reusable renderer. */
    public static native int opuRendererFrame(long renderer, byte[] irJson, byte[] stateJson,
                                              byte[] out, int width, int height);

    /** Renders IR plus state overrides with a one-shot renderer. */
    public static native int opuFrameFromIr(byte[] irJson, byte[] stateJson, byte[] out,
                                            int width, int height);
}
