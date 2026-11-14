// Layered startup-crash triage for an Android artifact directory.
//
// An APK that crashes on startup fails at one of four ordered layers:
// package/ABI, manifest, native linkage, or the kernel runtime contract.
// This module inspects a real directory (an unpacked APK mirror or a built
// jniLibs tree) and reports each layer as PASS, FAIL or SKIP with evidence.
// Each layer self-skips with a concrete reason when its input is absent, so a
// host without build output still produces a clean report instead of a fake
// verdict. Standard library only; the ELF reader reuses the checks already
// documented in tests/elf_exports.rs rather than cloning that whole reader.
'use strict';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The ABI names the Android Gradle plugin expects under lib/<abi>/.
export const ANDROID_ABIS = [
  { abi: 'arm64-v8a', target: 'aarch64-linux-android', machine: 183, machineName: 'EM_AARCH64' },
  { abi: 'x86_64', target: 'x86_64-linux-android', machine: 62, machineName: 'EM_X86_64' },
];

// Exported entry points the mobile staticlib must keep reachable through the
// JNI shim; the list matches tests/elf_exports.rs so every check agrees.
export const EXPECTED_EXPORTS = [
  'opu_state_new', 'opu_dispatch', 'opu_frame', 'opu_state_free',
  'opu_frame_from_ir', 'opu_renderer_new', 'opu_renderer_frame', 'opu_renderer_free',
];

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const SHT_DYNSYM = 11;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const SHN_UNDEF = 0;

// Android platform libraries available at each API level. An app that targets
// API 24 cannot resolve a soname introduced later, which crashes the loader at
// startup on that device. The table only lists the sonames an app commonly
// links that changed presence; stdlib sonames (libc, liblog, libdl) are always
// present and are not gated.
const API_SONAME_FLOOR = new Map([
  ['libandroid.so', 1],
  ['libjnigraphics.so', 8],
  ['libmediandk.so', 21],
  ['liblog.so', 1],
]);

