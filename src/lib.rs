//! Rust C ABI for the arm64 iOS static library and the Android shared objects.
//!
//! The original counter state machine is unchanged. The additive IR path parses OPUIR 0.1.0 and
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

use opurom_core::{
    Event as CoreEvent, Patch as CorePatch, Runtime as CoreRuntime, Value as CoreValue,
};
use opurom_render::{
    hit, layout, layout_at, parse_ir, parse_state_json, tap_hit_rect, text_spans_for, Frame,
    Gesture, GestureEngine, GestureKind, Ir, Node, PointerEvent, PointerKind, PressPhase, Rect,
    Renderer, StateView, SETTLED_MS,
};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::alloc::{alloc, dealloc, Layout};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, OnceLock};

pub const OPU_OK: i32 = 0;
pub const OPU_ERR_NULL: i32 = 1;
pub const OPU_ERR_EVENT: i32 = 2;
pub const OPU_ERR_DIMENSION: i32 = 3;
pub const OPU_ERR_OVERFLOW: i32 = 4;
pub const OPU_ERR_PANIC: i32 = 5;
pub const OPU_ERR_IR: i32 = 6;
pub const OPU_ERR_STATE: i32 = 7;
pub const OPU_ERR_TIME: i32 = 8;

/* Negative status values for span export, so a count can never be confused
 * with an error by a caller that only checks the sign. */
pub const OPU_SPAN_ERR_NULL: i32 = -1;
pub const OPU_SPAN_ERR_IR: i32 = -2;
pub const OPU_SPAN_ERR_STATE: i32 = -3;
pub const OPU_SPAN_ERR_DIMENSION: i32 = -4;
pub const OPU_SPAN_ERR_OVERFLOW: i32 = -5;
pub const OPU_SPAN_ERR_PANIC: i32 = -6;

pub const OPU_EVENT_TAP: u32 = 1;
pub const OPU_EVENT_RESET: u32 = 2;

/// One host pointer signal, byte-for-byte with `OpuPointerEvent` in opurom.h.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpuPointerEvent {
    pub kind: u32,
    pub pointer_id: u32,
    pub node_id: u32,
    pub time_ms: i64,
    pub local_x: i64,
    pub local_y: i64,
    pub global_x: i64,
    pub global_y: i64,
}

/// One ABI gesture result, byte-for-byte with `OpuGesture` in opurom.h.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpuGesture {
    pub code: u32,
    pub node_id: u32,
    pub dx: i32,
    pub dy: i32,
}

pub const OPU_POINTER_DOWN: u32 = 1;
pub const OPU_POINTER_MOVE: u32 = 2;
pub const OPU_POINTER_UP: u32 = 3;
pub const OPU_POINTER_CANCEL: u32 = 4;
pub const OPU_GESTURE_NONE: u32 = 0;
pub const OPU_GESTURE_TAP: u32 = 1;
pub const OPU_GESTURE_DOUBLE_TAP: u32 = 2;
pub const OPU_GESTURE_LONG_PRESS: u32 = 3;
pub const OPU_GESTURE_DRAG: u32 = 4;

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

/// FNV-1a over a byte slice: a cheap content key so the press frame pump can
/// reuse a parsed IR instead of re-parsing multi-megabyte base64 every frame.
fn ir_content_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// O(1) content fingerprint for large IR blobs: length plus FNV over the head,
/// tail and a few interior windows. A cached entry also stores the sampled
/// bytes and verifies them on hit, so a collision can never serve wrong spans.
fn ir_fingerprint(bytes: &[u8]) -> ([u64; 3], Vec<u8>) {
    fn fnv(seed: u64, bytes: &[u8]) -> u64 {
        let mut h = seed;
        for &b in bytes {
            h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
        }
        h
    }
    const W: usize = 64;
    let n = bytes.len();
    let mut sample = Vec::with_capacity(W * 4);
    let mut push_window = |start: usize| {
        let end = (start + W).min(n);
        sample.extend_from_slice(&bytes[start..end]);
    };
    push_window(0);
    push_window(n.saturating_sub(W));
    push_window(n / 2);
    let fp = [
        n as u64,
        fnv(0xcbf2_9ce4_8422_2325, &sample[..W.min(sample.len())]),
        fnv(0x9e37_79b9_7f4a_7c15, &sample[W.min(sample.len())..]),
    ];
    (fp, sample)
}

/// Opaque reusable renderer. C callers see only an incomplete struct type.
#[repr(C)]
pub struct OpuRenderer {
    renderer: Renderer,
    width: u32,
    height: u32,
    /// Caller-owned press phase; None keeps every frame byte-identical.
    press: Option<PressPhase>,
    /// Last parsed IR keyed by (content hash, route). Press frames reuse it;
    /// a changed IR or route invalidates it. State is never cached (small).
    ir_cache: Option<([u64; 3], Option<String>, Ir, Vec<u8>)>,
    /// Caller-owned gesture arena, living exactly as long as this renderer.
    gesture: GestureEngine,
    /// Fingerprint of the IR/route/viewport whose layout populated `gesture`.
    gesture_key: Option<([u64; 3], Option<String>, u32, u32)>,
    /// Last accepted pointer/tick time on the caller-owned logical clock.
    clock_ms: i64,
    /// Last accepted tick time; equal or older ticks are rejected.
    last_tick_ms: Option<i64>,
    /// Node id of the active pointer, used to label tick-emitted gestures.
    gesture_node: u32,
}

impl OpuRenderer {
    /// Ensures the cache holds the parsed, route-selected IR for this input.
    /// Reuses it across press frames; a changed IR or route refreshes it.
    /// Parsing a large base64-bearing IR every frame is the dominant cost on
    /// device. State is never cached (small, and may change per frame).
    fn cache_active_ir(
        &mut self,
        ir_json: *const u8,
        ir_len: usize,
        route: Option<&str>,
    ) -> Result<(), i32> {
        let bytes = json_str(ir_json, ir_len, OPU_ERR_IR)?;
        let (fp, sample) = ir_fingerprint(bytes.as_bytes());
        if let Some((cached_fp, cached_route, _, cached_sample)) = &self.ir_cache {
            if *cached_fp == fp
                && cached_route.as_deref() == route
                && cached_sample.as_slice() == sample.as_slice()
            {
                return Ok(());
            }
        }
        let parsed = parse_ir(bytes).map_err(|_| OPU_ERR_IR)?;
        let active = route_ir(&parsed, route)?.into_owned();
        self.ir_cache = Some((fp, route.map(str::to_owned), active, sample));
        Ok(())
    }

