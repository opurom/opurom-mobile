// One APK per sample app requires the build to accept package-specific inputs.
// The defaults must stay unchanged so the single-shell build still works.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'build-apk.mjs'), 'utf8');

test('output, manifest and asset inputs are overridable with safe defaults', () => {
  for (const [env, fallback] of [
    ['OPR_APK_OUTPUT', 'opurom-mobile-debug.apk'],
    ['OPR_APK_MANIFEST', "android', 'app', 'src', 'main', 'AndroidManifest.xml"],
    ['OPR_APK_ASSETS', "android', 'app', 'src', 'main', 'assets"],
  ]) {
    assert.match(SOURCE, new RegExp(`process\\.env\\.${env}`), `${env} is read`);
    assert.match(SOURCE, new RegExp(fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${env} keeps the default single-shell path`);
  }
  assert.match(SOURCE, /const KEYSTORE = path\.join\(DIST, 'opurom-debug\.jks'\)/,
    'the shared debug keystore is still defined');
  assert.match(SOURCE, /const ABI = \['arm64-v8a', 'x86_64'\]/,
    'both ABIs are still packaged');
});

test('aapt2 link and target-SDK parsing use the selected manifest', () => {
  assert.match(SOURCE, /'--manifest', MANIFEST,/, 'aapt2 link uses the override');
  assert.match(SOURCE, /readFileSync\(MANIFEST, 'utf8'\)/, 'target SDK reads the override');
  assert.doesNotMatch(SOURCE, /console\.log\('install: adb install -r dist\//,
    'the install hint reflects the real output path');
  assert.ok(SOURCE.includes('const pkg = /package\\s*=\\s*"([^"]+)"/.exec(readFileSync(MANIFEST'),
    'the reported package comes from the selected manifest');
});
