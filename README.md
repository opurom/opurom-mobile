# opurom-mobile

Round 6 **mobile native artifacts** slice of OPUROM (`R6_ADDENDUM.md`, section 3). One independent local
git repo, one pure-std Rust crate, no external crates, no network at build time. It implements the
C ABI of the [Platform Adapter contract](../opurom-spec/ADAPTER_CONTRACT.md) as a small
deterministic state machine and proves the three compile-level deliverables of R6: a real
`aarch64-apple-ios` static library, a Swift wrapper typechecked against a C header via a module
map, and a JNI declaration compiled with `javac`.

This is **not** an app: no UIKit view, no renderer integration, no device run.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/mac/work/opurom/opurom-mobile
cargo test --offline --lib                    # Rust unit tests, host target
node verify.mjs                               # full R6 verification (also runs from any cwd)
npm test                                      # Node-side ABI spec test
```

`verify.mjs` is zero-dependency Node and resolves all paths from its own file, so
`node /path/to/opurom-mobile/verify.mjs` works from the umbrella workspace root. Every child
process has a hard spawn timeout. On non-macOS hosts it prints a documented `SKIP` and exits 0.

### Measured results (macOS arm64, this host)

| Check | Actual result |
| --- | --- |
| `cargo test --offline --lib` | `6 passed; 0 failed; 0 ignored` |
| `cargo build --release --target aarch64-apple-ios --offline` | archive written, `18412568` bytes |
| `file libopurom_mobile.a` | `current ar archive` |
| `lipo -info libopurom_mobile.a` | `Non-fat file ... is architecture: arm64` |
| `otool -l libopurom_mobile.a` | `LC_VERSION_MIN_IPHONEOS` present (iOS platform) |
| `xcrun --sdk iphoneos swiftc -typecheck` | pass, SDK `iPhoneOS27.2.sdk`, Swift 6.4.2 |
| `javac` | `javac 21.0.13` compiled `org/opurom/mobile/OpuromNative.class` |
| `clang -fsyntax-only` on `jni/opurom_jni.h` | pass against the same JDK's `jni.h` |
| `node test/abi.test.mjs` | `PASS: abi spec fixtures match the documented C contract` |

Archive path (deterministic): `target/aarch64-apple-ios/release/libopurom_mobile.a`.

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

## JNI declaration

`jni/OpuromNative.java` (`org.opurom.mobile`) declares the four native methods with `long`
handles; `jni/opurom_jni.h` gives the exact `Java_org_opurom_mobile_OpuromNative_*` signatures
against a real `jni.h`.

**No `.so` is built: this host has no Android NDK.** The Java class is compiled with `javac`
21.0.13 and the header passes `clang -fsyntax-only`; that is a compile check, not a linked
Android artifact. `verify.mjs` finds `javac` via `OPUROM_JAVAC`, `JAVA_HOME`, or the known JDK
paths and prints a documented `SKIP` (exit 0) when no JDK exists on the host.

## Honest scope

| Verified in R6 here | Not implemented (R7+) |
| --- | --- |
| Real arm64 iOS staticlib (`file`/`lipo`/`otool` evidence) | No iOS simulator or device execution (no simulator runtime installed) |
| Swift wrapper typecheck against the C header | No linked Swift/Xcode app, no UIKit integration |
| `javac` compile of the JNI declaration + header syntax check | **No Android `.so`** (no NDK), no Android device/emulator run |
| Pure-std Rust state machine with unit + Node spec tests | No App Store submission or signing |
| Offline, bounded verifier with honest non-macOS SKIP | No Harmony toolchain or Harmony artifacts |
| | No renderer/GPU integration, no fps or size benchmarks (invented numbers are forbidden) |

Gaps: the state machine is intentionally tiny (counter + tap), not an IR runtime; `opurom-core`
owns the full kernel. JNI symbols are declared but never dlopen'd here. Everything beyond this
table remains R7+.