    /// Renders one frame, honouring the press phase when one is set. Without a
    /// press this is the exact incremental call, so default frames are unchanged.
    fn render_at(&mut self, ir: &Ir, state: &StateView, elapsed_ms: i64) -> Frame {
        match self.press_phase(ir, state, elapsed_ms) {
            Some(p) => self
                .renderer
                .render_with_press_incremental(ir, state, elapsed_ms, Some(&p)),
            None => self.renderer.render_incremental_at(ir, state, elapsed_ms),
        }
    }

    /// The stored touch is absolute canvas coords; the ripple raster wants it
    /// relative to the pressed node, so resolve the node rect here.
    fn press_phase(&self, ir: &Ir, state: &StateView, elapsed_ms: i64) -> Option<PressPhase> {
        let mut p = self.press?;
        if let Some((x, y)) = p.touch {
            p.touch = layout_at(ir, state, self.width, self.height, elapsed_ms)
                .iter()
                .find(|n| n.id == p.node_id)
                .map(|n| (x - n.rect.x, y - n.rect.y));
        }
        Some(p)
    }
}

/// Rebuild the gesture arena when the IR, route or viewport changes. Node
/// rects come from the same layout pass the raster uses; re-registering is
/// idempotent by id so a stale rect cannot duplicate an entry.
fn sync_gesture(
    gesture: &mut GestureEngine,
    gesture_key: &mut Option<([u64; 3], Option<String>, u32, u32)>,
    ir: &Ir,
    state: &StateView,
    width: u32,
    height: u32,
    elapsed_ms: i64,
    key: ([u64; 3], Option<String>, u32, u32),
) {
    if gesture_key.as_ref() == Some(&key) {
        return;
    }
    fn collect(
        node: &Node,
        parent: Option<u32>,
        out: &mut HashMap<u32, (Option<u32>, Option<GestureKind>)>,
    ) {
        out.insert(node.id, (parent, node.props.gesture));
        for child in &node.children {
            collect(child, Some(node.id), out);
        }
    }
    let mut meta = HashMap::new();
    collect(&ir.tree, None, &mut meta);
    *gesture = GestureEngine::new();
    for laid in layout_at(ir, state, width, height, elapsed_ms.max(0)) {
        let (parent, kind) = meta.get(&laid.id).copied().unwrap_or((None, None));
        gesture.add_node_with(laid.id, laid.rect, parent, kind);
    }
    *gesture_key = Some(key);
}

fn gesture_key(
    ir_json: *const u8,
    ir_len: usize,
    route: Option<&str>,
    width: u32,
    height: u32,
) -> Result<([u64; 3], Option<String>, u32, u32), i32> {
    let bytes = json_str(ir_json, ir_len, OPU_ERR_IR)?;
    Ok((
        ir_fingerprint(bytes.as_bytes()).0,
        route.map(str::to_owned),
        width,
        height,
    ))
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

fn parse_ir_state(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
) -> Result<(Ir, StateView), i32> {
    let ir = parse_ir(json_str(ir_json, ir_len, OPU_ERR_IR)?).map_err(|_| OPU_ERR_IR)?;
    let state = parse_state_json(&ir, json_str(state_json, state_len, OPU_ERR_STATE)?)
        .map_err(|_| OPU_ERR_STATE)?;
    Ok((ir, state))
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
    if out.is_null() {
        return Err(OPU_ERR_NULL);
    }
    let byte_len = frame_len(width, height).ok_or(OPU_ERR_DIMENSION)?;
    let (ir, state) = parse_ir_state(ir_json, ir_len, state_json, state_len)?;
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
                press: None,
                ir_cache: None,
                gesture: GestureEngine::new(),
                gesture_key: None,
                clock_ms: 0,
                last_tick_ms: None,
                gesture_node: 0,
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

/// Parses an IR 0.1.0 document plus a JSON object of state overrides, renders one
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
            let key = match gesture_key(ir_json, ir_len, None, width, height) {
                Ok(key) => key,
                Err(code) => return code,
            };
            sync_gesture(
                &mut owned.gesture,
                &mut owned.gesture_key,
                &ir,
                &state,
                width,
                height,
                SETTLED_MS,
                key,
            );
            let frame = owned.render_at(&ir, &state, SETTLED_MS);
            write_pixels(&frame.pixels, out, byte_len)
        },
        OPU_ERR_PANIC,
    )
}

/// Selects the IR to render: the tree of `route` when the document declares
/// routes, otherwise the document unchanged (single-page IR ignores `route`).
fn route_ir<'a>(ir: &'a Ir, route: Option<&str>) -> Result<std::borrow::Cow<'a, Ir>, i32> {
    match route {
        Some(name) if !ir.routes.is_empty() => ir
            .with_route(name)
            .map(std::borrow::Cow::Owned)
            .ok_or(OPU_ERR_IR),
        _ => Ok(std::borrow::Cow::Borrowed(ir)),
    }
}

/// Borrows an optional route key; `None` when the pointer is null or the span is empty.
fn route_str<'a>(ptr: *const u8, len: usize) -> Result<Option<&'a str>, i32> {
    if ptr.is_null() || len == 0 {
        return Ok(None);
    }
    if len > OPU_MAX_JSON_BYTES || len > isize::MAX as usize {
        return Err(OPU_ERR_IR);
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map(Some).map_err(|_| OPU_ERR_IR)
}

/// Multi-page variant of `opu_frame_from_ir`: renders the tree of `route`
/// (or the initial route when null/empty). A single-page IR ignores `route`.
#[no_mangle]
pub extern "C" fn opu_frame_from_ir_route(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    route: *const u8,
    route_len: usize,
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
            let active = match route_str(route, route_len).and_then(|r| route_ir(&ir, r)) {
                Ok(active) => active,
                Err(code) => return code,
            };
            let Ok(renderer) = Renderer::try_new(width, height) else {
                return OPU_ERR_DIMENSION;
            };
            let pixels = renderer.pixels_at(&active, &state, SETTLED_MS);
            write_pixels(&pixels, out, byte_len)
        },
        OPU_ERR_PANIC,
    )
}

