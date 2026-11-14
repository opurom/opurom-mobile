//! Rust C ABI for the arm64 iOS static library and the Android shared objects.
//!
//! The original counter state machine is unchanged. The additive IR path parses OPUIR v0.1 and
//! state overrides with `opurom-render` and writes real RGBA8 frames; malformed input is a
//! status value, never a panic or an abort.
//!
//! Ownership: `opu_state_new` allocates one opaque state whose counter starts at zero. The caller
//! owns that pointer and must pass it to `opu_state_free` exactly once. A null state pointer is
//! rejected by the status-returning functions and is a no-op for `opu_state_free`; a non-null
//! pointer that was not returned by `opu_state_new`, was already freed, or is used concurrently
//! without serialization is invalid and cannot be validated by Rust.
//!
//! Lifetime: the pointer stays valid until `opu_state_free`. `opu_frame` borrows the state only
//! for the duration of the call; `out` is caller-owned and must remain writable and not overlap
//! the state. The caller supplies at least `width * height * 4` bytes for row-major RGBA8 output.
//! Panics inside Rust code are caught and returned as `OPU_ERR_PANIC`; an abort or an invalid
//! pointer remains undefined behavior. This ABI is not thread-safe for one state: serialize calls.

use opurom_render::{parse_ir, parse_state_json, Ir, Renderer, StateView, SETTLED_MS};
use std::alloc::{alloc, dealloc, Layout};
use std::panic::{catch_unwind, AssertUnwindSafe};

pub const OPU_OK: i32 = 0;
pub const OPU_ERR_NULL: i32 = 1;
pub const OPU_ERR_EVENT: i32 = 2;
pub const OPU_ERR_DIMENSION: i32 = 3;
pub const OPU_ERR_OVERFLOW: i32 = 4;
pub const OPU_ERR_PANIC: i32 = 5;
pub const OPU_ERR_IR: i32 = 6;
pub const OPU_ERR_STATE: i32 = 7;

pub const OPU_EVENT_TAP: u32 = 1;
pub const OPU_EVENT_RESET: u32 = 2;

pub const OPU_MAX_DIMENSION: u32 = 4096;
pub const OPU_MAX_FRAME_BYTES: usize = 67108864;
pub const OPU_MAX_JSON_BYTES: usize = 16777216;

/// Opaque state. C callers see only an incomplete struct type and must not access fields.
#[repr(C)]
pub struct OpuState {
    counter: u32,
}

fn ffi_guard<T, F>(f: F, fallback: T) -> T
where
    F: FnOnce() -> T,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(fallback)
}

fn state_layout() -> Layout {
    Layout::new::<OpuState>()
}

fn frame_len(width: u32, height: u32) -> Option<usize> {
    if width == 0 || height == 0 || width > OPU_MAX_DIMENSION || height > OPU_MAX_DIMENSION {
        return None;
    }
    let w = usize::try_from(width).ok()?;
    let h = usize::try_from(height).ok()?;
    let bytes = w.checked_mul(h)?.checked_mul(4)?;
    if bytes > OPU_MAX_FRAME_BYTES || bytes > isize::MAX as usize {
        return None;
    }
    Some(bytes)
}

fn rgba(counter: u32, x: u32, y: u32) -> [u8; 4] {
    let mixed = counter
        .wrapping_add(x.wrapping_mul(73))
        .wrapping_add(y.wrapping_mul(151))
        .wrapping_mul(2_654_435_761);
    [mixed as u8, (mixed >> 8) as u8, (mixed >> 16) as u8, 0xff]
}

fn dispatch_impl(state: *mut OpuState, event_id: u32) -> i32 {
    if state.is_null() {
        return OPU_ERR_NULL;
    }
    let state = unsafe { &mut *state };
    match event_id {
        OPU_EVENT_TAP => match state.counter.checked_add(1) {
            Some(next) => {
                state.counter = next;
                OPU_OK
            }
            None => OPU_ERR_OVERFLOW,
        },
        OPU_EVENT_RESET => {
            state.counter = 0;
            OPU_OK
        }
        _ => OPU_ERR_EVENT,
    }
}

