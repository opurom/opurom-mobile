#!/usr/bin/env node
// Zero-dependency verifier for the OPUROM R6 mobile workstream.
// Resolves every path from this file, so it runs from any working directory
// (including the umbrella workspace root). Each child process is bounded by a
// spawn timeout; nothing is left running after this script exits.
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.join(ROOT, 'target', 'aarch64-apple-ios', 'release', 'libopurom_mobile.a');
const WORK = path.join(ROOT, 'target', 'verify');

const failures = [];
let passed = 0;
let skipped = 0;

function pass(message) {
  passed += 1;
  console.log(`PASS: ${message}`);
}

function skip(message) {
  skipped += 1;
  console.log(`SKIP: ${message}`);
}

function fail(message, detail) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
  if (detail) console.error(detail);
}

function childEnv() {
  const env = { ...process.env };
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  if (!env.PATH) env.PATH = cargoBin;
  else if (!env.PATH.split(path.delimiter).includes(cargoBin)) {
    env.PATH = `${cargoBin}${path.delimiter}${env.PATH}`;
  }
  env.CARGO_TERM_COLOR = 'never';
  return env;
}

// Every step is bounded; a timeout kills the child and fails that step.
// argv[0] is the executable, the rest are its arguments.
function run(label, argv, { timeoutMs = 60000, cwd = ROOT } = {}) {
  const [cmd, ...args] = argv;
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: childEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  if (res.error) {
    return { ok: false, ms, stdout, stderr: `${stderr}\n${res.error.message}` };
  }
  return { ok: res.status === 0, ms, status: res.status, stdout, stderr };
}

function firstLine(text) {
  return (text || '').split('\n')[0];
}

// Non-macOS hosts get a documented SKIP and exit 0 by design.
if (process.platform !== 'darwin') {
  skip('verify requires macOS (xcrun, lipo, iPhoneOS SDK); this host is ' +
    process.platform + '. Documented: no iOS build on non-macOS hosts.');
  console.log('VERIFY SKIP (exit 0)');
  process.exit(0);
}

mkdirSync(WORK, { recursive: true });
mkdirSync(path.join(WORK, 'module-cache'), { recursive: true });
mkdirSync(path.join(WORK, 'classes'), { recursive: true });

console.log(`verify root: ${ROOT}`);

// --- 1. Rust unit tests for the pure state machine (native host target) ---
const testRun = run('cargo test', ['cargo', 'test', '--offline', '--lib'], { timeoutMs: 120000 });
if (testRun.ok) {
  const summary = testRun.stdout.split('\n').find((line) => line.startsWith('test result:')) || '';
  pass(`cargo unit tests: ${summary} (${testRun.ms}ms)`);
} else {
  fail('cargo unit tests failed', `${testRun.stdout}\n${testRun.stderr}`);
}

// --- 2. Cross-compile the staticlib for aarch64-apple-ios (offline) ---
const buildStart = Date.now();
const build = run('cargo build', [
  'cargo', 'build', '--release', '--target', 'aarch64-apple-ios', '--offline',
], { timeoutMs: 240000 });
const buildMs = Date.now() - buildStart;
if (!build.ok) {
  fail('cargo build --release --target aarch64-apple-ios --offline failed',
    `${build.stdout}\n${build.stderr}`);
} else if (!existsSync(ARCHIVE)) {
  fail(`archive missing after successful build: ${ARCHIVE}`);
} else {
  const bytes = statSync(ARCHIVE).size;
  console.log(`archive: ${ARCHIVE}`);
  console.log(`archive size: ${bytes} bytes`);
  pass(`aarch64-apple-ios staticlib built: ${ARCHIVE} (${bytes} bytes, ${buildMs}ms)`);

  // --- 3. Evidence: real ar archive, arm64, iOS load commands ---
  const fileRun = run('file', ['file', ARCHIVE], { timeoutMs: 30000 });
  if (fileRun.ok && /current ar archive/.test(fileRun.stdout)) {
    pass(`file: ${firstLine(fileRun.stdout)}`);
  } else {
    fail('file(1) did not report a real ar archive', fileRun.stdout || fileRun.stderr);
  }

  const lipoRun = run('lipo', ['lipo', '-info', ARCHIVE], { timeoutMs: 30000 });
  if (lipoRun.ok && /:\s*arm64\s*$/.test(lipoRun.stdout) &&
      !/armv7|arm64e|x86_64|i386/.test(lipoRun.stdout)) {
    pass(`lipo -info: ${firstLine(lipoRun.stdout)}`);
  } else {
    fail('lipo -info did not report a single arm64 slice',
      lipoRun.stdout || lipoRun.stderr);
  }

  const otoolRun = run('otool', ['otool', '-l', ARCHIVE], { timeoutMs: 60000 });
  if (otoolRun.ok &&
      /LC_VERSION_MIN_IPHONEOS|LC_BUILD_VERSION/.test(otoolRun.stdout)) {
    const marker = /LC_VERSION_MIN_IPHONEOS/.test(otoolRun.stdout)
      ? 'LC_VERSION_MIN_IPHONEOS' : 'LC_BUILD_VERSION';
    pass(`otool -l: iOS load command present (${marker})`);
  } else {
    fail('otool -l did not show an iOS platform load command',
      otoolRun.stdout || otoolRun.stderr);
  }
}