/// Multi-page variant of `opu_renderer_frame`: renders `route`'s tree through a
/// reusable renderer. Error codes match `opu_frame_from_ir_route`.
#[no_mangle]
pub extern "C" fn opu_renderer_frame_route(
    renderer: *mut OpuRenderer,
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    route: *const u8,
    route_len: usize,
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
            let route_name = match route_str(route, route_len) {
                Ok(name) => name,
                Err(code) => return code,
            };
            let active = match route_ir(&ir, route_name) {
                Ok(active) => active,
                Err(code) => return code,
            };
            let key = match gesture_key(ir_json, ir_len, route_name, width, height) {
                Ok(key) => key,
                Err(code) => return code,
            };
            sync_gesture(
                &mut owned.gesture,
                &mut owned.gesture_key,
                &active,
                &state,
                width,
                height,
                SETTLED_MS,
                key,
            );
            let frame = owned.render_at(&active, &state, SETTLED_MS);
            write_pixels(&frame.pixels, out, byte_len)
        },
        OPU_ERR_PANIC,
    )
}

/// Timed variant of `opu_renderer_frame_route`: renders `route`'s tree at an
/// explicit caller-owned `elapsed_ms` so a host frame pump can play animations.
/// Identical to `opu_renderer_frame_route` except the clock is caller-supplied
/// instead of `SETTLED_MS`. Error codes match `opu_renderer_frame_route`.
#[no_mangle]
pub extern "C" fn opu_renderer_frame_at(
    renderer: *mut OpuRenderer,
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    route: *const u8,
    route_len: usize,
    elapsed_ms: i64,
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
            if out.is_null() {
                return OPU_ERR_NULL;
            }
            let byte_len = match frame_len(width, height) {
                Some(len) => len,
                None => return OPU_ERR_DIMENSION,
            };
            let route = match route_str(route, route_len) {
                Ok(route) => route,
                Err(code) => return code,
            };
            // Reuse the parsed, route-selected IR across press frames. Parsing
            // a 1.88 MB base64-bearing IR on every pump frame caused the
            // multi-second visible stalls on device.
            if let Err(code) = owned.cache_active_ir(ir_json, ir_len, route) {
                return code;
            }
            let state_json = match json_str(state_json, state_len, OPU_ERR_STATE) {
                Ok(s) => s,
                Err(code) => return code,
            };
            let press = owned.press;
            let width_c = owned.width;
            let height_c = owned.height;
            // Disjoint field borrows: active IR from the cache, renderer mutable.
            let active = match &owned.ir_cache {
                Some((_, _, ir, _)) => ir,
                None => return OPU_ERR_IR,
            };
            let state = match parse_state_json(active, state_json) {
                Ok(view) => view,
                Err(_) => return OPU_ERR_STATE,
            };
            let key = match gesture_key(ir_json, ir_len, route, width, height) {
                Ok(key) => key,
                Err(code) => return code,
            };
            sync_gesture(
                &mut owned.gesture,
                &mut owned.gesture_key,
                active,
                &state,
                width,
                height,
                elapsed_ms,
                key,
            );
            let phase = press.and_then(|mut p| {
                if let Some((x, y)) = p.touch {
                    p.touch = layout_at(active, &state, width_c, height_c, elapsed_ms.max(0))
                        .iter()
                        .find(|n| n.id == p.node_id)
                        .map(|n| (x - n.rect.x, y - n.rect.y));
                }
                Some(p)
            });
            let frame = match phase {
                Some(p) => owned.renderer.render_with_press_incremental(
                    active,
                    &state,
                    elapsed_ms.max(0),
                    Some(&p),
                ),
                None => owned
                    .renderer
                    .render_incremental_at(active, &state, elapsed_ms.max(0)),
            };
            write_pixels(&frame.pixels, out, byte_len)
        },
        OPU_ERR_PANIC,
    )
}

/// Writes the IR's `initialRoute` (UTF-8, not NUL-terminated) into `out` and
/// returns its length, or 0 for a single-page/unparsable IR or an oversized key.
#[no_mangle]
pub extern "C" fn opu_ir_initial_route(
    ir_json: *const u8,
    ir_len: usize,
    out: *mut u8,
    out_capacity: usize,
) -> usize {
    ffi_guard(
        || {
            if out.is_null() {
                return 0;
            }
            let Ok(text) = json_str(ir_json, ir_len, OPU_ERR_IR) else {
                return 0;
            };
            let Ok(ir) = parse_ir(text) else {
                return 0;
            };
            let Some(route) = ir.initial_route else {
                return 0;
            };
            let bytes = route.as_bytes();
            if bytes.len() > out_capacity {
                return 0;
            }
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
            bytes.len()
        },
        0,
    )
}

