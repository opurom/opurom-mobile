// Deterministic PlatformView bridge conformance for the Android JNI / iOS side.
//
// The contract lives in include/platform_view.h; this test compiles a real C
// program into a temp directory, runs it, and asserts the byte-level handle
// encoding plus the lifecycle/bounds rules. It then cross-checks that header
// against the opurom-platform Rust constants and the Java constants, so the
// Android JNI / iOS surface cannot drift from the platform contract. No
// emulator, no fs mocks and no golden digest: the bytes are produced by the
// real header at test time.
'use strict';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = path.join(ROOT, 'include', 'platform_view.h');
const JAVA = path.join(ROOT, 'jni', 'OpuromNative.java');
const SWIFT = path.join(ROOT, 'swift', 'OpuromMobile.swift');
const PLATFORM_VIEW_RS = path.resolve(
  ROOT, '..', 'opurom-platform', 'src', 'platform_view.rs');
const WAYLAND_WIRE_RS = path.resolve(
  ROOT, '..', 'opurom-platform', 'src', 'wayland_wire.rs');

// The deterministic model of the shared contract. It is not a copy of the C
// header: the compiled program below proves the header produces these bytes.
const HANDLE_MAGIC = [0x4f, 0x50, 0x56, 0x31];
const HANDLE_LEN = 8;
const HANDLE_CASES = [0, 1, 42, 0x12345678, 0xffffffff];

const C_PROGRAM = `
#include "platform_view.h"
#include <stdio.h>
#include <string.h>

static void print_hex(const uint8_t *bytes, size_t len) {
    for (size_t i = 0; i < len; i += 1) {
        printf("%02x", bytes[i]);
    }
    printf("\\n");
}

int main(void) {
    uint8_t bytes[OPU_PLATFORM_VIEW_HANDLE_LEN];
    uint32_t decoded = 0;
    uint32_t handles[5] = {0u, 1u, 42u, 0x12345678u, 0xffffffffu};
    int index;

    printf("MAGIC %d %d %d %d %d\\n",
        OPU_PLATFORM_VIEW_HANDLE_MAGIC_0, OPU_PLATFORM_VIEW_HANDLE_MAGIC_1,
        OPU_PLATFORM_VIEW_HANDLE_MAGIC_2, OPU_PLATFORM_VIEW_HANDLE_MAGIC_3,
        OPU_PLATFORM_VIEW_HANDLE_LEN);
    if (opu_platform_view_encode_handle(0, NULL) != OPU_PLATFORM_VIEW_ERR) {
        return 1;
    }
    printf("ENCODE_NULL_ERR %d\\n", OPU_PLATFORM_VIEW_ERR);

    for (index = 0; index < 5; index += 1) {
        uint32_t handle = handles[index];
        if (opu_platform_view_encode_handle(handle, bytes) != OPU_PLATFORM_VIEW_OK) {
            return 1;
        }
        printf("ENCODE %08x ", handle);
        print_hex(bytes, OPU_PLATFORM_VIEW_HANDLE_LEN);
        if (opu_platform_view_decode_handle(bytes, OPU_PLATFORM_VIEW_HANDLE_LEN, &decoded)
            != OPU_PLATFORM_VIEW_OK || decoded != handle) {
            return 1;
        }
        printf("DECODE %u\\n", decoded);
    }

    bytes[0] ^= 0x01;
    if (opu_platform_view_decode_handle(bytes, OPU_PLATFORM_VIEW_HANDLE_LEN, &decoded)
        != OPU_PLATFORM_VIEW_ERR) {
        return 1;
    }
    printf("DECODE_TAMPERED_ERR %d\\n", OPU_PLATFORM_VIEW_ERR);

    printf("BOUNDS %d %d %d %d %d %d\\n",
        opu_platform_view_bounds_valid(0, 0, 320, 240),
        opu_platform_view_bounds_valid(-1, 0, 320, 240),
        opu_platform_view_bounds_valid(0, -1, 320, 240),
        opu_platform_view_bounds_valid(0, 0, -1, 240),
        opu_platform_view_bounds_valid(0, 0, 320, -1),
        opu_platform_view_bounds_valid(0, 0, 0, 0));

    printf("LIFECYCLE %d %d %d %d %d %d %d %d %d %d\\n",
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_CREATED,
            OPU_PLATFORM_VIEW_LIFECYCLE_ATTACHED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_ATTACHED,
            OPU_PLATFORM_VIEW_LIFECYCLE_RESIZED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_RESIZED,
            OPU_PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED,
            OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED,
            OPU_PLATFORM_VIEW_LIFECYCLE_CREATED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_CREATED,
            OPU_PLATFORM_VIEW_LIFECYCLE_RESIZED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_CREATED,
            OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_ATTACHED,
            OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED,
            OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED),
        opu_platform_view_lifecycle_advance(OPU_PLATFORM_VIEW_LIFECYCLE_CREATED,
            OPU_PLATFORM_VIEW_LIFECYCLE_CREATED));
    return 0;
}
`;

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opurom-platform-view-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hexToBytes(text) {
  return text.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16));
}

