# opurom-mobile

**Mobile native artifacts** slice of OPUROM ([PLATFORM_DELIVERY.md](https://github.com/opurom/opurom-spec/blob/main/PLATFORM_DELIVERY.md), section 3) plus the
**Android native library and app module** slice ([NATIVE_NETWORK.md](https://github.com/opurom/opurom-spec/blob/main/NATIVE_NETWORK.md), section 3). One independent local git repo, one Rust crate with a path dependency on the sibling
[opurom-render](https://github.com/opurom/opurom-render/blob/main/README.md) software renderer, and no network access at build
time. It implements the C ABI of the [Platform Adapter contract](https://github.com/opurom/opurom-spec/blob/main/ADAPTER_CONTRACT.md)
as a small deterministic state machine plus an additive IR path that draws real OPUROM UI:

- a real `aarch64-apple-ios` static library with `file`/`lipo`/`otool` evidence;
- a Swift wrapper typechecked against the C header via a module map, including the IR entry points;
- a JNI declaration compiled with `javac`;
- real ELF Android shared objects for `aarch64-linux-android` and `x86_64-linux-android`,
  built with the Android NDK clang, with ELF magic bytes and machine type proven;
- a minimal Android app module (Gradle, `AndroidManifest.xml`, one `Activity`) that loads
  the compiled Todo IR from its assets and renders real frames through JNI into an `ImageView`.

On-host verification covers compilation, ELF provenance, dynamic symbol exports, Mach-O64
provenance for the iOS archive, resource packaging, APK ZIP structure and the full APK build;
on-device execution and store distribution are packaged targets
for hosts with an Android system image.

## Build and verify

```sh
cd opurom-mobile
cargo test --offline                          # full Rust suite, host target
node verify.mjs                               # full verification (runs from any cwd)
npm test                                      # Node-side ABI spec test
```

`verify.mjs` is zero-dependency Node and resolves all paths from its own file, so
`node <path-to>/opurom-mobile/verify.mjs` works from the umbrella workspace root. Every child
process has a hard spawn timeout. On a host that lacks a tool the verifier prints a concrete
`SKIP` naming the exact missing tool and exits 0. The
verifier calls `opuromc` from the sibling compiler project to compile
`../opurom-examples/todo.opu` and compares the result byte-for-byte with the IR asset shipped
in the Android app.

### Toolchain discovery

The verifier finds its tools through environment variables and a runtime-resolved
local `toolchains/` directory. No absolute path is compiled into the tool.

| Tool | Required version | Looked up in |
| --- | --- | --- |
| `cargo`, `rustc` | any recent stable | `PATH` (plus `~/.cargo/bin` prepended) |
| `javac` | JDK 21 | `OPUROM_JAVAC`, `JAVA_HOME`, then a sibling `toolchains/` JDK 21 |
| Android NDK | NDK r27c | `OPR_NDK_HOME`, `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`, then a sibling `toolchains/` NDK r27c |
| Android SDK | newest installed platform with `android.jar` | `OPR_ANDROID_SDK`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then a sibling `toolchains/` SDK |
| `aapt2`, `d8` | newest complete build-tools release | newest `build-tools/*/` of the SDK that actually contains them |

The local `toolchains/` fallback is resolved at runtime relative to the
repository root, and the directory entries are scanned rather than named, so the
layout on the host does not have to match a fixed path. Set the environment
variables above to point the verifier at a specific installation.

#### Android API and NDK configuration

`android/gradle.properties` defines `opuromCompileSdk=36`, `opuromTargetSdk=36`,
`opuromMinSdk=24`, and `opuromNdkVersion=27.2.12479018`. Gradle reads these
project properties; changing them changes the SDK API levels and NDK version.
`build-apk.mjs` and `verify.mjs` default to the newest installed Android
platform with `android.jar`; `OPR_ANDROID_API` selects a specific API. The APK
build prints the selected API and build-tools version in its final summary.

The Android Rust targets must be installed: `rustup target add aarch64-linux-android
x86_64-linux-android`.

### On-device APK

`npm run build:apk` produces `dist/opurom-mobile-debug.apk`, an installable APK for
device testing. The build runs `javac` and `d8` over the app sources, `aapt2 compile` and
`aapt2 link` over the manifest, resources and compiled IR asset, then assembles `classes.dex`
and the two ABI shared objects from `target/android/jniLibs/` into the archive. `zipalign`
aligns stored entries to 4-byte boundaries; `apksigner` signs with a stable debug keystore in
`dist/` (reused across rebuilds so `adb install -r` can replace an earlier build). The script
then verifies the v1, v2 and v3 signatures, the alignment, and the launchable activity before
reporting success. Every child process has a bounded timeout; a missing tool is a concrete
error naming what to install.

```sh
npm run build:apk
adb install -r dist/opurom-mobile-debug.apk
```

Entry timestamps are fixed, so rebuilding on the same host is byte-identical; the reported
SHA-256 is stable. The debug keystore is a build output and is not committed.

`npm run smoke:emulator` installs the built APK on a running emulator or device, launches
`MainActivity`, confirms the process stays alive with no fatal exception, captures a
screenshot, and taps the fixture's counter to prove the frame re-renders on interaction. It
resolves `adb` and the online device itself and prints an honest SKIP naming the missing
piece when no device is attached, so it is safe to run anywhere.

```sh
npm run build:apk
npm run smoke:emulator
```

### Measured results (macOS arm64, this host)

| Check | Actual result |
| --- | --- |
| `cargo test --offline` (host) | `29 passed; 0 failed; 0 ignored` |
| `node test/abi.test.mjs` | `PASS: abi spec fixtures match the documented C contract` |
| `node --test` (host) | `12 passed; 0 failed; 0 skipped`; ABI fixtures, asset integrity and APK signing determinism |
| `cargo test --offline --test real_render -- --nocapture` | `7 passed; 0 failed`; reports the measured per-frame microseconds and incremental redraw stats |
| `opuromc compile ../opurom-examples/todo.opu` | `1602` bytes, `ir 0.1`, `app TodoApp`, byte-identical to the shipped asset |
| `cargo build --release --target aarch64-apple-ios --offline` | archive written, `19393896` bytes |
| `file libopurom_mobile.a` | `current ar archive` |
| `lipo -info libopurom_mobile.a` | `Non-fat file ... is architecture: arm64` |
| `otool -l libopurom_mobile.a` | `LC_VERSION_MIN_IPHONEOS` present (iOS platform) |
| `xcrun --sdk iphoneos swiftc -typecheck` | pass, SDK `iPhoneOS27.2.sdk`, Swift 6.4.2 |
| `javac` (JNI declaration) | `javac 21.0.13` compiled `org/opurom/mobile/OpuromNative.class` |
| `clang -fsyntax-only` on `jni/opurom_jni.h` | pass against the same JDK's `jni.h` |
| `cargo build --release --target aarch64-linux-android` | Rust staticlib, `25830068` bytes |
| `cargo build --release --target x86_64-linux-android` | Rust staticlib, `25473494` bytes |
| NDK clang `-shared` (arm64) | `libopurom_mobile.so`, `7788048` bytes, real ELF |
| NDK clang `-shared` (x86_64) | `libopurom_mobile.so`, `7420576` bytes, real ELF |
| `javac` (Android app sources) | `javac 21.0.13 --release 17` compiled `MainActivity.class` |
| `aapt2 compile` + `aapt2 link` | `res.zip` + `app.apk`, `1977` bytes, IR asset present |
| `d8` (build-tools 34.0.0) | `classes.dex`, `5284` bytes |
| `gradle :app:assembleDebug` | `BUILD SUCCESSFUL`, `app-debug.apk`, `21175532` bytes |
| `node verify.mjs` | `29 passed, 1 skipped, 0 failed` (exit 0) |

### Measured library sizes and render time

Release artifacts were built twice on this host with the same toolchain: once before the
`opurom-render` path dependency was added and once after. Both columns are measured byte counts
of the files on disk.

| Artifact | Before (bytes) | After (bytes) | Change |
| --- | ---: | ---: | ---: |
| `aarch64-apple-ios` staticlib | 18412568 | 19393896 | +981328 (+5.33%) |
| `aarch64-linux-android` staticlib | 24447174 | 25830068 | +1382894 (+5.66%) |
| `x86_64-linux-android` staticlib | 24016844 | 25473494 | +1456650 (+6.07%) |
| arm64 `libopurom_mobile.so` | 7075928 | 7788048 | +712120 (+10.06%) |
| x86_64 `libopurom_mobile.so` | 6664912 | 7420576 | +755664 (+11.34%) |

The growth is the renderer's layout, raster, font and IR parser code plus its `serde_json`
dependency. The linked `.so` files contain that code because the NDK clang links the Rust
static library with `--whole-archive`.

`tests/real_render.rs` measures the IR path with `std::time::Instant` over 24 frames of the
compiled Todo IR at 320x240, including IR and state JSON parsing, layout and RGBA8 raster:

| Build | Measured total | Measured per frame |
| --- | ---: | ---: |
| `cargo test --offline --test real_render` (debug) | 124845 us | 5201 us |
| `cargo test --offline --release --test real_render` | 10433 us | 434 us |

These are measured wall-clock durations on this host for that fixed workload, not a throughput
or frame-rate claim; timings vary with host load. `node verify.mjs` prints the debug measurement
on every run.

### Real ELF evidence for the Android shared objects

The two shared objects are build output under `target/android/jniLibs/<abi>/libopurom_mobile.so`.
They are produced by the NDK clang (r27c, clang 18.0.3) linking `jni/opurom_jni.c` together with
the Rust static library.

**arm64 (`aarch64-linux-android`)**

```
$ file target/android/jniLibs/aarch64/libopurom_mobile.so
ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV), dynamically linked, with debug_info, not stripped

$ llvm-readobj --file-headers target/android/jniLibs/aarch64/libopurom_mobile.so
Format: elf64-littleaarch64
Arch: aarch64
    Magic: (7F 45 4C 46)
  Type: SharedObject (0x3)
  Machine: EM_AARCH64 (0xB7)

$ llvm-readelf -h ... | grep Machine
  Machine:                           AArch64
```

**x86_64 (`x86_64-linux-android`)**

```
$ file target/android/jniLibs/x86_64/libopurom_mobile.so
ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked, with debug_info, not stripped

$ llvm-readobj --file-headers target/android/jniLibs/x86_64/libopurom_mobile.so
Format: elf64-x86-64
Arch: x86_64
    Magic: (7F 45 4C 46)
  Type: SharedObject (0x3)
  Machine: EM_X86_64 (0x3E)

$ llvm-readelf -h ... | grep Machine
  Machine:                           Advanced Micro Devices X86-64
```

`EM_AARCH64` is 183 and `EM_X86_64` is 62; `verify.mjs` asserts those exact numbers, and the Rust
test `tests/android_elf.rs` reads `e_machine` straight out of the ELF header bytes. Both shared
objects export the eight `Java_org_opurom_mobile_OpuromNative_*` entry points and the eight plain
C ABI symbols, which `verify.mjs` checks with `llvm-readelf --dyn-syms`.
`tests/elf_exports.rs` reads the same exports from the ELF64 dynamic symbol table with
standard-library Rust.

### Dynamic symbol verification in pure Rust

`tests/elf_exports.rs` reads the ELF64 header and section header table of each Android shared
object. It asserts `ELFCLASS64`, little-endian data, `ET_DYN` and the ABI's `e_machine` value,
then resolves every defined global or weak symbol in `SHT_DYNSYM` through its linked string
table. Each object must export the eight `Java_org_opurom_mobile_OpuromNative_*` entry points and
the eight plain C ABI functions named in `verify.mjs`. Synthetic ELF64 images exercise the reader
and its rejection of malformed headers on hosts without build output; the real shared objects are
checked when `verify.mjs` has produced them. The reader uses no NDK readelf binary and no external
crate. `node verify.mjs` runs this test as one of its cargo steps.

### Mach-O64 verification in pure Rust

`tests/mach_o.rs` reads the `aarch64-apple-ios` static library archive and parses every
object member with standard-library Rust, so the same evidence that `file`/`lipo`/`otool`
provide is available without those tools. The archive walk understands the BSD member
format (`!<arch>` global header, 60-byte member records, `#1/<len>` extended names) and
skips symbol-index and string-table members. Every remaining member must be a Mach-O64
object: `MH_MAGIC_64` in little-endian byte order, `CPU_TYPE_ARM64`, file type
`MH_OBJECT`, and a load-command region whose commands stay inside their declared size
with 8-byte-aligned command sizes. Each object must carry at least one `LC_SEGMENT_64`
and an iOS platform command, `LC_VERSION_MIN_IPHONEOS` or `LC_BUILD_VERSION` with the iOS
platform value; object members carry no `LC_UUID`, which belongs to linked dylibs and
executables rather than archive members. The platform value separates the iOS build from
an arm64 macOS build of the same sources. Synthetic in-memory archives and objects
exercise the reader and its rejection of malformed images on hosts without build output;
the real archive is checked when the iOS build has produced it. The reader uses no
external crate.

### APK ZIP structure in pure Rust

`tests/apk_structure.rs` reads the packaged APK as a ZIP archive with standard-library Rust
only, so the packaging-structure evidence does not depend on `unzip(1)` or the Android SDK
being present. The reader locates the end-of-central-directory record by searching backwards
within the legal comment window, then walks every central directory header and cross-checks
it against its local file header: matching signatures, entry names and compression methods,
consistent sizes and CRC32, and data that stays inside the archive before the central
directory. Stored entries are re-hashed with CRC32 and must keep their uncompressed data on
a 4-byte boundary, matching `zipalign`. The synthetic signed archive also asserts the core
APK entries (`AndroidManifest.xml`, `resources.arsc`, `classes.dex`, the IR asset) and the
`META-INF` signing placeholders (`MANIFEST.MF`, a `.SF` file and an `.RSA`/`.DSA`/`.EC`
block); cryptographic validity remains `apksigner`'s responsibility. Synthetic in-memory
archives drive positive and negative cases on every host, including a flipped EOCD
signature, a broken central directory header, a mismatched local header, tampered stored
data, a missing core entry and a misaligned stored entry. The built `app.apk` is checked for
its manifest, resource table, IR asset and stored-entry alignment when `verify.mjs` has
produced it; otherwise the reader's synthetic cases still run and the host check skips with
a concrete reason.

### Packaged asset integrity

`test/asset-integrity.test.mjs` runs with `node --test`. It compiles
`../opurom-examples/todo.opu` with the real `opuromc` into a temp file and requires the bytes to
equal `android/app/src/main/assets/todo.opuir.json`. Tampered and truncated copies are written to
real temp files and must be rejected with a reason naming the differing byte or the length
mismatch; the shipped asset is only read. The ELF machine-type table carries the exact
little-endian `e_machine` bytes for every shipped ABI (`arm64-v8a`: `b7 00`, `x86_64`: `3e 00`);
the test checks it against `verify.mjs`'s `ANDROID_ABIS`, the built `jniLibs` ABI set and the real
ELF headers, and rejects a flipped or truncated header. Without `opuromc` or the built shared
objects the corresponding checks skip with a concrete reason; no IR or ELF data is mocked.

## C ABI: ownership, lifetime, validation

```c
/* Original state-machine ABI, unchanged */
OpuState *opu_state_new(void);                       /* caller owns; NULL on failure */
int32_t   opu_dispatch(OpuState *state, uint32_t event_id);
int32_t   opu_frame(OpuState *state, uint8_t *out, uint32_t width, uint32_t height);
void      opu_state_free(OpuState *state);           /* exactly once; NULL is a no-op */

/* Additive IR ABI: real OPUROM UI */
OpuRenderer *opu_renderer_new(uint32_t width, uint32_t height);
void         opu_renderer_free(OpuRenderer *renderer);
int32_t      opu_frame_from_ir(const uint8_t *ir_json, size_t ir_len,
                               const uint8_t *state_json, size_t state_len,
                               uint8_t *out, uint32_t width, uint32_t height);
int32_t      opu_renderer_frame(OpuRenderer *renderer,
                                const uint8_t *ir_json, size_t ir_len,
                                const uint8_t *state_json, size_t state_len,
                                uint8_t *out, uint32_t width, uint32_t height);
int32_t      opu_renderer_redraw_stats(OpuRenderer *renderer,
                                       size_t *redrawn_nodes, uint64_t *redraw_pixels);
```

- **State:** one integer counter starting at 0. `OPU_EVENT_TAP` (1) does a checked `+1`,
  `OPU_EVENT_RESET` (2) sets it to 0; any other id returns `OPU_ERR_EVENT` without mutation, and
  counter overflow returns `OPU_ERR_OVERFLOW` without mutation. The four original entry points
  keep their exact signatures, return codes and behaviour.
- **Frame:** `opu_frame` writes `width * height` row-major RGBA8 pixels (alpha always 255) into
  the caller's `out`, which must hold at least `width * height * 4` writable bytes. Dimensions
  must be nonzero and at most `OPU_MAX_DIMENSION` (4096), within `OPU_MAX_FRAME_BYTES` (64 MiB).
- **IR:** `opu_frame_from_ir` parses IR v0.1 through `opurom-render`'s `parse_ir`, applies a JSON
  object of state overrides (`{}` means the IR initial values), builds a `Renderer` with
  `Renderer::try_new` and writes its `pixels_at` output as RGBA8. A malformed IR returns
  `OPU_ERR_IR` (6), malformed state `OPU_ERR_STATE` (7); neither can panic or abort. JSON inputs
  are borrowed, length-checked up to `OPU_MAX_JSON_BYTES` (16 MiB) and need no NUL terminator.
- **Reuse:** `opu_renderer_new` returns one caller-owned renderer for a fixed viewport (NULL on
  invalid dimensions or failure). `opu_renderer_frame` renders through it with the renderer's
  incremental dirty-region path: after the first full raster, a state change recomputes only the
  dirty region and leaves the rest of the previous frame, so successive frames are byte-identical
  to a full raster while recomputing less. `width`/`height` must match, and the caller frees
  exactly once with `opu_renderer_free`. `opu_renderer_redraw_stats` reports the nodes and pixels
  the most recent `opu_renderer_frame` recomputed (zero for a full raster). A null renderer returns
  `OPU_ERR_NULL`.
- **Nulls are never dereferenced:** every status-returning function checks its pointer arguments
  before use and returns `OPU_ERR_NULL`; `opu_state_free(NULL)` and `opu_renderer_free(NULL)` are
  no-ops.
- **Ownership:** the caller frees exactly once after `opu_state_new` succeeded. Double free,
  foreign pointers, use-after-free and unsynchronized concurrent calls on one state are invalid
  and cannot be checked in Rust; they are undefined behavior, documented rather than papered over.
- **Errors are values:** a Rust panic inside the ABI is caught and returned as `OPU_ERR_PANIC`;
  an abort or invalid pointer still escapes, as with any C library.
- Determinism: pixel bytes are a pure function of `(counter, x, y)` with no clock, randomness or
  platform input, so the same event sequence yields identical frames on every run.

## Swift wrapper

`swift/module.modulemap` exposes `include/opurom.h` as the `COpuromMobile` module;
`swift/OpuromMobile.swift` imports it. `OpuromState` wraps `opu_state_new`/`opu_state_free` in a
final class whose `deinit` is the single free site, checks the output buffer size before calling
`opu_frame`, and surfaces non-`OPU_OK` statuses as `OpuromMobileError`. `OpuromIRFrame.frame` is
a one-shot real IR render; `OpuromIRRenderer` owns one reusable renderer handle with `deinit` as
its single free site. Both validate the buffer size before the native call. Verified by
typecheck against the iPhoneOS SDK (no simulator runtime on this host).

## JNI layer

`jni/OpuromNative.java` (`org.opurom.mobile`) declares the four original native methods plus four
IR methods (`opuRendererNew`, `opuRendererFrame`, `opuRendererFree`, `opuFrameFromIr`) with `long`
handles. `jni/opurom_jni.h` gives the exact `Java_org_opurom_mobile_OpuromNative_*` signatures
against a real `jni.h`, and `jni/opurom_jni.c` implements them: it forwards to the plain C ABI and
copies the RGBA bytes into the Java `byte[]` during the native call, so no pointer into Rust
memory outlives that call. The IR shim pins the three arrays, releases the inputs with
`JNI_ABORT` and copies the output back with mode 0. The shim is linked into both Android shared
objects, and `verify.mjs` asserts that all eight JNI symbols and all eight C ABI symbols are
exported from each `.so`.

## Android app module

`android/` is a minimal Gradle project (`settings.gradle`, `build.gradle`,
`gradle.properties`, `app/build.gradle`) with one module:

- `android/app/src/main/AndroidManifest.xml` declares `org.opurom.mobile.MainActivity` as the
  launcher activity.
- `android/app/src/main/java/org/opurom/mobile/MainActivity.java` builds the adaptive native
  shell: a gradient header, session and task cards, and a Refresh/Reset action bar. All
  typography uses platform typefaces at density-independent sizes, with a dark palette selected
  from `uiMode`. Refresh rotates its glyph, fades the counter, re-renders the frame and crossfades
  it; Reset restores the initial state. Every button has a ripple and a press-scale animator.
- The shell reflows from three width tiers, and the breakpoints are the renderer's own logical
  pixel boundaries. Below `600 dp` the shell is a single scrollable column; at `600 dp` and
  above it splits into two columns; at `1200 dp` and above it becomes a three-column workbench
  layout of a navigation rail, a renderer column and a detail column. The tier is chosen by the
  `screenWidthDp` measured value, so a wide window shows the rail, the self-drawn frame and the
  detail view side by side while a phone shows one column. The rail's three views switch the
  detail column between the session summary, the task list and both; the stats and task cards
  are moved between views instead of rebuilt, so one set of state is on screen at a time. The
  frame card is taller at each wider tier and the frame is re-rendered whenever its measured
  viewport changes, so the same APK fills its card at every width without letterboxing.
- `android/app/src/main/assets/dashboard.opuir.json` is a graphics-only IR: gradient header,
  particle field and rounded cards with shadows. The self-drawn frame renders through JNI into
  the card's actual viewport, so it fills the card instead of sitting at a fixed size. The host
  keeps one persistent renderer per viewport, so a state change recomputes only the renderer's
  dirty region and leaves the rest of the previous frame. Native text is layered above the
  frame, which is the documented hybrid mode: self-drawn graphics
  plus native controls.
- `android/app/src/main/assets/todo.opuir.json` is the exact output of
  `opuromc compile ../opurom-examples/todo.opu`; `verify.mjs` recompiles the source and compares
  byte-for-byte, then proves the asset is packaged by the offline `aapt2 link` step.
- `android/app/src/main/res/` holds the string resources; the layout is built in code so the
  column breakpoint is a single measured value.

`docs/adaptive-preview.png` shows the same shell at a narrow and a wide width, rendered offline
with the real OPUROM frame embedded. It is a design reference, not a device capture.

The Activity is **compiled and packaged** on this host: `verify.mjs` proves the sources compile (`javac` against the
real `android.jar`), that the resources and manifest package (`aapt2 compile` + `aapt2 link`),
and that the classes dex (`d8`). `npm run build:apk` produces a signed APK for on-device
installation. Running the APK is an on-device step for a host with an Android system image.

A full Gradle build also succeeds on this host and packages both shared objects into a real APK:

```sh
cd android
JAVA_HOME=<jdk21> ANDROID_HOME=<sdk> gradle :app:assembleDebug
```

```
$ unzip -l app/build/outputs/apk/debug/app-debug.apk
   1072  classes.dex
 7788048  lib/arm64-v8a/libopurom_mobile.so
 7420576  lib/x86_64/libopurom_mobile.so
   1602  assets/todo.opuir.json
   1980  AndroidManifest.xml
```

The APK is debug-signed with the local debug key. The Gradle build needs the Android Gradle
Plugin from a network repository, so it is not part of the offline `verify.mjs` run; the
`aapt2`/`d8`/`javac` steps above are the offline equivalent.

## Verified here

| Verified in this repository |
| --- |
| Real arm64/x86_64 Android shared objects with ELF magic + machine type evidence |
| ELF64 class, endianness, type, machine and dynamic symbol exports read from the shared objects |
| Mach-O64 magic, byte order, cpu type, file type and iOS load commands read from the iOS archive members |
| APK ZIP central directory, local-header cross-check, stored-entry CRC32, alignment and signing placeholders in pure Rust |
| Real arm64 iOS staticlib (`file`/`lipo`/`otool` evidence) |
| `javac` compile of the JNI declaration, the app sources and the JNI header syntax check |
| `aapt2` resource compile + manifest/resource link, `d8` dexing |
| `gradle :app:assembleDebug` producing a real APK with both `.so` files and the IR asset |
| Swift wrapper typecheck against the C header, including the IR entry points |
| Rust unit, ELF, Mach-O, APK ZIP structure, real-renderer and Node spec tests |
| Offline, bounded verifier with tool-specific SKIPs |
| IR C ABI pixels equal the shared software renderer's pixels; malformed IR returns status values |
| Measured artifact size growth and measured per-frame render time |

The original counter state machine is intentionally tiny and stays byte-compatible;
`opurom-core` owns the full kernel. The IR path draws real UI with the shared software
renderer. The Android shared objects are linked and packaged, and the app sources are compiled
and packaged; the Activity is never executed on a device here. Both shared objects export the
eight JNI entry points and the eight C ABI symbols.

`opurom-render` was also checked with `cargo check --target aarch64-apple-ios --offline` and
`cargo check --target aarch64-linux-android --offline`; both succeed.

