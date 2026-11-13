#!/usr/bin/env node
// Builds an installable, signed Android APK for on-device testing.
//
// The pipeline uses only the tools the Android SDK and JDK already provide:
// aapt2 (resources + manifest), javac + d8 (app classes), the NDK-built JNI
// shared objects produced by verify.mjs, zipalign, keytool and apksigner.
// Every step is a real tool invocation with a bounded timeout; a missing tool
// is reported as a concrete error naming what to install. No fake success.
//
// Output: dist/opurom-mobile-debug.apk, ready for `adb install`.
'use strict';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, statSync, utimesSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(ROOT, 'target', 'verify');
const JNI_LIBS = path.join(ROOT, 'target', 'android', 'jniLibs');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = path.join(DIST, 'opurom-mobile-debug.apk');
const KEYSTORE = path.join(DIST, 'opurom-debug.jks');
const STORE_PASS = 'android';
const KEY_ALIAS = 'opuromdebug';
const ABI = ['arm64-v8a', 'x86_64'];

let step = 0;
function say(message) {
  step += 1;
  console.log(`[${step}] ${message}`);
}
function die(message, detail) {
  console.error(`error: ${message}`);
  if (detail) console.error(String(detail).trim());
  process.exit(1);
}

// Every child is bounded; a timeout kills it rather than leaving a process.
function run(label, argv, { timeoutMs = 120000, cwd = ROOT } = {}) {
  const [cmd, ...args] = argv;
  const started = Date.now();
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const ok = res.status === 0 && !res.error && !res.signal;
  return {
    ok,
    ms: Date.now() - started,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    detail: `${res.stdout || ''}\n${res.stderr || ''}`.trim() || res.error?.message || res.signal || '',
  };
}

// Toolchain roots are resolved at runtime so a downloaded JDK/SDK folder name
// never has to be hardcoded. Environment overrides come first.
function toolchainRoots() {
  const roots = [];
  const sibling = path.resolve(ROOT, '..', '..', 'toolchains');
  const parent = path.resolve(ROOT, '..', 'toolchains');
  if (existsSync(sibling)) roots.push(sibling);
  if (existsSync(parent) && parent !== sibling) roots.push(parent);
  return roots;
}
function subdirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => path.join(root, name)).filter((p) => statSync(p).isDirectory());
}
function deepest(root, maxDepth = 2) {
  const out = [];
  const walk = (dir, depth) => {
    out.push(dir);
    if (depth < maxDepth) for (const sub of subdirs(dir)) walk(sub, depth + 1);
  };
  for (const top of subdirs(root)) walk(top, 0);
  return out;
}

function findJdk() {
  const bins = [];
  if (process.env.JAVA_HOME) bins.push(path.join(process.env.JAVA_HOME, 'bin'));
  if (process.env.OPUROM_JAVAC) bins.push(path.dirname(process.env.OPUROM_JAVAC));
  for (const root of toolchainRoots()) {
    for (const dir of deepest(root)) {
      bins.push(path.join(dir, 'Contents', 'Home', 'bin'), path.join(dir, 'bin'));
    }
  }
  for (const bin of bins) {
    if (['java', 'javac', 'keytool'].every((t) => existsSync(path.join(bin, t)))) return bin;
  }
  return null;
}