function readUInt(bytes, offset, size) {
  if (offset + size > bytes.length) throw new Error('ELF image is truncated');
  let value = 0n;
  for (let i = size - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  return Number(value);
}

function readCString(bytes, offset) {
  const end = bytes.indexOf(0, offset);
  if (end < 0) throw new Error('string is not NUL-terminated');
  return bytes.subarray(offset, end).toString('utf8');
}

// Reads an ELF64 file's machine type, DT_NEEDED sonames, and defined dynamic
// symbol names. Mirrors the header and section walk in tests/elf_exports.rs so
// the failing layer and message match what the Rust test would report.
export function readElf(bytes) {
  for (let i = 0; i < ELF_MAGIC.length; i += 1) {
    if (bytes[i] !== ELF_MAGIC[i]) throw new Error('ELF magic bytes are absent');
  }
  const elfClass = bytes[4];
  const data = bytes[5];
  if (elfClass !== 2) throw new Error(`ELF class ${elfClass} is not ELFCLASS64`);
  if (data !== 1) throw new Error(`ELF data encoding ${data} is not little-endian`);
  const eType = readUInt(bytes, 16, 2);
  if (eType !== 3) throw new Error(`ELF type ${eType} is not ET_DYN`);
  const machine = readUInt(bytes, 18, 2);

  const phoff = readUInt(bytes, 32, 8);
  const phentsize = readUInt(bytes, 54, 2);
  const phnum = readUInt(bytes, 56, 2);
  const shoff = readUInt(bytes, 40, 8);
  const shentsize = readUInt(bytes, 58, 2);
  const shnum = readUInt(bytes, 60, 2);
  const shstrndx = readUInt(bytes, 62, 2);

  const segments = [];
  let dynamicSegment = null;
  for (let i = 0; i < phnum; i += 1) {
    const off = phoff + i * phentsize;
    const pType = readUInt(bytes, off, 4);
    const pOffset = readUInt(bytes, off + 8, 8);
    const pVaddr = readUInt(bytes, off + 16, 8);
    const pFilesz = readUInt(bytes, off + 32, 8);
    segments.push({ pType, pOffset, pVaddr, pFilesz });
    if (pType === PT_DYNAMIC) dynamicSegment = { pOffset, pFilesz };
  }

  const vaddrToOffset = (vaddr) => {
    for (const seg of segments) {
      if (seg.pType === PT_LOAD && vaddr >= seg.pVaddr && vaddr < seg.pVaddr + seg.pFilesz) {
        return seg.pOffset + (vaddr - seg.pVaddr);
      }
    }
    throw new Error(`virtual address 0x${vaddr.toString(16)} is not inside a PT_LOAD segment`);
  };

  const needed = [];
  if (dynamicSegment) {
    const dynOffsets = [];
    let strtabVaddr = null;
    for (let cursor = 0; cursor + 16 <= dynamicSegment.pFilesz; cursor += 16) {
      const off = dynamicSegment.pOffset + cursor;
      const tag = readUInt(bytes, off, 8);
      if (tag === DT_NULL) break;
      const val = readUInt(bytes, off + 8, 8);
      if (tag === DT_NEEDED) dynOffsets.push(val);
      if (tag === DT_STRTAB) strtabVaddr = val;
    }
    if (dynOffsets.length > 0) {
      if (strtabVaddr === null) throw new Error('ELF has DT_NEEDED but no DT_STRTAB');
      const strtabOffset = vaddrToOffset(strtabVaddr);
      for (const nameOffset of dynOffsets) needed.push(readCString(bytes, strtabOffset + nameOffset));
    }
  }

  // Defined global/weak symbols live in SHT_DYNSYM linked to its string table.
  const sectionAt = (index) => {
    const off = shoff + index * shentsize;
    return {
      type: readUInt(bytes, off + 4, 4),
      offset: readUInt(bytes, off + 24, 8),
      size: readUInt(bytes, off + 32, 8),
      link: readUInt(bytes, off + 40, 4),
      entSize: readUInt(bytes, off + 56, 8),
    };
  };
  const exports = new Set();
  const shstrtab = sectionAt(shstrndx);
  for (let i = 0; i < shnum; i += 1) {
    const section = sectionAt(i);
    if (section.type !== SHT_DYNSYM) continue;
    const strtab = sectionAt(section.link);
    const entrySize = section.entSize || 24;
    for (let cursor = 0; cursor + entrySize <= section.size; cursor += entrySize) {
      const off = section.offset + cursor;
      const nameOffset = readUInt(bytes, off, 4);
      const info = bytes[off + 4];
      const shndx = readUInt(bytes, off + 6, 2);
      const binding = info >> 4;
      if (shndx === SHN_UNDEF || (binding !== 1 && binding !== 2)) continue;
      exports.add(readCString(bytes, strtab.offset + nameOffset));
    }
  }
  void shstrtab;

  return { machine, needed, exports };
}

// --- Minimal AndroidManifest.xml reader -----------------------------------
// A textual manifest is parsed with a small tag scanner; a binary AXML
// manifest (the form inside a built APK) is detected but not decoded, so the
// manifest layer reports SKIP with the conversion command rather than a wrong
// verdict. This avoids a full AXML decoder for a triage tool.
export function parseManifestText(text) {
  const applicationMatch = /<application\b([\s\S]*?)(\/?)>/.exec(text);
  const launcher = /<activity\b[\s\S]*?<intent-filter>[\s\S]*?<action\s+android:name="android\.intent\.action\.MAIN"\s*\/>[\s\S]*?<category\s+android:name="android\.intent\.category\.LAUNCHER"\s*\/>[\s\S]*?<\/intent-filter>/.test(text);
  const applicationName = applicationMatch && /android:name\s*=\s*"([^"]+)"/.exec(applicationMatch[1]);
  const manifestSdk = /<uses-sdk\b([^>]*?)\/?>/.exec(text);
  const targetSdk = (manifestSdk && /android:targetSdkVersion\s*=\s*"(\d+)"/.exec(manifestSdk[1]))
    || /android:targetSdkVersion\s*=\s*"(\d+)"/.exec(text);
  // Each activity must declare android:exported once a launcher intent-filter
  // exists, which API 31 requires; a missing attribute is an install-time risk.
  const activityBlocks = [...text.matchAll(/<activity\b([\s\S]*?)>/g)].map((m) => m[1]);
  const exportedDeclared = activityBlocks.length > 0
    && activityBlocks.every((block) => /android:exported\s*=\s*"(true|false)"/.test(block));
  return {
    hasApplication: Boolean(applicationMatch),
    applicationName: applicationName ? applicationName[1] : null,
    hasLauncher: launcher,
    targetSdk: targetSdk ? Number(targetSdk[1]) : null,
    activityCount: activityBlocks.length,
    exportedDeclared,
  };
}

