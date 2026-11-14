package org.opurom.mobile;

import android.animation.ObjectAnimator;
import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.view.WindowManager;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

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
 * OPUROM Android host: a native adaptive shell around one self-drawn OPUROM
 * frame. The frame renders graphics (gradient, particles, cards) through JNI;
 * all typography and controls are native widgets so text uses the platform
 * typeface at every density. The shell reflows from one column on a phone to
 * two columns on a tablet and a navigation rail plus content plus detail
 * column on a desktop-width window.
 */
public final class MainActivity extends Activity {

    private static final String GRAPHICS_IR = "dashboard.opuir.json";
    /** Intent extra selecting which packaged IR asset drives the self-drawn frame. */
    private static final String IR_EXTRA = "org.opurom.mobile.IR";
    /** Packaged IR filenames only; no separators, so a hostile extra cannot escape assets. */
    private static final java.util.regex.Pattern IR_NAME =
            java.util.regex.Pattern.compile("[A-Za-z0-9_-]+\\.opuir\\.json");
    private static final int MAX_FRAME_PIXELS = 1024;

    // IR assets are sealed with AES-256-GCM before packaging so the compiled UI
    // is not readable as plain text from an unpacked APK. The key is derived
    // from a fixed application secret; a determined attacker can still reach the
    // packaged bytes, but the asset is no longer plain text.
    private static final byte[] ASSET_MAGIC = {'O', 'P', 'U', '1'};
    private static final byte[] ASSET_KEY = digestKey("opurom-mobile-asset-key-v1");
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    // Column breakpoints mirror the renderer's width tiers: the shell and the
    // software renderer reflow at the same logical-pixel boundaries.
    private static final int WIDE_COLUMN_DP = 600;
    private static final int THREE_COLUMN_DP = 1200;

    private static final int TIER_COMPACT = 0;
    private static final int TIER_TWO_COLUMN = 1;
    private static final int TIER_THREE_COLUMN = 2;

    private static final String[] VIEWS = {"Overview", "Activity", "Status"};

    private static final String[] TASKS = {
            "Inspect the north array", "Calibrate the panel", "Publish the field report"
    };

    private final boolean[] done = {false, false, false};

    private byte[] graphicsIr;
    private int remaining = 3;
    private boolean dark;

    private ImageView frameView;
    private TextView remainingValue;
    private TextView statusValue;
    private TextView refreshGlyph;
    private LinearLayout taskRows;
    private int lastMeasuredWidth = -1;
    private int lastMeasuredHeight = -1;

    private Bitmap lastFrame;

    // One persistent renderer for the current frame viewport. Rendering through it
    // lets the renderer reuse the previous frame, so a state change recomputes only
    // the dirty region instead of the whole surface. Recreated when the measured
    // viewport changes; zero (disabled) falls back to the one-shot renderer.
    private long renderer;
    private int rendererWidth;
    private int rendererHeight;

    // Detail-column view switching: one stats card and one task card are moved
    // between the detail panels so the selected view shows one live instance.
    private LinearLayout detailContent;
    private LinearLayout statsCard;
    private LinearLayout taskCard;
    private LinearLayout[] navRows = new LinearLayout[VIEWS.length];
    private int activeView;

    // Palette resolved once per configuration; the self-drawn frame keeps its
    // own colours so pixel parity with the software renderer is preserved.
    private int background;
    private int card;
    private int text;
    private int muted;
    private int divider;
    private int accent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        dark = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        resolvePalette();

        System.loadLibrary("opurom_mobile");
        graphicsIr = readAsset(selectedIrAsset());

        getWindow().setStatusBarColor(dark ? 0xFF0B1220 : 0xFF097FEB);
        getWindow().setNavigationBarColor(background);
        requestHighestRefreshRate();

