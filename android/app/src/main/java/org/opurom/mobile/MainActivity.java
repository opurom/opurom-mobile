package org.opurom.mobile;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.widget.ImageView;

/**
 * Minimal OPUROM Android host: loads {@code libopurom_mobile.so}, asks the native state machine
 * for one deterministic RGBA frame and shows it in an {@link ImageView}.
 *
 * <p>The native side is the pure-std Rust C ABI from {@code include/opurom.h} reached through
 * {@link OpuromNative}. The handle returned by {@code opuStateNew} is released exactly once in
 * {@link #onDestroy()}; no pointer into Rust memory survives the native call.
 */
public final class MainActivity extends Activity {
    private static final int FRAME_WIDTH = 256;
    private static final int FRAME_HEIGHT = 256;

    private long state;
    private ImageView frameView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        frameView = new ImageView(this);
        setContentView(frameView);

        System.loadLibrary("opurom_mobile");

        state = OpuromNative.opuStateNew();
        if (state == 0L) {
            throw new IllegalStateException("opu_state_new failed: out of memory");
        }
        OpuromNative.opuDispatch(state, OpuromNative.EVENT_TAP);
        frameView.setImageBitmap(renderFrame());
    }

    private Bitmap renderFrame() {
        byte[] pixels = new byte[FRAME_WIDTH * FRAME_HEIGHT * 4];
        int status = OpuromNative.opuFrame(state, pixels, FRAME_WIDTH, FRAME_HEIGHT);
        if (status != OpuromNative.OK) {
            throw new IllegalStateException("opu_frame failed with status " + status);
        }
        // The native frame is row-major RGBA8; Bitmap wants packed ARGB ints.
        int[] argb = new int[FRAME_WIDTH * FRAME_HEIGHT];
        for (int index = 0; index < argb.length; index++) {
            int offset = index * 4;
            argb[index] = ((pixels[offset + 3] & 0xff) << 24)
                    | ((pixels[offset] & 0xff) << 16)
                    | ((pixels[offset + 1] & 0xff) << 8)
                    | (pixels[offset + 2] & 0xff);
        }
        return Bitmap.createBitmap(argb, FRAME_WIDTH, FRAME_HEIGHT, Bitmap.Config.ARGB_8888);
    }

    @Override
    protected void onDestroy() {
        if (state != 0L) {
            OpuromNative.opuStateFree(state);
            state = 0L;
        }
        super.onDestroy();
    }
}
