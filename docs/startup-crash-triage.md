# Android Startup-Crash Triage

This note describes an ordered path for diagnosing an OPUROM Android APK that crashes
immediately on launch, before the first frame is drawn. It works from the built artifact
outwards: package and ABI, then manifest, then native linkage, then the kernel runtime
contract. The tool `lib/startup-triage.mjs` (CLI `bin/triage.mjs`) checks the same four
layers against an artifact directory and prints one PASS, FAIL or SKIP line per check.

The layers are ordered because each one can only be trusted once the ones before it hold.
A wrong ABI never reaches the manifest loader; a missing soname never reaches the kernel
entry point. Fix the first failing layer, rebuild, and run the tool again rather than
jumping ahead.

## Running the tool

```sh
node bin/triage.mjs <artifact-dir>
```

`<artifact-dir>` is either an unpacked APK mirror or a jniLibs-style tree. The tool reads
`lib/<abi>/*.so`, `AndroidManifest.xml` (textual form) and `assets/<ir>.json`. Use
`--ir <asset-name>` to point at a non-default IR asset. The tool exits non-zero only when a
layer reports FAIL; a host with no build output produces SKIP lines and exits zero.

To inspect a built APK, unpack it first so the tool sees the manifest and libraries:

```sh
unzip -o app-debug.apk -d build/unpacked
node bin/triage.mjs build/unpacked
```

## Layer 1 — Package and ABI

**Symptom.** The app installs but dies at `System.loadLibrary("opurom_mobile")` with
`java.lang.UnsatisfiedLinkError: dlopen failed ... is 64-bit instead of 32-bit`, or the
installer rejects the APK for the device ABI.

**Command.**

```sh
node bin/triage.mjs <artifact-dir>
```

**Passing output.**

```
== 1. Package / ABI ==
  PASS: package/ABI: libopurom_mobile.so (arm64-v8a) is ELF64 EM_AARCH64 (183)
  PASS: package/ABI: libopurom_mobile.so (x86_64) is ELF64 EM_X86_64 (62)
```

**Fix options.** Build and ship a native library for every declared ABI
(`arm64-v8a`, `x86_64`); each `lib*.so` must be present under `lib/<abi>/` and its ELF
`e_machine` must match the ABI (`183` for aarch64, `62` for x86_64). A library with the
wrong machine type means the wrong cross-compile toolchain linked that ABI.

## Layer 2 — Manifest

**Symptom.** The launcher icon shows no activity, or the app installs on API 31+ but the
system refuses to start it with `Activity ... does not declare android:exported`, or launch
fails with `ClassNotFoundException` for the application class.

**Command.** The tool reads the textual manifest; for a built APK, decode it first:

```sh
aapt2 dump xmltree app-debug.apk --file AndroidManifest.xml
```

**Passing output.**

```
== 2. Manifest ==
  PASS: manifest: <application android:name="org.opurom.mobile.App"> is present
  PASS: manifest: launcher activity declares MAIN action + LAUNCHER category
  PASS: manifest: targetSdk 36 >= 31 with android:exported declared on every activity
```

**Fix options.** Keep one `<application>` node with a launcher activity whose
`<intent-filter>` carries `android.intent.action.MAIN` and `android.intent.category.LAUNCHER`.
Once `targetSdk` is 31 or higher, declare `android:exported` explicitly on every activity
that has an intent-filter. When `targetSdk` lives in Gradle rather than the manifest, the
tool self-skips the exported check with that reason.

## Layer 3 — Native linkage

**Symptom.** The process aborts at load time with
`dlopen failed: library "libfoo.so" not found` or `cannot locate symbol`. The APK installs and
the manifest is correct, but the loader cannot satisfy a shared-library dependency.

**Command.**

```sh
llvm-readelf -d lib/<abi>/libopurom_mobile.so | grep NEEDED
node bin/triage.mjs <artifact-dir>
```

**Passing output.**

```
== 3. Native linkage ==
  PASS: linkage: libopurom_mobile.so (arm64-v8a) resolves all DT_NEEDED (liblog.so, libdl.so, libc.so) against the packaged set
```

**Fix options.** A `DT_NEEDED` soname must resolve either to a library packaged in the same
`lib/<abi>/` set or to a platform library the device provides (`libc.so`, `liblog.so`,
`libdl.so`, `libm.so`). A missing packaged dependency means the dependent library was not
copied into that ABI folder; ship it or drop the dependency. A soname introduced after the
manifest's target API level means the app links against code the device does not have;
either raise `minSdk`/`targetSdk` to the availability floor or link an older library variant.