/// Writes the declared route name at `index` (sorted order) into `out` and
/// returns its length, or 0 when the IR has fewer routes or cannot be parsed.
#[no_mangle]
pub extern "C" fn opu_ir_route_at(
    ir_json: *const u8,
    ir_len: usize,
    index: u32,
    out: *mut u8,
    out_capacity: usize,
) -> usize {
    ffi_guard(
        || {
            if out.is_null() {
                return 0;
            }
            let Ok(text) = json_str(ir_json, ir_len, OPU_ERR_IR) else {
                return 0;
            };
            let Ok(ir) = parse_ir(text) else {
                return 0;
            };
            let Some((name, _)) = ir.routes.iter().nth(index as usize) else {
                return 0;
            };
            let bytes = name.as_bytes();
            if bytes.len() > out_capacity {
                return 0;
            }
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
            bytes.len()
        },
        0,
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

/// Drag-only classification for a laid-out id, read from the IR tree that
/// `layout` consumed. Matches the render arena's `gesture == Drag` rule.
fn ir_node_is_drag_only(node: &Node, id: u32) -> bool {
    if node.id == id {
        return node.props.gesture == Some(GestureKind::Drag);
    }
    node.children
        .iter()
        .any(|child| ir_node_is_drag_only(child, id))
}

/// Top-most laid-out node containing the viewport point, or 0 for a miss.
/// The viewport must match the one passed to the render call, so the host can
/// forward a screen coordinate without a second layout.
#[no_mangle]
pub extern "C" fn opu_hit_test(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> u32 {
    ffi_guard(
        || {
            if x < 0 || y < 0 || frame_len(width, height).is_none() {
                return 0;
            }
            let (ir, state) = match parse_ir_state(ir_json, ir_len, state_json, state_len) {
                Ok(inputs) => inputs,
                Err(_) => return 0,
            };
            let laid = layout(&ir, &state, width, height);
            for node in laid.iter().rev() {
                let target = tap_hit_rect(node.rect, ir_node_is_drag_only(&ir.tree, node.id));
                if hit(&target, x as i64, y as i64) {
                    return node.id;
                }
            }
            0
        },
        0,
    )
}

fn core_value(value: &JsonValue) -> Result<CoreValue, i32> {
    match value {
        JsonValue::String(text) => Ok(CoreValue::Str(text.clone())),
        JsonValue::Bool(flag) => Ok(CoreValue::Bool(*flag)),
        JsonValue::Number(number) => number.as_i64().map(CoreValue::Int).ok_or(OPU_ERR_STATE),
        JsonValue::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or(OPU_ERR_STATE))
            .collect::<Result<Vec<String>, i32>>()
            .map(CoreValue::List),
        _ => Err(OPU_ERR_STATE),
    }
}

fn tap_node_impl(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    node_id: u32,
    out_json: *mut u8,
    out_capacity: usize,
) -> Result<i32, i32> {
    if out_json.is_null() {
        return Err(OPU_ERR_NULL);
    }
    let ir_text = json_str(ir_json, ir_len, OPU_ERR_IR)?;
    let state_text = json_str(state_json, state_len, OPU_ERR_STATE)?;
    let overrides: JsonValue = serde_json::from_str(state_text).map_err(|_| OPU_ERR_STATE)?;
    let mut runtime = CoreRuntime::from_ir_json(ir_text).map_err(|_| OPU_ERR_IR)?;
    let object = overrides.as_object().ok_or(OPU_ERR_STATE)?;
    for (name, value) in object {
        // Host state may outlive an IR that no longer declares a key.
        if runtime.state(name).is_none() {
            continue;
        }
        let patch = CorePatch {
            name: name.clone(),
            value: core_value(value)?,
        };
        runtime.apply_patch(&patch).map_err(|_| OPU_ERR_STATE)?;
    }
    let patches = runtime
        .dispatch(CoreEvent::Tap { node_id })
        .map_err(|_| OPU_ERR_EVENT)?;
    let mut state = JsonMap::new();
    for patch in runtime.snapshot() {
        let value = serde_json::to_value(patch.value).map_err(|_| OPU_ERR_STATE)?;
        state.insert(patch.name, value);
    }
    // Reserved navigation signals (e.g. @nav) are returned by dispatch but
    // never enter the state mirror. Forward them to the host so it can switch
    // the active route; the host consumes and strips them before reuse.
    for patch in patches {
        if patch.name.starts_with('@') {
            let value = serde_json::to_value(patch.value).map_err(|_| OPU_ERR_STATE)?;
            state.insert(patch.name, value);
        }
    }
    let text = serde_json::to_string(&JsonValue::Object(state)).map_err(|_| OPU_ERR_STATE)?;
    let bytes = text.as_bytes();
    if bytes.len() > out_capacity {
        return Err(OPU_ERR_OVERFLOW);
    }
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_json, bytes.len()) };
    Ok(OPU_OK)
}

/// Dispatches `tap` on one node through the shared state machine and writes the
/// complete resulting state as a JSON object into `out_json`. The host reuses
/// that document for the next frame, so state survives successive taps. A node
/// with no tap binding returns OPU_ERR_EVENT and leaves the output untouched.
#[no_mangle]
pub extern "C" fn opu_tap_node(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    node_id: u32,
    out_json: *mut u8,
    out_capacity: usize,
) -> i32 {
    ffi_guard(
        || match tap_node_impl(
            ir_json,
            ir_len,
            state_json,
            state_len,
            node_id,
            out_json,
            out_capacity,
        ) {
            Ok(status) => status,
            Err(code) => code,
        },
        OPU_ERR_PANIC,
    )
}

/// Writes the deterministic text-span JSON for one IR/state/viewport and
/// Cache of the last text-span JSON documents, keyed by (IR hash, state hash,
/// route, viewport). The host calls this every frame; without a cache each
/// call re-parses a multi-megabyte IR just to recompute identical spans.
const SPAN_CACHE_CAPACITY: usize = 8;
type SpanKey = ([u64; 3], u64, String, u32, u32);
static SPAN_CACHE: OnceLock<Mutex<std::collections::HashMap<SpanKey, (Vec<u8>, i32, Vec<u8>)>>> =
    OnceLock::new();

fn span_cache(
) -> std::sync::MutexGuard<'static, std::collections::HashMap<SpanKey, (Vec<u8>, i32, Vec<u8>)>> {
    SPAN_CACHE
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

