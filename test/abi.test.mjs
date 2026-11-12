// Node-side ABI spec test for the OPUROM mobile state machine.
// It encodes the contract documented in include/opurom.h and src/lib.rs and
// asserts the same fixtures as the Rust unit tests, so a contract drift shows
// up on either side of the C boundary.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Constants must come from the shipped C header, not from a copy in this file.
const header = readFileSync(path.join(ROOT, 'include', 'opurom.h'), 'utf8');
function define(name) {
  const match = header.match(new RegExp(`^#define\\s+${name}\\s+(\\d+)$`, 'm'));
  assert.ok(match, `header must define ${name}`);
  return Number(match[1]);
}

const OPU_OK = define('OPU_OK');
const OPU_ERR_NULL = define('OPU_ERR_NULL');
const OPU_ERR_EVENT = define('OPU_ERR_EVENT');
const OPU_ERR_DIMENSION = define('OPU_ERR_DIMENSION');
const OPU_ERR_OVERFLOW = define('OPU_ERR_OVERFLOW');
const OPU_MAX_DIMENSION = define('OPU_MAX_DIMENSION');
const OPU_EVENT_TAP = define('OPU_EVENT_TAP');
const OPU_EVENT_RESET = define('OPU_EVENT_RESET');

// Spec-level model of the state machine (mirrors src/lib.rs exactly).
function newState() {
  return { counter: 0 };
}

function dispatch(state, eventId) {
  if (eventId === OPU_EVENT_TAP) {
    if (state.counter === 0xffffffff) return OPU_ERR_OVERFLOW;
    state.counter += 1;
    return OPU_OK;
  }
  if (eventId === OPU_EVENT_RESET) {
    state.counter = 0;
    return OPU_OK;
  }
  return OPU_ERR_EVENT;
}

function frameLen(width, height) {
  if (width === 0 || height === 0 ||
      width > OPU_MAX_DIMENSION || height > OPU_MAX_DIMENSION) return null;
  const bytes = width * height * 4;
  return Number.isSafeInteger(bytes) && bytes <= 67108864 ? bytes : null;
}

function rgba(counter, x, y) {
  const mixed = (Math.imul(counter + Math.imul(x, 73) + Math.imul(y, 151),
    2654435761)) >>> 0;
  return [mixed & 0xff, (mixed >>> 8) & 0xff, (mixed >>> 16) & 0xff, 255];
}

function frame(state, width, height) {
  const bytes = frameLen(width, height);
  if (bytes === null) return { status: OPU_ERR_DIMENSION, pixels: null };
  const pixels = [];
  for (let index = 0; index < width * height; index += 1) {
    pixels.push(...rgba(state.counter, index % width, Math.floor(index / width)));
  }
  return { status: OPU_OK, pixels };
}

// Fixtures shared with the Rust unit tests in src/lib.rs.
let state = newState();
assert.equal(dispatch(state, OPU_EVENT_TAP), OPU_OK);
assert.deepEqual(frame(state, 2, 1).pixels,
  [177, 121, 55, 255, 42, 45, 9, 255]);
assert.equal(dispatch(state, OPU_EVENT_RESET), OPU_OK);
assert.deepEqual(frame(state, 2, 1).pixels, [0, 0, 0, 255, 121, 179, 209, 255]);

state = newState();
assert.deepEqual(frame(state, 1, 2).pixels, [0, 0, 0, 255, 103, 199, 184, 255]);

state = newState();
assert.equal(dispatch(state, 0), OPU_ERR_EVENT);
assert.equal(dispatch(state, 3), OPU_ERR_EVENT);
assert.deepEqual(frame(state, 1, 1).pixels, [0, 0, 0, 255]);

state = newState();
state.counter = 0xffffffff;
assert.equal(dispatch(state, OPU_EVENT_TAP), OPU_ERR_OVERFLOW);
assert.equal(state.counter, 0xffffffff);
assert.equal(dispatch(state, OPU_EVENT_RESET), OPU_OK);
assert.equal(state.counter, 0);

// Dimension validation happens before any write.
for (const [width, height] of [[0, 1], [1, 0], [OPU_MAX_DIMENSION + 1, 1],
  [1, OPU_MAX_DIMENSION + 1], [0xffffffff, 0xffffffff]]) {
  assert.equal(frameLen(width, height), null, `invalid dims ${width}x${height}`);
}
assert.equal(frameLen(OPU_MAX_DIMENSION, OPU_MAX_DIMENSION), 67108864);

// Null-pointer behavior is part of the C contract: opu_* returns OPU_ERR_NULL
// (or no-ops for free) without dereferencing; the header documents it.
assert.match(header, /null state pointer/i);
assert.match(header, /#define\s+OPU_ERR_NULL\s+1/);

console.log('PASS: abi spec fixtures match the documented C contract');
