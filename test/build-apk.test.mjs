// Tests for the on-device APK build. A host without the Android toolchain
// skips with a concrete reason; when the tools exist the test runs the real
// build and checks the shipped artifact. No fake success.
'use strict';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'dist', 'opurom-mobile-debug.apk');
const JNI_LIBS = ['arm64-v8a', 'x86_64'].map((abi) => path.join(
  ROOT, 'target', 'android', 'jniLibs', abi, 'libopurom_mobile.so',
));

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

function findToolchain() {
  const candidates = [];
  for (const name of ['OPR_ANDROID_SDK', 'ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[name]) candidates.push(process.env[name]);
  }
  for (const root of toolchainRoots()) {
    for (const top of subdirs(root)) {
      candidates.push(top);
      for (const nested of subdirs(top)) candidates.push(nested);
    }
  }
  const sdk = candidates.find((c) => c && existsSync(path.join(c, 'platforms')));
  if (!sdk) return null;
  const btRoot = path.join(sdk, 'build-tools');
  if (!existsSync(btRoot)) return null;
  for (const version of readdirSync(btRoot).sort().reverse()) {
    const dir = path.join(btRoot, version);
    if (['apksigner', 'aapt2', 'zipalign'].every((t) => existsSync(path.join(dir, t)))) {
      const jdkBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : null;
      if (!jdkBin || !existsSync(path.join(jdkBin, 'java'))) return null;
      return { apksigner: path.join(dir, 'apksigner'), aapt2: path.join(dir, 'aapt2'), jdkBin };
    }
  }
  return null;
}

function run(argv, env) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(env || {}) },
  });
  return { ok: res.status === 0 && !res.error, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

test('the built APK is signed, aligned, launchable and deterministic', (t) => {
  const tools = findToolchain();
  if (!tools) {
    t.skip('APK build needs an Android SDK (platforms + build-tools) and JAVA_HOME');
    return;
  }
  // The NDK shared objects are produced by verify.mjs; CI has no NDK toolchain.
  if (JNI_LIBS.some((lib) => !existsSync(lib))) {
    t.skip('APK build needs the NDK shared objects from `node verify.mjs`');
    return;
  }
  const env = { JAVA_HOME: path.dirname(tools.jdkBin), PATH: `${tools.jdkBin}${path.delimiter}${process.env.PATH || ''}` };

  const first = run([process.execPath, 'build-apk.mjs'], env);
  assert.ok(first.ok, `build-apk.mjs failed: ${first.stderr}`);
  assert.ok(existsSync(OUTPUT), 'the APK was not produced');
  const firstBytes = readFileSync(OUTPUT);
  const firstDigest = createHash('sha256').update(firstBytes).digest('hex');

  const second = run([process.execPath, 'build-apk.mjs'], env);
  assert.ok(second.ok, `second build failed: ${second.stderr}`);
  const secondDigest = createHash('sha256').update(readFileSync(OUTPUT)).digest('hex');
  assert.equal(secondDigest, firstDigest, 'rebuilding must be byte-identical');

  const verify = run([tools.apksigner, 'verify', '--verbose', OUTPUT], env);
  assert.ok(verify.ok && /Verifies/.test(verify.stdout), `apksigner verify failed: ${verify.stderr}`);
  for (const scheme of ['v1', 'v2', 'v3']) {
    assert.match(verify.stdout, new RegExp(`Verified using ${scheme} scheme[^:]*: true`));
  }

  const badging = run([tools.aapt2, 'dump', 'badging', OUTPUT], env);
  assert.match(badging.stdout, /launchable-activity: name='org\.opurom\.mobile\.MainActivity'/);
  assert.match(badging.stdout, /package: name='org\.opurom\.mobile'/);

  console.log(`apk: ${OUTPUT} (${statSync(OUTPUT).size} bytes, sha256 ${firstDigest})`);
});