        // Actions live outside the scrollable area so they stay clickable at
        // every scroll offset; a ScrollView child with wrap_content height can
        // otherwise leave its last row outside the touchable bounds.
        LinearLayout root = column(0);
        root.setBackgroundColor(background);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(background);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        LinearLayout page = column(0);
        int pagePad = dp(18);
        page.setPadding(pagePad, dp(18), pagePad, dp(12));
        page.addView(buildHeader());
        page.addView(buildBody(layoutTier(getResources().getConfiguration().screenWidthDp)));
        scroll.addView(page, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout dock = column(0);
        dock.setBackgroundColor(background);
        dock.setPadding(pagePad, dp(10), pagePad, dp(18));
        dock.addView(buildActions());
        dock.addView(buildVersionLine());
        dock.setElevation(dp(10));
        root.addView(dock, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);
    }

    // ------------------------------------------------------------------
    // Layout. Widths are measured in dp so the same structure works from a
    // 320 dp phone to a desktop-width window; the width decides the column
    // count. layoutTier is package-visible so the column rule stays testable
    // without an emulator.
    // ------------------------------------------------------------------
    /** One column below 600 dp, two up to 1199 dp, three at 1200 dp and above. */
    static int layoutTier(int widthDp) {
        if (widthDp >= THREE_COLUMN_DP) return TIER_THREE_COLUMN;
        if (widthDp >= WIDE_COLUMN_DP) return TIER_TWO_COLUMN;
        return TIER_COMPACT;
    }

