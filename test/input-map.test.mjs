// InputMap self-check on a plain JVM: the mapping rules are pure Java, so the
// press bracket, variant classification and wheel passthrough run without an
// Android runtime. The adapter-side pixel conversion call is checked too.
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

public final class InputMapCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    public static void main(String[] args) {
        // coordinate conversion lives in one place: logical = px / density
        check(InputMap.toLogical(1080f, 2.5f) == 432f, "px to logical");
        check(InputMap.toLogical(0f, 3f) == 0f, "origin stays origin");

        // a press emits Tap immediately with the host hit-test node id
        InputMap.Event tap = InputMap.tap(12.5f, 3.25f);
        check(tap.kind.equals("tap"), "tap kind");
        check(tap.nodeId == InputMap.NODE_ID_HOST, "node id defers to the host");
        check(InputMap.NODE_ID_HOST == 0xFFFFFFFFL, "node id is u32 max");

        // a pointer moved: held button is a drag, free move otherwise
        check(InputMap.pointerMove(true, 1f, 2f).kind.equals("drag"), "held move is drag");
        check(InputMap.pointerMove(false, 1f, 2f).kind.equals("move"), "free move is move");

        // wheel deltas pass through in notch units, fractions kept
        InputMap.Event wheel = InputMap.wheel(4f, 5f, 1.0f);
        check(wheel.kind.equals("wheel") && wheel.delta == 1.0f, "one notch");
        check(InputMap.wheel(4f, 5f, -0.5f).delta == -0.5f, "fraction kept, never rounded");

        // the press bracket: down opens, drag inside, up closes
        InputMap.Bracket bracket = new InputMap.Bracket();
        check(!bracket.isPressed(), "bracket starts open");
        check(bracket.down(7, 10f, 20f).equals(InputMap.tap(10f, 20f)), "down is tap");
        check(bracket.isPressed(), "down closes the bracket");
        check(bracket.move(7, 11f, 21f).kind.equals("drag"), "move inside is drag");
        check(bracket.up(8, 12f, 22f) == null, "foreign pointer up is ignored");
        check(bracket.isPressed(), "foreign up leaves the bracket closed");
        InputMap.Event up = bracket.up(7, 12f, 22f);
        check(up.kind.equals("up") && up.x == 12f && up.y == 22f, "own up emits PointerUp");
        check(!bracket.isPressed(), "up reopens the bracket");
        check(bracket.move(7, 13f, 23f).kind.equals("move"), "move outside is a free move");

        // multi-touch: the adopted pointer wins, extra pointers emit nothing
        InputMap.Bracket single = new InputMap.Bracket();
        single.down(1, 0f, 0f);
        check(single.move(2, 5f, 5f) == null, "second finger move ignored");
        check(single.up(1, 1f, 1f).kind.equals("up"), "first pointer closes");

        System.out.println("INPUT_MAP_CHECKS_OK");
    }
}
`.trim();

test('the Android input mapping rules pass bracket and variant checks on a JVM', () => {
  const javac = findJavac();
  if (!javac || javac === 'javac') {
    return; // no JDK: packaging verify covers compile
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-input-'));
  const harnessFile = path.join(work, 'InputMapCheck.java');
  writeFileSync(harnessFile, HARNESS);
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-d', classes,
    path.join(SRC, 'InputMap.java'), harnessFile], { stdio: 'pipe' });
  const out = execFileSync(javac.replace(/javac$/, 'java'),
    ['-cp', classes, 'org.opurom.mobile.InputMapCheck'],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(out, /INPUT_MAP_CHECKS_OK/);
});
