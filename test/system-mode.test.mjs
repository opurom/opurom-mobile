// `theme.mode: system` is resolved by the host adapter into a concrete mode
// before the deterministic kernel sees the IR. The rewrite is byte-scoped to
// that one token; this checks the same pattern the Java helper uses against
// both emitted JSON formats and the packaged assets.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(
  ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile', 'MainActivity.java'),
  'utf8');
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

test('the adapter resolves system mode from the host configuration', () => {
  const decl = /SYSTEM_MODE\s*=\s*java\.util\.regex\.Pattern\.compile\("((?:\\.|[^"\\])*)"\)/.exec(SOURCE);
  assert.ok(decl, 'a single SYSTEM_MODE pattern owns the token rewrite');
  // Java string literal escapes -> JS regex source.
  const pattern = new RegExp(decl[1].replace(/\\(.)/g, '$1'));
  assert.match(SOURCE, /resolveSystemMode\(readAsset\(selectedIrAsset\(\)\), dark\)/,
    'onCreate resolves the mode using the configured night flag');
  assert.match(SOURCE, /if \(!dark\) \{\s*return ir;/,
    'a light host leaves the IR untouched');

  for (const mode of ['"mode":"system"', '"mode": "system"', '"mode" :  "system"']) {
    assert.ok(pattern.test(mode), `pattern matches ${mode}`);
    assert.equal(mode.replace(pattern, '"mode": "dark"'), '"mode": "dark"');
  }
  assert.ok(!pattern.test('"mode":"light"'), 'an explicit light mode is not rewritten');
  assert.ok(!pattern.test('"mode":"dark"'), 'an explicit dark mode is not rewritten');
});

test('resolving system mode preserves every other IR byte', () => {
  const pattern = new RegExp('"mode"\\s*:\\s*"system"');
  for (const name of ['calculator.opuir.json', 'typography.opuir.json']) {
    const text = readFileSync(path.join(ASSETS, name), 'utf8');
    assert.ok(pattern.test(text), `${name} declares system mode`);
    const resolved = text.replace(pattern, '"mode": "dark"');
    const before = JSON.parse(text);
    const after = JSON.parse(resolved);
    assert.equal(after.theme.mode, 'dark', `${name} resolves to dark`);
    before.theme.mode = 'dark';
    assert.deepEqual(after, before, `${name} keeps every other field unchanged`);
  }
  const explicit = readFileSync(path.join(ASSETS, 'dashboard.opuir.json'), 'utf8');
  assert.ok(!pattern.test(explicit), 'an explicit light IR is not touched');
});
