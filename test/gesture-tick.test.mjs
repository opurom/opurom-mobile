// Static contract for the gesture arena host tick: C ABI shapes, error code,
// JNI/verify plumbing and the Android logical-clock pump. The Rust unit tests
// carry the runtime gesture decisions; this pins cross-layer wiring.
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
const JNI_H = read('jni/opurom_jni.h');
const ABI = read('include/opurom.h');
const RUST = read('src/lib.rs');
const VERIFY = read('verify.mjs');

test('gesture tick ABI keeps the -1 sentinel and time error in all layers', () => {
  assert.match(ABI, /#define OPU_ERR_TIME 8/);
  assert.match(RUST, /pub const OPU_ERR_TIME: i32 = 8;/);
  assert.match(JAVA, /public static final int ERR_TIME = 8;/);
  assert.match(ABI, /typedef struct \{\s*uint32_t kind;/);
  assert.match(RUST, /#\[repr\(C\)\][\s\S]*?pub struct OpuPointerEvent/);
  assert.match(ABI, /typedef struct \{\s*uint32_t code;/);
  assert.match(RUST, /#\[repr\(C\)\][\s\S]*?pub struct OpuGesture/);
  assert.match(ABI, /int64_t opu_renderer_next_deadline_ms\(OpuRenderer \*renderer\);/);
  assert.match(RUST, /pub extern "C" fn opu_renderer_next_deadline_ms\(/);
  assert.match(RUST, /\.unwrap_or\(-1\)/, 'i64::MAX is not collapsed into the sentinel');
});

test('three ABI functions resolve through Java, JNI, headers and verify', () => {
  for (const [javaName, cName] of [
    ['opuRendererPointer', 'opu_renderer_pointer'],
    ['opuRendererNextDeadlineMs', 'opu_renderer_next_deadline_ms'],
    ['opuRendererTick', 'opu_renderer_tick'],
    ['opuRendererTickAt', 'opu_renderer_tick_at'],
    ['opuRendererFrameTimeNanos', 'opu_renderer_frame_time_nanos'],
  ]) {
    assert.match(JAVA, new RegExp(`native .* ${javaName}\\\(`), `${javaName} declared in Java`);
    const symbol = `Java_org_opurom_mobile_OpuromNative_${javaName}`;
    assert.ok(SHIM.includes(symbol), `${symbol} defined in the C shim`);
    assert.ok(JNI_H.includes(symbol), `${symbol} declared in the JNI header`);
    assert.ok(VERIFY.includes(`'${symbol}'`), `${symbol} checked by packaging verify`);
    assert.ok(ABI.includes(`${cName}(`), `${cName} declared in the C ABI header`);
    assert.match(RUST, new RegExp(`pub extern "C" fn ${cName}\\\(`), `${cName} implemented in Rust`);
    assert.ok(VERIFY.includes(`'${cName}'`), `${cName} checked by packaging verify`);
  }
});

test('Android feeds monotonic vsync-derived ticks from the frame pump', () => {
  assert.match(ACTIVITY, /host\.runGestureTicks\(frameTimeNanos\);/);
  assert.match(ACTIVITY, /OpuromNative\.opuRendererTickAt\(renderer, frameTimeNanos, tick, gestureOut\)/);
  assert.match(ACTIVITY, /FrameClock\.elapsedMs\(frameTimeNanos, host\.lastFrameNanos\)/);
  assert.match(ACTIVITY, /FrameClock\.tickMs\(frameTimeNanos,\s*host\.gestureOriginNanos/);
  assert.ok(!ACTIVITY.includes('FRAME_STEP_MS'), 'no fixed-step host accumulation');
  assert.ok(!/SystemClock\.uptimeMillis/.test(ACTIVITY), 'no wall clock in the host gesture path');
});

test('multi-pointer dispatch still feeds the same logical clock', () => {
  assert.match(ACTIVITY, /OpuromNative\.opuRendererPointer\(renderer, kind, pointerId, node,/);
  assert.match(ACTIVITY, /OpuromNative\.opuRendererNextDeadlineMs\(renderer\)/);
  assert.match(ACTIVITY, /reportGesturePointer\(OpuromNative\.POINTER_DOWN, nativeId, node,/);
  assert.match(ACTIVITY, /reportGesturePointer\(OpuromNative\.POINTER_MOVE, nativeId,/);
  assert.match(ACTIVITY, /reportGesturePointer\(OpuromNative\.POINTER_UP, nativeId,/);
  assert.match(ACTIVITY, /reportGesturePointer\(OpuromNative\.POINTER_CANCEL, pointerIds\.valueAt\(i\),/);
  assert.match(ACTIVITY, /press\.markLongPressed\(tick, LONG_PRESS_MS\)/);
});