// --- IR asset validation ---------------------------------------------------
// The app hands the packaged IR JSON to opu_frame_from_ir, which parses it
// before the first frame. A missing or malformed asset aborts startup, so the
// runtime layer checks that the referenced asset exists and parses with the
// fields the renderer requires.
export function validateIrAsset(text) {
  let ir;
  try {
    ir = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `IR asset is not valid JSON: ${error.message}` };
  }
  if (!ir || typeof ir !== 'object') return { ok: false, reason: 'IR root is not an object' };
  if (ir.ir !== '0.1') return { ok: false, reason: `IR version is ${JSON.stringify(ir.ir)}, expected "0.1"` };
  if (!ir.tree || typeof ir.tree !== 'object') return { ok: false, reason: 'IR has no tree node' };
  if (typeof ir.tree.kind !== 'string') return { ok: false, reason: 'IR tree node has no kind' };
  return { ok: true };
}

// --- Artifact directory model ---------------------------------------------
// Accepts either a jniLibs-style tree (lib/<abi>/*.so) or an unpacked APK
// mirror, plus the source AndroidManifest.xml and assets directory.
export function loadArtifact(dir) {
  // Accept the two layouts the build actually produces: Gradle's jniLibs/ and
  // the unpacked-APK lib/ mirror; jniLibs is tried first because it ships intact.
  const libRoot =
    [path.join(dir, 'jniLibs'), path.join(dir, 'lib')].find((p) => existsSync(p)) ??
    path.join(dir, 'lib');
  const abiDirs = new Map();
  if (existsSync(libRoot)) {
    for (const { abi } of ANDROID_ABIS) {
      const abiDir = path.join(libRoot, abi);
      if (existsSync(abiDir)) abiDirs.set(abi, abiDir);
    }
  }
  const manifestCandidates = [
    path.join(dir, 'AndroidManifest.xml'),
    path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'),
  ];
  const manifestPath = manifestCandidates.find((p) => existsSync(p)) || null;
  const assetsCandidates = [
    path.join(dir, 'assets'),
    path.join(dir, 'app', 'src', 'main', 'assets'),
  ];
  const assetsDir = assetsCandidates.find((p) => existsSync(p)) || null;
  return { dir, libRoot, abiDirs, manifestPath, assetsDir };
}

function nativeLibraries(abiDir) {
  const libs = [];
  for (const entry of readdirSync(abiDir)) {
    if (/^lib.*\.so$/.test(entry)) libs.push(path.join(abiDir, entry));
  }
  return libs;
}

// --- Layer 1: package / ABI ------------------------------------------------
export function layerPackageAbi(artifact) {
  const results = [];
  if (artifact.abiDirs.size === 0) {
    return [{
      status: 'SKIP',
      message: `package/ABI: no lib/<abi>/ directory under ${artifact.dir} ` +
        '(build the NDK shared objects first); nothing to inspect.',
    }];
  }
  const builtAbis = new Set();
  for (const [abi, abiDir] of artifact.abiDirs) {
    const libs = nativeLibraries(abiDir);
    const spec = ANDROID_ABIS.find((entry) => entry.abi === abi);
    if (libs.length === 0) {
      results.push({ status: 'FAIL', message: `package/ABI: ${abi} declares no lib*.so under ${abiDir}` });
      continue;
    }
    builtAbis.add(abi);
    for (const lib of libs) {
      let elf;
      try {
        elf = readElf(readFileSync(lib));
      } catch (error) {
        results.push({ status: 'FAIL', message: `package/ABI: ${path.basename(lib)} (${abi}) is not a valid ELF: ${error.message}` });
        continue;
      }
      if (elf.machine !== spec.machine) {
        results.push({ status: 'FAIL', message: `package/ABI: ${path.basename(lib)} (${abi}) ELF machine is ${elf.machine}, expected ${spec.machine} (${spec.machineName})` });
      } else {
        results.push({ status: 'PASS', message: `package/ABI: ${path.basename(lib)} (${abi}) is ELF64 ${spec.machineName} (${elf.machine})` });
      }
    }
  }
  const missing = ANDROID_ABIS.filter((spec) => !builtAbis.has(spec.abi)).map((spec) => spec.abi);
  if (missing.length > 0) {
    results.push({ status: 'FAIL', message: `package/ABI: declared ABIs ${missing.join(', ')} ship no native library; a device on that ABI cannot load libopurom_mobile.so` });
  }
  return results;
}

