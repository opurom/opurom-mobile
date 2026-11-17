#ifndef Opurom_H
#define Opurom_H

#include <stdint.h>
#include <stddef.h>

/*
 * Opurom Platform Adapter ABI 0.1.0, mobile slice.
 *
 * Ownership: opu_state_new returns one caller-owned opaque state whose integer counter starts at
 * zero. Pass it to opu_state_free exactly once. A null state pointer is rejected by the
 * status-returning functions and is a no-op for opu_state_free. A non-null pointer that was not
 * returned by opu_state_new, was already freed, or is used concurrently without serialization is
 * invalid and cannot be validated by Rust.
 *
 * Lifetime: the state pointer is valid until opu_state_free. opu_frame borrows it only for the
 * call. out is caller-owned, must remain writable for width * height * 4 bytes, and must not
 * overlap the state. Panics inside Rust are caught and returned as OPU_ERR_PANIC; an abort or an
 * invalid pointer remains undefined behavior.
 *
 * Errors are values; no Rust panic crosses the C boundary. Errors leave the state unchanged.
 * Frame output is row-major RGBA8 with alpha 255, derived deterministically from the counter and
 * pixel coordinates.
 *
 * The additive IR path parses an IR 0.1.0 document plus a JSON object of state overrides, then
 * renders real Opurom UI with the shared software renderer. ir_json/state_json are borrowed for
 * the call only and need not be NUL-terminated; out is caller-owned and must hold at least
 * width * height * 4 writable bytes. A reusable renderer can be shared by successive frames of
 * the same viewport; a one-shot opu_frame_from_ir creates and drops one internally.
 */

#define OPU_OK 0
#define OPU_ERR_NULL 1
#define OPU_ERR_EVENT 2
#define OPU_ERR_DIMENSION 3
#define OPU_ERR_OVERFLOW 4
#define OPU_ERR_PANIC 5
#define OPU_ERR_IR 6
#define OPU_ERR_STATE 7
#define OPU_ERR_TIME 8

typedef enum {
    OPU_POINTER_DOWN = 1, OPU_POINTER_MOVE = 2,
    OPU_POINTER_UP = 3, OPU_POINTER_CANCEL = 4
} OpuPointerKind;

typedef struct {
    uint32_t kind;        /* OpuPointerKind */
    uint32_t pointer_id;  /* host pointer identity, kept verbatim */
    uint32_t node_id;     /* opu_hit_test result; 0 means miss */
    int64_t  time_ms;     /* caller-owned logical time, never a wall clock */
    int64_t  local_x, local_y;
    int64_t  global_x, global_y;
} OpuPointerEvent;

typedef enum {
    OPU_GESTURE_NONE = 0, OPU_GESTURE_TAP = 1,
    OPU_GESTURE_DOUBLE_TAP = 2, OPU_GESTURE_LONG_PRESS = 3,
    OPU_GESTURE_DRAG = 4
} OpuGestureCode;

typedef struct {
    uint32_t code;        /* OpuGestureCode, 0 = none */
    uint32_t node_id;
    int32_t  dx, dy;      /* drag delta only */
} OpuGesture;

#define OPU_EVENT_TAP 1
#define OPU_EVENT_RESET 2

#define OPU_MAX_DIMENSION 4096
#define OPU_MAX_FRAME_BYTES 67108864
#define OPU_MAX_JSON_BYTES 16777216