fn frame_impl(state: *mut OpuState, out: *mut u8, width: u32, height: u32) -> i32 {
    if state.is_null() || out.is_null() {
        return OPU_ERR_NULL;
    }
    let Some(byte_len) = frame_len(width, height) else {
        return OPU_ERR_DIMENSION;
    };
    let counter = unsafe { (*state).counter };
    let pixels = unsafe { std::slice::from_raw_parts_mut(out, byte_len) };
    for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let x = (index % width as usize) as u32;
        let y = (index / width as usize) as u32;
        pixel.copy_from_slice(&rgba(counter, x, y));
    }
    OPU_OK
}

/// Creates one heap state with counter zero. Returns NULL on allocation failure or a caught panic.
/// The caller owns the returned pointer until exactly one call to `opu_state_free`.
#[no_mangle]
pub extern "C" fn opu_state_new() -> *mut OpuState {
    ffi_guard(
        || unsafe {
            let layout = state_layout();
            let state = alloc(layout).cast::<OpuState>();
            if state.is_null() {
                return std::ptr::null_mut();
            }
            state.write(OpuState { counter: 0 });
            state
        },
        std::ptr::null_mut(),
    )
}

/// Applies `OPU_EVENT_TAP` (checked +1), `OPU_EVENT_RESET` (set 0), or returns `OPU_ERR_EVENT`.
/// Unknown events and counter overflow leave the state unchanged. A null pointer returns
/// `OPU_ERR_NULL`; a caught Rust panic returns `OPU_ERR_PANIC`.
#[no_mangle]
pub extern "C" fn opu_dispatch(state: *mut OpuState, event_id: u32) -> i32 {
    ffi_guard(|| dispatch_impl(state, event_id), OPU_ERR_PANIC)
}

/// Writes a deterministic `width * height` RGBA8 frame into `out`; alpha is always 255.
/// Width and height must be nonzero, at most `OPU_MAX_DIMENSION`, and produce at most
/// `OPU_MAX_FRAME_BYTES` bytes. `out` must be non-null and have at least that many writable
/// bytes. Null pointers return `OPU_ERR_NULL`, invalid dimensions return `OPU_ERR_DIMENSION`,
/// and a caught Rust panic returns `OPU_ERR_PANIC`.
#[no_mangle]
pub extern "C" fn opu_frame(state: *mut OpuState, out: *mut u8, width: u32, height: u32) -> i32 {
    ffi_guard(|| frame_impl(state, out, width, height), OPU_ERR_PANIC)
}

/// Releases one state returned by `opu_state_new`. The pointer is invalid after this call.
/// The caller must not free it twice or use it afterward; a null pointer is a no-op.
#[no_mangle]
pub extern "C" fn opu_state_free(state: *mut OpuState) {
    if state.is_null() {
        return;
    }
    let _ = ffi_guard(
        || unsafe {
            std::ptr::drop_in_place(state);
            dealloc(state.cast::<u8>(), state_layout());
        },
        (),
    );
}

/// Opaque reusable renderer. C callers see only an incomplete struct type.
#[repr(C)]
pub struct OpuRenderer {
    renderer: Renderer,
    width: u32,
    height: u32,
}

/// Borrow one caller-owned JSON document. Lengths are bounded before any read so
/// a malformed call is a status value instead of an out-of-bounds access.
fn json_str<'a>(ptr: *const u8, len: usize, code: i32) -> Result<&'a str, i32> {
    if ptr.is_null() {
        return Err(OPU_ERR_NULL);
    }
    if len == 0 || len > OPU_MAX_JSON_BYTES || len > isize::MAX as usize {
        return Err(code);
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|_| code)
}

fn frame_inputs(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    out: *mut u8,
    width: u32,
    height: u32,
) -> Result<(Ir, StateView, usize), i32> {
    if ir_json.is_null() || state_json.is_null() || out.is_null() {
        return Err(OPU_ERR_NULL);
    }
    let byte_len = frame_len(width, height).ok_or(OPU_ERR_DIMENSION)?;
    let ir = parse_ir(json_str(ir_json, ir_len, OPU_ERR_IR)?).map_err(|_| OPU_ERR_IR)?;
    let state = parse_state_json(&ir, json_str(state_json, state_len, OPU_ERR_STATE)?)
        .map_err(|_| OPU_ERR_STATE)?;
    Ok((ir, state, byte_len))
}

fn write_pixels(pixels: &[u8], out: *mut u8, byte_len: usize) -> i32 {
    if pixels.len() != byte_len {
        return OPU_ERR_DIMENSION;
    }
    unsafe { std::ptr::copy_nonoverlapping(pixels.as_ptr(), out, byte_len) };
    OPU_OK
}