// --- Layer 2: manifest -----------------------------------------------------
export function layerManifest(artifact) {
  if (!artifact.manifestPath) {
    return [{ status: 'SKIP', message: `manifest: no AndroidManifest.xml under ${artifact.dir}; manifest layer skipped.` }];
  }
  const head = readFileSync(artifact.manifestPath).subarray(0, 4);
  const isBinary = head.length >= 2 && head[0] === 0x03 && head[1] === 0x00;
  if (isBinary) {
    return [{
      status: 'SKIP',
      message: 'manifest: AndroidManifest.xml is binary AXML (inside a built APK); ' +
        'decode it with `aapt2 dump xmltree` and pass the textual manifest directory instead.',
    }];
  }
  const parsed = parseManifestText(readFileSync(artifact.manifestPath, 'utf8'));
  const results = [];
  if (parsed.hasApplication && parsed.applicationName) {
    results.push({ status: 'PASS', message: `manifest: <application android:name="${parsed.applicationName}"> is present` });
  } else if (parsed.hasApplication) {
    results.push({ status: 'PASS', message: 'manifest: <application> node is present' });
  } else {
    results.push({ status: 'FAIL', message: 'manifest: no <application> node; the launcher activity is not mounted' });
  }
  results.push(parsed.hasLauncher
    ? { status: 'PASS', message: 'manifest: launcher activity declares MAIN action + LAUNCHER category' }
    : { status: 'FAIL', message: 'manifest: no activity with MAIN action + LAUNCHER category; the app has no entry point' });
  const targetSdk = parsed.targetSdk;
  if (targetSdk === null) {
    results.push({ status: 'SKIP', message: 'manifest: no targetSdkVersion declared here (Gradle sets it); exported-attribute check skipped.' });
  } else if (targetSdk >= 31 && !parsed.exportedDeclared) {
    results.push({ status: 'FAIL', message: `manifest: targetSdk ${targetSdk} >= 31 requires android:exported on every activity, but one omits it` });
  } else if (targetSdk >= 31) {
    results.push({ status: 'PASS', message: `manifest: targetSdk ${targetSdk} >= 31 with android:exported declared on every activity` });
  } else {
    results.push({ status: 'PASS', message: `manifest: targetSdk ${targetSdk} < 31 needs no android:exported attribute` });
  }
  return results;
}

// --- Layer 3: native linkage ----------------------------------------------
export function layerLinkage(artifact) {
  if (artifact.abiDirs.size === 0) {
    return [{ status: 'SKIP', message: `linkage: no lib/<abi>/ directory under ${artifact.dir}; linkage layer skipped.` }];
  }
  const results = [];
  const targetSdk = artifact.manifestPath && !isBinary(readFileSync(artifact.manifestPath))
    ? parseManifestText(readFileSync(artifact.manifestPath, 'utf8')).targetSdk
    : null;
  for (const [abi, abiDir] of artifact.abiDirs) {
    const packaged = new Set(nativeLibraries(abiDir).map((lib) => path.basename(lib)));
    for (const lib of nativeLibraries(abiDir)) {
      let elf;
      try {
        elf = readElf(readFileSync(lib));
      } catch (error) {
        results.push({ status: 'FAIL', message: `linkage: cannot read DT_NEEDED of ${path.basename(lib)} (${abi}): ${error.message}` });
        continue;
      }
      const base = path.basename(lib);
      // A soname resolves if it is packaged in this ABI set or is a platform
      // library; libc/liblog/libdl/libm are provided by the device loader.
      const platformSonames = new Set(['libc.so', 'liblog.so', 'libdl.so', 'libm.so', 'libandroid.so', 'libstdc++.so', 'libz.so']);
      const missing = elf.needed.filter((soname) => !packaged.has(soname) && !platformSonames.has(soname));
      if (missing.length > 0) {
        for (const soname of missing) {
          results.push({ status: 'FAIL', message: `linkage: ${base} (${abi}) needs ${soname}, which is not packaged in lib/${abi}; the loader aborts with UnsatisfiedLinkError` });
        }
      } else {
        results.push({ status: 'PASS', message: `linkage: ${base} (${abi}) resolves all DT_NEEDED (${elf.needed.join(', ') || 'none'}) against the packaged set` });
      }
      if (targetSdk !== null) {
        const tooNew = elf.needed.filter((soname) => {
          const floor = API_SONAME_FLOOR.get(soname);
          return floor !== undefined && floor > targetSdk;
        });
        if (tooNew.length > 0) {
          results.push({ status: 'FAIL', message: `linkage: ${base} (${abi}) needs ${tooNew.join(', ')}, only present on API > ${targetSdk}; the loader rejects it on the declared target` });
        }
      }
    }
  }
  return results;
}