fn text_spans_impl(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    route: Option<&str>,
    width: u32,
    height: u32,
    out_json: *mut u8,
    out_capacity: usize,
) -> i32 {
    ffi_guard(
        || {
            if out_json.is_null() {
                return OPU_SPAN_ERR_NULL;
            }
            if frame_len(width, height).is_none() {
                return OPU_SPAN_ERR_DIMENSION;
            }
            let (ir, state) = match parse_ir_state(ir_json, ir_len, state_json, state_len) {
                Ok(inputs) => inputs,
                Err(OPU_ERR_IR) => return OPU_SPAN_ERR_IR,
                Err(OPU_ERR_STATE) => return OPU_SPAN_ERR_STATE,
                Err(_) => return OPU_SPAN_ERR_NULL,
            };
            let active = match route_ir(&ir, route) {
                Ok(active) => active,
                Err(_) => return OPU_SPAN_ERR_IR,
            };
            let text = text_spans_for(&active, &state, width, height);
            let spans: Vec<JsonValue> = match serde_json::from_str(&text) {
                Ok(spans) => spans,
                Err(_) => return OPU_SPAN_ERR_STATE,
            };
            let count = spans.len();
            let bytes = text.as_bytes();
            if bytes.len() > out_capacity {
                return OPU_SPAN_ERR_OVERFLOW;
            }
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_json, bytes.len()) };
            count as i32
        },
        OPU_SPAN_ERR_PANIC,
    )
}

#[no_mangle]
pub extern "C" fn opu_text_spans(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    width: u32,
    height: u32,
    out_json: *mut u8,
    out_capacity: usize,
) -> i32 {
    text_spans_impl(
        ir_json,
        ir_len,
        state_json,
        state_len,
        None,
        width,
        height,
        out_json,
        out_capacity,
    )
}

/// Route-aware text spans: emits the system-font spans of `route`'s tree so
/// the host text overlay matches the graphics frame on multi-page programs.
#[no_mangle]
pub extern "C" fn opu_text_spans_route(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    route: *const u8,
    route_len: usize,
    width: u32,
    height: u32,
    out_json: *mut u8,
    out_capacity: usize,
) -> i32 {
    let route = match route_str(route, route_len) {
        Ok(route) => route,
        Err(_) => return OPU_SPAN_ERR_IR,
    };
    let ir_bytes = match json_str(ir_json, ir_len, OPU_SPAN_ERR_IR) {
        Ok(s) => s.as_bytes(),
        Err(code) => return code,
    };
    let state_bytes = match json_str(state_json, state_len, OPU_SPAN_ERR_STATE) {
        Ok(s) => s.as_bytes(),
        Err(code) => return code,
    };
    let (fp, sample) = ir_fingerprint(ir_bytes);
    let key: SpanKey = (
        fp,
        ir_content_hash(state_bytes),
        route.unwrap_or("").to_owned(),
        width,
        height,
    );
    if let Some((cached, count, cached_sample)) = span_cache().get(&key) {
        if cached_sample.as_slice() == sample.as_slice() {
            if cached.len() > out_capacity {
                return OPU_SPAN_ERR_OVERFLOW;
            }
            unsafe { std::ptr::copy_nonoverlapping(cached.as_ptr(), out_json, cached.len()) };
            return *count;
        }
    }
    let count = text_spans_impl(
        ir_json,
        ir_len,
        state_json,
        state_len,
        route,
        width,
        height,
        out_json,
        out_capacity,
    );
    if count >= 0 {
        let len = {
            let data = unsafe { std::slice::from_raw_parts(out_json, out_capacity) };
            data.iter().position(|b| *b == 0).unwrap_or(out_capacity)
        };
        let stored = unsafe { std::slice::from_raw_parts(out_json, len) }.to_vec();
        let mut cache = span_cache();
        if cache.len() >= SPAN_CACHE_CAPACITY {
            // Drop one arbitrary entry; keys are content hashes so any eviction
            // is deterministic for a given call sequence.
            if let Some(old) = cache.keys().next().cloned() {
                cache.remove(&old);
            }
        }
        cache.insert(key, (stored, count, sample));
    }
    count
}

/// Opt-in graphics-only mode for a reusable renderer. Default stays false, so
/// existing frames are byte-identical until a host turns suppression on.
#[no_mangle]
pub extern "C" fn opu_renderer_set_suppress_text(renderer: *mut OpuRenderer, on: i32) -> i32 {
    ffi_guard(
        || {
            if renderer.is_null() {
                return OPU_ERR_NULL;
            }
            let owned = unsafe { &mut *renderer };
            owned.renderer.set_suppress_text(on != 0);
            OPU_OK
        },
        OPU_ERR_PANIC,
    )
}

/// Sets, confirms or clears the caller-owned press phase for a reusable
/// renderer (ANIMATION_AND_PHYSICS.md §8). `on` is the event kind:
/// `1` (DOWN) stores a press at `press_start_tick` with an absolute canvas
/// `touch` (negative = node centre); re-reporting DOWN for the same node keeps
/// the original `press_start_tick`. `2` (CONFIRM, release) keeps the press and
/// stamps its confirm tick with `press_start_tick` so the renderer runs the
/// accelerated radius and delayed fade-out; it never clears. `0` (CLEAR) and a
/// zero `node_id` clear the press. Never touches the state JSON or the IR;
/// frames without a press are unchanged.
#[no_mangle]
pub extern "C" fn opu_renderer_set_press(
    renderer: *mut OpuRenderer,
    node_id: u32,
    press_start_tick: i64,
    touch_x: i64,
    touch_y: i64,
    on: i32,
) -> i32 {
    ffi_guard(
        || {
            if renderer.is_null() {
                return OPU_ERR_NULL;
            }
            let owned = unsafe { &mut *renderer };
            if on == 2 {
                // CONFIRM: the release tick rides in press_start_tick. Keep the
                // down origin, node id and touch so the renderer can finish the
                // radius and fade out. A confirm with no active press is a no-op.
                if let Some(press) = owned.press.as_mut() {
                    if press.node_id == node_id {
                        press.confirm_tick = Some(press_start_tick);
                    }
                }
            } else if on != 0 && node_id != 0 {
                // Every DOWN is a new gesture and opens a fresh ripple clock.
                // A previous press (even mid-confirm) is replaced: its old down
                // tick would make the next ripple start at max radius.
                owned.press = Some(PressPhase {
                    node_id,
                    press_start_tick,
                    touch: if touch_x >= 0 && touch_y >= 0 {
                        Some((touch_x, touch_y))
                    } else {
                        None
                    },
                    confirm_tick: None,
                });
            } else {
                owned.press = None;
            }
            OPU_OK
        },
        OPU_ERR_PANIC,
    )
}