/// Creates one renderer bound to a viewport. Returns NULL on invalid dimensions,
/// allocation failure or a caught Rust panic. Free with `opu_renderer_free`.
#[no_mangle]
pub extern "C" fn opu_renderer_new(width: u32, height: u32) -> *mut OpuRenderer {
    ffi_guard(
        || {
            if frame_len(width, height).is_none() {
                return std::ptr::null_mut();
            }
            let Ok(renderer) = Renderer::try_new(width, height) else {
                return std::ptr::null_mut();
            };
            Box::into_raw(Box::new(OpuRenderer {
                renderer,
                width,
                height,
            }))
        },
        std::ptr::null_mut(),
    )
}

/// Releases one renderer returned by `opu_renderer_new`. NULL is a no-op.
#[no_mangle]
pub extern "C" fn opu_renderer_free(renderer: *mut OpuRenderer) {
    if renderer.is_null() {
        return;
    }
    let _ = ffi_guard(
        || unsafe {
            drop(Box::from_raw(renderer));
        },
        (),
    );
}

/// Parses an IR v0.1 document plus a JSON object of state overrides, renders one
/// settled frame with the real renderer and writes `width * height * 4` RGBA8
/// bytes into `out`. `state_json` may be `{}` to use the IR initial values.
/// OPU_ERR_NULL: null pointer, OPU_ERR_DIMENSION: invalid viewport,
/// OPU_ERR_IR: malformed IR, OPU_ERR_STATE: malformed state,
/// OPU_ERR_PANIC: caught Rust panic, OPU_OK: success.
#[no_mangle]
pub extern "C" fn opu_frame_from_ir(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    out: *mut u8,
    width: u32,
    height: u32,
) -> i32 {
    ffi_guard(
        || {
            let (ir, state, byte_len) =
                match frame_inputs(ir_json, ir_len, state_json, state_len, out, width, height) {
                    Ok(inputs) => inputs,
                    Err(code) => return code,
                };
            let Ok(renderer) = Renderer::try_new(width, height) else {
                return OPU_ERR_DIMENSION;
            };
            let pixels = renderer.pixels_at(&ir, &state, SETTLED_MS);
            write_pixels(&pixels, out, byte_len)
        },
        OPU_ERR_PANIC,
    )
}

/// Renders one frame through a reusable renderer. `width` and `height` must
/// match the viewport passed to `opu_renderer_new`. Error codes match
/// `opu_frame_from_ir`, plus OPU_ERR_NULL for a null renderer handle.
#[no_mangle]
pub extern "C" fn opu_renderer_frame(
    renderer: *mut OpuRenderer,
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    out: *mut u8,
    width: u32,
    height: u32,
) -> i32 {
    ffi_guard(
        || {
            if renderer.is_null() {
                return OPU_ERR_NULL;
            }
            let owned = unsafe { &mut *renderer };
            if (owned.width, owned.height) != (width, height) {
                return OPU_ERR_DIMENSION;
            }
            let (ir, state, byte_len) =
                match frame_inputs(ir_json, ir_len, state_json, state_len, out, width, height) {
                    Ok(inputs) => inputs,
                    Err(code) => return code,
                };
            let frame = owned
                .renderer
                .render_incremental_at(&ir, &state, SETTLED_MS);
            write_pixels(&frame.pixels, out, byte_len)
        },
        OPU_ERR_PANIC,
    )
}

