package org.opurom.mobile;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Full-screen Opurom host. Every visible pixel comes from the compiled IR frame;
 * the only Android view is the surface that draws those pixels and forwards
 * touch coordinates to the native hit test and tap dispatcher.
 */
public final class MainActivity extends Activity {
    private static final String GRAPHICS_IR = "dashboard.opuir.json";
    private static final String IR_EXTRA = "org.opurom.mobile.IR";
    private static final java.util.regex.Pattern IR_NAME =
            java.util.regex.Pattern.compile("[A-Za-z0-9_-]+\\.opuir\\.json");
    private static final java.util.regex.Pattern SYSTEM_MODE =
            java.util.regex.Pattern.compile("\"mode\"\\s*:\\s*\"system\"");
    private static final java.util.regex.Pattern FONT_METRICS =
            java.util.regex.Pattern.compile("\"fontMetrics\"\\s*:\\s*\"proportional\"");
    private static final java.util.regex.Pattern THEME_OPEN =
            java.util.regex.Pattern.compile("\"theme\"\\s*:\\s*\\{");
    // Render at physical resolution: downscaling then stretching to the view
    // halves DPI and blurs glyphs/edge AA. Full-res costs more per frame but
    // the native release kernel keeps it within budget; drawBitmap is 1:1.
    private static final int MAX_FRAME_PIXELS = 2400;
    private static final String TOUCH_TAG = "OpuromTouch";

    private static final byte[] ASSET_MAGIC = {'O', 'P', 'U', '1'};
    private static final byte[] ASSET_KEY = digestKey("opurom-mobile-asset-key-v1");
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    public static final String RELOAD_ACTION = "org.opurom.mobile.RELOAD";
    public static final String RELOAD_FILE = "opurom-reload.opuir.json";
    private static MainActivity live;

    private byte[] graphicsIr;
    private byte[] stateJson = "{}".getBytes(StandardCharsets.UTF_8);
    private boolean dark;
    private IrView view;
    private TextLayerView textLayer;
    private Bitmap lastFrame;
    private long renderer;
    private int rendererWidth;
    private int rendererHeight;
    // One transform for both the graphics bitmap and the text overlay. Set in
    // renderFrame; read-only afterwards until the next frame.
    private float frameScaleX = 1f;
    private float frameScaleY = 1f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        live = this;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        dark = (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;

        System.loadLibrary("opurom_mobile");
        applyIr(resolveFontMetrics(resolveSystemMode(readAsset(selectedIrAsset()), dark)));
        requestHighestRefreshRate();

        view = new IrView(this);
        textLayer = new TextLayerView(this);
        FrameLayout root = new FrameLayout(this);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(textLayer, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        view.post(this::renderFrame);
    }

    /** The only view in the app: draws IR pixels and maps touches back to IR nodes. */
    static final class IrView extends View {
        private final MainActivity host;

        IrView(MainActivity host) {
            super(host);
            this.host = host;
            setFocusable(true);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            Bitmap frame = host.lastFrame;
            if (frame != null) {
                // Same transform the text overlay uses: bitmap pixels are
                // rendererWidth x rendererHeight, scaled once into the view.
                canvas.drawBitmap(frame, null,
                        new RectF(0, 0, host.rendererWidth * host.frameScaleX,
                                host.rendererHeight * host.frameScaleY), null);
            }
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_UP) {
                host.onTap(event.getX(), event.getY());
                return true;
            }
            return event.getAction() == MotionEvent.ACTION_DOWN;
        }
    }

    /**
     * Transparent system-font overlay. Graphics come from the suppressed IR
     * frame below; every displayed glyph is painted here with Typeface.DEFAULT,
     * so no 5x7 kernel glyph reaches the preview. Touch falls through to IrView.
     */
    static final class TextLayerView extends View {
        private final MainActivity host;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private JSONArray spans = new JSONArray();

        TextLayerView(MainActivity host) {
            super(host);
            this.host = host;
            setClickable(false);
            setFocusable(false);
            paint.setTypeface(Typeface.DEFAULT);
        }

        void setSpans(String json) {
            try {
                JSONArray parsed = new JSONArray(json);
                for (int i = 0; i < parsed.length(); i += 1) {
                    parsed.getJSONObject(i).getInt("x");
                }
                spans = parsed;
            } catch (Exception error) {
                spans = new JSONArray();
            }
            invalidate();
        }

