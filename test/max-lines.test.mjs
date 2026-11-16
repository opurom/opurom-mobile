// Static contract for the opt-in maxLines branch of the system-font overlay.
// The drawing itself is verified on the emulator; this pins the Java decisions
// that keep the no-key path byte-identical and the declared paths distinct.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const ACTIVITY = read('android/app/src/main/java/org/opurom/mobile/MainActivity.java');
const README = read('README.md');

test('maxLines is opt-in via JSON key presence, with zero drawing nothing', () => {
  assert.match(ACTIVITY, /span\.has\("maxLines"\)/);
  assert.match(ACTIVITY, /int maxLines = span\.has\("maxLines"\) \? span\.optInt\("maxLines", 0\) : -1;/);
  assert.match(ACTIVITY, /if \(maxLines == 0\) \{\s*continue;\s*\}/);
});

test('a declared line cap ellipsizes the last visible line with the platform glyph', () => {
  assert.match(ACTIVITY, /private final TextPaint paint = new TextPaint\(Paint\.ANTI_ALIAS_FLAG\);/);
  assert.match(ACTIVITY, /int visible = Math\.min\(maxLines, lines\.length\);/);
  assert.match(ACTIVITY, /TextUtils\.ellipsize\(capped\[visible - 1\],/);
  assert.match(ACTIVITY, /TruncateAt\.END/);
  assert.match(README, /U\+2026 glyph; the raster\n  layer keeps ASCII dots/);
});

test('the legacy no-key path keeps its split and draw calls unchanged', () => {
  assert.match(ACTIVITY, /String\[\] lines = text\.split\("\\\\n", -1\);/);
  assert.match(ACTIVITY, /canvas\.drawText\(lines\[line\], anchorX,/);
  assert.match(ACTIVITY, /canvas\.clipRect\(left, top, right, bottom\);/);
  const ellipsize = ACTIVITY.indexOf('TextUtils.ellipsize(');
  const draw = ACTIVITY.indexOf('canvas.drawText(lines[line], anchorX,');
  const split = ACTIVITY.indexOf('String[] lines = text.split("\\\\n", -1);');
  assert.ok(split > 0 && ellipsize > split && draw > ellipsize,
      'ellipsize runs after the split and before the unchanged draw loop');
});
