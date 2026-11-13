// Signing determinism checks for the Android build path. The APK is built
// with the same aapt2 steps as verify.mjs section 5, signed with real
// apksigner and throwaway per-run keystores in temp directories. Missing
// tools produce a concrete SKIP; there are no fs mocks and no golden
// digests: every digest is computed by the tools at test time and compared
// against another run of the same tooling.
'use strict';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const ASSETS_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');
const STORED_ENTRY = 'resources.arsc';
const TEST_STORE_PASS = 'opurom-sign-test';

// =====================================================================
// Tool discovery, mirroring verify.mjs: env overrides first, then the
// sibling/parent toolchains/ roots scanned two levels deep. A missing
// tool must become a skip, never a fake pass.
// =====================================================================

function toolchainRoots() {
  const roots = [];
  const sibling = path.resolve(ROOT, '..', '..', 'toolchains');
  if (existsSync(sibling)) roots.push(sibling);
  const parent = path.resolve(ROOT, '..', 'toolchains');
  if (existsSync(parent) && parent !== sibling) roots.push(parent);
  return roots;
}

function subdirectories(root) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    try {
      if (statSync(full).isDirectory()) found.push(full);
    } catch {
      // A racing removal is not a reason to fail the lookup.
    }
  }
  return found;
}

function binCandidates(dir) {
  return [path.join(dir, 'Contents', 'Home', 'bin'), path.join(dir, 'bin')];
}

function findJdkTool(tool) {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', tool));
  if (process.env.OPUROM_JAVAC) {
    candidates.push(path.join(path.dirname(process.env.OPUROM_JAVAC), tool));
  }
  for (const root of toolchainRoots()) {
    for (const dir of subdirectories(root)) {
      for (const bin of binCandidates(dir)) candidates.push(path.join(bin, tool));
      for (const nested of subdirectories(dir)) {
        for (const bin of binCandidates(nested)) candidates.push(path.join(bin, tool));
      }
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function findSdk() {
  const candidates = [];
  for (const name of ['OPR_ANDROID_SDK', 'ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[name]) candidates.push(process.env[name]);
  }
  for (const root of toolchainRoots()) {
    for (const dir of subdirectories(root)) {
      candidates.push(dir);
      for (const nested of subdirectories(dir)) candidates.push(nested);
    }
  }
  return candidates.find((candidate) => existsSync(path.join(candidate, 'platforms'))) || null;
}

// The newest build-tools version that ships apksigner (aapt2 sits in the
// same version directory).
function findApksigner(sdk) {
  if (!sdk) return null;
  const root = path.join(sdk, 'build-tools');
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root).sort().reverse()) {
    const exe = path.join(root, entry, 'apksigner');
    if (existsSync(exe)) return exe;
  }
  return null;
}

function findPlatformJar(sdk) {
  if (!sdk) return null;
  const root = path.join(sdk, 'platforms');
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root).sort().reverse()) {
    const jar = path.join(root, entry, 'android.jar');
    if (existsSync(jar)) return jar;
  }
  return null;
}

let toolsCache = null;
function tools() {
  if (!toolsCache) {
    const sdk = findSdk();
    const apksigner = findApksigner(sdk);
    const keytool = findJdkTool('keytool');
    toolsCache = {
      apksigner,
      keytool,
      aapt2: apksigner ? path.join(path.dirname(apksigner), 'aapt2') : null,
      platformJar: findPlatformJar(sdk),
      // apksigner execs plain `java` from PATH; verify.mjs prepends cargo
      // bin the same way for cargo.
      javaBin: keytool ? path.dirname(keytool) : null,
    };
  }
  return toolsCache;
}

function requireTools(t) {
  const found = tools();
  const missing = [
    found.apksigner ? null : 'build-tools apksigner',
    found.aapt2 && existsSync(found.aapt2) ? null : 'build-tools aapt2',
    found.keytool ? null : 'JDK keytool',
    found.platformJar ? null : 'platform android.jar',
  ].filter(Boolean);
  if (missing.length > 0) {
    t.skip(`signing determinism needs ${missing.join(', ')} ` +
      '(set OPR_ANDROID_SDK/ANDROID_HOME and JAVA_HOME; same toolchains/ layout as verify.mjs)');
    return null;
  }
  return found;
}

