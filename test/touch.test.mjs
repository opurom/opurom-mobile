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
  assert.match(ACTIVITY, /FLAG_FULLSCREEN/);
  for (const widget of ['TextView', 'ImageView', 'LinearLayout', 'ScrollView', 'Button']) {
    assert.ok(!ACTIVITY.includes(widget), `${widget} must not appear in the host`);
  }
  assert.ok(!/setBackgroundColor\(|setPadding\(|GradientDrawable/.test(ACTIVITY),
    'no Java-owned colours or padding');
  assert.ok(!/createFromAsset|createFromFile/.test(ACTIVITY), 'no authored font file');
});

test('touch coordinates flow through hit test into tap dispatch', () => {
  assert.match(ACTIVITY, /public boolean onTouchEvent\(MotionEvent event\)/);
  assert.match(ACTIVITY, /MotionEvent\.ACTION_UP/);
  assert.match(ACTIVITY, /OpuromNative\.opuHitTest\(graphicsIr, stateJson, x, y,/);
  assert.match(ACTIVITY, /OpuromNative\.opuTapNode\(graphicsIr, stateJson, node, out\)/);
  assert.match(ACTIVITY, /stateJson = trim\(out\)/);
  assert.match(ACTIVITY, /view\.invalidate\(\)/);
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
