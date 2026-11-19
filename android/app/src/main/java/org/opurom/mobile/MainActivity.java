package org.opurom.mobile;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.TextPaint;
import android.text.TextUtils;
import android.text.TextUtils.TruncateAt;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.SparseIntArray;
import android.view.Choreographer;
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
    // A0 frame pump: caller-owned fixed-step clock, no wall clock, no new opt-in flag.
    private static final int LONG_PRESS_MS = 500;
    private static final int ANIM_SETTLED_MS = 4000;
    private static final String PRESS_TAG = "OpuromPress";
    // Confirm keeps the frame pump alive for the renderer's fade-out controller.
    // Mirrors RIPPLE_FADE_OUT_MS in opurom-render's InkRipple timing.
    private static final int PRESS_FADE_MS = 375;
    // opu_renderer_set_press event kinds; C ABI signature is unchanged.
    private static final int PRESS_CLEAR = 0;
    private static final int PRESS_DOWN = 1;
    private static final int PRESS_CONFIRM = 2;

    private static final byte[] ASSET_MAGIC = {'O', 'P', 'U', '1'};
    private static final byte[] ASSET_KEY = digestKey("opurom-mobile-asset-key-v1");
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    public static final String RELOAD_ACTION = "org.opurom.mobile.RELOAD";
    public static final String RELOAD_FILE = "opurom-reload.opuir.json";
    private static MainActivity live;

    private byte[] graphicsIr;
    private byte[] stateJson = "{}".getBytes(StandardCharsets.UTF_8);
    // Active route for multi-page IR. Null on single-page documents; the host
    // advances it from the reserved @nav signal returned by opuTapNode.
    private String activeRoute;
    private final java.util.ArrayDeque<String> routeStack =
            new java.util.ArrayDeque<>();
    private boolean dark;
    private IrView view;
    private TextLayerView textLayer;
    private Bitmap lastFrame;
    // Reused across frames: the pump renders continuously, so allocating two
    // ~10 MB arrays and a Bitmap every frame churns the heap and triggers GC.
    private byte[] framePixels;
    private int[] frameArgb;
    private long renderer;
    private int rendererWidth;
    private int rendererHeight;
    // One transform for both the graphics bitmap and the text overlay. Set in
    // renderFrame; read-only afterwards until the next frame.
    private float frameScaleX = 1f;
    private float frameScaleY = 1f;
    // Opt-in animation state. The pump runs only when the loaded IR declares an
    // animation property; otherwise renderFrame keeps the exact SETTLED path.
    private boolean animated;
    private int elapsedMs;
    // Monotonic caller clock for the gesture ABI; never reset by animation patches.
    private long gestureClockMs;
    // Vsync timebase: elapsedMs advances by real frame deltas, the gesture
    // clock by monotonic wall time since its origin. Neither uses a fixed step.
    private long gestureOriginNanos = Long.MIN_VALUE;
    private long lastFrameNanos = Long.MIN_VALUE;
    private long lastTickNanos = Long.MIN_VALUE;
    private boolean pumpQueued;
    private final FramePump framePump = new FramePump(this);
    // Caller-owned press phase; never written into stateJson or the IR.
    private final TouchPhase press = new TouchPhase();
    // Renderer-owned gesture arena: logical deadline and one gesture result.
    private long gestureDeadline = -1L;
    private final long[] gestureOut = new long[4];
    // One hit target and one stable native id per live pointer; primary keeps id 0.
    private final SparseIntArray pointerNodes = new SparseIntArray();
    private final SparseIntArray pointerIds = new SparseIntArray();

    /** Fixed-step animation clock; a named class keeps d8 dexing simple. */
    static final class FramePump implements Choreographer.FrameCallback {
        private final MainActivity host;

        FramePump(MainActivity host) {
            this.host = host;
        }

        @Override
        public void doFrame(long frameTimeNanos) {
            host.pumpQueued = false;
            boolean held = host.press.isPressed();
            boolean fading = host.press.isFading();
            if (!held && !fading && !host.animated) {
                return;
            }
            // A confirmed release still needs frames: the renderer accelerates
            // the radius to full and fades it out over PRESS_FADE_MS. Keep the
            // caller clock advancing through that window, then clear the press.
            if (fading && host.press.fadeDone(host.elapsedMs, PRESS_FADE_MS)) {
                host.clearConfirmedPress();
                fading = false;
                held = false;
            }
            // Both clocks come from the real vsync timestamp. The render core
            // evaluates displacement from these timestamps; the host never
            // accumulates a fixed step, so 60/120/144 Hz all run at wall speed.
            if (host.gestureOriginNanos == Long.MIN_VALUE) {
                host.gestureOriginNanos = frameTimeNanos;
                host.lastFrameNanos = frameTimeNanos;
            }
            long frameDeltaMs = FrameClock.elapsedMs(frameTimeNanos, host.lastFrameNanos);
            host.lastFrameNanos = frameTimeNanos;
            host.elapsedMs = (int) Math.min(Integer.MAX_VALUE, (held || fading)
                    ? host.elapsedMs + frameDeltaMs
                    : Math.min(ANIM_SETTLED_MS, host.elapsedMs + frameDeltaMs));
            host.gestureClockMs = FrameClock.tickMs(frameTimeNanos,
                    host.gestureOriginNanos, host.lastTickNanos == Long.MIN_VALUE
                            ? -1L : FrameClock.elapsedMs(host.lastTickNanos,
                                    host.gestureOriginNanos));
            host.lastTickNanos = frameTimeNanos;
            host.runGestureTicks(frameTimeNanos);
            host.renderFrame();
            if (held || fading || (host.animated && host.elapsedMs < ANIM_SETTLED_MS)) {
                host.pumpQueued = true;
                Choreographer.getInstance().postFrameCallback(this);
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        live = this;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        // Status bar stays visible, matching the golden captures. Content is
        // laid out below it; the three layers share view-relative coordinates.
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
        view.post(this::startPump);
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
            int action = event.getActionMasked();
            int index = event.getActionIndex();
            if (action == MotionEvent.ACTION_DOWN) {
                host.resetPointers();
                host.onPressDown(event.getX(index), event.getY(index));
                host.onPointerDown(event, index, 0);
                return true;
            }
            if (action == MotionEvent.ACTION_POINTER_DOWN) {
                host.onPointerDown(event, index, host.nextPointerId());
                return true;
            }
            if (action == MotionEvent.ACTION_MOVE) {
                for (int i = 0; i < event.getPointerCount(); i += 1) {
                    host.onPointerMove(event, i);
                }
                return true;
            }
            if (action == MotionEvent.ACTION_UP) {
                host.onPointerUp(event, index);
                host.cancelRemainingPointers();
                host.onPressUp(false);
                host.onTap(event.getX(index), event.getY(index));
                return true;
            }
            if (action == MotionEvent.ACTION_POINTER_UP) {
                host.onPointerUp(event, index);
                return true;
            }
            if (action == MotionEvent.ACTION_CANCEL) {
                host.cancelRemainingPointers();
                host.onPressUp(true);
                return true;
            }
            return false;
        }
    }

    /**
     * Transparent system-font overlay. Graphics come from the suppressed IR
     * frame below; every displayed glyph is painted here with Typeface.DEFAULT,
     * so no 5x7 kernel glyph reaches the preview. Touch falls through to IrView.
     */
    static final class TextLayerView extends View {
        private final MainActivity host;
        private final TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        // Cached so per-span weight switching never allocates; DEFAULT is reset each span.
        private final Typeface boldTypeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD);
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
                // fontPx is exact in logical pixels. The renderer exports it for
                // every text and interactive span; the legacy 7*size estimate remains
                // only for hand-written IR that predates the typography contract.
                int fontPx = span.optInt("fontPx", 0);
                float logicalSize = fontPx > 0 ? fontPx : 7f * Math.max(1, span.optInt("size", 1));
                float textSize = logicalSize * scaleY;
                paint.setTextSize(textSize);
                // Reset every span so a bold/spaced run cannot bleed into the next.
                paint.setTypeface("bold".equals(span.optString("weight", ""))
                        ? boldTypeface : Typeface.DEFAULT);
                // letterSpacing is logical px; Paint.setLetterSpacing takes ems.
                // shortcut: below API 28 letter spacing is skipped, default kept.
                if (Build.VERSION.SDK_INT >= 28) {
                    paint.setLetterSpacing(span.optInt("letterSpacing", 0) / logicalSize);
                }
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
                Paint.FontMetrics fm = paint.getFontMetrics();
                float fontHeight = fm.descent - fm.ascent;
                if (hasOrigin) {
                    // Renderer origin is the glyph-box top-left. Android drawText
                    // takes a baseline, so offset by the real font ascent.
                    anchorX = origin.optInt(0, x) * scaleX;
                    baseline = origin.optInt(1, y) * scaleY - fm.ascent;
                } else if ("center".equals(align)) {
                    anchorX = (left + right) / 2f;
                    baseline = (top + bottom - fontHeight) / 2f - fm.ascent;
                } else if ("end".equals(align)) {
                    anchorX = right - 2f * scaleX;
                    baseline = (top + bottom - fontHeight) / 2f - fm.ascent;
                } else {
                    anchorX = left + 2f * scaleX;
                    baseline = (top + bottom - fontHeight) / 2f - fm.ascent;
                }
                float lineHeight = Math.max(fontHeight + 2f * scaleY, textSize);
                // Only a declared maxLines changes drawing. A missing key keeps
                // the exact legacy split/draw path; a zero cap draws nothing.
                int maxLines = span.has("maxLines") ? span.optInt("maxLines", 0) : -1;
                if (maxLines == 0) {
                    continue;
                }
                float availableWidth = hasOrigin ? right - anchorX
                        : right - left - 4f * scaleX; // two pad() margins
                canvas.save();
                canvas.clipRect(left, top, right, bottom);
                String[] lines = text.split("\\n", -1);
                if (maxLines > 0) {
                    int visible = Math.min(maxLines, lines.length);
                    String[] capped = Arrays.copyOf(lines, visible);
                    // shortcut: last visible line only; the platform glyph is
                    // U+2026, intentionally not the raster layer's ASCII dots.
                    capped[visible - 1] = TextUtils.ellipsize(capped[visible - 1],
                            paint, Math.max(1f, availableWidth), TruncateAt.END).toString();
                    lines = capped;
                }
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

    /** ACTION_DOWN: hit-test the touch point and open the caller-owned press phase. */
    private void onPressDown(float screenX, float screenY) {
        if (lastFrame == null || rendererWidth <= 0 || view.getWidth() <= 0
                || view.getHeight() <= 0) {
            return;
        }
        int x = TouchPhase.toCanvas(screenX, frameScaleX);
        int y = TouchPhase.toCanvas(screenY, frameScaleY);
        int node = OpuromNative.opuHitTest(graphicsIr, stateJson, x, y,
                rendererWidth, rendererHeight);
        press.down(node, x, y, gestureClockMs);
        Log.d(PRESS_TAG, "down node=" + node + " x=" + x + " y=" + y);
        reportPressPhase(press, node != TouchPhase.NO_NODE ? PRESS_DOWN : PRESS_CLEAR, false);
    }

    /**
     * ACTION_UP confirms the press (ABI on=2) and leaves it live so the pump can
     * draw the radius/fade finish. ACTION_CANCEL clears it at once (on=0): there
     * is no cancel channel in the agreed ABI, so cancel takes the clear path.
     */
    private void onPressUp(boolean cancelled) {
        if (!press.isPressed()) {
            Log.d(PRESS_TAG, "up cancelled=" + cancelled + " no press");
            return;
        }
        if (cancelled) {
            reportPressPhase(press, PRESS_CLEAR, press.longPressed);
            press.clear();
            renderFrame();
        } else {
            press.confirm(elapsedMs);
            reportPressPhase(press, PRESS_CONFIRM, press.longPressed);
            // The release tick rides in the setter's tick slot. Keep pumping:
            // on=2 alone cannot draw frames, and the fade is not yet visible.
            startPump();
        }
        Log.d(PRESS_TAG, "up cancelled=" + cancelled + " fade=" + press.isFading());
    }

    /** Clears a confirmed press once its fade window has elapsed. */
    private void clearConfirmedPress() {
        int node = press.node;
        reportPressPhase(press, PRESS_CLEAR, press.longPressed);
        press.clear();
        Log.d(PRESS_TAG, "clear node=" + node + " tick=" + elapsedMs);
    }

    // Gesture semantics enter the host only through the renderer's deadline
    // and tick result. The long-press flag never re-reports the press phase:
    // that would re-stamp press_start_tick and restart the ripple mid-hold.
    private void resetPointers() {
        pointerIds.clear();
        pointerNodes.clear();
    }

    private int nextPointerId() {
        int id = 0;
        while (pointerIds.indexOfValue(id) >= 0) {
            id += 1;
        }
        return id;
    }

    /** Hit-tests one pointer in canvas coordinates; 0 means a miss. */
    private int hitNode(float screenX, float screenY) {
        if (lastFrame == null || rendererWidth <= 0 || view.getWidth() <= 0
                || view.getHeight() <= 0) {
            return 0;
        }
        int x = TouchPhase.toCanvas(screenX, frameScaleX);
        int y = TouchPhase.toCanvas(screenY, frameScaleY);
        return OpuromNative.opuHitTest(graphicsIr, stateJson, x, y,
                rendererWidth, rendererHeight);
    }

    private void onPointerDown(MotionEvent event, int index, int nativeId) {
        int androidId = event.getPointerId(index);
        int node = hitNode(event.getX(index), event.getY(index));
        pointerIds.put(androidId, nativeId);
        pointerNodes.put(androidId, node);
        reportGesturePointer(OpuromNative.POINTER_DOWN, nativeId, node,
                TouchPhase.toCanvas(event.getX(index), frameScaleX),
                TouchPhase.toCanvas(event.getY(index), frameScaleY));
    }

    private void onPointerMove(MotionEvent event, int index) {
        int androidId = event.getPointerId(index);
        int nativeId = pointerIds.get(androidId, -1);
        if (nativeId < 0) {
            return;
        }
        reportGesturePointer(OpuromNative.POINTER_MOVE, nativeId,
                pointerNodes.get(androidId, 0),
                TouchPhase.toCanvas(event.getX(index), frameScaleX),
                TouchPhase.toCanvas(event.getY(index), frameScaleY));
    }

    private void onPointerUp(MotionEvent event, int index) {
        int androidId = event.getPointerId(index);
        int nativeId = pointerIds.get(androidId, -1);
        if (nativeId < 0) {
            return;
        }
        reportGesturePointer(OpuromNative.POINTER_UP, nativeId,
                pointerNodes.get(androidId, 0),
                TouchPhase.toCanvas(event.getX(index), frameScaleX),
                TouchPhase.toCanvas(event.getY(index), frameScaleY));
        pointerIds.delete(androidId);
        pointerNodes.delete(androidId);
    }

    private void cancelRemainingPointers() {
        // CANCEL ignores coordinates in the arena; only the pointer id matters.
        for (int i = pointerIds.size() - 1; i >= 0; i -= 1) {
            int androidId = pointerIds.keyAt(i);
            reportGesturePointer(OpuromNative.POINTER_CANCEL, pointerIds.valueAt(i),
                    pointerNodes.get(androidId, 0), 0, 0);
            pointerIds.delete(androidId);
            pointerNodes.delete(androidId);
        }
    }

    private void reportGesturePointer(int kind, int pointerId, int node, int x, int y) {
        if (renderer == 0) {
            return;
        }
        int status = OpuromNative.opuRendererPointer(renderer, kind, pointerId, node,
                gestureClockMs, x, y, x, y, gestureOut);
        gestureDeadline = OpuromNative.opuRendererNextDeadlineMs(renderer);
        Log.d(PRESS_TAG, "pointer kind=" + kind + " pid=" + pointerId + " node=" + node
                + " t=" + gestureClockMs + " status=" + status + " deadline=" + gestureDeadline);
        if (gestureDeadline >= 0) {
            startPump();
        }
    }

    private void runGestureTicks(long frameTimeNanos) {
        if (renderer == 0) {
            return;
        }
        // Every real frame advances the arena; the renderer turns the supplied
        // timestamp into gesture deadlines, so tick count follows refresh rate.
        long tick = gestureClockMs;
        int status = OpuromNative.opuRendererTickAt(renderer, frameTimeNanos, tick, gestureOut);
        Log.d(PRESS_TAG, "tick t=" + tick + " nanos=" + frameTimeNanos
                + " status=" + status + " code=" + gestureOut[0]);
        if (status == OpuromNative.OK && gestureOut[0] == OpuromNative.GESTURE_LONG_PRESS) {
            if (press.markLongPressed(tick, LONG_PRESS_MS)) {
                Log.d(PRESS_TAG, "long node=" + gestureOut[1]);
            }
        }
        gestureDeadline = OpuromNative.opuRendererNextDeadlineMs(renderer);
    }

    /**
     * Single seam feeding the caller-owned press phase to the renderer
     * (ANIMATION_AND_PHYSICS.md 8). The touch point is the ripple centre and
     * elapsedMs is the caller frame clock the ripple advances on.
     */
    private void reportPressPhase(TouchPhase phase, int mode, boolean longPressed) {
        int node = mode == PRESS_CLEAR ? 0 : phase.node;
        int status = OpuromNative.opuRendererSetPress(renderer, node, elapsedMs,
                phase.x, phase.y, mode);
        Log.d(PRESS_TAG, "phase node=" + phase.node + " on=" + mode
                + " long=" + longPressed + " x=" + phase.x + " y=" + phase.y
                + " status=" + status);
        if (mode != PRESS_CLEAR) {
            // The ripple only moves while the frame clock runs.
            startPump();
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
        String nav = extractNav(out);
        stateJson = trim(out);
        stateJson = stripNav(stateJson);
        if (nav != null) {
            applyNav(nav);
        }
        // A confirmed press still owns the frame clock until its fade ends;
        // resetting here would strand the confirm tick ahead of the clock.
        if (animated && !press.isFading()) {
            elapsedMs = 0;
        }
        renderFrame();
        startPump();
    }

    private static byte[] trim(byte[] data) {
        int length = 0;
        while (length < data.length && data[length] != 0) {
            length += 1;
        }
        return Arrays.copyOf(data, length);
    }

    /** Reads the reserved @nav value from a tap result, or null when absent. */
    private static String extractNav(byte[] data) {
        String json = new String(trim(data), StandardCharsets.UTF_8);
        String key = "\"@nav\":\"";
        int at = json.indexOf(key);
        if (at < 0) {
            return null;
        }
        int from = at + key.length();
        int end = json.indexOf('"', from);
        return end < 0 ? null : json.substring(from, end);
    }

    /** Removes the reserved @nav field so it is not reused as host state. */
    private static byte[] stripNav(byte[] data) {
        String json = new String(data, StandardCharsets.UTF_8);
        String key = "\"@nav\":\"";
        int at = json.indexOf(key);
        if (at < 0) {
            return data;
        }
        int end = json.indexOf('"', at + key.length());
        if (end < 0) {
            return data;
        }
        int valueEnd = end + 1;
        int next = valueEnd;
        if (next < json.length() && json.charAt(next) == ',') {
            next += 1;
        } else if (at > 0 && json.charAt(at - 1) == ',') {
            at -= 1;
        }
        String cleaned = json.substring(0, at) + json.substring(next);
        return cleaned.getBytes(StandardCharsets.UTF_8);
    }

    /** Applies a navigation signal: a route name pushes, ".." pops. */
    private void applyNav(String nav) {
        if ("..".equals(nav)) {
            activeRoute = routeStack.isEmpty() ? null : routeStack.pop();
        } else {
            if (activeRoute != null) {
                routeStack.push(activeRoute);
            }
            activeRoute = nav;
        }
        Log.d(TOUCH_TAG, "nav=" + nav + " active=" + activeRoute);
    }

    /** Renders the current IR and state into a bitmap sized to the view. */
    private void renderFrame() {
        int viewWidth = view.getWidth();
        int viewHeight = view.getHeight();
        if (viewWidth <= 0 || viewHeight <= 0) {
            return;
        }
        // Layout in device-independent pixels. The renderer emits logical
        // coordinates and exact fontPx values in dp; the host converts them to
        // physical pixels once when drawing. Rendering in physical pixels
        // shrinks 24/64/16 dp text by density (420 dpi -> ~0.39x here) and made
        // the calculator unreadable.
        final float density = Math.max(0.5f, getResources().getDisplayMetrics().density);
        int width = Math.max(1, Math.round(viewWidth / density));
        int height = Math.max(1, Math.round(viewHeight / density));
        int pixelLen = width * height * 4;
        if (framePixels == null || framePixels.length != pixelLen) {
            framePixels = new byte[pixelLen];
            frameArgb = new int[width * height];
        }
        byte[] pixels = framePixels;

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
        frameScaleX = (float) viewWidth / width;   // ~= density
        frameScaleY = (float) viewHeight / height; // ~= density
        // Preview path: the kernel rasterizes graphics only; all text is
        // painted by TextLayerView with the host system font.
        if (renderer != 0) {
            OpuromNative.opuRendererSuppressText(renderer, true);
        }
        int status;
        // Pressed or fading frames need the caller clock so the ripple advances
        // through its confirm/fade controllers.
        boolean clocked = animated || press.isPressed() || press.isFading();
        byte[] route = activeRoute == null ? null
                : activeRoute.getBytes(StandardCharsets.UTF_8);
        if (renderer != 0 && clocked) {
            status = OpuromNative.opuRendererFrameAt(renderer, graphicsIr, stateJson,
                    route, elapsedMs, pixels, width, height);
        } else if (renderer != 0) {
            status = OpuromNative.opuRendererFrameRoute(renderer, graphicsIr, stateJson,
                    route, pixels, width, height);
        } else {
            status = OpuromNative.opuFrameSuppressed(graphicsIr, stateJson,
                    pixels, width, height);
        }
        if (status != OpuromNative.OK) {
            throw new IllegalStateException("frame render failed with status " + status);
        }
        byte[] spanBytes = new byte[65536];
        int spanCount = OpuromNative.opuTextSpansRoute(graphicsIr, stateJson, route,
                width, height, spanBytes);
        if (spanCount >= 0) {
            String spanJson = new String(trim(spanBytes), StandardCharsets.UTF_8);
            Log.d("OpuromText", String.format(
                    "view=%dx%d renderer=%dx%d scale=%.3f/%.3f spans=%d %s",
                    viewWidth, viewHeight, width, height, frameScaleX, frameScaleY,
                    spanCount, spanJson.length() > 600 ? spanJson.substring(0, 600) : spanJson));
            textLayer.setSpans(spanJson);
        } else {
            textLayer.clear();
        }
        int[] argb = frameArgb;
        for (int index = 0; index < argb.length; index += 1) {
            int offset = index * 4;
            argb[index] = ((pixels[offset + 3] & 0xff) << 24)
                    | ((pixels[offset] & 0xff) << 16)
                    | ((pixels[offset + 1] & 0xff) << 8)
                    | (pixels[offset + 2] & 0xff);
        }
        if (lastFrame == null || lastFrame.getWidth() != width
                || lastFrame.getHeight() != height) {
            lastFrame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        }
        lastFrame.setPixels(argb, 0, width, 0, 0, width, height);
        view.invalidate();
    }

    /** Replaces the IR program but keeps the current process alive. */
    private void applyIr(byte[] ir) {
        graphicsIr = ir;
        stateJson = "{}".getBytes(StandardCharsets.UTF_8);
        activeRoute = OpuromNative.initialRoute(ir);
        routeStack.clear();
        elapsedMs = 0;
        animated = declaresAnimation(ir);
    }

    /** Opt-in: an IR carrying a timing property drives the fixed-step frame pump. */
    private static boolean declaresAnimation(byte[] ir) {
        String text = new String(ir, StandardCharsets.UTF_8);
        return text.contains("\"animate\"") || text.contains("\"animClock\"")
                || text.contains("\"duration\"");
    }

    private void startPump() {
        if ((!animated && !press.isPressed() && !press.isFading()) || pumpQueued) {
            return;
        }
        pumpQueued = true;
        Choreographer.getInstance().postFrameCallback(framePump);
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
            activity.startPump();
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