## Layer 4 — Runtime contract

**Symptom.** The library loads, but the first native call fails:
`UnsatisfiedLinkError: No implementation found for ... opuFrameFromIr`, or the app throws
`opu_frame_from_ir failed with status ...` or `cannot read IR asset` before any frame.

**Command.**

```sh
node bin/triage.mjs <artifact-dir> --ir dashboard.opuir.json
```

**Passing output.**

```
== 4. Runtime contract ==
  PASS: runtime: libopurom_mobile.so exports all 8 kernel runtime entry points
  PASS: runtime: packaged IR asset dashboard.opuir.json exists and parses as IR 0.1
```

**Fix options.** The mobile staticlib must keep the eight kernel runtime entry points
exported (`opu_state_new`, `opu_dispatch`, `opu_frame`, `opu_state_free`,
`opu_frame_from_ir`, `opu_renderer_new`, `opu_renderer_frame`, `opu_renderer_free`); a
missing symbol means the link step dropped it or the JNI shim was built against a stale
archive. The IR asset the app loads must be packaged under `assets/` and parse as IR 0.1
with a `tree` node; a missing or malformed asset aborts the first render.

## Root-cause fix paths

### Missing 16 KB page-size alignment (target SDK 35 / API 35)

Android 15 on a 16 KB-page device (and Play requirements for apps targeting API 35) require
native libraries whose `PT_LOAD` segments are aligned to 16 KB. A library aligned only to
4 KB loads on 4 KB devices but aborts on a 16 KB device, which surfaces as a crash at
`System.loadLibrary`. The check is the `p_align` value of each `PT_LOAD` segment.

**Fix path A — link with 16 KB alignment.** Pass `-Wl,-z,max-page-size=16384` to the NDK
clang link step so the linker emits 16 KB-aligned segments. This is a link-time flag, so
every rebuild must use it; verify with:

```sh
llvm-readelf -l lib/arm64-v8a/libopurom_mobile.so | grep LOAD
```

Every `LOAD` line must show `0x4000` in its final alignment column.

**Fix path B — keep 4 KB alignment and lower the target.** Keep `targetSdk` below 35 so the
16 KB requirement does not apply, accepting that the app does not target the newest API and
does not install on a 16 KB-only device image.

**Comparison and recommendation.** Fix path A is preferred: it keeps the app on the current
target API and lets the same artifact run on both 4 KB and 16 KB devices, at the cost of a
single link flag that must be present on every build. Fix path B is a temporary narrowing
that trades device coverage for no build change. Adopt path A and add the flag to the NDK
link step so the artifact stays consistent across rebuilds.

### Missing `DT_NEEDED` soname or wrong ABI packaging

Two distinct failures share the loader stage. A missing soname means the library declares a
dependency the APK does not ship; a wrong ABI package means the `lib/<abi>/` tree does not
match the device ABI or carries the wrong `e_machine`. Both abort at `dlopen`.

**Fix path A — ship the dependency per ABI.** Copy the missing soname into every
`lib/<abi>/` folder that needs it, or remove the dependency from the library that requires
it. Confirm each ABI folder holds a complete, self-consistent set.

**Fix path B — correct the ABI packaging.** Rebuild the offending library with the toolchain
for its ABI so `e_machine` matches (`183` for `arm64-v8a`, `62` for `x86_64`), and place it
under the matching `lib/<abi>/` directory. This is required when one ABI folder accidentally
contains a library built for another architecture.

**Comparison and recommendation.** Choose the fix that matches the observed failure: a
missing packaged soname is a packaging gap (path A); a mismatched `e_machine` or a missing
ABI folder is a build-and-package error (path B). Both are confirmed in one run of
`node bin/triage.mjs <artifact-dir>`, whose layer 1 and layer 3 lines name the ABI, the
library and the missing or mismatched soname.

## Roadmap

- Add a binary AXML decoder so the manifest layer reads a packed APK manifest directly
  instead of requiring an unpacked textual manifest.
- Add a 16 KB page-size alignment assertion to layer 1 once the link step emits 16 KB
  segments, so the check reads `p_align` rather than inferring it from the load address.
