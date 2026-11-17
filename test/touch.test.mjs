// Static contract for the chrome-free host and the touch-to-tap bridge. The
// pixel path is exercised by cargo tests and the on-device smoke, while this
// pins the wiring that a compile alone cannot prove.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const ACTIVITY = read('android/app/src/main/java/org/opurom/mobile/MainActivity.java');
const JAVA = read('jni/OpuromNative.java');
const SHIM = read('jni/opurom_jni.c');
const ABI = read('include/opurom.h');
const RUST = read('src/lib.rs');
const VERIFY = read('verify.mjs');

test('the host draws only IR pixels and has no Java chrome', () => {
  assert.match(ACTIVITY, /static final class IrView extends View/);
  assert.match(ACTIVITY, /protected void onDraw\(Canvas canvas\)/);
  assert.match(ACTIVITY, /canvas\.drawBitmap\(frame, null,/);
  assert.ok(!ACTIVITY.includes('FLAG_FULLSCREEN'), 'status bar stays visible');
  for (const widget of ['TextView', 'ImageView', 'LinearLayout', 'ScrollView', 'Button']) {
    assert.ok(!ACTIVITY.includes(widget), `${widget} must not appear in the host`);
  }
  assert.ok(!/setBackgroundColor\(|setPadding\(|GradientDrawable/.test(ACTIVITY),
    'no Java-owned colours or padding');
  assert.ok(!/createFromAsset|createFromFile/.test(ACTIVITY), 'no authored font file');
});

test('every live pointer keeps its own id and hit target', () => {
  assert.match(ACTIVITY, /MotionEvent\.ACTION_POINTER_DOWN/);
  assert.match(ACTIVITY, /MotionEvent\.ACTION_POINTER_UP/);
  assert.match(ACTIVITY, /event\.getActionIndex\(\)/);
  assert.match(ACTIVITY, /event\.getPointerId\(index\)/);
  // One native id per pointer, so the arena can tell the pointers apart.
  assert.match(ACTIVITY, /private final SparseIntArray pointerIds = new SparseIntArray\(\)/);
  assert.match(ACTIVITY, /private final SparseIntArray pointerNodes = new SparseIntArray\(\)/);
  assert.match(ACTIVITY, /host\.onPointerDown\(event, index, host\.nextPointerId\(\)\)/);
  assert.match(ACTIVITY, /pointerIds\.put\(androidId, nativeId\)/);
  // The pointer id reaches the native ABI, not a hardcoded zero.
  assert.match(ACTIVITY,
    /OpuromNative\.opuRendererPointer\(renderer, kind, pointerId, node,/);
  assert.match(JAVA, /native int opuRendererPointer\(long renderer, int kind, int pointerId,/);
});

test('touch coordinates flow through hit test into tap dispatch', () => {
  assert.match(ACTIVITY, /public boolean onTouchEvent\(MotionEvent event\)/);
  assert.match(ACTIVITY, /MotionEvent\.ACTION_UP/);
  assert.match(ACTIVITY, /OpuromNative\.opuHitTest\(graphicsIr, stateJson, x, y,/);
  assert.match(ACTIVITY, /OpuromNative\.opuTapNode\(graphicsIr, stateJson, node, out\)/);
  assert.match(ACTIVITY, /stateJson = trim\(out\)/);
  assert.match(ACTIVITY, /view\.invalidate\(\)/);
});

test('press phase is captured on DOWN and released on UP or CANCEL', () => {
  assert.match(ACTIVITY, /MotionEvent\.ACTION_DOWN/);
  assert.match(ACTIVITY, /MotionEvent\.ACTION_CANCEL/);
  assert.match(ACTIVITY, /host\.onPressDown\(event\.getX\(index\), event\.getY\(index\)\)/);
  assert.match(ACTIVITY, /host\.onPressUp\(false\)/);
  assert.match(ACTIVITY, /host\.onPressUp\(true\)/);
  assert.match(ACTIVITY, /private static final int LONG_PRESS_MS = 500/);
  assert.match(ACTIVITY, /TouchPhase\.toCanvas\(screenX, frameScaleX\)/);
  assert.match(ACTIVITY, /private void reportPressPhase\(TouchPhase phase/);
  const seams = ACTIVITY.match(/private void reportPressPhase\(/g) || [];
  assert.equal(seams.length, 1, 'the renderer press seam is a single function');
});

test('a confirmed release keeps pumping until the press fade completes', () => {
  assert.match(ACTIVITY, /private static final int PRESS_FADE_MS = 375/);
  assert.match(ACTIVITY, /private static final int PRESS_CONFIRM = 2/);
  assert.match(ACTIVITY, /press\.confirm\(elapsedMs\)/);
  assert.match(ACTIVITY, /reportPressPhase\(press, PRESS_CONFIRM, press\.longPressed\)/);
  assert.match(ACTIVITY, /host\.clearConfirmedPress\(\)/);
  // Every pump/clock gate must treat a fading press as active.
  assert.match(ACTIVITY, /boolean fading = host\.press\.isFading\(\)/);
  assert.match(ACTIVITY, /if \(!held && !fading && !host\.animated\)/);
  assert.match(ACTIVITY, /host\.elapsedMs = \(held \|\| fading\)/);
  assert.match(ACTIVITY, /if \(held \|\| fading \|\| \(host\.animated/);
  assert.match(ACTIVITY, /animated \|\| press\.isPressed\(\) \|\| press\.isFading\(\)/);
  assert.match(ACTIVITY, /!animated && !press\.isPressed\(\) && !press\.isFading\(\)/);
  assert.match(ACTIVITY, /if \(animated && !press\.isFading\(\)\)/);
  // Long press must still not re-report the phase.
  assert.match(ACTIVITY, /never re-reports the press phase/);
  const PHASE = read('android/app/src/main/java/org/opurom/mobile/TouchPhase.java');
  assert.match(PHASE, /boolean isFading\(\)/);
  assert.match(PHASE, /boolean fadeDone\(long frameTick, long fadeMs\)/);
  assert.match(PHASE, /void confirm\(long frameTick\)/);
});

test('the press phase reaches the renderer through the setter ABI', () => {
  assert.match(ACTIVITY,
    /OpuromNative\.opuRendererSetPress\(renderer, node, elapsedMs,/);
  assert.match(ACTIVITY, /int node = mode == PRESS_CLEAR \? 0 : phase\.node;/);
  assert.match(JAVA, /native int opuRendererSetPress\(/);
  assert.ok(SHIM.includes('Java_org_opurom_mobile_OpuromNative_opuRendererSetPress'));
  assert.ok(VERIFY.includes("'Java_org_opurom_mobile_OpuromNative_opuRendererSetPress'"));
  assert.ok(ABI.includes('opu_renderer_set_press('));
  assert.match(RUST, /pub extern "C" fn opu_renderer_set_press\(/);
  assert.ok(VERIFY.includes("'opu_renderer_set_press'"));
  assert.ok(!ACTIVITY.includes('shortcut: render-side press ABI'), 'the seam is wired, not stubbed');
});

test('the hit and tap ABI resolves through Java, C and Rust', () => {
  for (const name of ['opuHitTest', 'opuTapNode']) {
    const symbol = `Java_org_opurom_mobile_OpuromNative_${name}`;
    assert.match(JAVA, new RegExp(`native int ${name}\\(`), `${name} declared in Java`);
    assert.ok(SHIM.includes(symbol), `${symbol} defined in the C shim`);
    assert.ok(VERIFY.includes(symbol), `${symbol} checked by packaging verify`);
  }
  for (const name of ['opu_hit_test', 'opu_tap_node']) {
    assert.ok(ABI.includes(`${name}(`), `${name} declared in the C ABI header`);
    assert.match(RUST, new RegExp(`pub extern "C" fn ${name}\\(`), `${name} implemented in Rust`);
    assert.ok(VERIFY.includes(`'${name}'`), `${name} checked by packaging verify`);
  }
});
