// Deterministic asset-integrity checks for the packaged Android artifacts.
// Every damaged candidate is a real file in a temp directory; the shipped
// asset is only read, never modified. The reference IR comes from the real
// opuromc compiler, and there are no fs mocks or stand-in IR fixtures.
'use strict';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'todo.opuir.json');
const SOURCE = path.resolve(ROOT, '..', 'opurom-examples', 'todo.opu');
const LANG_ROOT = path.resolve(ROOT, '..', 'opurom-lang');
const VERIFY = path.join(ROOT, 'verify.mjs');
const JNI_LIBS = path.join(ROOT, 'target', 'android', 'jniLibs');

// e_machine is a little-endian u16 at byte 18 of an ELF64 header. These are
// the exact bytes measured from the shipped objects: EM_AARCH64 (183) and
// EM_X86_64 (62), one entry per ABI the APK ships.
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const E_MACHINE_OFFSET = 18;
const MACHINE_BYTES = new Map([
  ['arm64-v8a', [0xb7, 0x00]],
  ['x86_64', [0x3e, 0x00]],
]);

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opurom-asset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

// The byte-for-byte contract of verify.mjs section 1c. Returns null for an
// intact asset, otherwise a reason that names the damage.
function checkAsset(candidatePath, referencePath) {
  const candidate = readFileSync(candidatePath);
  const reference = readFileSync(referencePath);
  if (candidate.length !== reference.length) {
    return `asset length mismatch: ${candidate.length} bytes, expected ` +
      `${reference.length} bytes from the reference IR`;
  }
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== reference[index]) {
      return `asset differs from the reference IR at byte ${index}`;
    }
  }
  return null;
}

function checkMachine(soPath, abi) {
  const expected = MACHINE_BYTES.get(abi);
  if (!expected) return `ABI ${abi} has no expected e_machine bytes`;
  const bytes = readFileSync(soPath);
  if (bytes.length < E_MACHINE_OFFSET + 2) {
    return `${abi} ELF header is truncated (${bytes.length} bytes)`;
  }
  for (let index = 0; index < ELF_MAGIC.length; index += 1) {
    if (bytes[index] !== ELF_MAGIC[index]) return `${abi} ELF magic bytes are absent`;
  }
  const actual = [...bytes.subarray(E_MACHINE_OFFSET, E_MACHINE_OFFSET + 2)];
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    return `${abi} e_machine bytes are ${hex(actual)}, expected ${hex(expected)}`;
  }
  return null;
}