// --- 4. Swift wrapper typecheck against the C header via the module map ---
const sdkRun = run('xcrun', ['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'],
  { timeoutMs: 30000 });
if (!sdkRun.ok) {
  fail('xcrun cannot locate the iPhoneOS SDK', sdkRun.stderr);
} else {
  const sdkPath = sdkRun.stdout.trim();
  const swift = run('swiftc', [
    'xcrun', '--sdk', 'iphoneos', 'swiftc', '-typecheck',
    '-target', 'arm64-apple-ios17.0',
    '-sdk', sdkPath,
    '-I', path.join(ROOT, 'swift'),
    '-I', path.join(ROOT, 'include'),
    '-module-cache-path', path.join(WORK, 'module-cache'),
    path.join(ROOT, 'swift', 'OpuromMobile.swift'),
  ], { timeoutMs: 120000 });
  if (swift.ok) {
    pass(`swift typecheck OK: xcrun --sdk iphoneos swiftc -typecheck (${swift.ms}ms, sdk ${sdkPath})`);
  } else {
    fail('swift typecheck failed', `${swift.stdout}\n${swift.stderr}`);
  }
}

// --- 5. JNI: javac compile of the Java declaration ---
function findJavac() {
  const candidates = [];
  if (process.env.OPUROM_JAVAC) candidates.push(process.env.OPUROM_JAVAC);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javac'));
  // Restored Temurin JDK 21 used by this host's R6 run (outside the repo).
  candidates.push(path.join(ROOT, '..', '..', 'toolchains', 'jdk-download',
    'jdk-21.0.13+9', 'Contents', 'Home', 'bin', 'javac'));
  // Original declared JDK path, if present on another host layout.
  candidates.push(path.join(ROOT, '..', '..', 'toolchains', 'jdk-21.0.13+9',
    'Contents', 'Home', 'bin', 'javac'));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const javac = findJavac();
if (!javac) {
  skip('javac not found (set JAVA_HOME or OPUROM_JAVAC): JNI compile not run on this host.');
} else {
  const versionRun = run('javac -version', [javac, '-version'], { timeoutMs: 30000 });
  const javacRun = run('javac', [
    javac, '-d', path.join(WORK, 'classes'), path.join(ROOT, 'jni', 'OpuromNative.java'),
  ], { timeoutMs: 60000 });
  if (javacRun.ok) {
    const classFile = path.join(WORK, 'classes', 'org', 'opurom', 'mobile',
      'OpuromNative.class');
    if (existsSync(classFile)) {
      pass(`javac OK: ${firstLine(versionRun.stdout) || versionRun.stdout} -> ${classFile} (${javacRun.ms}ms)`);
    } else {
      fail('javac reported success but OpuromNative.class is missing');
    }
  } else {
    fail('javac compile failed', `${javacRun.stdout}\n${javacRun.stderr}`);
  }

  // --- 6. JNI header: real clang syntax check against the same JDK's jni.h ---
  const jdkHome = path.resolve(path.dirname(path.dirname(javac)));
  const jniHeader = path.join(jdkHome, 'include', 'jni.h');
  const jniMdHeader = path.join(jdkHome, 'include', 'darwin', 'jni_md.h');
  if (existsSync(jniHeader) && existsSync(jniMdHeader)) {
    const clangRun = run('clang', [
      'xcrun', '--sdk', 'iphoneos', 'clang', '-fsyntax-only', '-x', 'c',
      '-I', path.join(jdkHome, 'include'),
      '-I', path.join(jdkHome, 'include', 'darwin'),
      '-I', path.join(ROOT, 'include'),
      path.join(ROOT, 'jni', 'opurom_jni.h'),
    ], { timeoutMs: 60000 });
    if (clangRun.ok) {
      pass(`clang -fsyntax-only OK for jni/opurom_jni.h against ${jniHeader} (${clangRun.ms}ms)`);
    } else {
      fail('clang -fsyntax-only failed for jni/opurom_jni.h',
        `${clangRun.stdout}\n${clangRun.stderr}`);
    }
  } else {
    skip('jni.h not found next to javac; JNI header syntax check not run.');
  }
}

console.log(`verify finished: ${passed} passed, ${skipped} skipped, ` +
  `${failures.length} failed`);
if (failures.length > 0) {
  console.log('VERIFY FAIL');
  process.exit(1);
}
console.log('VERIFY PASS (exit 0)');
process.exit(0);
