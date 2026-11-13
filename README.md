# opurom-mobile

**Mobile native artifacts** slice of OPUROM ([PLATFORM_DELIVERY.md](../opurom-spec/PLATFORM_DELIVERY.md), section 3) plus the
**Android native library and app module** slice ([NATIVE_NETWORK.md](../opurom-spec/NATIVE_NETWORK.md), section 3). One independent
local git repo, one pure-std Rust crate, no external crates, no network at build time. It
implements the C ABI of the [Platform Adapter contract](../opurom-spec/ADAPTER_CONTRACT.md) as a
small deterministic state machine and proves these compile-level deliverables:

- a real `aarch64-apple-ios` static library with `file`/`lipo`/`otool` evidence;
- a Swift wrapper typechecked against the C header via a module map;
- a JNI declaration compiled with `javac`;
- real ELF Android shared objects for `aarch64-linux-android` and `x86_64-linux-android`,
  built with the Android NDK clang, with ELF magic bytes and machine type proven;
- a minimal Android app module (Gradle, `AndroidManifest.xml`, one `Activity`) that loads
  the library through the JNI layer and renders a frame into an `ImageView`.

**No app runs.** There is no emulator or device execution, no AAB signing and no Play Store
submission anywhere in this repository.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd opurom-mobile
cargo test --offline --lib                    # Rust unit tests, host target
node verify.mjs                               # full verification (runs from any cwd)
npm test                                      # Node-side ABI spec test
```

`verify.mjs` is zero-dependency Node and resolves all paths from its own file, so
`node <path-to>/opurom-mobile/verify.mjs` works from the umbrella workspace root. Every child
process has a hard spawn timeout. On a host that lacks a tool the verifier prints a concrete
`SKIP` naming the exact missing tool and exits 0; there is no fake PASS anywhere in it.

### Toolchain discovery

The verifier finds its tools through environment variables and a runtime-resolved
local `toolchains/` directory. No absolute path is compiled into the tool.

| Tool | Required version | Looked up in |
| --- | --- | --- |
| `cargo`, `rustc` | any recent stable | `PATH` (plus `~/.cargo/bin` prepended) |
| `javac` | JDK 21 | `OPUROM_JAVAC`, `JAVA_HOME`, then a sibling `toolchains/` JDK 21 |
| Android NDK | NDK r27c | `OPR_NDK_HOME`, `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`, then a sibling `toolchains/` NDK r27c |
| Android SDK | platform 34 | `OPR_ANDROID_SDK`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then a sibling `toolchains/` SDK |
| `aapt2`, `d8` | build-tools 34 | newest `build-tools/*/` of the SDK that actually contains them |

The local `toolchains/` fallback is resolved at runtime relative to the
repository root, and the directory entries are scanned rather than named, so the
layout on the host does not have to match a fixed path. Set the environment
variables above to point the verifier at a specific installation.

The Android Rust targets must be installed: `rustup target add aarch64-linux-android
x86_64-linux-android`.

### Measured results (macOS arm64, this host)

| Check | Actual result |
| --- | --- |
| `cargo test --offline --lib` | `6 passed; 0 failed; 0 ignored` |
| `cargo test --offline --test android_elf` | `1 passed; 0 failed` |
| `node test/abi.test.mjs` | `PASS: abi spec fixtures match the documented C contract` |
| `cargo build --release --target aarch64-apple-ios --offline` | archive written, `18412568` bytes |
| `file libopurom_mobile.a` | `current ar archive` |
| `lipo -info libopurom_mobile.a` | `Non-fat file ... is architecture: arm64` |
| `otool -l libopurom_mobile.a` | `LC_VERSION_MIN_IPHONEOS` present (iOS platform) |
| `xcrun --sdk iphoneos swiftc -typecheck` | pass, SDK `iPhoneOS27.2.sdk`, Swift 6.4.2 |
| `javac` (JNI declaration) | `javac 21.0.13` compiled `org/opurom/mobile/OpuromNative.class` |
| `clang -fsyntax-only` on `jni/opurom_jni.h` | pass against the same JDK's `jni.h` |
| `cargo build --release --target aarch64-linux-android` | Rust staticlib, `24447174` bytes |
| `cargo build --release --target x86_64-linux-android` | Rust staticlib, `24016844` bytes |
| NDK clang `-shared` (arm64) | `libopurom_mobile.so`, `7075928` bytes, real ELF |
| NDK clang `-shared` (x86_64) | `libopurom_mobile.so`, `6664912` bytes, real ELF |
| `javac` (Android app sources) | `javac 21.0.13 --release 17` compiled `MainActivity.class` |
| `aapt2 compile` + `aapt2 link` | `res.zip` + `app.apk`, `1375` bytes |
| `d8` (build-tools 34.0.0) | `classes.dex`, DEX version `035`, `2820` bytes |
| `gradle :app:assembleDebug` | `BUILD SUCCESSFUL`, `app-debug.apk`, `13752892` bytes |
| `node verify.mjs` | `24 passed, 1 skipped, 0 failed` (exit 0) |

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
objects export the four `Java_org_opurom_mobile_OpuromNative_*` entry points and the four plain C
ABI symbols, which `verify.mjs` checks with `llvm-readelf --dyn-syms`.

## C ABI: ownership, lifetime, validation

```c
OpuState *opu_state_new(void);                       /* caller owns; NULL on failure */
int32_t   opu_dispatch(OpuState *state, uint32_t event_id);
int32_t   opu_frame(OpuState *state, uint8_t *out, uint32_t width, uint32_t height);
void      opu_state_free(OpuState *state);           /* exactly once; NULL is a no-op */
```

- **State:** one integer counter starting at 0. `OPU_EVENT_TAP` (1) does a checked `+1`,
  `OPU_EVENT_RESET` (2) sets it to 0; any other id returns `OPU_ERR_EVENT` without mutation, and
  counter overflow returns `OPU_ERR_OVERFLOW` without mutation.
- **Frame:** `opu_frame` writes `width * height` row-major RGBA8 pixels (alpha always 255) into
  the caller's `out`, which must hold at least `width * height * 4` writable bytes. Dimensions
  must be nonzero and at most `OPU_MAX_DIMENSION` (4096), within `OPU_MAX_FRAME_BYTES` (64 MiB).
- **Nulls are never dereferenced:** every status-returning function checks `state` and `out`
  before use and returns `OPU_ERR_NULL`; `opu_state_free(NULL)` is a no-op.
- **Ownership:** the caller frees exactly once after `opu_state_new` succeeded. Double free,
  foreign pointers, use-after-free and unsynchronized concurrent calls on one state are invalid
  and cannot be checked in Rust; they are undefined behavior, documented rather than papered over.
- **Errors are values:** a Rust panic inside the ABI is caught and returned as `OPU_ERR_PANIC`;
  an abort or invalid pointer still escapes, as with any C library.
- Determinism: pixel bytes are a pure function of `(counter, x, y)` with no clock, randomness or
  platform input, so the same event sequence yields identical frames on every run.

## Swift wrapper

`swift/module.modulemap` exposes `include/opurom.h` as the `COpuromMobile` module;
`swift/OpuromMobile.swift` imports it, wraps `opu_state_new`/`opu_state_free` in a final class
whose `deinit` is the single free site, checks the output buffer size before calling
`opu_frame`, and surfaces non-`OPU_OK` statuses as `OpuromMobileError`. Verified by typecheck
only (no simulator runtime on this host).

## JNI layer

`jni/OpuromNative.java` (`org.opurom.mobile`) declares the four native methods with `long`
handles. `jni/opurom_jni.h` gives the exact `Java_org_opurom_mobile_OpuromNative_*` signatures
against a real `jni.h`, and `jni/opurom_jni.c` implements them: it forwards to the plain C ABI and
copies the RGBA bytes into the Java `byte[]` during the native call, so no pointer into Rust
memory outlives that call. The shim is linked into both Android shared objects.

## Android app module

`android/` is a minimal Gradle project (`settings.gradle`, `build.gradle`,
`gradle.properties`, `app/build.gradle`) with one module:

- `android/app/src/main/AndroidManifest.xml` declares `org.opurom.mobile.MainActivity` as the
  launcher activity.
- `android/app/src/main/java/org/opurom/mobile/MainActivity.java` calls
  `System.loadLibrary("opurom_mobile")`, allocates one native state, applies one tap event, asks
  the native side for a 256x256 RGBA frame, converts it to packed ARGB and shows it in an
  `ImageView`. The native handle is released exactly once in `onDestroy()`.
- `android/app/src/main/res/` holds the layout and the string resources.

The Activity is **compiled and packaged, never run**: this host has no Android system image, so
there is no emulator and no device. `verify.mjs` proves the sources compile (`javac` against the
real `android.jar`), that the resources and manifest package (`aapt2 compile` + `aapt2 link`),
and that the classes dex (`d8`).

A full Gradle build also succeeds on this host and packages both shared objects into a real APK:

```sh
cd android
JAVA_HOME=<jdk21> ANDROID_HOME=<sdk> gradle :app:assembleDebug
```

```
$ unzip -l app/build/outputs/apk/debug/app-debug.apk
   1072  classes.dex
 7075928  lib/arm64-v8a/libopurom_mobile.so
 6664912  lib/x86_64/libopurom_mobile.so
   1980  AndroidManifest.xml
```

The APK is debug-signed with the local debug key. The Gradle build needs the Android Gradle
Plugin from a network repository, so it is not part of the offline `verify.mjs` run; the
`aapt2`/`d8`/`javac` steps above are the offline equivalent.

## Verified here

| Verified in this repository |
| --- |
| Real arm64/x86_64 Android shared objects with ELF magic + machine type evidence |
| Real arm64 iOS staticlib (`file`/`lipo`/`otool` evidence) |
| `javac` compile of the JNI declaration, the app sources and the JNI header syntax check |
| `aapt2` resource compile + manifest/resource link, `d8` dexing |
| `gradle :app:assembleDebug` producing a real APK with both `.so` files |
| Swift wrapper typecheck against the C header |
| Pure-std Rust state machine with unit + ELF + Node spec tests |
| Offline, bounded verifier with tool-specific SKIPs |

The state machine is intentionally tiny (counter + tap); `opurom-core` owns the
full kernel. The Android shared objects are linked and packaged, and the app
sources are compiled and packaged.