function compilerPath() {
  const candidates = [];
  if (process.env.OPUROMC) candidates.push(process.env.OPUROMC);
  for (const profile of ['release', 'debug']) {
    candidates.push(path.join(LANG_ROOT, 'target', profile, 'opuromc'));
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

// Shipping ABIs come from the real build output, not from a copy.
function shippedAbis() {
  if (!existsSync(JNI_LIBS)) return null;
  return readdirSync(JNI_LIBS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() &&
      existsSync(path.join(JNI_LIBS, entry.name, 'libopurom_mobile.so')))
    .map((entry) => entry.name)
    .sort();
}

// verify.mjs ANDROID_ABIS is the tracked definition of what the build ships.
function declaredAbis() {
  const source = readFileSync(VERIFY, 'utf8');
  const table = source.match(/const ANDROID_ABIS = \[([\s\S]*?)\n\];/);
  assert.ok(table, 'verify.mjs must declare ANDROID_ABIS');
  const objects = table[1].match(/\{[^{}]*\}/g) || [];
  return objects.map((object) => {
    const abi = object.match(/abiDir:\s*'([^']+)'/);
    const machine = object.match(/machine:\s*(\d+)/);
    assert.ok(abi && machine, 'every ANDROID_ABIS entry needs abiDir and machine');
    return { abi: abi[1], machine: Number(machine[1]) };
  });
}

test('freshly compiled Todo IR is byte-identical to the packaged asset', (t) => {
  const compiler = compilerPath();
  if (!compiler || !existsSync(SOURCE) || !existsSync(ASSET)) {
    t.skip('needs ../opurom-examples/todo.opu, the shipped asset and opuromc at ' +
      '../opurom-lang/target/{debug,release}/opuromc');
    return;
  }
  const dir = tempDir(t);
  const fresh = path.join(dir, 'todo.opuir.json');
  const compiledRun = spawnSync(compiler, ['compile', SOURCE, '-o', fresh], {
    encoding: 'utf8', timeout: 120000,
  });
  assert.equal(compiledRun.status, 0, `opuromc compile failed: ${compiledRun.stderr}`);
  const compiled = readFileSync(fresh);
  const shipped = readFileSync(ASSET);
  assert.ok(compiled.equals(shipped),
    `fresh compilation is ${compiled.length} bytes, packaged asset is ${shipped.length} bytes`);
  const ir = JSON.parse(compiled.toString('utf8'));
  assert.equal(ir.ir, '0.1');
  assert.equal(ir.app, 'TodoApp');
  assert.match(readFileSync(VERIFY, 'utf8'), /compiled === shipped/,
    'verify.mjs must keep its byte-for-byte IR comparison');
});

test('an intact copy of the packaged IR passes the integrity check', (t) => {
  const dir = tempDir(t);
  const copy = path.join(dir, 'todo.opuir.json');
  writeFileSync(copy, readFileSync(ASSET));
  assert.equal(checkAsset(copy, ASSET), null);
});

test('a tampered asset is rejected with a clear failure', (t) => {
  const dir = tempDir(t);
  const tampered = Buffer.from(readFileSync(ASSET));
  const index = Math.floor(tampered.length / 2);
  tampered[index] ^= 0x01;
  const candidate = path.join(dir, 'tampered.opuir.json');
  writeFileSync(candidate, tampered);
  const reason = checkAsset(candidate, ASSET);
  assert.ok(reason, 'a tampered asset must be rejected');
  assert.match(reason, /differs from the reference IR at byte \d+/);
});

test('a truncated asset is rejected with a clear failure', (t) => {
  const dir = tempDir(t);
  const bytes = readFileSync(ASSET);
  const candidate = path.join(dir, 'truncated.opuir.json');
  writeFileSync(candidate, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const reason = checkAsset(candidate, ASSET);
  assert.ok(reason, 'a truncated asset must be rejected');
  assert.match(reason, /length mismatch: \d+ bytes, expected \d+ bytes/);
});

test('the ELF machine-type table covers every shipped ABI with exact bytes', (t) => {
  const declared = declaredAbis();
  const expected = [...MACHINE_BYTES.keys()].sort();
  assert.deepEqual(declared.map((entry) => entry.abi).sort(), expected,
    'verify.mjs ANDROID_ABIS must cover every shipped ABI exactly once');
  assert.equal(new Set(declared.map((entry) => entry.abi)).size, declared.length,
    'ANDROID_ABIS must not repeat an ABI');
  for (const { abi, machine } of declared) {
    assert.equal(machine, Buffer.from(MACHINE_BYTES.get(abi)).readUInt16LE(0),
      `${abi} machine number must match the exact ELF header bytes`);
  }
  const shipped = shippedAbis();
  if (shipped === null) {
    t.diagnostic('no built jniLibs on this host; coverage checked against verify.mjs only');
  } else {
    assert.deepEqual(shipped, expected,
      'the shipped jniLibs ABI set must match the machine-type table');
  }
});

test('shipped ELF headers carry the exact expected machine bytes', (t) => {
  const shipped = shippedAbis();
  if (shipped === null || shipped.length === 0) {
    t.skip('needs target/android/jniLibs/<abi>/libopurom_mobile.so from node verify.mjs');
    return;
  }
  const dir = tempDir(t);
  for (const abi of shipped) {
    const so = path.join(JNI_LIBS, abi, 'libopurom_mobile.so');
    assert.equal(checkMachine(so, abi), null, `${abi} ELF header`);

    // Real temp copies: one flipped machine byte and one truncated header.
    const header = Buffer.from(readFileSync(so).subarray(0, 64));
    header[E_MACHINE_OFFSET] ^= 0xff;
    const tampered = path.join(dir, `${abi}-tampered.so`);
    writeFileSync(tampered, header);
    assert.match(checkMachine(tampered, abi), /e_machine bytes are/, `${abi} tampered header`);

    const truncated = path.join(dir, `${abi}-truncated.so`);
    writeFileSync(truncated, header.subarray(0, E_MACHINE_OFFSET));
    assert.match(checkMachine(truncated, abi), /truncated/, `${abi} truncated header`);
  }
});
