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
    for bad_state in ["", "{", "[]", r#"{"missing":1}"#, r#"{"remaining":"x"}"#] {
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
