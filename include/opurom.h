#ifndef OPUROM_H
#define OPUROM_H

#include <stdint.h>
#include <stddef.h>

/*
 * OPUROM Platform Adapter ABI v0.1, mobile slice.
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
 * The additive IR path parses an IR v0.1 document plus a JSON object of state overrides, then
 * renders real OPUROM UI with the shared software renderer. ir_json/state_json are borrowed for
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
 * Parses ir_json (OPUIR v0.1) and state_json (an object of named overrides), renders one settled
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

#ifdef __cplusplus
}
#endif

#endif
