#!/usr/bin/env node
// Zero-dependency verifier for the OPUROM mobile workstream (iOS + Android).
// Resolves every path from this file, so it runs from any working directory
// (including the umbrella workspace root). Each child process is bounded by a
// spawn timeout; nothing is left running after this script exits.
//
// Every tool that is missing on the host produces a concrete SKIP naming the
// exact missing tool. There is no fake PASS anywhere in this file.
'use strict';

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.join(ROOT, 'target', 'aarch64-apple-ios', 'release', 'libopurom_mobile.a');
const WORK = path.join(ROOT, 'target', 'verify');
const ANDROID_OUT = path.join(ROOT, 'target', 'android');

const failures = [];
let passed = 0;
let skipped = 0;

function pass(message) {
  passed += 1;
  console.log(`PASS: ${message}`);
}

function skip(message) {
  skipped += 1;
  console.log(`SKIP: ${message}`);
}

function fail(message, detail) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
  if (detail) console.error(detail);
}

function childEnv() {
  const env = { ...process.env };
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  if (!env.PATH) env.PATH = cargoBin;
  else if (!env.PATH.split(path.delimiter).includes(cargoBin)) {
    env.PATH = `${cargoBin}${path.delimiter}${env.PATH}`;
  }
  env.CARGO_TERM_COLOR = 'never';
  return env;
}

// Every step is bounded; a timeout kills the child and fails that step.
// argv[0] is the executable, the rest are its arguments.
function run(label, argv, { timeoutMs = 60000, cwd = ROOT, env } = {}) {
  const [cmd, ...args] = argv;
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: env ? { ...childEnv(), ...env } : childEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  if (res.error) {
    return { ok: false, ms, stdout, stderr: `${stderr}\n${res.error.message}` };
  }
  return { ok: res.status === 0, ms, status: res.status, stdout, stderr };
}

function firstLine(text) {
  return (text || '').split('\n')[0];
}

mkdirSync(WORK, { recursive: true });
mkdirSync(path.join(WORK, 'module-cache'), { recursive: true });
mkdirSync(path.join(WORK, 'classes'), { recursive: true });

console.log(`verify root: ${ROOT}`);

// =====================================================================
// Tool discovery. Each helper returns an absolute path or null, so a
// missing tool becomes a concrete SKIP instead of a fake PASS.
// =====================================================================

// Local toolchain roots are resolved at runtime, never hardcoded. A sibling
// `toolchains/` directory next to the repository root is the fallback layout;
// the directory entries are scanned, so the exact archive folder names on the
// host do not matter.
function localToolchainRoots() {
  const roots = [];
  const sibling = path.resolve(ROOT, '..', '..', 'toolchains');
  if (existsSync(sibling)) roots.push(sibling);
  const parent = path.resolve(ROOT, '..', 'toolchains');
  if (existsSync(parent) && parent !== sibling) roots.push(parent);
  return roots;
}

// Every immediate subdirectory of a toolchain root, so a downloaded archive
// folder (for example a JDK under `jdk-download/`) is found without naming it.
function toolchainSubdirectories(root) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    try {
      if (statSync(full).isDirectory()) found.push(full);
    } catch {
      // A racing removal is not a reason to fail the whole lookup.
    }
  }
  return found;
}

// JDK 21 layouts: a macOS bundle keeps the tools under Contents/Home/bin, a
// Linux tarball keeps them directly under bin.
function javacCandidates(dir) {
  return [
    path.join(dir, 'Contents', 'Home', 'bin', 'javac'),
    path.join(dir, 'bin', 'javac'),
  ];
}