        void clear() {
            spans = new JSONArray();
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            // Never recompute a second scale: both layers must use the exact
            // transform applied to the graphics bitmap in IrView.onDraw.
            float scaleX = host.frameScaleX;
            float scaleY = host.frameScaleY;
            for (int index = 0; index < spans.length(); index += 1) {
                JSONObject span = spans.optJSONObject(index);
                if (span == null) {
                    continue;
                }
                String text = span.optString("text", "");
                if (text.isEmpty()) {
                    continue;
                }
                JSONArray color = span.optJSONArray("color");
                if (color != null && color.length() == 4) {
                    paint.setColor(Color.argb(color.optInt(3, 255), color.optInt(0, 0),
                            color.optInt(1, 0), color.optInt(2, 0)));
                }
                float textSize = 7f * Math.max(1, span.optInt("size", 1)) * scaleY;
                paint.setTextSize(textSize);
                String align = span.optString("align", "start");
                JSONArray origin = span.optJSONArray("origin");
                boolean hasOrigin = origin != null && origin.length() == 2;
                // raster.draw_text ignores the alignment when a glyph origin is
                // present: the origin is the absolute top-left of the run.
                paint.setTextAlign(hasOrigin ? Paint.Align.LEFT
                        : "center".equals(align) ? Paint.Align.CENTER
                        : "end".equals(align) ? Paint.Align.RIGHT : Paint.Align.LEFT);
                int x = span.optInt("x", 0);
                int y = span.optInt("y", 0);
                int w = span.optInt("w", 0);
                int h = span.optInt("h", 0);
                float left = x * scaleX;
                float top = y * scaleY;
                float right = (x + w) * scaleX;
                float bottom = (y + h) * scaleY;
                float anchorX;
                float baseline;
                if (hasOrigin) {
                    anchorX = origin.optInt(0, x) * scaleX;
                    baseline = origin.optInt(1, y) * scaleY + textSize;
                } else {
                    float pad = 2f * scaleX;
                    anchorX = "center".equals(align) ? (left + right) / 2f
                            : "end".equals(align) ? right - pad : left + pad;
                    baseline = top + Math.max(2f * scaleY, (bottom - top - textSize) / 2f)
                            + textSize;
                }
                float lineHeight = textSize + 2f * scaleY;
                canvas.save();
                canvas.clipRect(left, top, right, bottom);
                String[] lines = text.split("\\n", -1);
                for (int line = 0; line < lines.length; line += 1) {
                    if (!lines[line].isEmpty()) {
                        canvas.drawText(lines[line], anchorX,
                                baseline + line * lineHeight, paint);
                    }
                }
                canvas.restore();
            }
        }
    }

    /** Maps a screen coordinate into the render viewport, then dispatches a tap. */
    private void onTap(float screenX, float screenY) {
        if (lastFrame == null || rendererWidth <= 0 || view.getWidth() <= 0
                || view.getHeight() <= 0) {
            return;
        }
        int x = (int) Math.round(screenX * rendererWidth / view.getWidth());
        int y = (int) Math.round(screenY * rendererHeight / view.getHeight());
        int node = OpuromNative.opuHitTest(graphicsIr, stateJson, x, y,
                rendererWidth, rendererHeight);
        Log.d(TOUCH_TAG, "node=" + node);
        if (node == 0) {
            return;
        }
        byte[] out = new byte[Math.max(8192, stateJson.length * 2 + 1024)];
        int status = OpuromNative.opuTapNode(graphicsIr, stateJson, node, out);
        Log.d(TOUCH_TAG, "tap=" + node + " status=" + status);
        if (status != OpuromNative.OK) {
            return;
        }
        stateJson = trim(out);
        renderFrame();
    }

    private static byte[] trim(byte[] data) {
        int length = 0;
        while (length < data.length && data[length] != 0) {
            length += 1;
        }
        return Arrays.copyOf(data, length);
    }

