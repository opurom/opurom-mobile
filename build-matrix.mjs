// Builds one independent, signed APK per registered sample application so the
// whole matrix can be installed side by side on a single device. Each APK gets
// its own package (`org.opurom.app.<name>`), its own manifest with a fully
// qualified activity, and an asset directory holding exactly one compiled IR
// (named after the shell's default load target). The single-shell build is
// unchanged; this only drives build-apk.mjs through its OPR_APK_* overrides.
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'target', 'apk-matrix');
const OUT = path.join(WORK, 'out');
const EXAMPLES = path.join(ROOT, '..', 'opurom-examples');
const REGISTRY = path.join(EXAMPLES, 'examples.json');
const MANIFEST_TEMPLATE = path.join(
  ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const COMPILER = path.join(ROOT, '..', 'opurom-lang', 'target', 'debug', 'opuromc');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function packageFor(name) {
  return 'org.opurom.app.' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// One manifest per app: swap the package, make the activity fully qualified so
// it resolves outside the app's own package, and label it with the app name.
function manifestFor(template, name) {
  return template
    .replace('package="org.opurom.mobile"', `package="${packageFor(name)}"`)
    .replace('android:name=".MainActivity"', 'android:name="org.opurom.mobile.MainActivity"')
    .replace('android:label="@string/app_name"', `android:label="${name}"`);
}

if (!existsSync(REGISTRY)) fail(`missing examples registry at ${REGISTRY}`);
if (!existsSync(COMPILER)) fail(`missing compiler at ${COMPILER} (build opurom-lang first)`);
const apps = JSON.parse(readFileSync(REGISTRY, 'utf8')).apps;
const template = readFileSync(MANIFEST_TEMPLATE, 'utf8');

rmSync(WORK, { recursive: true, force: true });
for (const dir of [OUT, path.join(WORK, 'manifests'), path.join(WORK, 'assets')]) {
  mkdirSync(dir, { recursive: true });
}

let built = 0;
const failed = [];
for (const app of apps) {
  const name = app.name;
  writeFileSync(path.join(WORK, 'manifests', `${name}.xml`), manifestFor(template, name));
  const assetDir = path.join(WORK, 'assets', name);
  mkdirSync(assetDir, { recursive: true });
  // Compile the source with the real opuromc, then place it under the shell's
  // default IR filename so the APK needs no launch-intent extra.
  const irOut = path.join(assetDir, 'dashboard.opuir.json');
  const compile = spawnSync(COMPILER, ['compile', path.join(EXAMPLES, app.source), '-o', irOut], {
    encoding: 'utf8', timeout: 120000,
  });
  if (compile.status !== 0) {
    failed.push(name);
    console.log(`  FAIL ${name}: compile ${(compile.stderr || '').trim().split('\n')[0]}`);
    continue;
  }
  const apkOut = path.join(OUT, `${name}.apk`);
  const build = spawnSync(process.execPath, [path.join(ROOT, 'build-apk.mjs')], {
    encoding: 'utf8',
    timeout: 600000,
    env: {
      ...process.env,
      OPR_APK_OUTPUT: apkOut,
      OPR_APK_MANIFEST: path.join(WORK, 'manifests', `${name}.xml`),
      OPR_APK_ASSETS: assetDir,
    },
  });
  if (build.status === 0 && existsSync(apkOut)) {
    built += 1;
    console.log(`  OK   ${name.padEnd(22)} ${String(statSync(apkOut).size).padStart(8)} bytes`);
  } else {
    failed.push(name);
    console.log(`  FAIL ${name}: build ${(build.stderr || '').trim().split('\n').slice(-1)[0]}`);
  }
}

console.log(`\nAPK matrix: built ${built}/${apps.length}`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`output: ${OUT}`);