/// Feed one caller-supplied pointer signal to the renderer-owned gesture
/// arena. `time_ms` is a caller-owned logical clock, never a wall clock; it
/// must not move backwards. A null `out` asks for no gesture result.
#[no_mangle]
pub extern "C" fn opu_renderer_pointer(
    renderer: *mut OpuRenderer,
    event: *const OpuPointerEvent,
    out: *mut OpuGesture,
) -> i32 {
    ffi_guard(
        || {
            if renderer.is_null() || event.is_null() {
                return OPU_ERR_NULL;
            }
            let event = unsafe { *event };
            if event.time_ms < 0 || (event.time_ms as i64) < unsafe { (*renderer).clock_ms } {
                return OPU_ERR_TIME;
            }
            let kind = match event.kind {
                OPU_POINTER_DOWN => PointerKind::Down,
                OPU_POINTER_MOVE => PointerKind::Move,
                OPU_POINTER_UP => PointerKind::Up,
                OPU_POINTER_CANCEL => PointerKind::Cancel,
                _ => return OPU_ERR_EVENT,
            };
            let owned = unsafe { &mut *renderer };
            // A miss follows the engine's cancel path, so no stale down can
            // survive a pointer that lands outside every registered node.
            let signal = if event.node_id == 0 {
                PointerKind::Cancel
            } else {
                kind
            };
            let pointer = PointerEvent::new(
                signal,
                event.pointer_id,
                event.time_ms,
                event.local_x,
                event.local_y,
                event.global_x,
                event.global_y,
            );
            let gesture = owned.gesture.on_event(event.node_id, &pointer);
            owned.clock_ms = event.time_ms;
            if event.kind == OPU_POINTER_DOWN {
                owned.gesture_node = event.node_id;
            }
            write_gesture(gesture, event.node_id, out);
            OPU_OK
        },
        OPU_ERR_PANIC,
    )
}

/// Returns the next caller-owned gesture deadline in logical milliseconds, or
/// -1 when no deadline is pending (or the renderer handle is null). i64::MAX
/// is a legitimate saturating deadline and is never collapsed into the -1
/// sentinel. The query is side-effect free.
#[no_mangle]
pub extern "C" fn opu_renderer_next_deadline_ms(renderer: *mut OpuRenderer) -> i64 {
    if renderer.is_null() {
        return -1;
    }
    unsafe { (*renderer).gesture.next_deadline_ms().unwrap_or(-1) }
}

/// Advance the renderer-owned gesture arena to a caller-owned logical tick.
#[no_mangle]
pub extern "C" fn opu_renderer_tick(
    renderer: *mut OpuRenderer,
    t_ms: i64,
    out: *mut OpuGesture,
) -> i32 {
    ffi_guard(
        || {
            if renderer.is_null() {
                return OPU_ERR_NULL;
            }
            let owned = unsafe { &mut *renderer };
            if t_ms < 0
                || t_ms < owned.clock_ms
                || owned.last_tick_ms.is_some_and(|last| t_ms <= last)
            {
                return OPU_ERR_TIME;
            }
            let gesture = owned.gesture.on_tick(t_ms);
            owned.clock_ms = t_ms;
            owned.last_tick_ms = Some(t_ms);
            let node = owned.gesture_node;
            write_gesture(gesture, node, out);
            OPU_OK
        },
        OPU_ERR_PANIC,
    )
}

fn write_gesture(gesture: Option<Gesture>, node_id: u32, out: *mut OpuGesture) {
    if out.is_null() {
        return;
    }
    let (code, dx, dy) = match gesture {
        None => (OPU_GESTURE_NONE, 0, 0),
        Some(Gesture::Tap) => (OPU_GESTURE_TAP, 0, 0),
        Some(Gesture::DoubleTap) => (OPU_GESTURE_DOUBLE_TAP, 0, 0),
        Some(Gesture::LongPress) => (OPU_GESTURE_LONG_PRESS, 0, 0),
        Some(Gesture::Drag { dx, dy }) => (OPU_GESTURE_DRAG, dx as i32, dy as i32),
    };
    unsafe {
        *out = OpuGesture {
            code,
            node_id,
            dx,
            dy,
        }
    };
}

fn frame_suppressed_impl(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    out: *mut u8,
    width: u32,
    height: u32,
) -> Result<i32, i32> {
    if out.is_null() {
        return Err(OPU_ERR_NULL);
    }
    let byte_len = frame_len(width, height).ok_or(OPU_ERR_DIMENSION)?;
    let (ir, state) = parse_ir_state(ir_json, ir_len, state_json, state_len)?;
    let mut renderer = Renderer::try_new(width, height).map_err(|_| OPU_ERR_DIMENSION)?;
    renderer.set_suppress_text(true);
    let pixels = renderer.pixels_at(&ir, &state, SETTLED_MS);
    Ok(write_pixels(&pixels, out, byte_len))
}