function isBinary(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x03 && bytes[1] === 0x00;
}

// --- Layer 4: runtime contract --------------------------------------------
export function layerRuntimeContract(artifact, { irAsset = 'dashboard.opuir.json' } = {}) {
  const results = [];
  if (artifact.abiDirs.size === 0) {
    results.push({ status: 'SKIP', message: `runtime: no lib/<abi>/ directory under ${artifact.dir}; export check skipped.` });
  } else {
    const [abi, abiDir] = [...artifact.abiDirs.entries()][0];
    const lib = nativeLibraries(abiDir)[0];
    if (!lib) {
      results.push({ status: 'FAIL', message: `runtime: ${abi} ships no native library to export the kernel runtime` });
    } else {
      let elf;
      try {
        elf = readElf(readFileSync(lib));
      } catch (error) {
        results.push({ status: 'FAIL', message: `runtime: cannot read exports of ${path.basename(lib)}: ${error.message}` });
      }
      if (elf) {
        const missing = EXPECTED_EXPORTS.filter((name) => !elf.exports.has(name));
        if (missing.length > 0) {
          results.push({ status: 'FAIL', message: `runtime: ${path.basename(lib)} does not export the kernel runtime entry ${missing.join(', ')}; the JNI shim cannot reach it` });
        } else {
          results.push({ status: 'PASS', message: `runtime: ${path.basename(lib)} exports all ${EXPECTED_EXPORTS.length} kernel runtime entry points` });
        }
      }
    }
  }
  if (!artifact.assetsDir) {
    results.push({ status: 'SKIP', message: `runtime: no assets/ directory under ${artifact.dir}; IR asset check skipped.` });
    return results;
  }
  const assetPath = path.join(artifact.assetsDir, irAsset);
  if (!existsSync(assetPath)) {
    results.push({ status: 'FAIL', message: `runtime: the packaged IR asset ${irAsset} referenced by the app is missing under ${artifact.assetsDir}` });
    return results;
  }
  const validated = validateIrAsset(readFileSync(assetPath, 'utf8'));
  results.push(validated.ok
    ? { status: 'PASS', message: `runtime: packaged IR asset ${irAsset} exists and parses as IR ${'0.1'}` }
    : { status: 'FAIL', message: `runtime: IR asset ${irAsset} does not parse: ${validated.reason}` });
  return results;
}

// --- Report driver ---------------------------------------------------------
export const LAYERS = [
  { name: '1. Package / ABI', run: layerPackageAbi },
  { name: '2. Manifest', run: layerManifest },
  { name: '3. Native linkage', run: layerLinkage },
  { name: '4. Runtime contract', run: layerRuntimeContract },
];

// Runs the four layers in order and returns per-layer results plus a summary.
export function triage(dir, options = {}) {
  const artifact = loadArtifact(dir);
  const layers = LAYERS.map(({ name, run }) => ({ name, results: run(artifact, options) }));
  const flat = layers.flatMap((layer) => layer.results);
  return {
    dir,
    layers,
    passed: flat.filter((r) => r.status === 'PASS').length,
    failed: flat.filter((r) => r.status === 'FAIL').length,
    skipped: flat.filter((r) => r.status === 'SKIP').length,
  };
}

export function formatReport(report) {
  const lines = [`startup triage: ${report.dir}`];
  for (const layer of report.layers) {
    lines.push(`== ${layer.name} ==`);
    for (const result of layer.results) lines.push(`  ${result.status}: ${result.message}`);
  }
  lines.push(`triage finished: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  return lines.join('\n');
}

// CLI entry helper: prints the report and exits non-zero only on a real FAIL,
// so a SKIP-only run stays a clean exit for hosts without build output.
export function runCli(dir, options = {}) {
  const report = triage(dir, options);
  console.log(formatReport(report));
  return report.failed === 0 ? 0 : 1;
}
