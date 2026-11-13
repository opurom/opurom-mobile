package org.opurom.mobile;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.widget.ImageView;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Minimal OPUROM Android host: loads {@code libopurom_mobile.so}, reads the compiled Todo IR
 * from the app assets and renders real OPUROM UI through JNI into an {@link ImageView}.
 *
 * <p>The IR is produced by {@code opuromc compile opurom-examples/todo.opu}; the verifier checks
 * that the shipped asset matches a fresh compilation. One reusable renderer is created in
 * {@link #onCreate(Bundle)} and released exactly once in {@link #onDestroy()}. Each tap changes
 * the state overrides and renders another frame through the same renderer.
 */
public final class MainActivity extends Activity {
    // Wide enough for the Todo label: at 256 px the text is clipped before the
    // interpolated state, so a tap would change state without changing pixels.
    private static final int FRAME_WIDTH = 480;
    private static final int FRAME_HEIGHT = 320;
    private static final String IR_ASSET = "todo.opuir.json";

    private long renderer;
    private byte[] irJson;
    private int remaining;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ImageView frameView = new ImageView(this);
        setContentView(frameView);
        frameView.setOnClickListener(view -> {
            remaining += 1;
            frameView.setImageBitmap(renderFrame());
        });

        System.loadLibrary("opurom_mobile");
        irJson = readIrAsset();
        renderer = OpuromNative.opuRendererNew(FRAME_WIDTH, FRAME_HEIGHT);
        if (renderer == 0L) {
            throw new IllegalStateException("opu_renderer_new failed");
        }
        frameView.setImageBitmap(renderFrame());
    }

    private byte[] readIrAsset() {
        try (InputStream input = getAssets().open(IR_ASSET)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) {
                bytes.write(chunk, 0, count);
            }
            return bytes.toByteArray();
        } catch (IOException error) {
            throw new IllegalStateException("cannot read IR asset " + IR_ASSET, error);
        }
    }

    private Bitmap renderFrame() {
        byte[] state = ("{\"remaining\":" + remaining + "}")
                .getBytes(StandardCharsets.UTF_8);
        byte[] pixels = new byte[FRAME_WIDTH * FRAME_HEIGHT * 4];
        int status = OpuromNative.opuRendererFrame(renderer, irJson, state, pixels,
                FRAME_WIDTH, FRAME_HEIGHT);
        if (status != OpuromNative.OK) {
            throw new IllegalStateException("opu_renderer_frame failed with status " + status);
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
        if (renderer != 0L) {
            OpuromNative.opuRendererFree(renderer);
            renderer = 0L;
        }
        super.onDestroy();
    }
}
