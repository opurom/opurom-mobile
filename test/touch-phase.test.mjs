// TouchPhase self-check on a plain JVM: the press phase is pure Java, so the
// coordinate inverse, long-press gate and DOWN/UP pairing run without Android.
'use strict';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile');

function findJavac() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javac'));
  candidates.push(
    path.join(home, 'java', 'temurin-21', 'Contents', 'Home', 'bin', 'javac'),
    path.join(home, 'work', 'toolchains', 'jdk-download', 'jdk-21.0.13+9', 'Contents', 'Home', 'bin', 'javac'),
  );
  candidates.push('javac');
  return candidates.find((c) => c === 'javac' || existsSync(c)) ?? null;
}

const HARNESS = `
package org.opurom.mobile;

public final class TouchPhaseCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    public static void main(String[] args) {
        // frameScale inverse roundtrip: canvas -> screen -> canvas.
        for (float scale : new float[] {1f, 0.5f, 2f, 1.7f}) {
            for (int canvas = 0; canvas <= 1080; canvas += 135) {
                float screen = canvas * scale;
                check(TouchPhase.toCanvas(screen, scale) == canvas,
                    "roundtrip canvas=" + canvas + " scale=" + scale);
            }
        }
        check(TouchPhase.toCanvas(216f, 2f) == 108, "half scale inverse");
        check(TouchPhase.toCanvas(0f, 2f) == 0, "origin stays origin");
        check(TouchPhase.toCanvas(100f, 0f) == 0, "zero scale is rejected");

        TouchPhase p = new TouchPhase();
        check(!p.isPressed() && p.node == TouchPhase.NO_NODE, "starts open");

        // DOWN / UP pairing with a hit node.
        check(p.down(12, 100, 200, 1000L), "down on a hit node");
        check(p.isPressed() && p.node == 12 && p.x == 100 && p.y == 200 && p.downMs == 1000L,
            "down records node, coords and time");
        check(!p.markLongPressed(1000L + 499L, 500L), "before timeout is not long");
        check(p.markLongPressed(1000L + 500L, 500L), "at timeout is long");
        check(!p.markLongPressed(1000L + 900L, 500L), "long fires once only");

        // CONFIRM keeps the press live through the fade window.
        check(!p.isFading() && !p.fadeDone(2000L, 375L), "no fade before confirm");
        p.confirm(2000L);
        check(p.isPressed() && p.isFading(), "confirm keeps press and starts fade");
        check(!p.fadeDone(2000L + 374L, 375L), "fade still active just before end");
        check(p.fadeDone(2000L + 375L, 375L), "fade done at the window end");
        p.confirm(9999L);
        check(p.confirmTick == 2000L, "confirm is idempotent once");

        p.clear();
        check(!p.isPressed() && p.node == TouchPhase.NO_NODE && !p.longPressed
            && !p.isFading(), "up clears the press and fade");

        // A missed DOWN cannot become a long press.
        check(!p.down(TouchPhase.NO_NODE, 5, 6, 0L), "miss opens no press");
        check(!p.markLongPressed(5000L, 500L), "miss cannot long press");
        check(!p.isFading(), "miss cannot fade");

        // A new DOWN on the same node resets confirm state.
        check(p.down(12, 1, 2, 7000L), "second down on same node");
        check(!p.isFading() && p.confirmTick == 0L, "down resets confirm");

        System.out.println("TOUCH_PHASE_CHECKS_OK");
    }
}
`.trim();

test('the press phase passes coordinate and pairing checks on a JVM', () => {
  const javac = findJavac();
  if (!javac || javac === 'javac') {
    return; // no JDK: packaging verify covers compile
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-touch-'));
  const harnessFile = path.join(work, 'TouchPhaseCheck.java');
  writeFileSync(harnessFile, HARNESS);
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-d', classes,
    path.join(SRC, 'TouchPhase.java'), harnessFile], { stdio: 'pipe' });
  const out = execFileSync(javac.replace(/javac$/, 'java'),
    ['-cp', classes, 'org.opurom.mobile.TouchPhaseCheck'],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(out, /TOUCH_PHASE_CHECKS_OK/);
});
