// Tests for the layered startup-crash triage tool. Fixtures are tiny ELF64
// shared objects, a minimal AndroidManifest.xml and a parses-clean IR asset
// built in a temp directory, so the layers can be exercised on every host
// without build output. A healthy fixture must pass every layer; each broken
// fixture must fail exactly its intended layer with a specific message.
'use strict';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPECTED_EXPORTS, layerLinkage, layerManifest, layerPackageAbi,
  layerRuntimeContract, loadArtifact, readElf, triage,
} from '../lib/startup-triage.mjs';

const EM_AARCH64 = 183;
const EM_X86_64 = 62;

function putU16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}
function putU32(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
}
function putU64(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

// Builds a minimal ELF64 little-endian ET_DYN shared object with one PT_LOAD
// segment, one PT_DYNAMIC segment carrying DT_NEEDED/DT_STRTAB, and a
// SHT_DYNSYM section exporting the given defined global symbols.
export function buildElf({ machine, needed = [], exports = [] }) {
  const EHDR = 64;
  const PHDR = 56;
  const SHDR = 64;
  const phnum = 2;
  const shnum = 3; // null, SHT_STRTAB (symbol names), SHT_DYNSYM

  const dynStr = Buffer.from(`${[...needed].join('\0')}\0`, 'utf8');
  const symNames = ['', ...exports];
  const symStr = Buffer.from(`${symNames.join('\0')}\0`, 'utf8');
  const symCount = exports.length + 1; // index 0 is the null symbol

  // Payloads after the program headers; PT_LOAD maps vaddr == offset so the
  // reader's identity translation works for a single-segment synthetic image.
  let cursor = EHDR + phnum * PHDR;
  const dynStrOff = cursor; cursor += dynStr.length;
  const dynOff = cursor; cursor += (needed.length + 2) * 16;
  const symStrOff = cursor; cursor += symStr.length;
  const symOff = cursor; cursor += symCount * 24;
  const shoff = cursor; cursor += shnum * SHDR;

  const buf = Buffer.alloc(cursor);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buf, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // little-endian
  buf[6] = 1;
  putU16(buf, 16, 3); // ET_DYN
  putU16(buf, 18, machine);
  putU32(buf, 20, 1);
  putU64(buf, 32, EHDR); // e_phoff
  putU64(buf, 40, shoff); // e_shoff
  putU16(buf, 52, EHDR);
  putU16(buf, 54, PHDR);
  putU16(buf, 56, phnum);
  putU16(buf, 58, SHDR);
  putU16(buf, 60, shnum);

  // PT_LOAD spans the whole image; PT_DYNAMIC points at the dynamic array.
  putU32(buf, EHDR, 1);
  putU64(buf, EHDR + 8, 0);
  putU64(buf, EHDR + 16, 0);
  putU64(buf, EHDR + 32, cursor);
  putU64(buf, EHDR + 40, cursor);
  const dynPh = EHDR + PHDR;
  putU32(buf, dynPh, 2);
  putU64(buf, dynPh + 8, dynOff);
  putU64(buf, dynPh + 16, dynOff);
  putU64(buf, dynPh + 32, (needed.length + 2) * 16);

  const nameOffset = (name) => dynStr.indexOf(Buffer.from(`${name}\0`));
  let dynCursor = dynOff;
  for (const name of needed) {
    putU64(buf, dynCursor, 1); // DT_NEEDED
    putU64(buf, dynCursor + 8, nameOffset(name));
    dynCursor += 16;
  }
  putU64(buf, dynCursor, 5); // DT_STRTAB
  putU64(buf, dynCursor + 8, dynStrOff);
  dynCursor += 16;
  putU64(buf, dynCursor, 0); // DT_NULL
  dynStr.copy(buf, dynStrOff);

  symStr.copy(buf, symStrOff);
  const symNameOffset = (name) => symStr.indexOf(Buffer.from(`${name}\0`));
  for (let i = 0; i < exports.length; i += 1) {
    const off = symOff + (i + 1) * 24;
    putU32(buf, off, symNameOffset(exports[i]));
    buf[off + 4] = 0x12; // GLOBAL | FUNC
    putU16(buf, off + 6, 1); // defined
  }

  // Section 1: SHT_STRTAB (symbol names). Section 2: SHT_DYNSYM -> sh_link 1.
  const s1 = shoff + SHDR;
  putU32(buf, s1 + 4, 3); // SHT_STRTAB
  putU64(buf, s1 + 24, symStrOff);
  putU64(buf, s1 + 32, symStr.length);
  const s2 = shoff + 2 * SHDR;
  putU32(buf, s2 + 4, 11); // SHT_DYNSYM
  putU64(buf, s2 + 24, symOff);
  putU64(buf, s2 + 32, symCount * 24);
  putU32(buf, s2 + 40, 1); // sh_link -> section 1
  putU64(buf, s2 + 56, 24); // sh_entsize
  return buf;
}


const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="org.opurom.mobile"
    android:versionCode="1"
    android:versionName="0.1.0">
    <application android:name="org.opurom.mobile.App" android:label="opurom">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

const IR_ASSET = JSON.stringify({ ir: '0.1', app: 'Fixture', tree: { id: 0, kind: 'Column', props: {}, children: [] } });

// The caller removes the directory; a test context auto-registers cleanup.
function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opurom-triage-'));
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Writes a healthy artifact tree: two ABI libraries, manifest, IR asset.
function healthyFixture(t) {
  const dir = tempDir(t);
  for (const [abi, machine] of [['arm64-v8a', EM_AARCH64], ['x86_64', EM_X86_64]]) {
    const abiDir = path.join(dir, 'lib', abi);
    mkdirSync(abiDir, { recursive: true });
    const elf = buildElf({ machine, needed: ['liblog.so', 'libc.so'], exports: EXPECTED_EXPORTS });
    writeFileSync(path.join(abiDir, 'libopurom_mobile.so'), elf);
  }
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', 'dashboard.opuir.json'), IR_ASSET);
  writeFileSync(path.join(dir, 'AndroidManifest.xml'), MANIFEST);
  return dir;
}

function statuses(results) {
  return results.map((r) => r.status);
}

test('readElf reads machine, DT_NEEDED and defined exports from a synthetic object', () => {
  const bytes = buildElf({ machine: EM_AARCH64, needed: ['liblog.so', 'libc.so'], exports: EXPECTED_EXPORTS });
  const elf = readElf(bytes);
  assert.equal(elf.machine, EM_AARCH64);
  assert.deepEqual(elf.needed, ['liblog.so', 'libc.so']);
  for (const name of EXPECTED_EXPORTS) assert.ok(elf.exports.has(name), `missing export ${name}`);
});

test('a healthy fixture passes every layer', () => {
  const dir = healthyFixture(null);
  try {
    const report = triage(dir);
    assert.equal(report.failed, 0, JSON.stringify(report.layers));
    assert.ok(report.passed >= 6);
    // The manifest fixture declares no targetSdk, so its exported check skips.
    for (const layer of report.layers) {
      assert.ok(!layer.results.some((r) => r.status === 'FAIL'), `${layer.name} failed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong ELF machine fails only the package/ABI layer', () => {
  const dir = healthyFixture(null);
  try {
    const abiDir = path.join(dir, 'lib', 'x86_64');
    writeFileSync(path.join(abiDir, 'libopurom_mobile.so'),
      buildElf({ machine: EM_AARCH64, needed: ['libc.so'], exports: EXPECTED_EXPORTS }));
    const artifact = loadArtifact(dir);
    const pkg = layerPackageAbi(artifact);
    assert.ok(pkg.some((r) => r.status === 'FAIL' && /x86_64.*machine is 183, expected 62/.test(r.message)), JSON.stringify(pkg));
    assert.equal(layerLinkage(artifact).filter((r) => r.status === 'FAIL').length, 0);
    assert.equal(layerRuntimeContract(artifact).filter((r) => r.status === 'FAIL').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing launcher activity fails only the manifest layer', () => {
  const dir = healthyFixture(null);
  try {
    writeFileSync(path.join(dir, 'AndroidManifest.xml'), MANIFEST.replace(/<intent-filter>[\s\S]*?<\/intent-filter>/, ''));
    const artifact = loadArtifact(dir);
    const manifest = layerManifest(artifact);
    assert.ok(manifest.some((r) => r.status === 'FAIL' && /no activity with MAIN action \+ LAUNCHER/.test(r.message)), JSON.stringify(manifest));
    assert.equal(layerPackageAbi(artifact).filter((r) => r.status === 'FAIL').length, 0);
    assert.equal(layerLinkage(artifact).filter((r) => r.status === 'FAIL').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unresolved DT_NEEDED soname fails only the linkage layer', () => {
  const dir = healthyFixture(null);
  try {
    const abiDir = path.join(dir, 'lib', 'arm64-v8a');
    writeFileSync(path.join(abiDir, 'libopurom_mobile.so'),
      buildElf({ machine: EM_AARCH64, needed: ['libmissingkernel.so'], exports: EXPECTED_EXPORTS }));
    const artifact = loadArtifact(dir);
    const linkage = layerLinkage(artifact);
    assert.ok(linkage.some((r) => r.status === 'FAIL'
      && /libopurom_mobile\.so \(arm64-v8a\) needs libmissingkernel\.so, which is not packaged/.test(r.message)), JSON.stringify(linkage));
    assert.equal(layerPackageAbi(artifact).filter((r) => r.status === 'FAIL').length, 0);
    assert.equal(layerRuntimeContract(artifact).filter((r) => r.status === 'FAIL').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a native library missing a kernel runtime entry fails only the runtime layer', () => {
  const dir = healthyFixture(null);
  try {
    const abiDir = path.join(dir, 'lib', 'arm64-v8a');
    const trimmed = EXPECTED_EXPORTS.filter((name) => name !== 'opu_frame_from_ir');
    writeFileSync(path.join(abiDir, 'libopurom_mobile.so'),
      buildElf({ machine: EM_AARCH64, needed: ['libc.so'], exports: trimmed }));
    const artifact = loadArtifact(dir);
    const runtime = layerRuntimeContract(artifact);
    assert.ok(runtime.some((r) => r.status === 'FAIL' && /does not export the kernel runtime entry opu_frame_from_ir/.test(r.message)), JSON.stringify(runtime));
    assert.equal(layerPackageAbi(artifact).filter((r) => r.status === 'FAIL').length, 0);
    assert.equal(layerLinkage(artifact).filter((r) => r.status === 'FAIL').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('absent artifact layers self-skip with a concrete reason and a clean exit', () => {
  const dir = tempDir(null);
  try {
    const report = triage(dir);
    assert.equal(report.failed, 0);
    assert.ok(report.skipped >= 4);
    for (const layer of report.layers) {
      for (const result of layer.results) {
        if (result.status === 'SKIP') assert.match(result.message, /skipped|no .*directory|no AndroidManifest/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
