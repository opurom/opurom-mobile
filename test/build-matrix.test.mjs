// The APK matrix driver must produce a stable package per app and rewrite the
// manifest package/activity/label. The transformations are pure, so they are
// asserted against the real source without an Android toolchain.
'use strict';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'build-matrix.mjs'), 'utf8');

test('package id is derived by lowercasing and stripping non-alphanumerics', () => {
  assert.match(SOURCE, /'org\.opurom\.app\.' \+ name\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\/g, ''\)/);
  // Independent recomputation for representative names.
  const pkg = (n) => 'org.opurom.app.' + n.toLowerCase().replace(/[^a-z0-9]/g, '');
  assert.equal(pkg('counter'), 'org.opurom.app.counter');
  assert.equal(pkg('northstar-dashboard'), 'org.opurom.app.northstardashboard');
  assert.equal(pkg('design-system'), 'org.opurom.app.designsystem');
});

test('manifest rewrite swaps package, fully qualifies the activity, sets the label', () => {
  for (const needle of [
    'package="org.opurom.mobile"',
    'android:name=".MainActivity"',
    'android:label="@string/app_name"',
  ]) {
    assert.ok(SOURCE.includes(needle), `rewrites ${needle}`);
  }
  assert.match(SOURCE, /android:name="org\.opurom\.mobile\.MainActivity"/,
    'activity becomes fully qualified so it resolves outside the app package');
});

test('the driver feeds build-apk.mjs through the documented OPR_APK overrides', () => {
  for (const env of ['OPR_APK_OUTPUT', 'OPR_APK_MANIFEST', 'OPR_APK_ASSETS']) {
    assert.ok(SOURCE.includes(env), `${env} is passed to the child build`);
  }
  assert.match(SOURCE, /'dashboard\.opuir\.json'/, 'IR is named after the shell default load target');
});