#ifdef __cplusplus
extern "C" {
#endif

typedef struct OpuState OpuState;

/* Returns NULL on allocation failure or a caught Rust panic. */
OpuState *opu_state_new(void);

/* Event 1 is a checked +1 tap; event 2 resets the counter to zero. */
int32_t opu_dispatch(OpuState *state, uint32_t event_id);

/* Writes width * height * 4 RGBA8 bytes; validates null pointers and dimensions before writing. */
int32_t opu_frame(OpuState *state, uint8_t *out, uint32_t width, uint32_t height);

/* Releases one state; the pointer is invalid afterward. NULL is a no-op. */
void opu_state_free(OpuState *state);

typedef struct OpuRenderer OpuRenderer;

/* Creates one renderer for a viewport; NULL on invalid dimensions or failure. */
OpuRenderer *opu_renderer_new(uint32_t width, uint32_t height);

/* Releases one renderer from opu_renderer_new; NULL is a no-op. */
void opu_renderer_free(OpuRenderer *renderer);

/*
 * Parses ir_json (OPUIR 0.1.0) and state_json (an object of named overrides), renders one settled
 * frame with the real renderer and writes width * height * 4 RGBA8 bytes into out. state_json may
 * be "{}" to use the IR initial values. Returns OPU_OK, OPU_ERR_NULL (any null pointer),
 * OPU_ERR_DIMENSION (invalid viewport), OPU_ERR_IR (malformed IR), OPU_ERR_STATE (malformed
 * state) or OPU_ERR_PANIC (caught Rust panic). Malformed input never panics or aborts.
 */
int32_t opu_frame_from_ir(const uint8_t *ir_json, size_t ir_len,
                          const uint8_t *state_json, size_t state_len,
                          uint8_t *out, uint32_t width, uint32_t height);

/*
 * Same as opu_frame_from_ir but reuses a renderer. width/height must equal the viewport passed
 * to opu_renderer_new, and a null renderer returns OPU_ERR_NULL.
 */
int32_t opu_renderer_frame(OpuRenderer *renderer,
                           const uint8_t *ir_json, size_t ir_len,
                           const uint8_t *state_json, size_t state_len,
                           uint8_t *out, uint32_t width, uint32_t height);

/*
 * Multi-page variant of opu_frame_from_ir. When ir_json has a top-level "routes" map, the frame
 * is the tree of route_name (a UTF-8, non-NUL-terminated page key). route_name == NULL or
 * route_len == 0 selects the IR's "initialRoute"; an unknown route returns OPU_ERR_IR. A
 * single-page IR (top-level "tree", no "routes") renders exactly like opu_frame_from_ir and
 * ignores route_name. Error codes match opu_frame_from_ir.
 */
int32_t opu_frame_from_ir_route(const uint8_t *ir_json, size_t ir_len,
                                const uint8_t *state_json, size_t state_len,
                                const uint8_t *route, size_t route_len,
                                uint8_t *out, uint32_t width, uint32_t height);

/*
 * Same as opu_frame_from_ir_route but reuses a renderer; width/height must equal the viewport
 * passed to opu_renderer_new, and a null renderer returns OPU_ERR_NULL.
 */
int32_t opu_renderer_frame_route(OpuRenderer *renderer,
                                 const uint8_t *ir_json, size_t ir_len,
                                 const uint8_t *state_json, size_t state_len,
                                 const uint8_t *route, size_t route_len,
                                 uint8_t *out, uint32_t width, uint32_t height);

/*
 * Timed variant of opu_renderer_frame_route: renders at a caller-owned elapsed_ms
 * so a host frame pump can play animations. Same contract and error codes; the
 * clock is caller-supplied instead of settled. Negative elapsed_ms is clamped to 0.
 */
int32_t opu_renderer_frame_at(OpuRenderer *renderer,
                              const uint8_t *ir_json, size_t ir_len,
                              const uint8_t *state_json, size_t state_len,
                              const uint8_t *route, size_t route_len,
                              int64_t elapsed_ms,
                              uint8_t *out, uint32_t width, uint32_t height);

/*
 * Writes the IR's initial page key into out (UTF-8, not NUL-terminated) and returns the number of
 * bytes written, or 0 when the IR is single-page, has no initialRoute, or cannot be parsed.
 * out_capacity bounds the write; a key longer than the buffer returns 0.
 */
size_t opu_ir_initial_route(const uint8_t *ir_json, size_t ir_len,
                            uint8_t *out, size_t out_capacity);

/*
 * Writes the declared route name at `index` (sorted order) into out (UTF-8, not NUL-terminated)
 * and returns its length, or 0 when the IR has fewer routes or cannot be parsed. Lets a host
 * enumerate the page set without parsing JSON.
 */
size_t opu_ir_route_at(const uint8_t *ir_json, size_t ir_len, uint32_t index,
                       uint8_t *out, size_t out_capacity);

/*
 * Returns the top-most laid-out node containing (x, y) for the given viewport,
 * or 0 for a miss, malformed input or an out-of-range point. The viewport must
 * match the one used for the frame so one screen coordinate maps to one node.
 */
uint32_t opu_hit_test(const uint8_t *ir_json, size_t ir_len,
                      const uint8_t *state_json, size_t state_len,
                      int32_t x, int32_t y, uint32_t width, uint32_t height);

/*
 * Dispatches a tap on node_id through the state machine and writes the full
 * resulting state as a JSON object into out_json (bounded by out_capacity).
 * Returns OPU_OK on success, OPU_ERR_EVENT for a node without a binding, or
 * OPU_ERR_OVERFLOW when the JSON does not fit.
 */
int32_t opu_tap_node(const uint8_t *ir_json, size_t ir_len,
                     const uint8_t *state_json, size_t state_len,
                     uint32_t node_id, uint8_t *out_json, size_t out_capacity);

/* Negative status codes returned by opu_text_spans. */
#define OPU_SPAN_ERR_NULL (-1)
#define OPU_SPAN_ERR_IR (-2)
#define OPU_SPAN_ERR_STATE (-3)
#define OPU_SPAN_ERR_DIMENSION (-4)
#define OPU_SPAN_ERR_OVERFLOW (-5)
#define OPU_SPAN_ERR_PANIC (-6)

/*
 * Writes the deterministic text-span JSON for one IR/state/viewport into
 * out_json and returns the span count (>= 0), or one of the OPU_SPAN_ERR_*
 * codes. The span rects use the same logical pixels as the frame viewport.
 */
int32_t opu_text_spans(const uint8_t *ir_json, size_t ir_len,
                       const uint8_t *state_json, size_t state_len,
                       uint32_t width, uint32_t height,
                       uint8_t *out_json, size_t out_capacity);

/*
 * Route-aware text spans: emits the spans of `route`'s tree on a multi-page
 * program (NULL/empty route uses the initial route), so a host's system-font
 * text overlay matches the graphics frame of the active page.
 */
int32_t opu_text_spans_route(const uint8_t *ir_json, size_t ir_len,
                             const uint8_t *state_json, size_t state_len,
                             const uint8_t *route, size_t route_len,
                             uint32_t width, uint32_t height,
                             uint8_t *out_json, size_t out_capacity);

/*
 * Gesture arena host tick (ANIMATION_AND_PHYSICS.md section 8). The renderer
 * owns the arena; every time value is caller-owned logical time. A rewind or
 * a non-monotonic tick returns OPU_ERR_TIME. `out` may be NULL when the caller
 * does not want a gesture result. next_deadline_ms returns -1 for idle or a
 * null handle; i64::MAX is a legitimate saturating value, not a sentinel.
 */
int32_t opu_renderer_pointer(OpuRenderer *renderer, const OpuPointerEvent *event,
                             OpuGesture *out);
int64_t opu_renderer_next_deadline_ms(OpuRenderer *renderer);
int32_t opu_renderer_tick(OpuRenderer *renderer, int64_t t_ms, OpuGesture *out);

/* Opt-in graphics-only raster. Default frames keep their bitmap text. */
int32_t opu_renderer_set_suppress_text(OpuRenderer *renderer, int32_t on);

/*
 * Drives the caller-owned press phase. on=1 (DOWN, node_id!=0) opens a press:
 * press_start_tick is the caller clock at touch down, touch_x/y are absolute
 * canvas coordinates (either negative for the node centre). on=2 (CONFIRM)
 * keeps the press and stamps the same clock slot as its confirm tick, so the
 * renderer accelerates the radius and fades out; it never clears. on=0 (or
 * node_id=0) clears. Press frames use the renderer's press path; frames without
 * a press are byte-identical. Never enters the state JSON or the IR.
 */
int32_t opu_renderer_set_press(OpuRenderer *renderer, uint32_t node_id,
                               int64_t press_start_tick, int64_t touch_x, int64_t touch_y,
                               int32_t on);

int32_t opu_frame_from_ir_suppressed(const uint8_t *ir_json, size_t ir_len,
                                     const uint8_t *state_json, size_t state_len,
                                     uint8_t *out, uint32_t width, uint32_t height);

#ifdef __cplusplus
}
#endif

#endif
