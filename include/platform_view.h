#ifndef OPUROM_PLATFORM_VIEW_H
#define OPUROM_PLATFORM_VIEW_H

/*
 * OPUROM PlatformView bridge contract, mobile slice.
 *
 * The byte-level handle frame is shared with opurom-platform/src/platform_view.rs:
 * four `OPV1` magic bytes followed by a little-endian 32-bit view handle. The
 * opcodes mirror opurom-platform/src/wayland_wire.rs, including the keyboard
 * focus event. Android JNI and iOS Swift callers use these inline functions, so
 * no native entry point is added and the encoding stays byte-identical.
 */

#include <stdint.h>
#include <stddef.h>

#define OPU_PLATFORM_VIEW_OK 0
#define OPU_PLATFORM_VIEW_ERR -1

#define OPU_PLATFORM_VIEW_HANDLE_MAGIC_0 0x4f
#define OPU_PLATFORM_VIEW_HANDLE_MAGIC_1 0x50
#define OPU_PLATFORM_VIEW_HANDLE_MAGIC_2 0x56
#define OPU_PLATFORM_VIEW_HANDLE_MAGIC_3 0x31
#define OPU_PLATFORM_VIEW_HANDLE_LEN 8

#define OPU_PLATFORM_VIEW_LIFECYCLE_CREATED 0
#define OPU_PLATFORM_VIEW_LIFECYCLE_ATTACHED 1
#define OPU_PLATFORM_VIEW_LIFECYCLE_RESIZED 2
#define OPU_PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED 3
#define OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED 4

#define OPU_PLATFORM_VIEW_EVENT_PRESS 1
#define OPU_PLATFORM_VIEW_EVENT_RELEASE 2
#define OPU_PLATFORM_VIEW_EVENT_MOVE 3
#define OPU_PLATFORM_VIEW_EVENT_FOCUS 4

#define OPU_PLATFORM_VIEW_SELF_DRAWN_Z 0

#ifdef __cplusplus
extern "C" {
#endif

/* Encodes the shared OPV1 little-endian frame into out; returns OPU_PLATFORM_VIEW_OK. */
static inline int opu_platform_view_encode_handle(uint32_t handle, uint8_t *out) {
    if (out == NULL) {
        return OPU_PLATFORM_VIEW_ERR;
    }
    out[0] = (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_0;
    out[1] = (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_1;
    out[2] = (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_2;
    out[3] = (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_3;
    out[4] = (uint8_t)(handle & 0xffu);
    out[5] = (uint8_t)((handle >> 8) & 0xffu);
    out[6] = (uint8_t)((handle >> 16) & 0xffu);
    out[7] = (uint8_t)((handle >> 24) & 0xffu);
    return OPU_PLATFORM_VIEW_OK;
}

/* Decodes the shared OPV1 little-endian frame; returns OPU_PLATFORM_VIEW_ERR on any error. */
static inline int opu_platform_view_decode_handle(const uint8_t *bytes, size_t len,
                                                  uint32_t *handle) {
    if (bytes == NULL || handle == NULL || len != (size_t)OPU_PLATFORM_VIEW_HANDLE_LEN) {
        return OPU_PLATFORM_VIEW_ERR;
    }
    if (bytes[0] != (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_0 ||
        bytes[1] != (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_1 ||
        bytes[2] != (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_2 ||
        bytes[3] != (uint8_t)OPU_PLATFORM_VIEW_HANDLE_MAGIC_3) {
        return OPU_PLATFORM_VIEW_ERR;
    }
    *handle = (uint32_t)bytes[4] | ((uint32_t)bytes[5] << 8) |
              ((uint32_t)bytes[6] << 16) | ((uint32_t)bytes[7] << 24);
    return OPU_PLATFORM_VIEW_OK;
}

/* Every logical-pixel component must be non-negative. */
static inline int opu_platform_view_bounds_valid(int32_t x, int32_t y, int32_t width,
                                                 int32_t height) {
    return x >= 0 && y >= 0 && width >= 0 && height >= 0;
}

/* The lifecycle advances one documented step at a time; returns 1 for a legal advance. */
static inline int opu_platform_view_lifecycle_advance(int from, int to) {
    if (from == OPU_PLATFORM_VIEW_LIFECYCLE_CREATED) {
        return to == OPU_PLATFORM_VIEW_LIFECYCLE_ATTACHED;
    }
    if (from == OPU_PLATFORM_VIEW_LIFECYCLE_ATTACHED) {
        return to == OPU_PLATFORM_VIEW_LIFECYCLE_RESIZED;
    }
    if (from == OPU_PLATFORM_VIEW_LIFECYCLE_RESIZED) {
        return to == OPU_PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED;
    }
    if (from == OPU_PLATFORM_VIEW_LIFECYCLE_INPUT_FORWARDED) {
        return to == OPU_PLATFORM_VIEW_LIFECYCLE_DISPOSED;
    }
    return 0;
}

#ifdef __cplusplus
}
#endif

#endif
