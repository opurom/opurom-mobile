// Native capability call-surface self-check. The typed verdicts and JNI seam
// are pure Java/source facts, so they run on a JVM without an Android runtime.
'use strict';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile');
const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const SYMBOLS = [
  'opuNotifyPost', 'opuNotifyCancel', 'opuCameraCapture', 'opuLocationGet',
];

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
    for (const entry of readdirSync(platforms).sort().reverse()) {
      const jar = path.join(platforms, entry, 'android.jar');
      if (existsSync(jar)) return jar;
    }
  }
  return null;
}

const HARNESS = `
package org.opurom.mobile;

public final class CapabilityCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    public static void main(String[] args) {
        check(CapabilityStatus.from(new IllegalArgumentException("x")) == CapabilityStatus.INVALID, "invalid");
        check(CapabilityStatus.from(new UnsupportedOperationException("x")) == CapabilityStatus.UNSUPPORTED, "unsupported");
        check(CapabilityStatus.from(new SecurityException("x")) == CapabilityStatus.PERMISSION_DENIED, "denied");
        check(CapabilityStatus.from(new IllegalStateException("x")) == CapabilityStatus.INTERNAL, "internal");

        check(CameraBridge.decide(false, true) == CapabilityStatus.NO_HARDWARE, "no camera");
        check(CameraBridge.decide(true, false) == CapabilityStatus.PERMISSION_DENIED, "camera denied");
        check(CameraBridge.decide(true, true) == CapabilityStatus.UNSUPPORTED, "no capture session wired");
        check(CameraBridge.capture(null) == CapabilityStatus.INVALID, "null camera context");

        check(LocationBridge.decide(false, true) == CapabilityStatus.PERMISSION_DENIED, "location denied");
        check(LocationBridge.decide(true, false) == CapabilityStatus.NO_HARDWARE, "no location hardware");
        check(LocationBridge.decide(true, true) == CapabilityStatus.OK, "location gate open");
        check(LocationBridge.get(null, new double[2]) == CapabilityStatus.INVALID, "null location context");
        check(LocationBridge.get(null, null) == CapabilityStatus.INVALID, "null location output");

        check(NotificationBridge.callPost(null, 1, "  ", "t", "b") == CapabilityStatus.INVALID, "blank channel");
        check(NotificationBridge.callCancel(null, 1) == CapabilityStatus.INTERNAL, "no context contained");

        System.out.println("CAPABILITY_CHECKS_OK");
    }
}
`.trim();

test('capability bridges pass typed-degradation checks on a JVM', () => {
  const javac = findJavac();
  const androidJar = findAndroidJar();
  if (!javac || javac === 'javac' || !androidJar) {
    return; // no JDK/android.jar: packaging verify covers compile
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-cap-'));
  const harnessFile = path.join(work, 'CapabilityCheck.java');
  writeFileSync(harnessFile, HARNESS);
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-cp', androidJar, '-d', classes,
    path.join(SRC, 'CapabilityStatus.java'),
    path.join(SRC, 'PermissionBridge.java'),
    path.join(SRC, 'NotificationBridge.java'),
    path.join(SRC, 'CameraBridge.java'),
    path.join(SRC, 'LocationBridge.java'),
    harnessFile], { stdio: 'pipe' });
  const out = execFileSync(javac.replace(/javac$/, 'java'),
    ['-cp', `${classes}${path.delimiter}${androidJar}`, 'org.opurom.mobile.CapabilityCheck'],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(out, /CAPABILITY_CHECKS_OK/);
});

test('the native call surface and manifest match the capability contract', () => {
  const native = readFileSync(path.join(ROOT, 'jni', 'OpuromNative.java'), 'utf8');
  const shim = readFileSync(path.join(ROOT, 'jni', 'opurom_jni.c'), 'utf8');
  const verify = readFileSync(path.join(ROOT, 'verify.mjs'), 'utf8');
  const manifest = readFileSync(MANIFEST, 'utf8');
  for (const name of SYMBOLS) {
    assert.match(native, new RegExp(`native int ${name}\\(`), `${name} declared in Java`);
    const symbol = `Java_org_opurom_mobile_OpuromNative_${name}`;
    assert.ok(shim.includes(symbol), `${symbol} defined in the C shim`);
    assert.ok(verify.includes(symbol), `${symbol} checked by packaging verify`);
  }
  for (const permission of ['CAMERA', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
    assert.ok(manifest.includes(`android.permission.${permission}`), `${permission} declared`);
  }
  assert.match(manifest, /android:name="android.hardware.camera" android:required="false"/);
  assert.match(manifest, /android:name="android.hardware.camera.any" android:required="false"/);
  assert.match(manifest, /android:name="android.hardware.location" android:required="false"/);
});
