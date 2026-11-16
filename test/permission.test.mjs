// PermissionBridge self-check on a plain JVM: the grant verdict routing and
// the supported-permission contract are pure Java, so they run without an
// Android runtime (android.jar only satisfies class verification). has()/request()
// touch Context/Activity and are covered by packaging verify plus the install.
'use strict';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

function findAndroidJar() {
  const home = os.homedir();
  const roots = [];
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  roots.push(
    path.join(home, 'android-sdk'),
    path.join(home, 'work', 'toolchains', 'android-sdk'),
  );
  for (const root of roots) {
    const platforms = path.join(root, 'platforms');
    if (!existsSync(platforms)) continue;
    const entries = readdirSync(platforms).sort().reverse();
    for (const entry of entries) {
      const jar = path.join(platforms, entry, 'android.jar');
      if (existsSync(jar)) return jar;
    }
  }
  return null;
}

const HARNESS = `
package org.opurom.mobile;

public final class PermissionCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }
    static String take1 = null;
    static boolean take2 = false;
    static int calls = 0;
    static PermissionBridge.Callback sink =
            (permission, granted) -> { take1 = permission; take2 = granted; calls += 1; };

    public static void main(String[] args) {
        // supported set
        check(PermissionBridge.isSupported(PermissionBridge.RECORD_AUDIO), "record supported");
        check(PermissionBridge.isSupported(PermissionBridge.POST_NOTIFICATIONS), "notifications supported");
        check(!PermissionBridge.isSupported("android.permission.CAMERA"), "camera not declared here");
        check(!PermissionBridge.isSupported(""), "empty is unsupported");
        try {
            PermissionBridge.require("android.permission.CAMERA");
            check(false, "require must reject an undeclared permission");
        } catch (IllegalArgumentException expected) {
            check(expected.getMessage().contains("unsupported permission"), "message: " + expected.getMessage());
        }

        // verdict mapping
        check(PermissionBridge.granted(new int[] {0}), "0 is granted");
        check(!PermissionBridge.granted(new int[] {-1}), "-1 is denied");
        check(!PermissionBridge.granted(new int[0]), "empty is denied");
        check(!PermissionBridge.granted(null), "null is denied");

        // a foreign request code neither consumes nor fires the pending slot
        PermissionBridge.begin(PermissionBridge.RECORD_AUDIO, sink);
        check(!PermissionBridge.dispatch(123, new String[] {PermissionBridge.RECORD_AUDIO}, new int[] {0}),
                "foreign code ignored");
        check(calls == 0, "foreign code must not fire the callback");

        // the matching code delivers once, then the slot is consumed
        check(PermissionBridge.dispatch(PermissionBridge.REQUEST_CODE,
                new String[] {PermissionBridge.RECORD_AUDIO}, new int[] {0}), "own code consumed");
        check(calls == 1, "callback fires exactly once");
        check(PermissionBridge.RECORD_AUDIO.equals(take1), "permission name delivered");
        check(take2, "granted verdict delivered");
        check(!PermissionBridge.dispatch(PermissionBridge.REQUEST_CODE,
                new String[] {PermissionBridge.RECORD_AUDIO}, new int[] {0}), "second dispatch is a no-op");
        check(calls == 1, "consumed slot must not fire again");

        // denied verdicts round-trip as false, not as an exception
        PermissionBridge.begin(PermissionBridge.POST_NOTIFICATIONS, sink);
        check(PermissionBridge.dispatch(PermissionBridge.REQUEST_CODE,
                new String[] {PermissionBridge.POST_NOTIFICATIONS}, new int[] {-1}), "denied consumed");
        check(calls == 2 && !take2, "denied verdict delivered as false");

        System.out.println("PERMISSION_CHECKS_OK");
    }
}
`.trim();

test('the Android permission bridge passes verdict-routing checks on a JVM', () => {
  const javac = findJavac();
  const androidJar = findAndroidJar();
  if (!javac || javac === 'javac' || !androidJar) {
    return; // no JDK/android.jar: packaging verify covers compile
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-perm-'));
  const harnessFile = path.join(work, 'PermissionCheck.java');
  writeFileSync(harnessFile, HARNESS);
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-cp', androidJar, '-d', classes,
    path.join(SRC, 'PermissionBridge.java'), harnessFile], { stdio: 'pipe' });
  const out = execFileSync(javac.replace(/javac$/, 'java'),
    ['-cp', `${classes}${path.delimiter}${androidJar}`, 'org.opurom.mobile.PermissionCheck'],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(out, /PERMISSION_CHECKS_OK/);
});
