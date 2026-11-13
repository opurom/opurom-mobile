package org.opurom.mobile;

import android.animation.ObjectAnimator;
import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
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

/**
 * OPUROM Android host: a native adaptive shell around one self-drawn OPUROM
 * frame. The frame renders graphics (gradient, particles, cards) through JNI;
 * all typography and controls are native widgets so text uses the platform
 * typeface at every density. Narrow screens use one column, wide screens two.
 */
public final class MainActivity extends Activity {

    private static final String GRAPHICS_IR = "dashboard.opuir.json";
    private static final int MAX_FRAME_PIXELS = 1024;
    private static final int WIDE_COLUMN_DP = 600;

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
    private Bitmap lastFrame;

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
        graphicsIr = readAsset(GRAPHICS_IR);

        getWindow().setStatusBarColor(dark ? 0xFF0B1220 : 0xFF097FEB);
        getWindow().setNavigationBarColor(background);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(background);
        scroll.setFillViewport(true);

        LinearLayout page = column(0);
        int pagePad = dp(18);
        page.setPadding(pagePad, dp(18), pagePad, dp(28));

        page.addView(buildHeader());
        page.addView(buildBody());
        page.addView(buildActions());
        scroll.addView(page, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
    }

    // ------------------------------------------------------------------
    // Layout. Widths are measured in dp so the same structure works from a
    // 320 dp phone to a tablet; the breakpoint only changes the column count.
    // ------------------------------------------------------------------
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

    private View buildBody() {
        boolean wide = getResources().getConfiguration().screenWidthDp >= WIDE_COLUMN_DP;
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        body.setBaselineAligned(false);

        LinearLayout left = cardColumn();
        left.addView(sectionTitle("Renderer output"));
        left.addView(sectionCaption("Self-drawn RGBA frame · gradient, particles, cards"));
        left.addView(buildFrameCard());

        LinearLayout right = cardColumn();
        right.addView(sectionTitle("Session"));
        right.addView(buildStatsCard());
        right.addView(sectionTitle("Tasks"));
        right.addView(buildTaskCard());

        if (wide) {
            LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 1.15f);
            a.rightMargin = dp(9);
            LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 0.85f);
            b.leftMargin = dp(9);
            body.addView(left, a);
            body.addView(right, b);
        } else {
            body.addView(left, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            LinearLayout.LayoutParams lower = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lower.topMargin = dp(14);
            body.addView(right, lower);
        }
        return body;
    }

    private View buildFrameCard() {
        FrameLayout holder = new FrameLayout(this);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(card);
        shape.setCornerRadius(dp(18));
        shape.setStroke(1, divider);
        holder.setBackground(shape);
        holder.setElevation(dp(6));

        frameView = new ImageView(this);
        frameView.setScaleType(ImageView.ScaleType.FIT_XY);
        holder.addView(frameView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(wideFrameHeight())));

        // Native typography sits above the self-drawn frame: this is the
        // documented hybrid mode, not a second renderer.
        LinearLayout overlay = column(dp(14));
        overlay.setGravity(Gravity.BOTTOM);
        TextView caption = label("OPUROM / NATIVE HYBRID", 11,
                Typeface.create("sans-serif-medium", Typeface.NORMAL), 0xFFFFFFFF);
        caption.setLetterSpacing(0.14f);
        caption.setShadowLayer(dp(2), 0, dp(1), 0x88000000);
        overlay.addView(caption);
        holder.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        frameView.post(this::renderFrame);
        return holder;
    }

    private View buildStatsCard() {
        LinearLayout box = paddedCard();
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
        lp.topMargin = dp(20);
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
        int width = frameView.getWidth();
        int height = frameView.getHeight();
        if (width <= 0 || height <= 0) return;
        width = Math.min(width, MAX_FRAME_PIXELS);
        height = Math.min(height, MAX_FRAME_PIXELS);

        byte[] state = ("{\"remaining\":" + remaining + "}")
                .getBytes(StandardCharsets.UTF_8);
        byte[] pixels = new byte[width * height * 4];
        int status = OpuromNative.opuFrameFromIr(graphicsIr, state, pixels, width, height);
        if (status != OpuromNative.OK) {
            throw new IllegalStateException("opu_frame_from_ir failed with status " + status);
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
        if (lastFrame != null) {
            frameView.setAlpha(0.35f);
            frameView.animate().alpha(1f).setDuration(280).start();
        }
        frameView.setImageBitmap(next);
        lastFrame = next;
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

    private int wideFrameHeight() {
        return getResources().getConfiguration().screenWidthDp >= WIDE_COLUMN_DP ? 230 : 200;
    }

    private int dp(float value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics());
    }

    private byte[] readAsset(String name) {
        try (InputStream input = getAssets().open(name)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) {
                bytes.write(chunk, 0, count);
            }
            return bytes.toByteArray();
        } catch (IOException error) {
            throw new IllegalStateException("cannot read IR asset " + name, error);
        }
    }
}
