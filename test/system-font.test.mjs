// Static contract for the system-font display layer. Pixel-level behaviour is
// covered by cargo tests; this pins the host wiring and the exported ABI names.
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
const HEADER = read('include/opurom.h');
const RUST = read('src/lib.rs');
const VERIFY = read('verify.mjs');
const CARGO = read('Cargo.toml');

test('the host paints system-font text over a graphics-only frame', () => {
  assert.match(ACTIVITY, /textLayer = new TextLayerView\(this\)/);
  assert.match(ACTIVITY, /paint\.setTypeface\(Typeface\.DEFAULT\)/);
  assert.match(ACTIVITY, /canvas\.drawText\(lines\[line\], anchorX,/);
  assert.match(ACTIVITY, /setClickable\(false\)/);
  assert.match(ACTIVITY, /OpuromNative\.opuRendererSuppressText\(renderer, true\)/);
  assert.match(ACTIVITY, /OpuromNative\.opuFrameSuppressed\(graphicsIr, stateJson,/);
  assert.match(ACTIVITY, /OpuromNative\.opuTextSpans\(graphicsIr, stateJson,/);
  assert.match(ACTIVITY, /frameScaleX = \(float\) viewWidth \/ width/);
  assert.match(ACTIVITY, /frameScaleY = \(float\) viewHeight \/ height/);
  assert.match(ACTIVITY, /host\.rendererWidth \* host\.frameScaleX/);
  assert.match(ACTIVITY, /float scaleX = host\.frameScaleX/);
  assert.match(ACTIVITY, /paint\.setTextAlign\(hasOrigin \? Paint\.Align\.LEFT/);
});

test('text span and suppress ABIs resolve through Java, C and Rust', () => {
  const pairs = [
    ['opuTextSpans', 'opu_text_spans'],
    ['opuFrameSuppressed', 'opu_frame_from_ir_suppressed'],
    ['opuRendererSuppressText', 'opu_renderer_set_suppress_text'],
  ];
  for (const [javaName, cName] of pairs) {
    const symbol = `Java_org_opurom_mobile_OpuromNative_${javaName}`;
    assert.match(JAVA, new RegExp(`native int ${javaName}\\(`), `${javaName} declared in Java`);
    assert.ok(SHIM.includes(symbol), `${symbol} defined in the C shim`);
    assert.ok(VERIFY.includes(symbol), `${symbol} checked by packaging verify`);
    assert.ok(HEADER.includes(`${cName}(`), `${cName} declared in the C ABI header`);
    assert.match(RUST, new RegExp(`pub extern "C" fn ${cName}\\(`), `${cName} implemented in Rust`);
    assert.ok(VERIFY.includes(`'${cName}'`), `${cName} checked by packaging verify`);
  }
  assert.match(HEADER, /OPU_SPAN_ERR_OVERFLOW \(-5\)/);
  assert.ok(!/font|ttf|otf/i.test(CARGO), 'no font dependency is introduced');
});
