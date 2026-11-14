//! The additive IR C ABI must produce the real renderer's pixels, reject bad
//! input with status values and allow one renderer to serve successive frames.
//! The shipped Todo IR is compiled from the example source by `verify.mjs`.

use opurom_mobile::*;
use opurom_render::{digest_hex, parse_ir, parse_state_json, Renderer, SETTLED_MS};
use std::ptr;
use std::time::Instant;

const TODO_IR: &str = include_str!("../android/app/src/main/assets/todo.opuir.json");
const WIDTH: u32 = 320;
const HEIGHT: u32 = 240;
// The Todo label is wider than 320px at size 20, so state only changes pixels
// once the viewport is wide enough to show the interpolated counter.
const STATE_WIDTH: u32 = 800;
const STATE_HEIGHT: u32 = 600;

fn render(ir: &str, state: &str, width: u32, height: u32) -> (i32, Vec<u8>) {
    let mut out = vec![0u8; width as usize * height as usize * 4];
    let status = opu_frame_from_ir(
        ir.as_ptr(),
        ir.len(),
        state.as_ptr(),
        state.len(),
        out.as_mut_ptr(),
        width,
        height,
    );
    (status, out)
}

fn reference(ir: &str, state: &str, width: u32, height: u32) -> Vec<u8> {
    let parsed = parse_ir(ir).expect("fixture is valid IR");
    let view = parse_state_json(&parsed, state).expect("fixture state is valid");
    Renderer::new(width, height).pixels_at(&parsed, &view, SETTLED_MS)
}

struct OwnedRenderer(*mut OpuRenderer);

impl OwnedRenderer {
    fn new(width: u32, height: u32) -> Self {
        let handle = opu_renderer_new(width, height);
        assert!(!handle.is_null());
        Self(handle)
    }

    fn frame(&self, ir: &str, state: &str, out: &mut [u8], width: u32, height: u32) -> i32 {
        opu_renderer_frame(
            self.0,
            ir.as_ptr(),
            ir.len(),
            state.as_ptr(),
            state.len(),
            out.as_mut_ptr(),
            width,
            height,
        )
    }
}

impl Drop for OwnedRenderer {
    fn drop(&mut self) {
        opu_renderer_free(self.0);
    }
}

#[test]
fn frame_from_ir_is_the_real_renderer_output() {
    let (status, pixels) = render(TODO_IR, "{}", WIDTH, HEIGHT);
    assert_eq!(status, OPU_OK);
    assert_eq!(
        digest_hex(&pixels),
        digest_hex(&reference(TODO_IR, "{}", WIDTH, HEIGHT))
    );
    let distinct: std::collections::BTreeSet<[u8; 4]> = pixels
        .chunks_exact(4)
        .map(|p| [p[0], p[1], p[2], p[3]])
        .collect();
    assert!(distinct.len() > 4, "expected real UI, got a flat frame");
    assert_eq!(
        digest_hex(&pixels),
        digest_hex(&reference(TODO_IR, "{}", WIDTH, HEIGHT))
    );
}

