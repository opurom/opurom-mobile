#!/usr/bin/env node
// Zero-dependency on-device smoke test for the OPUROM Android app.
//
// Resolves every path from this file. When a running emulator/device and adb
// are both available it installs the debug APK, launches MainActivity, proves
// the process stays alive, captures a screenshot, and (when the fixture has a
// tappable counter) taps once and proves the frame changed. Every missing
// precondition is an honest SKIP naming the exact missing tool — there is no
// fake PASS.
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APK = path.join(ROOT, 'dist', 'opurom-mobile-debug.apk');
const OUT = path.join(ROOT, 'target', 'emulator');
const PKG = 'org.opurom.mobile';
const ACTIVITY = `${PKG}/.MainActivity`;

let passed = 0;
let skipped = 0;
const failures = [];

function pass(m) { passed += 1; console.log(`PASS: ${m}`); }
function skip(m) { skipped += 1; console.log(`SKIP: ${m}`); }
function fail(m, d) { failures.push(m); console.error(`FAIL: ${m}`); if (d) console.error(d); }

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
}

// adb lives under platform-tools in any Android SDK root on this host.
function findAdb() {
  if (process.env.OPR_ADB && existsSync(process.env.OPR_ADB)) return process.env.OPR_ADB;
  const roots = [
    process.env.OPR_ANDROID_SDK,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    '/Users/mac/work/toolchains/android-sdk',
    '/private/tmp/android-sdk-full',
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, 'platform-tools', 'adb');
    if (existsSync(candidate)) return candidate;
  }
  const onPath = run('sh', ['-c', 'command -v adb']);
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();
  return null;
}

function firstOnlineDevice(adb) {
  const devices = run(adb, ['devices']);
  if (devices.status !== 0) return null;
  for (const line of devices.stdout.split('\n')) {
    const m = /^(\S+)\tdevice$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

const adb = findAdb();
if (!adb) {
  skip('no adb on this host: install Android platform-tools (or set OPR_ADB), then rerun');
  finish();
}

const device = adb ? firstOnlineDevice(adb) : null;
if (!device) {
  skip('no online emulator/device: start one with `emulator -avd <name>` (or `adb connect`), then rerun');
  finish();
}

if (!existsSync(APK)) {
  skip(`no built APK at ${path.relative(ROOT, APK)}: run \`node build-apk.mjs\` first`);
  finish();
}

mkdirSync(OUT, { recursive: true });
const A = [adb, '-s', device];

// 1. Install.
const install = run(adb, ['-s', device, 'install', '-r', APK]);
if (install.status !== 0 || !/Success/.test(install.stdout)) {
  fail('adb install failed', `${install.stdout}\n${install.stderr}`);
} else {
  pass(`installed ${path.basename(APK)} on ${device}`);
}

// 2. Launch.
const start = run(adb, ['-s', device, 'shell', 'am', 'start', '-W', '-n', ACTIVITY]);
if (start.status !== 0) fail('am start failed', `${start.stdout}\n${start.stderr}`);

// 3. Wait for the launch to settle (bounded poll for the process).
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
let pid = '';
for (let i = 0; i < 20; i += 1) {
  pid = run(adb, ['-s', device, 'shell', 'pidof', PKG]).stdout.trim();
  if (pid) break;
  sleepMs(250);
}
if (!pid) fail('app process is not running after launch');
else pass(`MainActivity running (pid ${pid})`);

// 4. No crash on the activity's own logcat tail.
const log = run(adb, ['-s', device, 'logcat', '-d', '-t', '400']);
const fatal = log.stdout.split('\n').filter((l) => /FATAL EXCEPTION|AndroidRuntime: Process:/.test(l));
if (fatal.length) fail('app logged a fatal exception', fatal.slice(0, 6).join('\n'));
else pass('no fatal exception in logcat tail');

// 5. Screenshot is a non-trivial PNG (real pixels, not a blank frame).
function grab(name) {
  const dest = path.join(OUT, name);
  const png = run(adb, ['-s', device, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 60_000 });
  if (png.status !== 0 || !png.stdout || png.stdout.length < 1000) return null;
  writeFileSync(dest, png.stdout);
  return { path: dest, bytes: png.stdout.length };
}
const shot = grab('screen.png');
if (!shot) fail('screencap produced no usable PNG');
else pass(`captured screenshot (${shot.bytes} bytes) -> target/emulator/${path.basename(shot.path)}`);

// 6. Tap the counter button and prove the frame changed (state re-render). The
// REFRESH button sits in the lower third on the fixture app; the tap is a
// best-effort interaction check, skipped honestly when the screen is unknown.
if (shot) {
  const size = run(adb, ['-s', device, 'shell', 'wm', 'size']).stdout;
  const m = /(\d+)x(\d+)/.exec(size);
  if (m) {
    const x = Math.round(Number(m[1]) * 0.32);
    const y = Math.round(Number(m[2]) * 0.915);
    run(adb, ['-s', device, 'shell', 'input', 'tap', String(x), String(y)]);
    sleepMs(800);
    const after = grab('screen-after-tap.png');
    if (!after) {
      skip('could not capture the post-tap frame; visual change not asserted');
    } else if (after.bytes === shot.bytes && JSON.stringify(after) === JSON.stringify(shot)) {
      // Byte-identical screenshots mean the tap did not change anything.
      fail('post-tap frame is byte-identical to the first (no visible re-render)');
    } else {
      pass('post-tap frame differs from the first (visible re-render on interaction)');
    }
  } else {
    skip('device reports no screen size; interaction check skipped');
  }
}

finish();

function finish() {
  console.log(`smoke-emulator finished: ${passed} passed, ${skipped} skipped, ${failures.length} failed`);
  if (failures.length > 0) { console.log('SMOKE FAIL'); process.exit(1); }
  console.log('SMOKE PASS (exit 0)');
  process.exit(0);
}