function ccPath() {
  const candidates = [];
  if (process.env.CC) candidates.push(process.env.CC);
  candidates.push('cc', 'clang');
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runCompiled(cc, dir) {
  const source = path.join(dir, 'contract.c');
  const binary = path.join(dir, 'contract');
  writeFileSync(source, C_PROGRAM, 'utf8');
  const build = spawnSync(cc, [
    '-std=c11', '-Wall', '-Werror', '-I', path.join(ROOT, 'include'),
    '-o', binary, source,
  ], { encoding: 'utf8', timeout: 120000 });
  assert.equal(build.status, 0, `C build failed: ${build.stderr}`);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, `C contract program failed: ${run.stderr}`);
  return run.stdout.trim().split('\n').map((line) => line.trim());
}

test('the compiled header encodes the shared byte-level handle frames', (t) => {
  const cc = ccPath();
  if (!cc) {
    t.skip('a C compiler (CC/cc/clang) is required for the PlatformView conformance run');
    return;
  }
  const dir = tempDir(t);
  const lines = runCompiled(cc, dir);

  const magic = lines[0].split(' ').slice(1).map((value) => Number(value));
  assert.deepEqual(magic, [...HANDLE_MAGIC, HANDLE_LEN]);
  assert.equal(lines[1], 'ENCODE_NULL_ERR -1');

  let index = 2;
  for (const handle of HANDLE_CASES) {
    const encode = lines[index].split(' ');
    assert.equal(encode[0], 'ENCODE');
    assert.equal(Number.parseInt(encode[1], 16), handle >>> 0);
    assert.deepEqual(hexToBytes(encode[2]), [
      ...HANDLE_MAGIC,
      (handle & 0xff) >>> 0,
      ((handle >> 8) & 0xff) >>> 0,
      ((handle >> 16) & 0xff) >>> 0,
      ((handle >> 24) & 0xff) >>> 0,
    ], `handle ${handle} frame`);
    assert.equal(lines[index + 1], `DECODE ${handle}`);
    index += 2;
  }

  assert.equal(lines[index], 'DECODE_TAMPERED_ERR -1');
  index += 1;

  assert.deepEqual(lines[index].split(' ').slice(1).map(Number),
    [1, 0, 0, 0, 0, 1], 'bounds validation');
  index += 1;
  assert.deepEqual(lines[index].split(' ').slice(1).map(Number),
    [1, 1, 1, 1, 0, 0, 0, 0, 0, 0], 'strict lifecycle advance');
});