    private View buildHeader() {
        GradientDrawable bg = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xFF097FEB, 0xFF5B4BEF});
        bg.setCornerRadius(dp(22));

        LinearLayout header = column(dp(20));
        header.setBackground(bg);
        header.setElevation(dp(10));

        TextView brand = label("OPUROM", 24, Typeface.create("sans-serif-medium", Typeface.NORMAL),
                0xFFFFFFFF);
        brand.setLetterSpacing(0.09f);
        header.addView(brand);

        TextView subtitle = label("Field Service  ·  one IR, every screen", 13,
                Typeface.create("sans-serif", Typeface.NORMAL), 0xCCFFFFFF);
        subtitle.setPadding(0, dp(4), 0, 0);
        subtitle.setLetterSpacing(0.02f);
        header.addView(subtitle);

        LinearLayout badgeRow = new LinearLayout(this);
        badgeRow.setOrientation(LinearLayout.HORIZONTAL);
        badgeRow.setPadding(0, dp(14), 0, 0);
        badgeRow.addView(pill("LIVE RENDERER", 0x33FFFFFF, 0xFFFFFFFF));
        badgeRow.addView(pill("v0.1 IR", 0x22000000, 0xDDFFFFFF));
        header.addView(badgeRow);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(18);
        header.setLayoutParams(lp);
        return header;
    }

    private View buildBody(int tier) {
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(tier == TIER_COMPACT ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
        body.setBaselineAligned(false);

        LinearLayout renderer = rendererColumn();
        LinearLayout detail = detailColumn();

        if (tier == TIER_THREE_COLUMN) {
            // Navigation rail, then the renderer column, then the selected detail view.
            body.addView(buildNavRail(), new LinearLayout.LayoutParams(
                    dp(210), LinearLayout.LayoutParams.WRAP_CONTENT));
            body.addView(renderer, weighted(1.15f));
            body.addView(detail, weighted(0.85f));
        } else if (tier == TIER_TWO_COLUMN) {
            body.addView(renderer, weighted(1.15f));
            body.addView(detail, weighted(0.85f));
        } else {
            body.addView(renderer, singleColumnParams());
            LinearLayout.LayoutParams lower = singleColumnParams();
            lower.topMargin = dp(14);
            body.addView(detail, lower);
        }
        return body;
    }

    private LinearLayout rendererColumn() {
        LinearLayout column = cardColumn();
        column.addView(sectionTitle("Renderer output"));
        column.addView(sectionCaption("Self-drawn RGBA frame · gradient, particles, cards"));
        column.addView(buildFrameCard());
        return column;
    }

    private LinearLayout detailColumn() {
        // One detail container; the navigation rail swaps its content per view.
        detailContent = cardColumn();
        buildStatsCard();
        buildTaskCard();
        selectDetail(0);
        return detailContent;
    }

    /**
     * Fills the detail container with the selected view. The stats and task
     * cards are moved rather than rebuilt, so one set of state is on screen at
     * a time instead of two instances of the same card.
     */
    private void selectDetail(int index) {
        activeView = index;
        detailContent.removeAllViews();
        if (index == 1) {
            detailContent.addView(sectionTitle("Tasks"));
            detailContent.addView(taskCard, detailCardParams());
        } else if (index == 2) {
            detailContent.addView(sectionTitle("Session"));
            detailContent.addView(statsCard, detailCardParams());
        } else {
            detailContent.addView(sectionTitle("Session"));
            detailContent.addView(statsCard, detailCardParams());
            detailContent.addView(sectionTitle("Tasks"));
            detailContent.addView(taskCard, detailCardParams());
        }
        for (int i = 0; i < navRows.length; i++) {
            if (navRows[i] != null) refreshNavRow(navRows[i], i == index);
        }
    }

    private void onNav(int index) {
        selectDetail(index);
    }

    private LinearLayout buildNavRail() {
        LinearLayout rail = column(0);
        GradientDrawable railCard = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xFF2A5BD7, 0xFF123C8C});
        railCard.setCornerRadius(dp(16));

        LinearLayout headerCard = column(dp(16));
        headerCard.setBackground(railCard);
        headerCard.addView(label("Navigation", 16,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), 0xFFFFFFFF));
        TextView subtitle = label("one IR, every screen", 11,
                Typeface.create("sans-serif", Typeface.NORMAL), 0xC9DCFF);
        subtitle.setPadding(0, dp(4), 0, 0);
        headerCard.addView(subtitle);
        LinearLayout.LayoutParams headerLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        headerLp.bottomMargin = dp(12);
        headerCard.setLayoutParams(headerLp);
        rail.addView(headerCard);

        for (int i = 0; i < VIEWS.length; i++) {
            navRows[i] = navRow(VIEWS[i], i);
            LinearLayout.LayoutParams lp = singleColumnParams();
            lp.topMargin = dp(8);
            rail.addView(navRows[i], lp);
        }
        return rail;
    }

    private LinearLayout navRow(String name, int index) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(14), dp(12), dp(14), dp(12));
        row.addView(label(name, 13,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), text));
        row.setTag(index);
        row.setOnClickListener(view -> onNav((Integer) view.getTag()));
        refreshNavRow(row, index == 0);
        return row;
    }

    private void refreshNavRow(LinearLayout row, boolean active) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(active ? accent : card);
        shape.setCornerRadius(dp(14));
        shape.setStroke(1, active ? card : divider);
        row.setBackground(shape);
        TextView textView = (TextView) row.getChildAt(0);
        textView.setTextColor(active ? 0xFFFFFFFF : text);
    }

    private LinearLayout.LayoutParams weighted(float weight) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, weight);
        params.leftMargin = dp(9);
        return params;
    }

    private LinearLayout.LayoutParams singleColumnParams() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams detailCardParams() {
        LinearLayout.LayoutParams params = singleColumnParams();
        params.topMargin = dp(12);
        return params;
    }

    private View buildFrameCard() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);

        FrameLayout holder = new FrameLayout(this);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(card);
        shape.setCornerRadius(dp(18));
        shape.setStroke(1, divider);
        holder.setBackground(shape);
        holder.setElevation(dp(6));

        frameView = new ImageView(this);
        // The frame is rendered at the view's measured size, so FIT_XY maps
        // pixel-for-pixel without distortion.
        frameView.setScaleType(ImageView.ScaleType.FIT_XY);
        frameView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        holder.addView(frameView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(frameHeight())));

        // A window can change size without recreating the Activity; re-render
        // whenever the measured viewport changes so the frame stays tier-sized.
        frameView.addOnLayoutChangeListener((view, left, top, right, bottom,
                oldLeft, oldTop, oldRight, oldBottom) -> renderFrameIfSizeChanged());
        frameView.post(this::renderFrame);
        column.addView(holder);

        // Native typography sits below the self-drawn frame, never on top of
        // it: deep ink on the surface keeps the hybrid caption readable over
        // any rendered background without overlapping the frame's own text.
        TextView caption = label("OPUROM / NATIVE HYBRID", 11,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), 0xFF5A6478);
        caption.setLetterSpacing(0.14f);
        LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        captionParams.topMargin = dp(10);
        captionParams.gravity = Gravity.CENTER_HORIZONTAL;
        column.addView(caption, captionParams);
        return column;
    }

    private View buildStatsCard() {
        LinearLayout box = paddedCard();
        statsCard = box;
        remainingValue = label(String.valueOf(remaining), 46,
                Typeface.create("sans-serif-light", Typeface.NORMAL), accent);
        remainingValue.setIncludeFontPadding(false);
        box.addView(remainingValue);
        box.addView(label("tasks remaining", 13,
                Typeface.create("sans-serif", Typeface.NORMAL), muted));

        View bar = new View(this);
        GradientDrawable track = new GradientDrawable();
        track.setColor(divider);
        track.setCornerRadius(dp(6));
        bar.setBackground(track);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(8));
        barLp.topMargin = dp(16);
        box.addView(bar, barLp);

        GradientDrawable progress = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xFF097FEB, 0xFF5B4BEF});
        progress.setCornerRadius(dp(6));
        View fill = new View(this);
        fill.setBackground(progress);
        LinearLayout.LayoutParams fillLp = new LinearLayout.LayoutParams(0, dp(8), 0.62f);
        box.addView(fill, fillLp);

        statusValue = label("SYNCED  ·  frame deterministic", 12,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), 0xFF137A4B);
        statusValue.setPadding(0, dp(12), 0, 0);
        statusValue.setLetterSpacing(0.03f);
        box.addView(statusValue);
        return box;
    }

    private View buildTaskCard() {
        LinearLayout box = paddedCard();
        taskCard = box;
        taskRows = column(0);
        for (int i = 0; i < TASKS.length; i++) {
            taskRows.addView(buildTaskRow(i));
        }
        box.addView(taskRows);
        return box;
    }

    private View buildTaskRow(int index) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(9), 0, dp(9));

        TextView marker = label(done[index] ? "✓" : "○", 18,
                Typeface.create("sans-serif-medium", Typeface.NORMAL),
                done[index] ? 0xFF137A4B : muted);
        marker.setMinWidth(dp(30));
        row.addView(marker);

        TextView title = label(TASKS[index], 14,
                Typeface.create("sans-serif", Typeface.NORMAL), text);
        row.addView(title, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        row.setTag(index);
        row.setOnClickListener(view -> {
            int i = (Integer) view.getTag();
            done[i] = !done[i];
            TextView m = (TextView) ((LinearLayout) view).getChildAt(0);
            m.setText(done[i] ? "✓" : "○");
            m.setTextColor(done[i] ? 0xFF137A4B : muted);
            animatePress(m);
        });
        return row;
    }

    private View buildActions() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(2);
        bar.setLayoutParams(lp);

        LinearLayout refresh = actionButton("Refresh", 0xFF097FEB, 0xFF5B4BEF);
        refreshGlyph = (TextView) refresh.getChildAt(0);
        refreshGlyph.setText("⟳  REFRESH");
        refresh.setOnClickListener(view -> onRefresh());
        LinearLayout.LayoutParams refreshLp = new LinearLayout.LayoutParams(0, dp(52), 1f);
        bar.addView(refresh, refreshLp);

        LinearLayout reset = actionButton("Reset", card, card);
        ((TextView) reset.getChildAt(0)).setText("RESET");
        ((TextView) reset.getChildAt(0)).setTextColor(accent);
        reset.setOnClickListener(view -> onReset());
        LinearLayout.LayoutParams resetLp = new LinearLayout.LayoutParams(0, dp(52), 0.55f);
        resetLp.leftMargin = dp(12);
        bar.addView(reset, resetLp);
        return bar;
    }

    private void onRefresh() {
        remaining += 1;
        animateNumber(remainingValue, String.valueOf(remaining));
        ObjectAnimator spin = ObjectAnimator.ofFloat(refreshGlyph, "rotation", 0f, 360f);
        spin.setDuration(520);
        spin.setInterpolator(new DecelerateInterpolator());
        spin.start();
        statusValue.setText("RE-RENDERED  ·  frame deterministic");
        renderFrame();
    }

    private void onReset() {
        remaining = 0;
        animateNumber(remainingValue, String.valueOf(remaining));
        statusValue.setText("RESET  ·  frame deterministic");
        for (int i = 0; i < done.length; i++) {
            done[i] = false;
            LinearLayout row = (LinearLayout) taskRows.getChildAt(i);
            TextView m = (TextView) row.getChildAt(0);
            m.setText("○");
            m.setTextColor(muted);
        }
        renderFrame();
    }

    // ------------------------------------------------------------------
    // Self-drawn frame. The viewport follows the actual view size, so the
    // frame fills its card instead of sitting centered at a fixed 480x320.
    // ------------------------------------------------------------------
    private void renderFrame() {
        if (frameView == null) return;
        int measuredWidth = frameView.getWidth();
        int measuredHeight = frameView.getHeight();
        if (measuredWidth <= 0 || measuredHeight <= 0) return;
        lastMeasuredWidth = measuredWidth;
        lastMeasuredHeight = measuredHeight;

        // The renderer lays out in logical pixels: feed it dp, not raw device
        // pixels, so the breakpoint tier matches the host and a phone frame is
        // laid out compact instead of stretched over a wide-viewport grid.
        float density = getResources().getDisplayMetrics().density;
        int width = Math.max(1, (int) (measuredWidth / density));
        int height = Math.max(1, (int) (measuredHeight / density));
        // Render at the view's aspect ratio: capping both dimensions by the same
        // factor keeps the bitmap proportional, so FIT_XY fills the card without
        // letterbox bars or a stretched frame at wide window sizes.
        float scale = Math.min(1f, MAX_FRAME_PIXELS / Math.max(width, height));
        width = Math.max(1, (int) (width * scale));
        height = Math.max(1, (int) (height * scale));

        byte[] state = ("{\"remaining\":" + remaining + "}")
                .getBytes(StandardCharsets.UTF_8);
        byte[] pixels = new byte[width * height * 4];
        // Keep one renderer per viewport so the renderer can reuse the previous
        // frame. Recreate it when the measured viewport changes; if creation fails,
        // fall back to the one-shot renderer rather than failing the frame.
        if (renderer != 0
                && (rendererWidth != width || rendererHeight != height)) {
            OpuromNative.opuRendererFree(renderer);
            renderer = 0;
        }
        if (renderer == 0) {
            renderer = OpuromNative.opuRendererNew(width, height);
            if (renderer != 0) {
                rendererWidth = width;
                rendererHeight = height;
            }
        }
        int status = renderer != 0
            ? OpuromNative.opuRendererFrame(renderer, graphicsIr, state, pixels, width, height)
            : OpuromNative.opuFrameFromIr(graphicsIr, state, pixels, width, height);
        if (status != OpuromNative.OK) {
            throw new IllegalStateException("frame render failed with status " + status);
        }
        int[] argb = new int[width * height];
        for (int index = 0; index < argb.length; index++) {
            int offset = index * 4;
            argb[index] = ((pixels[offset + 3] & 0xff) << 24)
                    | ((pixels[offset] & 0xff) << 16)
                    | ((pixels[offset + 1] & 0xff) << 8)
                    | (pixels[offset + 2] & 0xff);
        }
        Bitmap next = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888);
        next = rounded(next, dp(18));
        if (lastFrame != null) {
            frameView.setAlpha(0.35f);
            frameView.animate().alpha(1f).setDuration(280).start();
        }
        frameView.setImageBitmap(next);
        lastFrame = next;
    }

    // The frame view can change size without a state change; re-render only when
    // its measured viewport actually changed so a reflow is not re-rendered twice.
    private void renderFrameIfSizeChanged() {
        if (frameView == null) return;
        int measuredWidth = frameView.getWidth();
        int measuredHeight = frameView.getHeight();
        if (measuredWidth <= 0 || measuredHeight <= 0) return;
        if (measuredWidth == lastMeasuredWidth && measuredHeight == lastMeasuredHeight) return;
        renderFrame();
    }

    // ------------------------------------------------------------------
    // Widgets and motion.
    // ------------------------------------------------------------------
    private void animatePress(View view) {
        ObjectAnimator.ofFloat(view, "scaleX", 1f, 0.9f, 1f).setDuration(220).start();
        ObjectAnimator.ofFloat(view, "scaleY", 1f, 0.9f, 1f).setDuration(220).start();
    }

    private void animateNumber(TextView view, String value) {
        view.animate().alpha(0.25f).setDuration(110)
                .withEndAction(() -> {
                    view.setText(value);
                    view.animate().alpha(1f).setDuration(180).start();
                }).start();
    }

    private LinearLayout actionButton(String name, int start, int end) {
        GradientDrawable shape = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT, new int[]{start, end});
        shape.setCornerRadius(dp(14));
        GradientDrawable pressed = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT, new int[]{start, end});
        pressed.setCornerRadius(dp(14));
        pressed.setAlpha(210);
        RippleDrawable ripple = new RippleDrawable(
                ColorStateList.valueOf(0x66FFFFFF), shape, shape);
        LinearLayout button = new LinearLayout(this);
        button.setBackground(ripple);
        button.setGravity(Gravity.CENTER);
        button.setElevation(dp(6));
        TextView text = label(name.toUpperCase(), 13,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), 0xFFFFFFFF);
        text.setLetterSpacing(0.08f);
        button.addView(text);
        button.setOnTouchListener((view, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) {
                view.animate().scaleX(0.96f).scaleY(0.96f).setDuration(90).start();
            } else if (event.getAction() == android.view.MotionEvent.ACTION_UP
                    || event.getAction() == android.view.MotionEvent.ACTION_CANCEL) {
                view.animate().scaleX(1f).scaleY(1f)
                        .setInterpolator(new OvershootInterpolator()).setDuration(240).start();
            }
            return false;
        });
        return button;
    }

    private void requestHighestRefreshRate() {
        // Devices expose 90/120 Hz modes; pick the fastest supported mode so
        // scrolling and press animations are not capped at 60 Hz.
        WindowManager.LayoutParams attrs = getWindow().getAttributes();
        float best = 0f;
        for (android.view.Display.Mode mode : getDisplay().getSupportedModes()) {
            if (mode.getRefreshRate() > best) {
                best = mode.getRefreshRate();
                attrs.preferredDisplayModeId = mode.getModeId();
            }
        }
        if (best > 0f) getWindow().setAttributes(attrs);
    }

    private Bitmap rounded(Bitmap source, int radius) {
        Bitmap out = Bitmap.createBitmap(source.getWidth(), source.getHeight(),
                Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        android.graphics.RectF rect = new android.graphics.RectF(
                0, 0, source.getWidth(), source.getHeight());
        canvas.drawRoundRect(rect, radius, radius, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(source, 0, 0, paint);
        source.recycle();
        return out;
    }

    private TextView buildVersionLine() {
        String version = "";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {
            // The package is always installed while this Activity runs.
        }
        TextView view = label("OPUROM  ·  v" + (version == null ? "0.1.0" : version)
                        + "  ·  API 36  ·  NDK r27c", 10,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), muted);
        view.setLetterSpacing(0.08f);
        view.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        view.setLayoutParams(lp);
        return view;
    }

    // ------------------------------------------------------------------
    // Small helpers. All sizes come from dp/sp so density never changes the
    // visual proportions; the palette is the only configuration-dependent part.
    // ------------------------------------------------------------------
    private void resolvePalette() {
        if (dark) {
            background = 0xFF0B1220;
            card = 0xFF16223A;
            text = 0xFFF2F6FF;
            muted = 0xFF98A6C0;
            divider = 0xFF2A3A57;
        } else {
            background = 0xFFF4F7FC;
            card = 0xFFFFFFFF;
            text = 0xFF101828;
            muted = 0xFF667085;
            divider = 0xFFDCE5F2;
        }
        accent = 0xFF097FEB;
    }

    private LinearLayout column(int pad) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        if (pad > 0) layout.setPadding(pad, pad, pad, pad);
        return layout;
    }

    private LinearLayout cardColumn() {
        LinearLayout layout = column(0);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout paddedCard() {
        LinearLayout layout = column(dp(18));
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(card);
        shape.setCornerRadius(dp(18));
        shape.setStroke(1, divider);
        layout.setBackground(shape);
        layout.setElevation(dp(6));
        return layout;
    }

    private TextView sectionTitle(String value) {
        TextView view = label(value.toUpperCase(), 12,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), muted);
        view.setLetterSpacing(0.12f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(3);
        view.setLayoutParams(lp);
        return view;
    }

    private TextView sectionCaption(String value) {
        TextView view = label(value, 12,
                Typeface.create("sans-serif", Typeface.NORMAL), muted);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(12);
        view.setLayoutParams(lp);
        return view;
    }

    private TextView label(String value, float sizeSp, Typeface face, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTypeface(face);
        view.setTextColor(color);
        return view;
    }

    private TextView pill(String value, int background, int foreground) {
        TextView view = label(value, 10,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), foreground);
        view.setLetterSpacing(0.10f);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(background);
        shape.setCornerRadius(dp(20));
        view.setBackground(shape);
        int h = dp(9);
        int v = dp(5);
        view.setPadding(h, v, h, v);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        view.setLayoutParams(lp);
        return view;
    }

    // The frame is taller as more vertical room appears: the desktop tier has
    // room for the rail, the renderer column and the detail column side by side.
    // A compact frame stacks the whole tree into one column, so it needs more
    // height than the desktop tiers to show more than the first card; the page
    // itself scrolls, so a taller frame never pushes the actions off screen.
    private int frameHeight() {
        int tier = layoutTier(getResources().getConfiguration().screenWidthDp);
        if (tier == TIER_THREE_COLUMN) return 300;
        if (tier == TIER_TWO_COLUMN) return 260;
        return 320;
    }

    private int dp(float value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics());
    }

    /** Resolve the requested IR asset from the launch intent, with a safe default. */
    private String selectedIrAsset() {
        String requested = getIntent() == null ? null : getIntent().getStringExtra(IR_EXTRA);
        if (requested == null || !IR_NAME.matcher(requested).matches()) {
            return GRAPHICS_IR;
        }
        return requested;
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

    // Sealed assets carry the magic, a 12-byte IV and a GCM tag; the tag is the
    // final 16 bytes of the blob handed to doFinal so tampering fails loudly.
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

    @Override
    protected void onDestroy() {
        if (renderer != 0) {
            OpuromNative.opuRendererFree(renderer);
            renderer = 0;
        }
        super.onDestroy();
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
        if (data.length < prefix.length) return false;
        for (int i = 0; i < prefix.length; i += 1) {
            if (data[i] != prefix[i]) return false;
        }
        return true;
    }
}
