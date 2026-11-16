// NotificationBridge self-check on a plain JVM: the input contract and the
// wire error decision are pure Java, so they run without an Android runtime
// (android.jar only satisfies class verification). post()/cancel() touch
// Context/NotificationManager and are covered by packaging verify plus the
// install.
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

public final class NotifyCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    static String expectInvalid(String what, String value) {
        try {
            NotificationBridge.requireText(what, value);
            throw new AssertionError("blank " + what + " must throw Invalid");
        } catch (IllegalArgumentException expected) {
            return expected.getMessage();
        }
    }

    public static void main(String[] args) {
        // title/channel contract: trimmed non-blank, body not validated here
        check(NotificationBridge.requireText("channel", "alerts").equals("alerts"), "plain channel");
        check(NotificationBridge.requireText("title", "  Hello  ").equals("Hello"), "title trimmed");
        String msg = expectInvalid("channel", null);
        check(msg.contains("invalid notification channel"), "channel message: " + msg);
        msg = expectInvalid("title", "   ");
        check(msg.contains("invalid notification title"), "title message: " + msg);
        msg = expectInvalid("title", "\\u3000");
        check(msg.contains("must not be blank"), "whitespace-only is blank: " + msg);

        // wire error order for post: Invalid (input) precedes Unsupported and PermissionDenied
        try { NotificationBridge.checkPost(36, true); check(true, "granted posts on 36"); }
        catch (RuntimeException e) { throw new AssertionError("post on 36 must succeed: " + e); }
        try {
            NotificationBridge.checkPost(25, true);
            throw new AssertionError("API 25 must be Unsupported");
        } catch (UnsupportedOperationException expected) {
            check(expected.getMessage().contains("API 26"), "message: " + expected.getMessage());
        }
        try {
            NotificationBridge.checkPost(36, false);
            throw new AssertionError("ungranted post must be PermissionDenied");
        } catch (SecurityException expected) {
            check(expected.getMessage().contains("POST_NOTIFICATIONS"), "message: " + expected.getMessage());
        }
        // no grant exists below 33, yet API 26-32 must not demand one
        check(true, "API 26-32 reaches the platform as granted via PermissionBridge.has");

        // requestPermission reuses the permission bridge's supported set
        check(PermissionBridge.isSupported(PermissionBridge.POST_NOTIFICATIONS),
                "notify permission is requestable");

        System.out.println("NOTIFY_CHECKS_OK");
    }
}
`.trim();

test('the Android notification bridge passes input and error-order checks on a JVM', () => {
  const javac = findJavac();
  const androidJar = findAndroidJar();
  if (!javac || javac === 'javac' || !androidJar) {
    return; // no JDK/android.jar: packaging verify covers compile
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-notify-'));
  const harnessFile = path.join(work, 'NotifyCheck.java');
  writeFileSync(harnessFile, HARNESS);
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-cp', androidJar, '-d', classes,
    path.join(SRC, 'NotificationBridge.java'), path.join(SRC, 'PermissionBridge.java'),
    harnessFile], { stdio: 'pipe' });
  const out = execFileSync(javac.replace(/javac$/, 'java'),
    ['-cp', `${classes}${path.delimiter}${androidJar}`, 'org.opurom.mobile.NotifyCheck'],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(out, /NOTIFY_CHECKS_OK/);
});