function spawn(argv, env) {
  const res = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

function javaEnv(kit) {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  return { PATH: `${kit.javaBin}${pathSep}${process.env.PATH || ''}` };
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opurom-signing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// =====================================================================
// Real pipeline: package, keystore, sign, verify. Each step returns the
// tool's own stdout/stderr so assertions quote tool output, not guesses.
// =====================================================================

function buildUnsignedApk(tools, dir) {
  const compiledZip = path.join(dir, 'res.zip');
  const unsigned = path.join(dir, 'unsigned.apk');
  const compile = spawn([tools.aapt2, 'compile', '--dir', RES_DIR, '-o', compiledZip],
    javaEnv(tools));
  assert.equal(compile.status, 0, `aapt2 compile failed: ${compile.stderr}`);
  const link = spawn([
    tools.aapt2, 'link', '-o', unsigned, '-I', tools.platformJar,
    '-A', ASSETS_DIR, '--manifest', MANIFEST, compiledZip,
  ], javaEnv(tools));
  assert.equal(link.status, 0, `aapt2 link failed: ${link.stderr}`);
  return unsigned;
}

function createKeystore(tools, dir, name, alias, dname) {
  const keystore = path.join(dir, name);
  const gen = spawn([
    tools.keytool, '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12',
    '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30',
    '-storepass', TEST_STORE_PASS, '-keypass', TEST_STORE_PASS, '-dname', dname,
  ], javaEnv(tools));
  assert.equal(gen.status, 0, `keytool -genkeypair failed: ${gen.stderr}`);
  return keystore;
}

function signApk(tools, keystore, unsigned, signed) {
  const run = spawn([
    tools.apksigner, 'sign', '--ks', keystore,
    '--ks-pass', `pass:${TEST_STORE_PASS}`, '--out', signed, unsigned,
  ], javaEnv(tools));
  assert.equal(run.status, 0, `apksigner sign failed: ${run.stderr}`);
  return signed;
}

function verifyApk(tools, apk, extraArgs = []) {
  return spawn([tools.apksigner, 'verify', ...extraArgs, apk], javaEnv(tools));
}

// Enabled signature schemes from `apksigner verify --verbose`, as a sorted
// set of scheme names ("v1", "v2", "v3", "v3.1", "v4").
function enabledSchemes(output) {
  const schemes = new Set();
  for (const match of output.matchAll(/Verified using (v[\d.]+) scheme[^:]*: true/gi)) {
    schemes.add(match[1]);
  }
  return [...schemes].sort();
}

function certificateDigests(output) {
  return [...output.matchAll(/Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/g)]
    .map((match) => match[1]);
}

// Real zip local-header walk to find the payload range of a stored
// (uncompressed) entry, so a tamper changes APK content while the archive
// stays readable for apksigner.
function storedEntryRange(apkBytes, wanted) {
  for (let offset = 0; offset + 30 <= apkBytes.length; ) {
    const isLocalHeader = apkBytes[offset] === 0x50 && apkBytes[offset + 1] === 0x4b &&
      apkBytes[offset + 2] === 0x03 && apkBytes[offset + 3] === 0x04;
    if (!isLocalHeader) break;
    const nameLength = apkBytes.readUInt16LE(offset + 26);
    const extraLength = apkBytes.readUInt16LE(offset + 28);
    const method = apkBytes.readUInt16LE(offset + 8);
    const compressedSize = apkBytes.readUInt32LE(offset + 18);
    const uncompressedSize = apkBytes.readUInt32LE(offset + 22);
    const name = apkBytes.toString('latin1', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (method === 0 && uncompressedSize > 16 && name === wanted) {
      return { start: dataStart, size: uncompressedSize };
    }
    offset = method === 0 ? dataStart + uncompressedSize : dataStart + compressedSize;
  }
  return null;
}

// Flip one byte inside the stored entry payload: the zip stays parseable
// and every entry still decompresses, but the signed digests no longer
// match the content.
function tamperStoredEntry(apk, tampered) {
  const bytes = Buffer.from(readFileSync(apk));
  const range = storedEntryRange(bytes, STORED_ENTRY);
  assert.ok(range, `the packaged APK must contain a stored ${STORED_ENTRY} entry`);
  bytes[range.start + Math.floor(range.size / 2)] ^= 0x01;
  writeFileSync(tampered, bytes);
  return tampered;
}

test('signing the same APK twice is byte-identical with a fixed scheme set', (t) => {
  const tools = requireTools(t);
  if (!tools) return;
  const dir = tempDir(t);
  const unsigned = buildUnsignedApk(tools, dir);
  const keystore = createKeystore(tools, dir, 'signer.p12', 'opurom',
    'CN=Opurom Mobile Signing Determinism');
  const first = signApk(tools, keystore, unsigned, path.join(dir, 'first.apk'));
  const second = signApk(tools, keystore, unsigned, path.join(dir, 'second.apk'));

  const firstBytes = readFileSync(first);
  const secondBytes = readFileSync(second);
  assert.ok(firstBytes.equals(secondBytes),
    `two signing runs differ: ${firstBytes.length} bytes vs ${secondBytes.length} bytes`);

  const firstVerify = verifyApk(tools, first, ['--verbose']);
  const secondVerify = verifyApk(tools, second, ['--verbose']);
  assert.ok(firstVerify.ok, `apksigner verify failed: ${firstVerify.stderr}`);
  assert.ok(secondVerify.ok, `apksigner verify failed: ${secondVerify.stderr}`);
  const firstSchemes = enabledSchemes(firstVerify.stdout);
  const secondSchemes = enabledSchemes(secondVerify.stdout);
  assert.ok(firstSchemes.length > 0,
    `apksigner reported no enabled scheme: ${firstVerify.stdout}`);
  assert.deepEqual(firstSchemes, secondSchemes,
    'the enabled signature scheme set must be identical across signing runs');
});

test('re-running verification on the same APK yields identical digests', (t) => {
  const tools = requireTools(t);
  if (!tools) return;
  const dir = tempDir(t);
  const unsigned = buildUnsignedApk(tools, dir);
  const keystore = createKeystore(tools, dir, 'signer.p12', 'opurom',
    'CN=Opurom Mobile Verify Stability');
  const signed = signApk(tools, keystore, unsigned, path.join(dir, 'signed.apk'));

  const firstRun = verifyApk(tools, signed, ['--verbose', '--print-certs']);
  const secondRun = verifyApk(tools, signed, ['--verbose', '--print-certs']);
  assert.ok(firstRun.ok, `apksigner verify failed: ${firstRun.stderr}`);
  assert.ok(secondRun.ok, `apksigner verify failed: ${secondRun.stderr}`);

  const firstDigests = certificateDigests(firstRun.stdout);
  const secondDigests = certificateDigests(secondRun.stdout);
  assert.equal(firstDigests.length, 1, `expected one signer digest, got ${firstRun.stdout}`);
  assert.deepEqual(secondDigests, firstDigests,
    're-verification must report identical certificate digests');
  assert.match(firstDigests[0], /^[0-9a-f]{64}$/, 'the digest must be a 64-hex SHA-256');
  const firstSchemes = enabledSchemes(firstRun.stdout);
  assert.ok(firstSchemes.length > 0,
    `apksigner reported no enabled scheme: ${firstRun.stdout}`);
  assert.deepEqual(enabledSchemes(secondRun.stdout), firstSchemes,
    're-verification must report an identical scheme set');
});

test('a tampered APK fails apksigner verification', (t) => {
  const tools = requireTools(t);
  if (!tools) return;
  const dir = tempDir(t);
  const unsigned = buildUnsignedApk(tools, dir);
  const keystore = createKeystore(tools, dir, 'signer.p12', 'opurom',
    'CN=Opurom Mobile Tamper Detection');
  const signed = signApk(tools, keystore, unsigned, path.join(dir, 'signed.apk'));
  assert.ok(verifyApk(tools, signed).ok, 'the pristine signed APK must verify');

  const tampered = tamperStoredEntry(signed, path.join(dir, 'tampered.apk'));
  const result = verifyApk(tools, tampered);
  assert.notEqual(result.status, 0, 'apksigner must reject a tampered APK');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /DOES NOT VERIFY|ERROR/i,
    `rejection must be a signature failure, got: ${output}`);
});

test('an APK re-signed with a different key is detected by its digest', (t) => {
  const tools = requireTools(t);
  if (!tools) return;
  const dir = tempDir(t);
  const unsigned = buildUnsignedApk(tools, dir);
  const ours = createKeystore(tools, dir, 'ours.p12', 'opurom',
    'CN=Opurom Mobile Release Key');
  const foreign = createKeystore(tools, dir, 'foreign.p12', 'foreign',
    'CN=Foreign Resigner');
  const signed = signApk(tools, ours, unsigned, path.join(dir, 'signed.apk'));
  const tampered = tamperStoredEntry(signed, path.join(dir, 'tampered.apk'));
  const reSigned = signApk(tools, foreign, tampered, path.join(dir, 'resigned.apk'));

  const oursVerify = verifyApk(tools, signed, ['--print-certs']);
  const reSignedVerify = verifyApk(tools, reSigned, ['--print-certs']);
  assert.ok(oursVerify.ok, `apksigner verify failed: ${oursVerify.stderr}`);
  assert.ok(reSignedVerify.ok,
    'a foreign re-signature is structurally valid and must verify');
  const oursDigest = certificateDigests(oursVerify.stdout)[0];
  const reSignedDigest = certificateDigests(reSignedVerify.stdout)[0];
  assert.match(oursDigest, /^[0-9a-f]{64}$/);
  assert.match(reSignedDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(oursDigest, reSignedDigest,
    'a re-signed APK must carry a different certificate digest, which exposes the swap');
});