    /** Renders the current IR and state into a bitmap sized to the view. */
    private void renderFrame() {
        int viewWidth = view.getWidth();
        int viewHeight = view.getHeight();
        if (viewWidth <= 0 || viewHeight <= 0) {
            return;
        }
        float scale = Math.min(1f, (float) MAX_FRAME_PIXELS
                / Math.max(viewWidth, viewHeight));
        int width = Math.max(1, (int) (viewWidth * scale));
        int height = Math.max(1, (int) (viewHeight * scale));
        byte[] pixels = new byte[width * height * 4];

        if (renderer != 0 && (rendererWidth != width || rendererHeight != height)) {
            OpuromNative.opuRendererFree(renderer);
            renderer = 0;
        }
        if (renderer == 0) {
            renderer = OpuromNative.opuRendererNew(width, height);
        }
        // Publish the one transform used by both layers on every render, so a
        // resize or a fallback cannot leave the overlay on an older scale.
        rendererWidth = width;
        rendererHeight = height;
        frameScaleX = (float) viewWidth / width;
        frameScaleY = (float) viewHeight / height;
        // Preview path: the kernel rasterizes graphics only; all text is
        // painted by TextLayerView with the host system font.
        if (renderer != 0) {
            OpuromNative.opuRendererSuppressText(renderer, true);
        }
        int status = renderer != 0
                ? OpuromNative.opuRendererFrameRoute(renderer, graphicsIr, stateJson,
                        null, pixels, width, height)
                : OpuromNative.opuFrameSuppressed(graphicsIr, stateJson,
                        pixels, width, height);
        if (status != OpuromNative.OK) {
            throw new IllegalStateException("frame render failed with status " + status);
        }
        byte[] spanBytes = new byte[65536];
        int spanCount = OpuromNative.opuTextSpans(graphicsIr, stateJson,
                width, height, spanBytes);
        if (spanCount >= 0) {
            textLayer.setSpans(new String(trim(spanBytes), StandardCharsets.UTF_8));
        } else {
            textLayer.clear();
        }
        int[] argb = new int[width * height];
        for (int index = 0; index < argb.length; index += 1) {
            int offset = index * 4;
            argb[index] = ((pixels[offset + 3] & 0xff) << 24)
                    | ((pixels[offset] & 0xff) << 16)
                    | ((pixels[offset + 1] & 0xff) << 8)
                    | (pixels[offset + 2] & 0xff);
        }
        lastFrame = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888);
        view.invalidate();
    }

    /** Replaces the IR program but keeps the current process alive. */
    private void applyIr(byte[] ir) {
        graphicsIr = ir;
        stateJson = "{}".getBytes(StandardCharsets.UTF_8);
    }

    /** Reload hook used by the dev CLI; keeps the warm process and state. */
    static boolean reloadFromFile(java.io.File file) {
        MainActivity activity = live;
        if (activity == null || file == null || !file.isFile()) {
            return false;
        }
        try {
            byte[] ir = java.nio.file.Files.readAllBytes(file.toPath());
            activity.applyIr(resolveFontMetrics(resolveSystemMode(ir, activity.dark)));
            activity.renderFrame();
            return true;
        } catch (IOException error) {
            return false;
        }
    }

    private String selectedIrAsset() {
        String requested = getIntent() == null ? null : getIntent().getStringExtra(IR_EXTRA);
        if (requested == null || !IR_NAME.matcher(requested).matches()) {
            return GRAPHICS_IR;
        }
        return requested;
    }

    private static byte[] resolveSystemMode(byte[] ir, boolean dark) {
        if (!dark) {
            return ir;
        }
        String text = new String(ir, StandardCharsets.UTF_8);
        java.util.regex.Matcher matcher = SYSTEM_MODE.matcher(text);
        if (!matcher.find()) {
            return ir;
        }
return matcher.replaceFirst("\"mode\": \"dark\"")
                .getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] resolveFontMetrics(byte[] ir) {
        String text = new String(ir, StandardCharsets.UTF_8);
        if (FONT_METRICS.matcher(text).find()) {
            return ir;
        }
        java.util.regex.Matcher opening = THEME_OPEN.matcher(text);
        if (!opening.find()) {
            return ir;
        }
        return (text.substring(0, opening.end())
+ "\"fontMetrics\": \"proportional\","
                + text.substring(opening.end()))
                .getBytes(StandardCharsets.UTF_8);
    }

    private byte[] readAsset(String name) {
        try (InputStream input = getAssets().open(name)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) {
                bytes.write(chunk, 0, count);
            }
            return unseal(bytes.toByteArray(), name);
        } catch (IOException error) {
            if (!GRAPHICS_IR.equals(name)) {
                return readAsset(GRAPHICS_IR);
            }
            throw new IllegalStateException("cannot read IR asset " + name, error);
        }
    }

    private static byte[] unseal(byte[] data, String name) {
        if (data.length < ASSET_MAGIC.length + GCM_IV_BYTES + GCM_TAG_BITS / 8
                || !startsWith(data, ASSET_MAGIC)) {
            return data;
        }
        try {
            byte[] iv = Arrays.copyOfRange(data, ASSET_MAGIC.length,
                    ASSET_MAGIC.length + GCM_IV_BYTES);
            byte[] blob = Arrays.copyOfRange(data,
                    ASSET_MAGIC.length + GCM_IV_BYTES, data.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(ASSET_KEY, "AES"),
                    new GCMParameterSpec(GCM_TAG_BITS, iv));
            return cipher.doFinal(blob);
        } catch (Exception error) {
            throw new IllegalStateException("cannot unseal IR asset " + name, error);
        }
    }

    private void requestHighestRefreshRate() {
        WindowManager.LayoutParams attrs = getWindow().getAttributes();
        float best = 0f;
        for (android.view.Display.Mode mode : getDisplay().getSupportedModes()) {
            if (mode.getRefreshRate() > best) {
                best = mode.getRefreshRate();
                attrs.preferredDisplayModeId = mode.getModeId();
            }
        }
        if (best > 0f) {
            getWindow().setAttributes(attrs);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
            int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        PermissionBridge.dispatch(requestCode, permissions, grantResults);
    }

    @Override
    protected void onDestroy() {
        if (live == this) {
            live = null;
        }
        if (renderer != 0) {
            OpuromNative.opuRendererFree(renderer);
            renderer = 0;
        }
        super.onDestroy();
    }

    public static final class ReloadReceiver extends android.content.BroadcastReceiver {
        @Override
        public void onReceive(android.content.Context context, android.content.Intent intent) {
            if (!RELOAD_ACTION.equals(intent.getAction())) {
                return;
            }
            MainActivity activity = live;
            if (activity == null) {
                return;
            }
            java.io.File file = new java.io.File(context.getFilesDir(), RELOAD_FILE);
            activity.runOnUiThread(() -> reloadFromFile(file));
        }
    }

    private static byte[] digestKey(String secret) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(secret.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            throw new IllegalStateException("asset key digest unavailable", error);
        }
    }

    private static boolean startsWith(byte[] data, byte[] prefix) {
        if (data.length < prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i += 1) {
            if (data[i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }
}
