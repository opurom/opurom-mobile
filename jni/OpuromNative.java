package org.opurom.mobile;

import android.content.Context;

/**
 * Java-side declaration of the Opurom mobile C ABI.
 *
 * <p>The opaque Rust state is passed as a raw {@code long}. Ownership: {@link #opuStateNew}
 * returns a nonzero handle owned by the Java caller and {@link #opuStateFree} must release it
 * exactly once; a zero handle, double free, or concurrent use of one handle is undefined. The
 * native method must copy the RGBA frame into the Java array during the call.
 *
 * <p>The IR methods parse OPUIR 0.1.0 plus a JSON object of state overrides and render real
 * Opurom UI with the shared software renderer. {@code "{}"} uses the IR initial state.
 * {@link #opuRendererNew} returns a reusable handle for one viewport; release it exactly once
 * with {@link #opuRendererFree}. The PlatformView constants carry the shared byte-level handle
 * encoding, bounds validation and strict lifecycle advance from include/platform_view.h, which
 * the JNI shim compiles into the Android shared objects.
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

    /** Shared OPV1 handle-frame magic and length, byte-for-byte with include/platform_view.h. */
    public static final int PLATFORM_VIEW_HANDLE_LEN = 8;
    public static final byte PLATFORM_VIEW_HANDLE_MAGIC_0 = 0x4f;
    public static final byte PLATFORM_VIEW_HANDLE_MAGIC_1 = 0x50;
    public static final byte PLATFORM_VIEW_HANDLE_MAGIC_2 = 0x56;
    public static final byte PLATFORM_VIEW_HANDLE_MAGIC_3 = 0x31;

    /** Platform-view lifecycle states and wire opcodes, mirroring include/platform_view.h. */
    public static final int PLATFORM_VIEW_LIFECYCLE_CREATED = 0;
    public static final int PLATFORM_VIEW_LIFECYCLE_ATTACHED = 1;
    public static final int PLATFORM_VIEW_LIFECYCLE_RESIZED = 2;
    public static final int PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED = 3;
    public static final int PLATFORM_VIEW_LIFECYCLE_DISPOSED = 4;
    public static final int PLATFORM_VIEW_EVENT_PRESS = 1;
    public static final int PLATFORM_VIEW_EVENT_RELEASE = 2;
    public static final int PLATFORM_VIEW_EVENT_MOVE = 3;
    public static final int PLATFORM_VIEW_EVENT_FOCUS = 4;

    /*
     * Native capability call surface. Each method returns a CapabilityStatus code
     * and never throws for a device condition; the C shim delegates to the Java
     * bridge of the same capability so typed errors survive the round trip.
     * These are the seam the IR PlatformCall lowering targets.
     */
    public static native int opuNotifyPost(Context context, int id, String channel,
                                           String title, String body);

    public static native int opuNotifyCancel(Context context, int id);

    public static native int opuCameraCapture(Context context);

    public static native int opuLocationGet(Context context, double[] out);

    /** Writes the IR result string {@code "<lat>,<lon>"} into {@code out}. */
    public static native int opuLocationGetText(Context context, byte[] out);

    /** Top-most IR node under a point in the render viewport; zero for a miss. */
    public static native int opuHitTest(byte[] irJson, byte[] stateJson,
                                        int x, int y, int width, int height);

    /** Dispatches a tap on one node and writes the new state JSON into {@code outJson}. */
    public static native int opuTapNode(byte[] irJson, byte[] stateJson,
                                        int nodeId, byte[] outJson);

    /** Writes the deterministic text-span JSON; returns span count or a negative error. */
    public static native int opuTextSpans(byte[] irJson, byte[] stateJson,
                                          int width, int height, byte[] outJson);

    /** Route-aware text spans: the text overlay of {@code route}'s tree. */
    public static native int opuTextSpansRoute(byte[] irJson, byte[] stateJson, byte[] route,
                                               int width, int height, byte[] outJson);

    /** Turns bitmap-text rasterization off for one reusable renderer. */
    public static native int opuRendererSuppressText(long renderer, boolean on);

    /** One-shot graphics-only frame, with the same viewport contract as the default path. */
    public static native int opuFrameSuppressed(byte[] irJson, byte[] stateJson,
                                                byte[] out, int width, int height);

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

    /**
     * Multi-page render through a reusable renderer: renders the tree of {@code route}
     * (UTF-8 page key, or {@code null} for the IR {@code initialRoute}). A single-page IR
     * ignores {@code route} and renders exactly like {@link #opuRendererFrame}.
     */
    public static native int opuRendererFrameRoute(long renderer, byte[] irJson, byte[] stateJson,
                                                   byte[] route, byte[] out, int width, int height);

    /**
     * Timed sibling of {@link #opuRendererFrameRoute}: elapsedMs is the caller-owned
     * animation clock in milliseconds; the host frame pump advances it in fixed steps.
     */
    public static native int opuRendererFrameAt(long renderer, byte[] irJson, byte[] stateJson,
                                                byte[] route, int elapsedMs, byte[] out,
                                                int width, int height);

    /**
     * Drives the caller-owned press phase. on=1 (DOWN, nodeId!=0) opens a press at
     * pressStartTick with touchX/Y as the absolute canvas point (either negative
     * for the node centre). on=2 (CONFIRM) keeps the press and records the same
     * clock slot as its confirm tick for the renderer's radius/fade finish; it
     * never clears. on=0 clears. The press never enters the state JSON; frames
     * without a press are unchanged.
     */
    public static native int opuRendererSetPress(long renderer, int nodeId, long pressStartTick,
                                                 long touchX, long touchY, int on);

    /** One-shot multi-page render; see {@link #opuRendererFrameRoute}. */
    public static native int opuFrameFromIrRoute(byte[] irJson, byte[] stateJson, byte[] route,
                                                 byte[] out, int width, int height);

    /** Writes the IR initial page key into {@code out}; returns its length, or 0 if single-page. */
    private static native int opuIrInitialRoute(byte[] irJson, byte[] out);

    /** Writes the route name at {@code index} (sorted) into {@code out}; returns its length, or 0. */
    private static native int opuIrRouteAt(byte[] irJson, int index, byte[] out);

    /** The IR {@code initialRoute} as a String, or {@code null} for a single-page document. */
    public static String initialRoute(byte[] irJson) {
        return routeAt(irJson, -1);
    }

    /**
     * The declared route at {@code index} (sorted order), or the initialRoute for a negative
     * {@code index}. Returns {@code null} for a single-page document or an out-of-range index.
     */
    public static String routeAt(byte[] irJson, int index) {
        if (irJson == null) {
            return null;
        }
        byte[] out = new byte[irJson.length];
        int len = index < 0
                ? opuIrInitialRoute(irJson, out)
                : opuIrRouteAt(irJson, index, out);
        if (len <= 0) {
            return null;
        }
        return new String(out, 0, len, java.nio.charset.StandardCharsets.UTF_8);
    }
}