#[test]
fn state_overrides_change_the_real_frame() {
    let (base_status, base) = render(TODO_IR, "{}", STATE_WIDTH, STATE_HEIGHT);
    let (seven_status, seven) = render(TODO_IR, r#"{"remaining":7}"#, STATE_WIDTH, STATE_HEIGHT);
    assert_eq!(base_status, OPU_OK);
    assert_eq!(seven_status, OPU_OK);
    assert_eq!(
        digest_hex(&seven),
        digest_hex(&reference(
            TODO_IR,
            r#"{"remaining":7}"#,
            STATE_WIDTH,
            STATE_HEIGHT
        ))
    );
    assert_ne!(base, seven);
}

#[test]
fn malformed_ir_and_state_return_status_values() {
    for bad_ir in [
        "",
        "{",
        "not json",
        r#"{"ir":"9.9"}"#,
        r#"{"ir":"0.1","app":"X","state":[],"tree":{},"theme":{}}"#,
    ] {
        let (status, out) = render(bad_ir, "{}", 8, 8);
        assert_eq!(status, OPU_ERR_IR, "IR {bad_ir:?}");
        assert_eq!(out, vec![0u8; 8 * 8 * 4], "no bytes written on error");
    }
    // A name the IR no longer declares is ignored (fault isolation): the frame
    // renders from the IR defaults instead of failing the call.
    let (status, _) = render(TODO_IR, r#"{"missing":1}"#, 8, 8);
    assert_eq!(status, OPU_OK, "undeclared override names are ignored");
    for bad_state in ["", "{", "[]", r#"{"remaining":"x"}"#] {
        let (status, _) = render(TODO_IR, bad_state, 8, 8);
        assert_eq!(status, OPU_ERR_STATE, "state {bad_state:?}");
    }
    let invalid_utf8 = [0xffu8, 0xfe, 0xfd];
    let mut out = vec![0u8; 8 * 8 * 4];
    assert_eq!(
        opu_frame_from_ir(
            invalid_utf8.as_ptr(),
            invalid_utf8.len(),
            b"{}".as_ptr(),
            2,
            out.as_mut_ptr(),
            8,
            8,
        ),
        OPU_ERR_IR
    );
}

#[test]
fn null_pointers_and_dimensions_are_rejected_before_writing() {
    let mut out = vec![7u8; 8 * 8 * 4];
    assert_eq!(
        opu_frame_from_ir(ptr::null(), 0, b"{}".as_ptr(), 2, out.as_mut_ptr(), 8, 8,),
        OPU_ERR_NULL
    );
    assert_eq!(
        opu_frame_from_ir(
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            ptr::null(),
            0,
            out.as_mut_ptr(),
            8,
            8
        ),
        OPU_ERR_NULL
    );
    assert_eq!(
        opu_frame_from_ir(
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            b"{}".as_ptr(),
            2,
            ptr::null_mut(),
            8,
            8
        ),
        OPU_ERR_NULL
    );
    assert_eq!(
        opu_frame_from_ir(
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            b"{}".as_ptr(),
            2,
            out.as_mut_ptr(),
            0,
            8,
        ),
        OPU_ERR_DIMENSION
    );
    assert_eq!(
        opu_frame_from_ir(
            TODO_IR.as_ptr(),
            usize::MAX,
            b"{}".as_ptr(),
            2,
            out.as_mut_ptr(),
            8,
            8,
        ),
        OPU_ERR_IR
    );
    assert_eq!(out, vec![7u8; 8 * 8 * 4]);
    assert!(opu_renderer_new(0, 8).is_null());
    assert!(opu_renderer_new(u32::MAX, u32::MAX).is_null());
    opu_renderer_free(ptr::null_mut());
}

#[test]
fn one_renderer_serves_successive_frames() {
    let renderer = OwnedRenderer::new(STATE_WIDTH, STATE_HEIGHT);
    let mut first = vec![0u8; STATE_WIDTH as usize * STATE_HEIGHT as usize * 4];
    let mut second = vec![0u8; STATE_WIDTH as usize * STATE_HEIGHT as usize * 4];
    assert_eq!(
        renderer.frame(TODO_IR, "{}", &mut first, STATE_WIDTH, STATE_HEIGHT),
        OPU_OK
    );
    assert_eq!(
        renderer.frame(
            TODO_IR,
            r#"{"remaining":7}"#,
            &mut second,
            STATE_WIDTH,
            STATE_HEIGHT
        ),
        OPU_OK
    );
    assert_eq!(
        digest_hex(&first),
        digest_hex(&reference(TODO_IR, "{}", STATE_WIDTH, STATE_HEIGHT))
    );
    assert_eq!(
        digest_hex(&second),
        digest_hex(&reference(
            TODO_IR,
            r#"{"remaining":7}"#,
            STATE_WIDTH,
            STATE_HEIGHT
        ))
    );
    assert_ne!(first, second);
    assert_eq!(
        renderer.frame(TODO_IR, "{}", &mut second, STATE_WIDTH, STATE_HEIGHT + 1),
        OPU_ERR_DIMENSION
    );
    assert_eq!(
        opu_renderer_frame(
            ptr::null_mut(),
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            b"{}".as_ptr(),
            2,
            first.as_mut_ptr(),
            WIDTH,
            HEIGHT,
        ),
        OPU_ERR_NULL
    );
}

#[test]
fn a_persistent_renderer_redraws_only_the_dirty_region_incrementally() {
    // A persistent renderer reuses the previous frame, so after the first full
    // raster a localized state change must recompute only the dirty region while
    // producing byte-identical pixels to the full reference.
    let handle = opu_renderer_new(STATE_WIDTH, STATE_HEIGHT);
    assert!(!handle.is_null());
    let mut first = vec![0u8; STATE_WIDTH as usize * STATE_HEIGHT as usize * 4];
    let mut changed = vec![0u8; STATE_WIDTH as usize * STATE_HEIGHT as usize * 4];
    let mut repeat = vec![0u8; STATE_WIDTH as usize * STATE_HEIGHT as usize * 4];

    let mut nodes = 0usize;
    let mut pixels = 0u64;
    assert_eq!(
        opu_renderer_frame(
            handle,
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            b"{}".as_ptr(),
            2,
            first.as_mut_ptr(),
            STATE_WIDTH,
            STATE_HEIGHT
        ),
        OPU_OK
    );
    // First frame is a full raster (no previous buffer to reuse).
    assert_eq!(
        opu_renderer_redraw_stats(handle, &mut nodes, &mut pixels),
        OPU_OK
    );
    assert_eq!(
        pixels,
        (STATE_WIDTH * STATE_HEIGHT) as u64,
        "first frame must full-raster"
    );

    assert_eq!(
        opu_renderer_frame(
            handle,
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            b"{\"remaining\":7}".as_ptr(),
            15,
            changed.as_mut_ptr(),
            STATE_WIDTH,
            STATE_HEIGHT
        ),
        OPU_OK
    );
    assert_eq!(
        opu_renderer_redraw_stats(handle, &mut nodes, &mut pixels),
        OPU_OK
    );
    assert_ne!(pixels, 0, "a changed frame must redraw something");
    assert!(
        pixels < (STATE_WIDTH * STATE_HEIGHT) as u64,
        "incremental path must redraw fewer than the full frame ({pixels})"
    );
    assert_eq!(
        digest_hex(&changed),
        digest_hex(&reference(
            TODO_IR,
            r#"{"remaining":7}"#,
            STATE_WIDTH,
            STATE_HEIGHT
        )),
        "incremental pixels must equal the full reference"
    );

    // An unchanged re-render redraws nothing yet still returns the same frame.
    assert_eq!(
        opu_renderer_frame(
            handle,
            TODO_IR.as_ptr(),
            TODO_IR.len(),
            b"{\"remaining\":7}".as_ptr(),
            15,
            repeat.as_mut_ptr(),
            STATE_WIDTH,
            STATE_HEIGHT
        ),
        OPU_OK
    );
    assert_eq!(
        opu_renderer_redraw_stats(handle, &mut nodes, &mut pixels),
        OPU_OK
    );
    assert_eq!(pixels, 0, "an unchanged re-render must redraw nothing");
    assert_eq!(digest_hex(&repeat), digest_hex(&changed));

    unsafe {
        drop(Box::from_raw(handle));
    }
}

#[test]
fn measured_per_frame_render_time_microseconds() {
    const FRAMES: usize = 24;
    let states = ["{}", r#"{"remaining":1}"#, r#"{"remaining":7}"#];
    let mut out = vec![0u8; WIDTH as usize * HEIGHT as usize * 4];
    // Warm up allocator and instruction caches before the measured window.
    let _ = render(TODO_IR, states[0], WIDTH, HEIGHT);
    let start = Instant::now();
    for index in 0..FRAMES {
        let state = states[index % states.len()];
        assert_eq!(
            opu_frame_from_ir(
                TODO_IR.as_ptr(),
                TODO_IR.len(),
                state.as_ptr(),
                state.len(),
                out.as_mut_ptr(),
                WIDTH,
                HEIGHT,
            ),
            OPU_OK
        );
    }
    let elapsed = start.elapsed();
    let micros = elapsed.as_micros();
    println!(
        "MEASURED {FRAMES} frames of compiled Todo IR at {WIDTH}x{HEIGHT}: {micros} us total, \
         {} us per frame (includes IR + state JSON parsing, layout and RGBA8 raster)",
        micros / FRAMES as u128
    );
    assert!(micros > 0, "Instant must report a positive duration");
}

// A two-page document: the same routes contract the compiler emits. Home is the
// initialRoute; Detail is a distinct tree so its frame differs in pixels.
const TWO_ROUTE_IR: &str = r##"{
  "ir": "0.1", "app": "Routes",
  "state": [{"name": "count", "type": "int", "init": 0}],
  "initialRoute": "Home",
  "routes": {
    "Home": {"tree": {"id": 0, "kind": "Column", "props": {"gap": 12, "padding": 16},
      "children": [
        {"id": 1, "kind": "Text", "props": {"value": "Home", "size": 28}, "children": [], "events": {}},
        {"id": 2, "kind": "Text", "props": {"value": "count {count}", "size": 16}, "children": [], "events": {}}
      ], "events": {}}, "title": "Home"},
    "Detail": {"tree": {"id": 0, "kind": "Column", "props": {"gap": 12, "padding": 16},
      "children": [
        {"id": 1, "kind": "Text", "props": {"value": "Detail page", "size": 28}, "children": [], "events": {}},
        {"id": 2, "kind": "Button", "props": {"label": "Open item", "variant": "primary"}, "children": [], "events": {}}
      ], "events": {}}, "title": "Detail"}
  },
  "theme": {"mode": "light", "accent": "#097FEB", "radius": 8}
}"##;

fn render_route(
    ir: &str,
    state: &str,
    route: Option<&str>,
    width: u32,
    height: u32,
) -> (i32, Vec<u8>) {
    let mut out = vec![0u8; width as usize * height as usize * 4];
    let (route_ptr, route_len) = match route {
        Some(name) => (name.as_ptr(), name.len()),
        None => (ptr::null(), 0),
    };
    let status = opu_frame_from_ir_route(
        ir.as_ptr(),
        ir.len(),
        state.as_ptr(),
        state.len(),
        route_ptr,
        route_len,
        out.as_mut_ptr(),
        width,
        height,
    );
    (status, out)
}

fn route_reference(ir: &str, state: &str, route: &str, width: u32, height: u32) -> Vec<u8> {
    let parsed = parse_ir(ir).expect("fixture is valid IR");
    let view = parse_state_json(&parsed, state).expect("fixture state is valid");
    let route_ir = parsed.with_route(route).expect("route is declared");
    Renderer::new(width, height).pixels_at(&route_ir, &view, SETTLED_MS)
}

#[test]
fn initial_route_renders_home_first() {
    // A null route selects the IR initialRoute, which is Home.
    let (status, home) = render_route(TWO_ROUTE_IR, "{}", None, WIDTH, HEIGHT);
    assert_eq!(status, OPU_OK);
    assert_eq!(
        digest_hex(&home),
        digest_hex(&route_reference(TWO_ROUTE_IR, "{}", "Home", WIDTH, HEIGHT))
    );
    // The initialRoute query returns "Home".
    let mut buf = [0u8; 32];
    let n = opu_ir_initial_route(
        TWO_ROUTE_IR.as_ptr(),
        TWO_ROUTE_IR.len(),
        buf.as_mut_ptr(),
        buf.len(),
    );
    assert_eq!(&buf[..n], b"Home");
}

#[test]
fn push_renders_detail_and_pop_returns_home() {
    // Render the Home page (a push from the root leaves Home as the frame).
    let (home_status, home) = render_route(TWO_ROUTE_IR, "{}", Some("Home"), WIDTH, HEIGHT);
    assert_eq!(home_status, OPU_OK);

    // Push Detail: the frame is Detail's own tree and differs from Home.
    let (detail_status, detail) = render_route(TWO_ROUTE_IR, "{}", Some("Detail"), WIDTH, HEIGHT);
    assert_eq!(detail_status, OPU_OK);
    assert_eq!(
        digest_hex(&detail),
        digest_hex(&route_reference(
            TWO_ROUTE_IR,
            "{}",
            "Detail",
            WIDTH,
            HEIGHT
        ))
    );
    assert_ne!(home, detail, "Detail frame must differ from Home");

    // Pop back to Home: the frame equals the first Home frame byte-for-byte.
    let (popped_status, popped) = render_route(TWO_ROUTE_IR, "{}", Some("Home"), WIDTH, HEIGHT);
    assert_eq!(popped_status, OPU_OK);
    assert_eq!(home, popped, "pop must reproduce the initial Home frame");

    // An undeclared route is a status value, never a panic.
    let (bad_status, _) = render_route(TWO_ROUTE_IR, "{}", Some("Nope"), WIDTH, HEIGHT);
    assert_eq!(bad_status, OPU_ERR_IR);
}

#[test]
fn single_page_ir_ignores_route_and_matches_legacy() {
    // A single-page IR carries no routes: a route name is ignored and the frame
    // stays byte-identical to the legacy one-shot render.
    let (legacy_status, legacy) = render(TODO_IR, "{}", WIDTH, HEIGHT);
    assert_eq!(legacy_status, OPU_OK);
    let (route_status, routed) = render_route(TODO_IR, "{}", Some("Detail"), WIDTH, HEIGHT);
    assert_eq!(route_status, OPU_OK);
    assert_eq!(legacy, routed, "single-page IR must ignore the route name");
    let mut buf = [0u8; 32];
    assert_eq!(
        opu_ir_initial_route(TODO_IR.as_ptr(), TODO_IR.len(), buf.as_mut_ptr(), buf.len()),
        0,
        "single-page IR has no initialRoute"
    );
}

#[test]
fn reusable_renderer_serves_route_frames() {
    let handle = opu_renderer_new(WIDTH, HEIGHT);
    assert!(!handle.is_null());
    let mut home = vec![0u8; WIDTH as usize * HEIGHT as usize * 4];
    let mut detail = vec![0u8; WIDTH as usize * HEIGHT as usize * 4];
    let route = |name: &str, out: &mut [u8]| {
        opu_renderer_frame_route(
            handle,
            TWO_ROUTE_IR.as_ptr(),
            TWO_ROUTE_IR.len(),
            b"{}".as_ptr(),
            2,
            name.as_ptr(),
            name.len(),
            out.as_mut_ptr(),
            WIDTH,
            HEIGHT,
        )
    };
    assert_eq!(route("Home", &mut home), OPU_OK);
    assert_eq!(route("Detail", &mut detail), OPU_OK);
    assert_eq!(
        digest_hex(&home),
        digest_hex(&route_reference(TWO_ROUTE_IR, "{}", "Home", WIDTH, HEIGHT))
    );
    assert_ne!(home, detail);
    // Enumerate the declared routes through the ABI (sorted: Detail, Home).
    let mut buf = [0u8; 32];
    let n = opu_ir_route_at(
        TWO_ROUTE_IR.as_ptr(),
        TWO_ROUTE_IR.len(),
        0,
        buf.as_mut_ptr(),
        buf.len(),
    );
    assert_eq!(&buf[..n], b"Detail");
    opu_renderer_free(handle);
}