test('the header, Java and Swift constants match the platform contract', (t) => {
  const header = readFileSync(HEADER, 'utf8');
  const java = readFileSync(JAVA, 'utf8');
  const swift = readFileSync(SWIFT, 'utf8');

  // The header itself is the byte-level source of truth.
  assert.match(header, /OPU_PLATFORM_VIEW_HANDLE_MAGIC_0 0x4f/);
  assert.match(header, /OPU_PLATFORM_VIEW_HANDLE_MAGIC_1 0x50/);
  assert.match(header, /OPU_PLATFORM_VIEW_HANDLE_MAGIC_2 0x56/);
  assert.match(header, /OPU_PLATFORM_VIEW_HANDLE_MAGIC_3 0x31/);
  assert.match(header, /OPU_PLATFORM_VIEW_HANDLE_LEN 8/);

  // Android JNI constants mirror the header, not a separate copy.
  assert.match(java, /PLATFORM_VIEW_HANDLE_LEN = 8/);
  assert.match(java, /PLATFORM_VIEW_HANDLE_MAGIC_0 = 0x4f/);
  assert.match(java, /PLATFORM_VIEW_HANDLE_MAGIC_1 = 0x50/);
  assert.match(java, /PLATFORM_VIEW_HANDLE_MAGIC_2 = 0x56/);
  assert.match(java, /PLATFORM_VIEW_HANDLE_MAGIC_3 = 0x31/);
  assert.match(java, /PLATFORM_VIEW_LIFECYCLE_CREATED = 0/);
  assert.match(java, /PLATFORM_VIEW_LIFECYCLE_ATTACHED = 1/);
  assert.match(java, /PLATFORM_VIEW_LIFECYCLE_RESIZED = 2/);
  assert.match(java, /PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED = 3/);
  assert.match(java, /PLATFORM_VIEW_LIFECYCLE_DISPOSED = 4/);
  assert.match(java, /PLATFORM_VIEW_EVENT_PRESS = 1/);
  assert.match(java, /PLATFORM_VIEW_EVENT_RELEASE = 2/);
  assert.match(java, /PLATFORM_VIEW_EVENT_MOVE = 3/);
  assert.match(java, /PLATFORM_VIEW_EVENT_FOCUS = 4/);

  // The JNI shim includes the shared header, so the Android build compiles it.
  assert.match(readFileSync(path.join(ROOT, 'jni', 'opurom_jni.c'), 'utf8'),
    /#include "platform_view.h"/);

  // The iOS wrapper calls the same shared C encoders.
  assert.match(swift, /opu_platform_view_encode_handle/);
  assert.match(swift, /opu_platform_view_decode_handle/);
  assert.match(swift, /opu_platform_view_bounds_valid/);
  assert.match(swift, /opu_platform_view_lifecycle_advance/);

  if (!existsSync(PLATFORM_VIEW_RS) || !existsSync(WAYLAND_WIRE_RS)) {
    t.skip(`needs ${PLATFORM_VIEW_RS} and ${WAYLAND_WIRE_RS} for the cross-repo contract check`);
    return;
  }
  const rust = readFileSync(PLATFORM_VIEW_RS, 'utf8');
  const wire = readFileSync(WAYLAND_WIRE_RS, 'utf8');
  assert.match(rust, /pub const HANDLE_MAGIC: \[u8; 4\] = \*b"OPV1"/);
  assert.match(rust, /pub const HANDLE_LEN: usize = 8/);
  assert.match(wire, /pub const EVENT_PRESS: u16 = 1/);
  assert.match(wire, /pub const EVENT_RELEASE: u16 = 2/);
  assert.match(wire, /pub const EVENT_MOVE: u16 = 3/);
  assert.match(wire, /pub const EVENT_FOCUS: u16 = 4/);
  assert.match(rust, /ViewLifecycle::Created => "created"/);
  assert.match(rust, /ViewLifecycle::Attached => "attached"/);
  assert.match(rust, /ViewLifecycle::Resized => "resized"/);
  assert.match(rust, /ViewLifecycle::InputForwarded => "input-forwarded"/);
  assert.match(rust, /ViewLifecycle::Disposed => "disposed"/);
});