function findSdk() {
  const candidates = [];
  for (const name of ['OPR_ANDROID_SDK', 'ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[name]) candidates.push(process.env[name]);
  }
  for (const root of toolchainRoots()) for (const dir of deepest(root)) candidates.push(dir);
  return candidates.find((c) => c && existsSync(path.join(c, 'platforms'))) || null;
}

// The build-tools release must carry every tool this pipeline invokes; newer
// releases may ship only a subset.
function findBuildTools(sdk) {
  const root = path.join(sdk, 'build-tools');
  if (!existsSync(root)) return null;
  const needed = ['aapt2', 'zipalign', 'apksigner'];
  const versions = readdirSync(root).sort().reverse();
  for (const version of versions) {
    const dir = path.join(root, version);
    if (needed.every((t) => existsSync(path.join(dir, t))) && existsSync(path.join(dir, 'lib', 'd8.jar'))) {
      return dir;
    }
  }
  return null;
}
function findPlatform(sdk) {
  const root = path.join(sdk, 'platforms');
  const installed = existsSync(root) ? readdirSync(root).sort().reverse()
    .filter((api) => statSync(path.join(root, api)).isDirectory()) : [];
  const available = installed.filter((api) => existsSync(path.join(root, api, 'android.jar')));
  const requested = process.env.OPR_ANDROID_API;
  const selected = requested
    ? (installed.includes(requested) ? requested : `android-${requested}`)
    : available[0];
  if (!available.includes(selected)) {
    if (requested) {
      die(`OPR_ANDROID_API=${requested} has no android.jar (available: ${available.join(', ') || 'none'}; installed: ${installed.join(', ') || 'none'})`);
    }
    return null;
  }
  return { api: selected.replace(/^android-/, ''), jar: path.join(root, selected, 'android.jar') };
}

function check(ok, label, result) {
  if (!ok) die(`${label} failed`, result?.detail);
  say(`${label} OK (${result.ms}ms)`);
}

// ---------------------------------------------------------------------
say('resolve the Android toolchain');
const jdkBin = findJdk();
if (!jdkBin) die('JDK 21 with java, javac and keytool not found (set JAVA_HOME)');
const sdk = findSdk();
if (!sdk) die('Android SDK not found (set OPR_ANDROID_SDK or ANDROID_HOME)');
const buildTools = findBuildTools(sdk);
if (!buildTools) die('build-tools with aapt2, zipalign, apksigner and d8.jar not found');
const platform = findPlatform(sdk);
if (!platform) die('no platforms/android-*/android.jar in the SDK');
const androidJar = platform.jar;
const java = path.join(jdkBin, 'java');
const javac = path.join(jdkBin, 'javac');
const keytool = path.join(jdkBin, 'keytool');
const aapt2 = path.join(buildTools, 'aapt2');
const zipalign = path.join(buildTools, 'zipalign');
const apksigner = path.join(buildTools, 'apksigner');
const d8Jar = path.join(buildTools, 'lib', 'd8.jar');
for (const abi of ABI) {
  const lib = path.join(JNI_LIBS, abi, 'libopurom_mobile.so');
  if (!existsSync(lib)) {
    die(`JNI library ${lib} is missing`, 'Run `node verify.mjs` first to build the NDK shared objects.');
  }
}
say(`toolchain: JDK ${jdkBin}, SDK ${sdk}, build-tools ${path.basename(buildTools)}`);

mkdirSync(DIST, { recursive: true });
const stage = mkdtempSync(path.join(os.tmpdir(), 'opurom-apk-'));
process.on('exit', () => rmSync(stage, { recursive: true, force: true }));
const classesDir = path.join(stage, 'classes');
const aaptWork = path.join(stage, 'aapt2');
const dexWork = path.join(stage, 'dex');
for (const dir of [classesDir, aaptWork, dexWork]) mkdirSync(dir, { recursive: true });

// The apksigner/zipalign scripts need JAVA_HOME; run() inherits process.env, so
// set it once for every remaining child.
process.env.JAVA_HOME = path.dirname(jdkBin);
process.env.PATH = `${jdkBin}${path.delimiter}${process.env.PATH || ''}`;

// ---------------------------------------------------------------------
const appSources = [
  path.join(ROOT, 'jni', 'OpuromNative.java'),
  path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile', 'MainActivity.java'),
];
let r = run('javac', [
  javac, '--release', '17', '-d', classesDir, '-cp', androidJar,
  '-sourcepath', path.join(ROOT, 'android', 'app', 'src', 'main', 'java') + path.delimiter + path.join(ROOT, 'jni'),
  ...appSources,
]);
check(r.ok && existsSync(path.join(classesDir, 'org', 'opurom', 'mobile', 'MainActivity.class')), 'javac app classes', r);

// Anonymous listeners compile to nest-mate classes; d8 requires every one of
// them on its program path, so collect the whole javac output rather than
// naming two files.
function classFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.class')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

r = run('d8', [
  java, '-cp', d8Jar, 'com.android.tools.r8.D8', '--lib', androidJar,
  '--min-api', '24', '--output', dexWork,
  ...classFiles(classesDir),
]);
const dex = path.join(dexWork, 'classes.dex');
check(r.ok && existsSync(dex), 'd8 classes.dex', r);

const resZip = path.join(aaptWork, 'res.zip');
r = run('aapt2 compile', [
  aapt2, 'compile', '--dir', path.join(ROOT, 'android', 'app', 'src', 'main', 'res'), '-o', resZip,
]);
check(r.ok, 'aapt2 compile resources', r);

const baseApk = path.join(aaptWork, 'base.apk');
r = run('aapt2 link', [
  aapt2, 'link', '-o', baseApk, '-I', androidJar,
  '-A', path.join(ROOT, 'android', 'app', 'src', 'main', 'assets'),
  '--manifest', path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  resZip,
]);
check(r.ok && existsSync(baseApk), 'aapt2 link base APK', r);

// ---------------------------------------------------------------------
// Assemble: the base APK holds manifest/resources/assets; add the dex and
// both ABI shared objects. resources.arsc must stay uncompressed so zipalign
// can page-align it; -0 stores it, zipalign handles the rest.
say('assemble APK entries');
const tree = path.join(stage, 'tree');
mkdirSync(tree, { recursive: true });
r = run('unpack base APK', ['unzip', '-q', '-o', baseApk, '-d', tree]);
check(r.ok, 'unpack base APK', r);
copyFileSync(dex, path.join(tree, 'classes.dex'));
for (const abi of ABI) {
  const dest = path.join(tree, 'lib', abi);
  mkdirSync(dest, { recursive: true });
  copyFileSync(path.join(JNI_LIBS, abi, 'libopurom_mobile.so'), path.join(dest, 'libopurom_mobile.so'));
}

// Fixed entry timestamps keep the ZIP bytes deterministic across rebuilds.
function stampTree(dir) {
  const when = new Date('2020-01-01T00:00:00Z');
  const walk = (current) => {
    utimesSync(current, when, when);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else utimesSync(full, when, when);
    }
  };
  walk(dir);
}
stampTree(tree);