/// One-shot graphics-only frame for hosts without a reusable renderer.
#[no_mangle]
pub extern "C" fn opu_frame_from_ir_suppressed(
    ir_json: *const u8,
    ir_len: usize,
    state_json: *const u8,
    state_len: usize,
    out: *mut u8,
    width: u32,
    height: u32,
) -> i32 {
    ffi_guard(
        || match frame_suppressed_impl(ir_json, ir_len, state_json, state_len, out, width, height) {
            Ok(status) => status,
            Err(code) => code,
        },
        OPU_ERR_PANIC,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_press_new_down_restarts_clock_and_confirm_records_tick() {
        let renderer = opu_renderer_new(32, 32);
        assert!(!renderer.is_null());

        // DOWN opens a press with no confirm tick.
        assert_eq!(opu_renderer_set_press(renderer, 7, 100, 3, 4, 1), OPU_OK);
        let p = unsafe { &*renderer }.press.unwrap();
        assert_eq!(p.node_id, 7);
        assert_eq!(p.press_start_tick, 100);
        assert_eq!(p.confirm_tick, None);
        assert_eq!(p.touch, Some((3, 4)));

        // A new DOWN re-stamps the clock even on the same node. A previous
        // press mid-confirm must not leak its old origin into the new ripple.
        assert_eq!(opu_renderer_set_press(renderer, 7, 900, 5, 6, 1), OPU_OK);
        let p = unsafe { &*renderer }.press.unwrap();
        assert_eq!(p.press_start_tick, 900, "new down opens a fresh clock");
        assert_eq!(p.touch, Some((5, 6)), "touch follows the finger");
        assert_eq!(p.confirm_tick, None);

        // CONFIRM stamps only the confirm tick; the press stays live.
        assert_eq!(opu_renderer_set_press(renderer, 7, 1200, 5, 6, 2), OPU_OK);
        let p = unsafe { &*renderer }.press.unwrap();
        assert_eq!(p.press_start_tick, 900, "confirm keeps the down origin");
        assert_eq!(
            p.confirm_tick,
            Some(1200),
            "confirm tick is the release tick"
        );
        assert_eq!(p.touch, Some((5, 6)), "confirm keeps the touch point");

        // A new DOWN during the fade discards the confirm and restarts cleanly.
        assert_eq!(opu_renderer_set_press(renderer, 7, 1300, 8, 9, 1), OPU_OK);
        let p = unsafe { &*renderer }.press.unwrap();
        assert_eq!(
            p.press_start_tick, 1300,
            "down during fade resets the clock"
        );
        assert_eq!(p.confirm_tick, None, "down during fade clears confirm");
        assert_eq!(p.touch, Some((8, 9)));

        // A confirm for another node leaves the active press untouched.
        assert_eq!(opu_renderer_set_press(renderer, 8, 500, 1, 1, 2), OPU_OK);
        assert_eq!(unsafe { &*renderer }.press.unwrap().confirm_tick, None);

        // Only CLEAR removes the press.
        assert_eq!(opu_renderer_set_press(renderer, 0, 0, 0, 0, 0), OPU_OK);
        assert!(
            unsafe { &*renderer }.press.is_none(),
            "clear removes the press"
        );
        opu_renderer_free(renderer);
    }

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

    #[test]
    fn hit_test_and_tap_node_drive_calculator_state() {
        let ir = include_bytes!("../android/app/src/main/assets/calculator.opuir.json");
        let empty = b"{}";
        let (width, height) = (400u32, 720u32);
        let mut unique = Vec::new();
        for y in (0..height as i32).step_by(20) {
            for x in (0..width as i32).step_by(20) {
                let id = opu_hit_test(
                    ir.as_ptr(),
                    ir.len(),
                    empty.as_ptr(),
                    empty.len(),
                    x,
                    y,
                    width,
                    height,
                );
                if id != 0 && !unique.contains(&id) {
                    unique.push(id);
                }
            }
        }
        assert!(unique.len() >= 2, "expected at least two laid-out nodes");
        assert_eq!(
            unique,
            vec![1, 2, 3, 4, 5, 6, 7, 10, 9, 11, 12, 13, 15, 14, 16, 17, 18]
        );
        let mut tappable = Vec::new();
        let mut scratch = [0u8; 8192];
        for id in unique {
            let status = opu_tap_node(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                id,
                scratch.as_mut_ptr(),
                scratch.len(),
            );
            if status == OPU_OK && !tappable.contains(&id) {
                tappable.push(id);
            }
        }
        assert!(
            tappable.len() >= 2,
            "expected at least two nodes with tap bindings"
        );
        let first = tappable[0];
        let second = tappable[1];
        let mut out1 = [0u8; 8192];
        let mut out2 = [0u8; 8192];
        assert_eq!(
            opu_tap_node(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                first,
                out1.as_mut_ptr(),
                out1.len()
            ),
            OPU_OK
        );
        assert_eq!(
            opu_tap_node(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                second,
                out2.as_mut_ptr(),
                out2.len()
            ),
            OPU_OK
        );
        let len1 = out1.iter().position(|b| *b == 0).unwrap_or(out1.len());
        let len2 = out2.iter().position(|b| *b == 0).unwrap_or(out2.len());
        let a = std::str::from_utf8(&out1[..len1]).unwrap();
        let b = std::str::from_utf8(&out2[..len2]).unwrap();
        let _: JsonValue = serde_json::from_str(a).unwrap();
        assert_ne!(a, b, "different digit nodes must produce different state");
        assert_eq!(
            opu_tap_node(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                u32::MAX,
                out1.as_mut_ptr(),
                out1.len()
            ),
            OPU_ERR_EVENT
        );
    }

    #[test]
    fn text_spans_are_deterministic_and_suppression_removes_bitmap_text() {
        let ir = include_bytes!("../android/app/src/main/assets/calculator.opuir.json");
        let empty = b"{}";
        let (width, height) = (400u32, 720u32);
        let mut first = [0u8; 32768];
        let mut second = [0u8; 32768];
        let count = opu_text_spans(
            ir.as_ptr(),
            ir.len(),
            empty.as_ptr(),
            empty.len(),
            width,
            height,
            first.as_mut_ptr(),
            first.len(),
        );
        assert!(count > 0, "calculator must export text spans");
        let other = opu_text_spans(
            ir.as_ptr(),
            ir.len(),
            empty.as_ptr(),
            empty.len(),
            width,
            height,
            second.as_mut_ptr(),
            second.len(),
        );
        assert_eq!(count, other);
        assert_eq!(first, second, "span JSON is byte-identical across runs");
        let _: JsonValue = serde_json::from_slice(
            &first[..first.iter().position(|b| *b == 0).unwrap_or(first.len())],
        )
        .unwrap();
        assert_eq!(
            opu_text_spans(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                width,
                height,
                first.as_mut_ptr(),
                1
            ),
            OPU_SPAN_ERR_OVERFLOW
        );
        let mut with_text = vec![0u8; (width * height * 4) as usize];
        let mut graphics = vec![0u8; with_text.len()];
        assert_eq!(
            opu_frame_from_ir(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                with_text.as_mut_ptr(),
                width,
                height
            ),
            OPU_OK
        );
        assert_eq!(
            opu_frame_from_ir_suppressed(
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                graphics.as_mut_ptr(),
                width,
                height
            ),
            OPU_OK
        );
        assert_ne!(
            with_text, graphics,
            "suppressed frame must not paint bitmap text"
        );
    }

    #[test]
    fn frame_at_uses_the_caller_clock_to_play_animation() {
        // A timed frame entry must honor elapsed_ms: the same renderer, IR and
        // state produce different pixels at different clock positions, and the
        // settled time matches the hardcoded-SETTLED_MS route entry.
        let ir = include_bytes!("../android/app/src/main/assets/motion.opuir.json");
        let empty = b"{}";
        let (width, height) = (320u32, 240u32);
        let len = (width * height * 4) as usize;
        let renderer = opu_renderer_new(width, height);
        assert!(!renderer.is_null());
        let mut at0 = vec![0u8; len];
        let mut at400 = vec![0u8; len];
        let mut settled = vec![0u8; len];
        assert_eq!(
            opu_renderer_frame_at(
                renderer,
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                std::ptr::null(),
                0,
                0,
                at0.as_mut_ptr(),
                width,
                height
            ),
            OPU_OK
        );
        assert_eq!(
            opu_renderer_frame_at(
                renderer,
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                std::ptr::null(),
                0,
                400,
                at400.as_mut_ptr(),
                width,
                height
            ),
            OPU_OK
        );
        assert_ne!(at0, at400, "elapsed_ms must change the rendered frame");
        assert_eq!(
            opu_renderer_frame_route(
                renderer,
                ir.as_ptr(),
                ir.len(),
                empty.as_ptr(),
                empty.len(),
                std::ptr::null(),
                0,
                settled.as_mut_ptr(),
                width,
                height
            ),
            OPU_OK
        );
        assert_eq!(at400, settled, "settled time must match the route entry");
        opu_renderer_free(renderer);
    }

    fn gesture_event(kind: u32, node: u32, t: i64, x: i64, y: i64) -> OpuPointerEvent {
        OpuPointerEvent {
            kind,
            pointer_id: 0,
            node_id: node,
            time_ms: t,
            local_x: x,
            local_y: y,
            global_x: x,
            global_y: y,
        }
    }

    fn gesture_renderer() -> *mut OpuRenderer {
        let renderer = opu_renderer_new(320, 240);
        assert!(!renderer.is_null());
        unsafe {
            (*renderer).gesture.add_node_with(
                7,
                Rect {
                    x: 100,
                    y: 100,
                    w: 48,
                    h: 48,
                },
                None,
                None,
            );
        }
        renderer
    }

    #[test]
    fn gesture_long_press_deadline_tick_and_contract_codes() {
        let renderer = gesture_renderer();
        assert_eq!(
            opu_renderer_next_deadline_ms(renderer),
            -1,
            "idle has no deadline"
        );
        let down = gesture_event(OPU_POINTER_DOWN, 7, 100, 120, 120);
        let up = gesture_event(OPU_POINTER_UP, 7, 110, 120, 120);
        let mut out = OpuGesture {
            code: 99,
            node_id: 99,
            dx: 9,
            dy: 9,
        };
        assert_eq!(
            opu_renderer_pointer(std::ptr::null_mut(), &down, &mut out),
            OPU_ERR_NULL
        );
        assert_eq!(
            opu_renderer_pointer(renderer, std::ptr::null(), &mut out),
            OPU_ERR_NULL
        );
        assert_eq!(
            opu_renderer_tick(std::ptr::null_mut(), 100, &mut out),
            OPU_ERR_NULL
        );
        assert_eq!(
            opu_renderer_pointer(renderer, &down, &mut out),
            OPU_OK,
            "down accepted"
        );
        assert_eq!(
            opu_renderer_next_deadline_ms(renderer),
            600,
            "100 + 500ms long press"
        );
        assert_eq!(opu_renderer_tick(renderer, 599, &mut out), OPU_OK);
        assert_eq!(out.code, OPU_GESTURE_NONE, "no long press before deadline");
        assert_eq!(opu_renderer_tick(renderer, 600, &mut out), OPU_OK);
        assert_eq!(out.code, OPU_GESTURE_LONG_PRESS);
        assert_eq!(out.node_id, 7);
        assert_eq!(
            opu_renderer_tick(renderer, 600, &mut out),
            OPU_ERR_TIME,
            "equal tick rejected"
        );
        assert_eq!(
            opu_renderer_pointer(renderer, &up, &mut out),
            OPU_ERR_TIME,
            "rewind rejected"
        );
        assert_eq!(
            opu_renderer_next_deadline_ms(renderer),
            -1,
            "settled has no deadline"
        );
        assert_eq!(opu_renderer_next_deadline_ms(std::ptr::null_mut()), -1);
        opu_renderer_free(renderer);
    }

    #[test]
    fn gesture_drag_wins_and_replay_is_byte_identical() {
        fn replay() -> (OpuGesture, OpuGesture, i64) {
            let renderer = gesture_renderer();
            let down = gesture_event(OPU_POINTER_DOWN, 7, 100, 120, 120);
            let move_event = gesture_event(OPU_POINTER_MOVE, 7, 120, 140, 120);
            let mut out = OpuGesture {
                code: 99,
                node_id: 99,
                dx: 9,
                dy: 9,
            };
            assert_eq!(opu_renderer_pointer(renderer, &down, &mut out), OPU_OK);
            assert_eq!(
                opu_renderer_pointer(renderer, &move_event, &mut out),
                OPU_OK
            );
            let drag = out;
            assert_eq!(drag.code, OPU_GESTURE_DRAG);
            assert_eq!(drag.dx, 20);
            assert_eq!(drag.dy, 0);
            assert_eq!(opu_renderer_tick(renderer, 600, &mut out), OPU_OK);
            let after = out;
            let deadline = opu_renderer_next_deadline_ms(renderer);
            opu_renderer_free(renderer);
            (drag, after, deadline)
        }
        let first = replay();
        assert_eq!(
            first,
            replay(),
            "same event+tick replay yields identical gestures"
        );
        assert_eq!(first.1.code, OPU_GESTURE_NONE, "drag rejects long press");
        assert_eq!(first.2, -1, "no stale deadline after drag");
    }
}