/// Nodes and pixels the most recent `opu_renderer_frame` call recomputed via the
/// incremental path (0 when it fell back to a full raster). Lets callers observe
/// that a persistent renderer skips unchanged regions across successive frames.
#[no_mangle]
pub extern "C" fn opu_renderer_redraw_stats(
    renderer: *mut OpuRenderer,
    redrawn_nodes: *mut usize,
    redraw_pixels: *mut u64,
) -> i32 {
    ffi_guard(
        || {
            if renderer.is_null() || redrawn_nodes.is_null() || redraw_pixels.is_null() {
                return OPU_ERR_NULL;
            }
            let owned = unsafe { &mut *renderer };
            let (nodes, pixels) = owned.renderer.redraw_stats();
            unsafe {
                *redrawn_nodes = nodes;
                *redraw_pixels = pixels;
            }
            OPU_OK
        },
        OPU_ERR_PANIC,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestState(*mut OpuState);

    impl TestState {
        fn new() -> Self {
            let state = opu_state_new();
            assert!(!state.is_null());
            Self(state)
        }

        fn ptr(&self) -> *mut OpuState {
            self.0
        }
    }

    impl Drop for TestState {
        fn drop(&mut self) {
            opu_state_free(self.0);
        }
    }

    #[test]
    fn null_pointers_are_never_dereferenced() {
        let state = TestState::new();
        let mut bytes = [0u8; 8];
        assert_eq!(
            opu_dispatch(std::ptr::null_mut(), OPU_EVENT_TAP),
            OPU_ERR_NULL
        );
        assert_eq!(
            opu_frame(std::ptr::null_mut(), bytes.as_mut_ptr(), 2, 1),
            OPU_ERR_NULL
        );
        assert_eq!(
            opu_frame(state.ptr(), std::ptr::null_mut(), 2, 1),
            OPU_ERR_NULL
        );
        opu_state_free(std::ptr::null_mut());
    }

    #[test]
    fn tap_changes_the_deterministic_frame_and_reset_restores_it() {
        let state = TestState::new();
        let mut initial = [0u8; 8];
        let mut tapped = [0u8; 8];
        let mut reset = [0u8; 8];
        assert_eq!(opu_frame(state.ptr(), initial.as_mut_ptr(), 2, 1), OPU_OK);
        assert_eq!(initial, [0, 0, 0, 255, 121, 179, 209, 255]);
        assert_eq!(opu_dispatch(state.ptr(), OPU_EVENT_TAP), OPU_OK);
        assert_eq!(opu_frame(state.ptr(), tapped.as_mut_ptr(), 2, 1), OPU_OK);
        assert_eq!(tapped, [177, 121, 55, 255, 42, 45, 9, 255]);
        assert_eq!(opu_dispatch(state.ptr(), OPU_EVENT_RESET), OPU_OK);
        assert_eq!(opu_frame(state.ptr(), reset.as_mut_ptr(), 2, 1), OPU_OK);
        assert_eq!(reset, initial);
    }

    #[test]
    fn unknown_events_leave_the_counter_unchanged() {
        let state = TestState::new();
        let mut bytes = [0u8; 4];
        assert_eq!(opu_dispatch(state.ptr(), 0), OPU_ERR_EVENT);
        assert_eq!(opu_dispatch(state.ptr(), 3), OPU_ERR_EVENT);
        assert_eq!(opu_frame(state.ptr(), bytes.as_mut_ptr(), 1, 1), OPU_OK);
        assert_eq!(bytes, [0, 0, 0, 255]);
    }

    #[test]
    fn overflow_is_reported_without_state_change() {
        let state = TestState::new();
        unsafe {
            (*state.ptr()).counter = u32::MAX;
        }
        assert_eq!(opu_dispatch(state.ptr(), OPU_EVENT_TAP), OPU_ERR_OVERFLOW);
        assert_eq!(unsafe { (*state.ptr()).counter }, u32::MAX);
        assert_eq!(opu_dispatch(state.ptr(), OPU_EVENT_RESET), OPU_OK);
        assert_eq!(unsafe { (*state.ptr()).counter }, 0);
    }

    #[test]
    fn frame_dimensions_are_validated_before_writing() {
        let state = TestState::new();
        let mut bytes = [7u8; 8];
        let invalid = [
            (0, 1),
            (1, 0),
            (OPU_MAX_DIMENSION + 1, 1),
            (1, OPU_MAX_DIMENSION + 1),
            (u32::MAX, u32::MAX),
        ];
        for (width, height) in invalid {
            assert_eq!(
                opu_frame(state.ptr(), bytes.as_mut_ptr(), width, height),
                OPU_ERR_DIMENSION
            );
        }
        assert_eq!(bytes, [7u8; 8]);
        assert_eq!(
            frame_len(OPU_MAX_DIMENSION, OPU_MAX_DIMENSION),
            Some(OPU_MAX_FRAME_BYTES)
        );
        assert_eq!(frame_len(u32::MAX, u32::MAX), None);
    }

    #[test]
    fn vertical_pixels_use_the_documented_row_major_rule() {
        let state = TestState::new();
        let mut bytes = [0u8; 8];
        assert_eq!(opu_frame(state.ptr(), bytes.as_mut_ptr(), 1, 2), OPU_OK);
        assert_eq!(bytes, [0, 0, 0, 255, 103, 199, 184, 255]);
    }
}