function findJavac() {
  const candidates = [];
  if (process.env.OPUROM_JAVAC) candidates.push(process.env.OPUROM_JAVAC);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javac'));
  for (const root of localToolchainRoots()) {
    for (const dir of toolchainSubdirectories(root)) {
      for (const candidate of javacCandidates(dir)) candidates.push(candidate);
      // One level deeper, for a root that holds download directories.
      for (const nested of toolchainSubdirectories(dir)) {
        for (const candidate of javacCandidates(nested)) candidates.push(candidate);
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function javaFromJavac(javac) {
  if (!javac) return null;
  const java = path.join(path.dirname(javac), 'java');
  return existsSync(java) ? java : null;
}

// The NDK ships one clang driver per Android ABI. The sysroot comes from the
// driver itself, so no extra --sysroot flag is needed.
function findNdk() {
  const candidates = [];
  if (process.env.OPR_NDK_HOME) candidates.push(process.env.OPR_NDK_HOME);
  if (process.env.ANDROID_NDK_HOME) candidates.push(process.env.ANDROID_NDK_HOME);
  if (process.env.ANDROID_NDK_ROOT) candidates.push(process.env.ANDROID_NDK_ROOT);
  for (const root of localToolchainRoots()) {
    for (const dir of toolchainSubdirectories(root)) {
      candidates.push(dir);
      for (const nested of toolchainSubdirectories(dir)) candidates.push(nested);
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const bin = path.join(candidate, 'toolchains', 'llvm', 'prebuilt',
      process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64', 'bin');
    if (existsSync(path.join(bin, 'aarch64-linux-android24-clang'))) {
      return { root: candidate, bin };
    }
  }
  return null;
}

function findSdk() {
  const candidates = [];
  if (process.env.OPR_ANDROID_SDK) candidates.push(process.env.OPR_ANDROID_SDK);
  if (process.env.ANDROID_HOME) candidates.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) candidates.push(process.env.ANDROID_SDK_ROOT);
  for (const root of localToolchainRoots()) {
    for (const dir of toolchainSubdirectories(root)) {
      candidates.push(dir);
      for (const nested of toolchainSubdirectories(dir)) candidates.push(nested);
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(path.join(candidate, 'platforms'))) return candidate;
  }
  return null;
}

// build-tools/<version> holds aapt2 and lib/d8.jar. Newest version wins.
function findBuildTools(sdk) {
  if (!sdk) return null;
  const root = path.join(sdk, 'build-tools');
  if (!existsSync(root)) return null;
  const versions = [];
  for (const entry of readdirSync(root).sort().reverse()) {
    const dir = path.join(root, entry);
    if (!existsSync(path.join(dir, 'aapt2'))) continue;
    versions.push(dir);
  }
  return versions[0] || null;
}

// OPR_ANDROID_API pins a platform; otherwise the newest directory with an
// android.jar wins.
function findPlatform(sdk) {
  if (!sdk) return null;
  const root = path.join(sdk, 'platforms');
  if (!existsSync(root)) return null;
  const requested = process.env.OPR_ANDROID_API;
  if (requested) {
    const api = requested.startsWith('android-') ? requested : `android-${requested}`;
    const jar = path.join(root, api, 'android.jar');
    return existsSync(jar) ? { api, jar } : null;
  }
  const versions = [];
  for (const entry of readdirSync(root).sort().reverse()) {
    const jar = path.join(root, entry, 'android.jar');
    if (existsSync(jar)) versions.push({ api: entry, jar });
  }
  return versions[0] || null;
}

// =====================================================================
// 1. Rust unit tests for the pure state machine (native host target).
// =====================================================================
const testRun = run('cargo test', ['cargo', 'test', '--offline', '--lib'], { timeoutMs: 120000 });
if (testRun.ok) {
  const summary = testRun.stdout.split('\n').find((line) => line.startsWith('test result:')) || '';
  pass(`cargo unit tests: ${summary} (${testRun.ms}ms)`);
} else {
  fail('cargo unit tests failed', `${testRun.stdout}\n${testRun.stderr}`);
}

// =====================================================================
// 1b. Real-renderer C ABI tests and the measured per-frame render time.
// =====================================================================
const renderTest = run('cargo test real_render', [
  'cargo', 'test', '--offline', '--test', 'real_render', '--', '--nocapture',
], { timeoutMs: 180000 });
if (renderTest.ok) {
  const summary = renderTest.stdout.split('\n').find((line) => line.startsWith('test result:')) || '';
  const measured = renderTest.stdout.match(/MEASURED[^\n]*/);
  if (!measured) {
    fail('real IR tests did not report a measured per-frame time', renderTest.stdout);
  } else {
    pass(`real IR C ABI: ${summary}`);
    pass(measured[0]);
  }
} else {
  fail('real IR C ABI tests failed', `${renderTest.stdout}\n${renderTest.stderr}`);
}

// =====================================================================
// 1c. Compile the Todo example with opuromc and prove the shipped Android
//     asset is exactly that compiled IR. Missing tools produce a concrete
//     SKIP; the comparison is byte-for-byte, never a fake PASS.
// =====================================================================
const LANG_ROOT = path.resolve(ROOT, '..', 'opurom-lang');
const TODO_SRC = path.resolve(ROOT, '..', 'opurom-examples', 'todo.opu');
const TODO_ASSET = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'todo.opuir.json');
const TODO_COMPILED = path.join(WORK, 'todo.opuir.json');

function findOpuromc() {
  const candidates = [];
  if (process.env.OPUROMC) candidates.push(process.env.OPUROMC);
  for (const profile of ['release', 'debug']) {
    candidates.push(path.join(LANG_ROOT, 'target', profile, 'opuromc'));
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

let compiler = findOpuromc();
if (!compiler && existsSync(path.join(LANG_ROOT, 'Cargo.toml'))) {
  const compilerBuild = run('cargo build opuromc', [
    'cargo', 'build', '--offline', '--manifest-path', path.join(LANG_ROOT, 'Cargo.toml'),
  ], { timeoutMs: 300000, cwd: LANG_ROOT });
  if (!compilerBuild.ok) {
    console.error(`note: offline opuromc build failed: ${firstLine(compilerBuild.stderr)}`);
  }
  compiler = findOpuromc();
}

if (!compiler || !existsSync(TODO_SRC) || !existsSync(TODO_ASSET)) {
  skip('Todo IR compilation needs ../opurom-examples/todo.opu, the shipped IR asset and opuromc at ../opurom-lang/target/{debug,release}/opuromc.');
} else {
  const compiledRun = run('opuromc compile todo.opu', [
    compiler, 'compile', TODO_SRC, '-o', TODO_COMPILED,
  ], { timeoutMs: 120000 });
  if (!compiledRun.ok) {
    fail('opuromc compile of the Todo example failed',
      `${compiledRun.stdout}\n${compiledRun.stderr}`);
  } else {
    const compiled = readFileSync(TODO_COMPILED, 'utf8');
    const shipped = readFileSync(TODO_ASSET, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(compiled);
    } catch (error) {
      fail('compiled Todo IR is not JSON', String(error));
    }
    if (parsed && compiled === shipped && parsed.ir === '0.1' &&
        parsed.app === 'TodoApp' &&
        Array.isArray(parsed.state) && parsed.state.some((s) => s.name === 'remaining') &&
        parsed.tree && parsed.tree.kind === 'Column') {
      pass(`opuromc compiled Todo IR matches the shipped Android asset (${compiled.length} bytes, ir ${parsed.ir}, app ${parsed.app})`);
    } else {
      fail('shipped Android IR asset differs from a fresh opuromc compilation',
        `compiled ${compiled.length} bytes, shipped ${shipped.length} bytes`);
    }
  }
}

// =====================================================================
// 1d. ELF64 dynamic symbol evidence. This is a Rust test so the check also
//     runs on hosts without the NDK readelf tools.
// =====================================================================
const elfTest = run('cargo test elf_exports', [
  'cargo', 'test', '--offline', '--test', 'elf_exports',
], { timeoutMs: 120000 });
if (elfTest.ok) {
  const summary = elfTest.stdout.split('\n').find((line) => line.startsWith('test result:')) || '';
  pass(`ELF64 dynamic symbol checks: ${summary} (${elfTest.ms}ms)`);
} else {
  fail('ELF64 dynamic symbol checks failed', `${elfTest.stdout}\n${elfTest.stderr}`);
}

// =====================================================================
// 2. Cross-compile the staticlib for aarch64-apple-ios (offline).
//    The iOS slice needs macOS; on other hosts it is a concrete SKIP.
// =====================================================================
if (process.platform !== 'darwin') {
  skip('iOS staticlib needs macOS (xcrun, lipo, iPhoneOS SDK); this host is ' +
    process.platform + '. Documented: no iOS build on non-macOS hosts.');
} else {
  const buildStart = Date.now();
  const build = run('cargo build', [
    'cargo', 'build', '--release', '--target', 'aarch64-apple-ios', '--offline',
  ], { timeoutMs: 240000 });
  const buildMs = Date.now() - buildStart;
  if (!build.ok) {
    fail('cargo build --release --target aarch64-apple-ios --offline failed',
      `${build.stdout}\n${build.stderr}`);
  } else if (!existsSync(ARCHIVE)) {
    fail(`archive missing after successful build: ${ARCHIVE}`);
  } else {
    const bytes = statSync(ARCHIVE).size;
    console.log(`archive: ${ARCHIVE}`);
    console.log(`archive size: ${bytes} bytes`);
    pass(`aarch64-apple-ios staticlib built: ${ARCHIVE} (${bytes} bytes, ${buildMs}ms)`);

    // --- Evidence: real ar archive, arm64, iOS load commands ---
    const fileRun = run('file', ['file', ARCHIVE], { timeoutMs: 30000 });
    if (fileRun.ok && /current ar archive/.test(fileRun.stdout)) {
      pass(`file: ${firstLine(fileRun.stdout)}`);
    } else {
      fail('file(1) did not report a real ar archive', fileRun.stdout || fileRun.stderr);
    }

    const lipoRun = run('lipo', ['lipo', '-info', ARCHIVE], { timeoutMs: 30000 });
    if (lipoRun.ok && /:\s*arm64\s*$/.test(lipoRun.stdout) &&
        !/armv7|arm64e|x86_64|i386/.test(lipoRun.stdout)) {
      pass(`lipo -info: ${firstLine(lipoRun.stdout)}`);
    } else {
      fail('lipo -info did not report a single arm64 slice',
        lipoRun.stdout || lipoRun.stderr);
    }

    const otoolRun = run('otool', ['otool', '-l', ARCHIVE], { timeoutMs: 60000 });
    if (otoolRun.ok &&
        /LC_VERSION_MIN_IPHONEOS|LC_BUILD_VERSION/.test(otoolRun.stdout)) {
      const marker = /LC_VERSION_MIN_IPHONEOS/.test(otoolRun.stdout)
        ? 'LC_VERSION_MIN_IPHONEOS' : 'LC_BUILD_VERSION';
      pass(`otool -l: iOS load command present (${marker})`);
    } else {
      fail('otool -l did not show an iOS platform load command',
        otoolRun.stdout || otoolRun.stderr);
    }
  }

  // --- Swift wrapper typecheck against the C header via the module map ---
  const sdkRun = run('xcrun', ['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'],
    { timeoutMs: 30000 });
  if (!sdkRun.ok) {
    fail('xcrun cannot locate the iPhoneOS SDK', sdkRun.stderr);
  } else {
    const sdkPath = sdkRun.stdout.trim();
    const swift = run('swiftc', [
      'xcrun', '--sdk', 'iphoneos', 'swiftc', '-typecheck',
      '-target', 'arm64-apple-ios17.0',
      '-sdk', sdkPath,
      '-I', path.join(ROOT, 'swift'),
      '-I', path.join(ROOT, 'include'),
      '-module-cache-path', path.join(WORK, 'module-cache'),
      path.join(ROOT, 'swift', 'OpuromMobile.swift'),
    ], { timeoutMs: 120000 });
    if (swift.ok) {
      pass(`swift typecheck OK: xcrun --sdk iphoneos swiftc -typecheck (${swift.ms}ms, sdk ${sdkPath})`);
    } else {
      fail('swift typecheck failed', `${swift.stdout}\n${swift.stderr}`);
    }
  }
}

// =====================================================================
// 3. Android native library for aarch64 and x86_64.
//    The Rust static library is cross-compiled with cargo and linked into
//    real ELF shared objects with the NDK clang.
// =====================================================================
const ANDROID_ABIS = [
  {
    abi: 'aarch64',
    abiDir: 'arm64-v8a',
    target: 'aarch64-linux-android',
    machine: 183,
    machineName: 'EM_AARCH64',
  },
  {
    abi: 'x86_64',
    abiDir: 'x86_64',
    target: 'x86_64-linux-android',
    machine: 62,
    machineName: 'EM_X86_64',
  },
];

const ndk = findNdk();
const ndkBin = ndk ? ndk.bin : null;
const ndkClang = (abi) => path.join(ndkBin, `${abi}-linux-android24-clang`);
const ndkReadelf = ndkBin ? path.join(ndkBin, 'llvm-readelf') : null;
const ndkReadobj = ndkBin ? path.join(ndkBin, 'llvm-readobj') : null;

// The per-ABI artifact directory mirrors the Android jniLibs layout. It lives
// under target/ because the shared objects are build output, not sources.
const jniLibsDir = path.join(ANDROID_OUT, 'jniLibs');

if (!ndk) {
  skip('Android NDK not found (set OPR_NDK_HOME or ANDROID_NDK_HOME; looked for ' +
    'toolchains/llvm/prebuilt/*/bin/aarch64-linux-android24-clang): no Android .so is built.');
} else {
  console.log(`ndk root: ${ndk.root}`);

  for (const { abi, abiDir, target, machine, machineName } of ANDROID_ABIS) {
    const clang = ndkClang(abi);
    // The directory name is the Android ABI name that the Gradle plugin expects
    // for a jniLibs folder, not the Rust target name.
    const outDir = path.join(jniLibsDir, abiDir);
    const soPath = path.join(outDir, 'libopurom_mobile.so');
    mkdirSync(outDir, { recursive: true });

    // The cargo cross-build needs the NDK clang as the linker for the Rust
    // runtime it pulls in.
    const cargoBuild = run(`cargo build ${target}`, [
      'cargo', 'build', '--release', '--target', target, '--offline',
    ], {
      timeoutMs: 300000,
      env: {
        CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: ndkClang('aarch64'),
        CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER: ndkClang('x86_64'),
      },
    });
    if (!cargoBuild.ok) {
      fail(`cargo build --release --target ${target} failed`,
        `${cargoBuild.stdout}\n${cargoBuild.stderr}`);
      continue;
    }
    const staticlib = path.join(ROOT, 'target', target, 'release', 'libopurom_mobile.a');
    if (!existsSync(staticlib)) {
      fail(`Rust staticlib missing after a successful build: ${staticlib}`);
      continue;
    }

    // The NDK clang links the JNI shim together with the Rust archive into
    // one shared object; --whole-archive keeps the C ABI symbols reachable.
    const link = run(`${abi} clang -shared`, [
      clang, '-shared', '-fPIC', '-O2',
      '-I', path.join(ROOT, 'jni'),
      '-I', path.join(ROOT, 'include'),
      '-o', soPath,
      path.join(ROOT, 'jni', 'opurom_jni.c'),
      '-Wl,--whole-archive', staticlib, '-Wl,--no-whole-archive',
      '-llog',
    ], { timeoutMs: 180000 });
    if (!link.ok) {
      fail(`NDK clang failed to link libopurom_mobile.so for ${abi}`,
        `${link.stdout}\n${link.stderr}`);
      continue;
    }
    const bytes = statSync(soPath).size;
    console.log(`android so: ${soPath} (${bytes} bytes)`);
    pass(`android ${abi} shared object built with the NDK clang: ${soPath} (${bytes} bytes)`);

    // --- Evidence: real ELF, expected machine type ---
    const header = readFileSync(soPath).subarray(0, 16);
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      fail(`${abi} shared object does not start with the ELF magic bytes`,
        `got ${[...header].map((b) => b.toString(16)).join(' ')}`);
      continue;
    }
    pass(`${abi} ELF magic bytes verified: 7f 45 4c 46`);

    const fileRun = run('file', ['file', soPath], { timeoutMs: 30000 });
    if (fileRun.ok && /ELF 64-bit LSB shared object/.test(fileRun.stdout)) {
      pass(`file: ${firstLine(fileRun.stdout)}`);
    } else {
      fail(`file(1) did not report an ELF 64-bit shared object for ${abi}`,
        fileRun.stdout || fileRun.stderr);
    }

    // llvm-readobj prints the numeric machine, which is the authoritative
    // EM_AARCH64 (183) / EM_X86_64 (62) evidence.
    const readobj = run('llvm-readobj', [
      ndkReadobj, '--file-headers', soPath,
    ], { timeoutMs: 30000 });
    const machineMatch = readobj.stdout.match(/Machine:\s*EM_[A-Z0-9_]+\s*\(0x([0-9A-Fa-f]+)\)/);
    if (!readobj.ok || !machineMatch) {
      fail(`llvm-readobj did not report a machine type for ${abi}`,
        readobj.stdout || readobj.stderr);
    } else {
      const reported = parseInt(machineMatch[1], 16);
      if (reported === machine) {
        pass(`${abi} ELF machine type verified: ${machineName} (${reported}) == ${machine}`);
      } else {
        fail(`${abi} ELF machine type is ${reported}, expected ${machine} (${machineName})`,
          readobj.stdout);
      }
    }

    const readelf = run('llvm-readelf', [ndkReadelf, '-h', soPath], { timeoutMs: 30000 });
    if (readelf.ok && /Machine:\s+AArch64/.test(readelf.stdout) && abi === 'aarch64') {
      pass('llvm-readelf -h: Machine: AArch64');
    } else if (readelf.ok && /Machine:\s+Advanced Micro Devices X86-64/.test(readelf.stdout) &&
               abi === 'x86_64') {
      pass('llvm-readelf -h: Machine: Advanced Micro Devices X86-64');
    } else if (!readelf.ok) {
      fail(`llvm-readelf -h failed for ${abi}`, readelf.stderr);
    } else {
      fail(`llvm-readelf -h reported the wrong machine for ${abi}`, readelf.stdout);
    }

    // The JNI entry points must be exported, otherwise System.loadLibrary
    // would fail at runtime with UnsatisfiedLinkError.
    const dynsyms = run('llvm-readelf --dyn-syms', [
      ndkReadelf, '--dyn-syms', soPath,
    ], { timeoutMs: 30000 });
    const jniSymbols = [
      'Java_org_opurom_mobile_OpuromNative_opuStateNew',
      'Java_org_opurom_mobile_OpuromNative_opuDispatch',
      'Java_org_opurom_mobile_OpuromNative_opuFrame',
      'Java_org_opurom_mobile_OpuromNative_opuStateFree',
      'Java_org_opurom_mobile_OpuromNative_opuRendererNew',
      'Java_org_opurom_mobile_OpuromNative_opuRendererFrame',
      'Java_org_opurom_mobile_OpuromNative_opuRendererFree',
      'Java_org_opurom_mobile_OpuromNative_opuFrameFromIr',
    ];
    const abiSymbols = [
      'opu_state_new', 'opu_dispatch', 'opu_frame', 'opu_state_free',
      'opu_frame_from_ir', 'opu_renderer_new', 'opu_renderer_frame', 'opu_renderer_free',
    ];
    const missing = [...jniSymbols, ...abiSymbols]
      .filter((symbol) => !dynsyms.stdout.includes(symbol));
    if (missing.length === 0) {
      pass(`${abi} exports all ${jniSymbols.length} JNI entry points and all ${abiSymbols.length} C ABI symbols`);
    } else {
      fail(`${abi} shared object is missing exported symbols: ${missing.join(', ')}`,
        dynsyms.stdout);
    }
  }
}

// =====================================================================
// 4. JNI declaration and the Android app sources: javac.
// =====================================================================
const javac = findJavac();
const java = javaFromJavac(javac);
const sdk = findSdk();
const buildTools = findBuildTools(sdk);
const platform = findPlatform(sdk);

if (!javac) {
  skip('javac not found (set JAVA_HOME or OPUROM_JAVAC): JNI and app compile checks not run.');
} else {
  const versionRun = run('javac -version', [javac, '-version'], { timeoutMs: 30000 });
  const javacRun = run('javac', [
    javac, '-d', path.join(WORK, 'classes'), path.join(ROOT, 'jni', 'OpuromNative.java'),
  ], { timeoutMs: 60000 });
  if (javacRun.ok) {
    const classFile = path.join(WORK, 'classes', 'org', 'opurom', 'mobile',
      'OpuromNative.class');
    if (existsSync(classFile)) {
      pass(`javac OK: ${firstLine(versionRun.stdout) || versionRun.stdout} -> ${classFile} (${javacRun.ms}ms)`);
    } else {
      fail('javac reported success but OpuromNative.class is missing');
    }
  } else {
    fail('javac compile failed', `${javacRun.stdout}\n${javacRun.stderr}`);
  }

  // --- JNI header: real clang syntax check against the same JDK's jni.h ---
  const jdkHome = path.resolve(path.dirname(path.dirname(javac)));
  const jniHeader = path.join(jdkHome, 'include', 'jni.h');
  const jniMdHeader = path.join(jdkHome, 'include', 'darwin', 'jni_md.h');
  if (existsSync(jniHeader) && existsSync(jniMdHeader) && process.platform === 'darwin') {
    const clangRun = run('clang', [
      'xcrun', '--sdk', 'iphoneos', 'clang', '-fsyntax-only', '-x', 'c',
      '-I', path.join(jdkHome, 'include'),
      '-I', path.join(jdkHome, 'include', 'darwin'),
      '-I', path.join(ROOT, 'include'),
      path.join(ROOT, 'jni', 'opurom_jni.h'),
    ], { timeoutMs: 60000 });
    if (clangRun.ok) {
      pass(`clang -fsyntax-only OK for jni/opurom_jni.h against ${jniHeader} (${clangRun.ms}ms)`);
    } else {
      fail('clang -fsyntax-only failed for jni/opurom_jni.h',
        `${clangRun.stdout}\n${clangRun.stderr}`);
    }
  } else {
    skip('jni.h (or its darwin/jni_md.h) not found next to javac: JNI header syntax check not run.');
  }
}

// --- The Android app sources need a real android.jar to compile against ---
const appSources = [
  path.join(ROOT, 'jni', 'OpuromNative.java'),
  path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile',
    'MainActivity.java'),
];
const appClassesDir = path.join(WORK, 'app-classes');
if (!javac) {
  skip('javac not found: the Android app sources are not compiled.');
} else if (!platform) {
  skip('android.jar not found (no platforms/android-*/android.jar under ' +
    `${sdk || 'the Android SDK'}): the Android app sources are not compiled.`);
} else {
  mkdirSync(appClassesDir, { recursive: true });
  const appJavac = run('javac app', [
    javac, '--release', '17', '-Xlint:all', '-d', appClassesDir,
    '-cp', platform.jar,
    '-sourcepath', path.join(ROOT, 'android', 'app', 'src', 'main', 'java') +
      path.delimiter + path.join(ROOT, 'jni'),
    ...appSources,
  ], { timeoutMs: 120000 });
  const mainClass = path.join(appClassesDir, 'org', 'opurom', 'mobile', 'MainActivity.class');
  if (appJavac.ok && existsSync(mainClass)) {
    pass(`javac OK: Android app sources compiled against ${platform.jar} ` +
      `-> ${mainClass} (${appJavac.ms}ms)`);
  } else {
    fail('javac compile of the Android app sources failed',
      `${appJavac.stdout}\n${appJavac.stderr}`);
  }
}

// =====================================================================
// 5. aapt2 and d8 from build-tools, when the SDK provides them.
// =====================================================================
if (!buildTools) {
  skip('aapt2 not found (no build-tools/*/aapt2 under ' +
    `${sdk || 'the Android SDK'}): resources and the manifest are not packaged.`);
} else {
  const aapt2 = path.join(buildTools, 'aapt2');
  const aapt2Work = path.join(WORK, 'aapt2');
  mkdirSync(path.join(aapt2Work, 'compiled'), { recursive: true });
  mkdirSync(path.join(aapt2Work, 'linked'), { recursive: true });

  const compileRun = run('aapt2 compile', [
    aapt2, 'compile', '--dir', path.join(ROOT, 'android', 'app', 'src', 'main', 'res'),
    '-o', path.join(aapt2Work, 'compiled', 'res.zip'),
  ], { timeoutMs: 120000 });
  if (!compileRun.ok) {
    fail('aapt2 compile failed', `${compileRun.stdout}\n${compileRun.stderr}`);
  } else {
    pass(`aapt2 compile OK: android/app/src/main/res -> res.zip (${compileRun.ms}ms)`);

    // Linking needs android.jar for the resource table.
    if (!platform) {
      skip('aapt2 link skipped: android.jar not found (no platforms/android-*/android.jar ' +
        `under ${sdk || 'the Android SDK'}).`);
    } else {
      const assetsDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');
      const linkRun = run('aapt2 link', [
        aapt2, 'link', '-o', path.join(aapt2Work, 'linked', 'app.apk'),
        '-I', platform.jar,
        '-A', assetsDir,
        '--manifest', path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        path.join(aapt2Work, 'compiled', 'res.zip'),
      ], { timeoutMs: 120000 });
      const apk = path.join(aapt2Work, 'linked', 'app.apk');
      if (linkRun.ok && existsSync(apk)) {
        // aapt2 link stores PNG resources uncompressed but does not align
        // them; the platform loader requires stored entries to be 4-byte
        // aligned, so align the linked APK before it is inspected or tested.
        const zipalign = path.join(buildTools, 'zipalign');
        if (!existsSync(zipalign)) {
          fail('zipalign not found in build-tools', buildTools);
        } else {
          const aligned = path.join(aapt2Work, 'linked', 'app.apk.aligned');
          const alignRun = run('zipalign', [zipalign, '-f', '-p', '4', apk, aligned], { timeoutMs: 60000 });
          if (!alignRun.ok || !existsSync(aligned)) {
            fail('zipalign 4-byte alignment failed', `${alignRun.stdout}\n${alignRun.stderr}`);
          } else {
            rmSync(apk, { force: true });
            copyFileSync(aligned, apk);
            rmSync(aligned, { force: true });
            pass(`aapt2 link + zipalign OK: AndroidManifest.xml + resources + Todo IR asset -> ${apk} ` +
              `(${statSync(apk).size} bytes, ${linkRun.ms}ms)`);
          }
        }
        const listing = run('unzip -l', ['unzip', '-l', apk], { timeoutMs: 30000 });
        if (/ENOENT|not found/i.test(listing.stderr)) {
          skip('unzip(1) is unavailable: APK asset listing not checked (aapt2 link succeeded).');
        } else if (listing.ok && listing.stdout.includes('assets/todo.opuir.json')) {
          pass('aapt2 APK contains the compiled Todo IR asset');
        } else {
          fail('aapt2 APK is missing the compiled Todo IR asset',
            listing.stdout || listing.stderr);
        }
      } else {
        fail('aapt2 link failed', `${linkRun.stdout}\n${linkRun.stderr}`);
      }
    }
  }
}

const d8Jar = buildTools ? path.join(buildTools, 'lib', 'd8.jar') : null;
if (!d8Jar || !existsSync(d8Jar)) {
  skip('d8 not found (no build-tools/*/lib/d8.jar under ' +
    `${sdk || 'the Android SDK'}): the app classes are not dexed.`);
} else if (!java) {
  skip('java not found next to javac: d8 cannot be started.');
} else if (!existsSync(path.join(appClassesDir, 'org', 'opurom', 'mobile', 'MainActivity.class'))) {
  skip('d8 skipped: the Android app classes were not compiled (see the javac step).');
} else {
  const d8Work = path.join(WORK, 'd8');
  mkdirSync(d8Work, { recursive: true });
  const d8Run = run('d8', [
    java, '-cp', d8Jar, 'com.android.tools.r8.D8',
    ...(platform ? ['--lib', platform.jar] : []),
    '--output', d8Work,
    path.join(appClassesDir, 'org', 'opurom', 'mobile', 'OpuromNative.class'),
    path.join(appClassesDir, 'org', 'opurom', 'mobile', 'MainActivity.class'),
  ], { timeoutMs: 120000 });
  const dex = path.join(d8Work, 'classes.dex');
  if (d8Run.ok && existsSync(dex)) {
    pass(`d8 OK: app classes -> ${dex} (${statSync(dex).size} bytes, ${d8Run.ms}ms)`);
  } else {
    fail('d8 dexing failed', `${d8Run.stdout}\n${d8Run.stderr}`);
  }
}

// =====================================================================
// 6. The emulator/device run never happens here.
// =====================================================================
skip('no emulator or device execution: no Android system image is installed on this host, ' +
  'so the Activity is compiled and packaged but never run.');

console.log(`verify finished: ${passed} passed, ${skipped} skipped, ` +
  `${failures.length} failed`);
if (failures.length > 0) {
  console.log('VERIFY FAIL');
  process.exit(1);
}
console.log('VERIFY PASS (exit 0)');
process.exit(0);