const unsigned = path.join(stage, 'unsigned.apk');
r = run('zip stored entries', [
  'zip', '-q', '-0', unsigned, 'AndroidManifest.xml', 'resources.arsc',
], { cwd: tree });
check(r.ok, 'zip stored entries', r);
r = run('zip remaining entries', [
  'zip', '-q', '-r', unsigned, 'classes.dex', 'assets', 'lib', 'res',
], { cwd: tree });
check(r.ok, 'zip remaining entries', r);

const aligned = path.join(stage, 'aligned.apk');
r = run('zipalign', [zipalign, '-f', '-p', '4', unsigned, aligned]);
check(r.ok, 'zipalign 4-byte boundaries', r);
r = run('zipalign verify', [zipalign, '-c', '-v', '4', aligned]);
check(r.ok, 'zipalign verification', r);

// ---------------------------------------------------------------------
// A stable debug keystore keeps the signature stable across rebuilds, so
// `adb install -r` can replace an earlier build on the same device.
if (!existsSync(KEYSTORE)) {
  r = run('keytool debug keystore', [
    keytool, '-genkeypair', '-keystore', KEYSTORE,
    '-storepass', STORE_PASS, '-keypass', STORE_PASS, '-alias', KEY_ALIAS,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=OPUROM Debug, OU=OPUROM, O=OPUROM, L=Unknown, ST=Unknown, C=US',
  ]);
  check(r.ok, 'keytool debug keystore', r);
} else {
  say('reuse the existing debug keystore');
}

r = run('apksigner sign', [
  apksigner, 'sign', '--ks', KEYSTORE, '--ks-pass', `pass:${STORE_PASS}`,
  '--ks-key-alias', KEY_ALIAS, '--key-pass', `pass:${STORE_PASS}`,
  '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
  '--v3-signing-enabled', 'true', '--out', OUTPUT, aligned,
]);
check(r.ok && existsSync(OUTPUT), 'apksigner v1+v2+v3 signature', r);

// ---------------------------------------------------------------------
r = run('apksigner verify', [apksigner, 'verify', '--verbose', OUTPUT]);
check(r.ok && /Verifies/.test(r.stdout), 'apksigner verification', r);
const schemes = ['v1', 'v2', 'v3'].filter((s) => new RegExp(`Verified using ${s} scheme[^:]*: true`).test(r.stdout));
if (schemes.length !== 3) die('the APK is not signed with all three schemes', r.stdout);

r = run('aapt2 badging', [aapt2, 'dump', 'badging', OUTPUT]);
const launchable = /launchable-activity: name='([^']+)'/.exec(r.stdout);
check(r.ok && launchable, 'aapt2 launchable activity', r);

const bytes = readFileSync(OUTPUT);
const sha256 = createHash('sha256').update(bytes).digest('hex');
say(`APK ready: ${OUTPUT} | API ${platform.api} | build-tools ${path.basename(buildTools)}`);
console.log(`package: org.opurom.mobile | launchable: ${launchable[1]} | schemes: ${schemes.join('+')}`);
console.log(`size: ${statSync(OUTPUT).size} bytes | sha256: ${sha256}`);
console.log('install: adb install -r dist/opurom-mobile-debug.apk');
