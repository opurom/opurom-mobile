// Host frame-clock contract. The Java FrameClock is pure; this test pins its
// formula and simulates 60/120/144 Hz sequences to verify monotonic tick ms
// and refresh-rate-dependent frame counts.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOCK = readFileSync(
  path.join(ROOT, 'android/app/src/main/java/org/opurom/mobile/FrameClock.java'),
  'utf8',
);

test('FrameClock uses the vsync origin and a strictly increasing tick', () => {
  assert.match(CLOCK, /class FrameClock/);
  assert.match(CLOCK, /static long elapsedMs\(long frameTimeNanos, long originNanos\)/);
  assert.match(CLOCK, /static long tickMs\(long frameTimeNanos, long originNanos, long lastMs\)/);
  assert.match(CLOCK, /long next = lastMs >= 0L \? lastMs \+ 1L : 0L;/);
});

test('60/120/144 Hz frame sequences yield monotonic ticks and matching counts', () => {
  const tickMs = (frameTimeNanos, originNanos, lastMs) => {
    const raw = Math.max(0, Math.floor((frameTimeNanos - originNanos) / 1_000_000));
    const next = lastMs >= 0 ? lastMs + 1 : 0;
    return raw > next ? raw : next;
  };
  const origin = 1_000_000_000;
  for (const [hz, periodNs] of [
    [60, 16_666_667],
    [120, 8_333_333],
    [144, 6_944_444],
  ]) {
    let last = -1;
    let frames = 0;
    for (let nanos = origin; nanos < origin + 1_000_000_000; nanos += periodNs) {
      const ms = tickMs(nanos, origin, last);
      assert.ok(ms > last, `${hz} Hz tick must increase`);
      last = ms;
      frames += 1;
    }
    assert.ok(
      Math.abs(frames - hz) <= 1,
      `${hz} Hz must deliver about ${hz} frames per second, got ${frames}`,
    );
  }
});
