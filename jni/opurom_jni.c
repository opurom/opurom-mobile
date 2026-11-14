/*
 * JNI shim for the OPUROM mobile C ABI.
 *
 * The Rust crate exports the plain C ABI from include/opurom.h. This file implements the
 * Java_org_opurom_mobile_OpuromNative_* entry points declared in jni/opurom_jni.h and is
 * linked together with the Rust static library into the Android shared objects
 * libopurom_mobile.so (arm64-v8a and x86_64).
 *
 * Ownership matches include/opurom.h and jni/OpuromNative.java: opuStateNew returns one
 * caller-owned state kept as an opaque jlong; opuStateFree releases it exactly once; a zero
 * handle is a no-op for free. The frame bytes are copied into the Java byte[] during the
 * native call, so no pointer into Rust memory outlives that call.
 */

#include "opurom_jni.h"

#include "opurom.h"
#include "platform_view.h"

JNIEXPORT jlong JNICALL Java_org_opurom_mobile_OpuromNative_opuStateNew(JNIEnv *env,
                                                                         jclass clazz) {
    (void)env;
    (void)clazz;
    return (jlong)(intptr_t)opu_state_new();
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuDispatch(JNIEnv *env,
                                                                       jclass clazz,
                                                                       jlong state,
                                                                       jint eventId) {
    (void)env;
    (void)clazz;
    return (jint)opu_dispatch((OpuState *)(intptr_t)state, (uint32_t)eventId);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrame(JNIEnv *env,
                                                                     jclass clazz,
                                                                     jlong state,
                                                                     jbyteArray out,
                                                                     jint width,
                                                                     jint height) {
    jbyte *bytes;
    jsize capacity;
    int32_t status;

    (void)clazz;
    if (out == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    if (width <= 0 || height <= 0) {
        return (jint)OPU_ERR_DIMENSION;
    }
    capacity = (*env)->GetArrayLength(env, out);
    if ((int64_t)width * (int64_t)height * 4 > (int64_t)capacity) {
        return (jint)OPU_ERR_DIMENSION;
    }
    bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (bytes == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    status = opu_frame((OpuState *)(intptr_t)state, (uint8_t *)bytes, (uint32_t)width,
                       (uint32_t)height);
    /* Mode 0 copies the written pixels back into the Java array before releasing it. */
    (*env)->ReleaseByteArrayElements(env, out, bytes, 0);
    return (jint)status;
}

JNIEXPORT void JNICALL Java_org_opurom_mobile_OpuromNative_opuStateFree(JNIEnv *env,
                                                                         jclass clazz,
                                                                         jlong state) {
    (void)env;
    (void)clazz;
    opu_state_free((OpuState *)(intptr_t)state);
}

/*
 * Pins three caller-owned arrays for the duration of one native call. Inputs are
 * released with JNI_ABORT (read-only); the output is copied back with mode 0.
 * Every early return releases whatever it pinned, so no pointer survives the call.
 */
static jint render_ir_arrays(JNIEnv *env, jbyteArray ir, jbyteArray state, jbyteArray out,
                             jint width, jint height, OpuRenderer *renderer) {
    jbyte *ir_bytes;
    jbyte *state_bytes;
    jbyte *out_bytes;
    jsize capacity;
    jsize ir_len;
    jsize state_len;
    int32_t status;

    if (ir == NULL || state == NULL || out == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    if (width <= 0 || height <= 0) {
        return (jint)OPU_ERR_DIMENSION;
    }
    capacity = (*env)->GetArrayLength(env, out);
    if ((int64_t)width * (int64_t)height * 4 > (int64_t)capacity) {
        return (jint)OPU_ERR_DIMENSION;
    }
    ir_len = (*env)->GetArrayLength(env, ir);
    state_len = (*env)->GetArrayLength(env, state);

    ir_bytes = (*env)->GetByteArrayElements(env, ir, NULL);
    if (ir_bytes == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    state_bytes = (*env)->GetByteArrayElements(env, state, NULL);
    if (state_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return (jint)OPU_ERR_NULL;
    }
    out_bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (out_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return (jint)OPU_ERR_NULL;
    }

    if (renderer != NULL) {
        status = opu_renderer_frame(renderer, (const uint8_t *)ir_bytes, (size_t)ir_len,
                                    (const uint8_t *)state_bytes, (size_t)state_len,
                                    (uint8_t *)out_bytes, (uint32_t)width, (uint32_t)height);
    } else {
        status = opu_frame_from_ir((const uint8_t *)ir_bytes, (size_t)ir_len,
                                   (const uint8_t *)state_bytes, (size_t)state_len,
                                   (uint8_t *)out_bytes, (uint32_t)width, (uint32_t)height);
    }

    (*env)->ReleaseByteArrayElements(env, out, out_bytes, 0);
    (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return (jint)status;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrameFromIr(JNIEnv *env,
                                                                           jclass clazz,
                                                                           jbyteArray ir,
                                                                           jbyteArray state,
                                                                           jbyteArray out,
                                                                           jint width,
                                                                           jint height) {
    (void)clazz;
    return render_ir_arrays(env, ir, state, out, width, height, NULL);
}

/*
 * Pins ir, state, optional route and out for one route-aware frame. Inputs are
 * released with JNI_ABORT; out is copied back with mode 0. A null route array
 * means "use the IR initial route", so the pointers passed are NULL/0.
 */
static jint render_ir_route_arrays(JNIEnv *env, jbyteArray ir, jbyteArray state, jbyteArray route,
                                   jbyteArray out, jint width, jint height,
                                   OpuRenderer *renderer) {
    jbyte *ir_bytes = NULL;
    jbyte *state_bytes = NULL;
    jbyte *route_bytes = NULL;
    jbyte *out_bytes = NULL;
    jsize capacity;
    jsize ir_len;
    jsize state_len;
    jsize route_len = 0;
    const uint8_t *route_ptr = NULL;
    int32_t status;

    if (ir == NULL || state == NULL || out == NULL || width <= 0 || height <= 0) {
        return (jint)OPU_ERR_NULL;
    }
    capacity = (*env)->GetArrayLength(env, out);
    if ((int64_t)width * (int64_t)height * 4 > (int64_t)capacity) {
        return (jint)OPU_ERR_DIMENSION;
    }
    ir_len = (*env)->GetArrayLength(env, ir);
    state_len = (*env)->GetArrayLength(env, state);

    ir_bytes = (*env)->GetByteArrayElements(env, ir, NULL);
    if (ir_bytes == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    state_bytes = (*env)->GetByteArrayElements(env, state, NULL);
    if (state_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return (jint)OPU_ERR_NULL;
    }
    if (route != NULL) {
        route_len = (*env)->GetArrayLength(env, route);
        if (route_len > 0) {
            route_bytes = (*env)->GetByteArrayElements(env, route, NULL);
            if (route_bytes == NULL) {
                (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
                (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
                return (jint)OPU_ERR_NULL;
            }
            route_ptr = (const uint8_t *)route_bytes;
        }
    }
    out_bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (out_bytes == NULL) {
        if (route_bytes != NULL) {
            (*env)->ReleaseByteArrayElements(env, route, route_bytes, JNI_ABORT);
        }
        (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return (jint)OPU_ERR_NULL;
    }

    if (renderer != NULL) {
        status = opu_renderer_frame_route(renderer, (const uint8_t *)ir_bytes, (size_t)ir_len,
                                          (const uint8_t *)state_bytes, (size_t)state_len,
                                          route_ptr, (size_t)route_len, (uint8_t *)out_bytes,
                                          (uint32_t)width, (uint32_t)height);
    } else {
        status = opu_frame_from_ir_route((const uint8_t *)ir_bytes, (size_t)ir_len,
                                         (const uint8_t *)state_bytes, (size_t)state_len,
                                         route_ptr, (size_t)route_len, (uint8_t *)out_bytes,
                                         (uint32_t)width, (uint32_t)height);
    }

    (*env)->ReleaseByteArrayElements(env, out, out_bytes, 0);
    if (route_bytes != NULL) {
        (*env)->ReleaseByteArrayElements(env, route, route_bytes, JNI_ABORT);
    }
    (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return (jint)status;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrameFromIrRoute(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jbyteArray route, jbyteArray out,
    jint width, jint height) {
    (void)clazz;
    return render_ir_route_arrays(env, ir, state, route, out, width, height, NULL);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFrameRoute(
    JNIEnv *env, jclass clazz, jlong renderer, jbyteArray ir, jbyteArray state, jbyteArray route,
    jbyteArray out, jint width, jint height) {
    (void)clazz;
    if (renderer == 0) {
        return (jint)OPU_ERR_NULL;
    }
    return render_ir_route_arrays(env, ir, state, route, out, width, height,
                                  (OpuRenderer *)(intptr_t)renderer);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuIrInitialRoute(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray out) {
    jbyte *ir_bytes;
    jbyte *out_bytes;
    jsize ir_len;
    jsize capacity;
    size_t written;

    (void)clazz;
    if (ir == NULL || out == NULL) {
        return 0;
    }
    ir_len = (*env)->GetArrayLength(env, ir);
    capacity = (*env)->GetArrayLength(env, out);
    ir_bytes = (*env)->GetByteArrayElements(env, ir, NULL);
    if (ir_bytes == NULL) {
        return 0;
    }
    out_bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (out_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return 0;
    }
    written = opu_ir_initial_route((const uint8_t *)ir_bytes, (size_t)ir_len,
                                   (uint8_t *)out_bytes, (size_t)capacity);
    /* Mode 0 copies back; on 0 the array stays zeroed (Java allocates zeros). */
    (*env)->ReleaseByteArrayElements(env, out, out_bytes, written > 0 ? 0 : JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return (jint)written;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuIrRouteAt(
    JNIEnv *env, jclass clazz, jbyteArray ir, jint index, jbyteArray out) {
    jbyte *ir_bytes;
    jbyte *out_bytes;
    jsize ir_len;
    jsize capacity;
    size_t written;

    (void)clazz;
    if (ir == NULL || out == NULL || index < 0) {
        return 0;
    }
    ir_len = (*env)->GetArrayLength(env, ir);
    capacity = (*env)->GetArrayLength(env, out);
    ir_bytes = (*env)->GetByteArrayElements(env, ir, NULL);
    if (ir_bytes == NULL) {
        return 0;
    }
    out_bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (out_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return 0;
    }
    written = opu_ir_route_at((const uint8_t *)ir_bytes, (size_t)ir_len, (uint32_t)index,
                              (uint8_t *)out_bytes, (size_t)capacity);
    (*env)->ReleaseByteArrayElements(env, out, out_bytes, written > 0 ? 0 : JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return (jint)written;
}

JNIEXPORT jlong JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererNew(JNIEnv *env,
                                                                            jclass clazz,
                                                                            jint width,
                                                                            jint height) {
    (void)env;
    (void)clazz;
    if (width <= 0 || height <= 0) {
        return (jlong)0;
    }
    return (jlong)(intptr_t)opu_renderer_new((uint32_t)width, (uint32_t)height);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFrame(JNIEnv *env,
                                                                             jclass clazz,
                                                                             jlong renderer,
                                                                             jbyteArray ir,
                                                                             jbyteArray state,
                                                                             jbyteArray out,
                                                                             jint width,
                                                                             jint height) {
    (void)clazz;
    if (renderer == 0) {
        return (jint)OPU_ERR_NULL;
    }
    return render_ir_arrays(env, ir, state, out, width, height,
                            (OpuRenderer *)(intptr_t)renderer);
}

JNIEXPORT void JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFree(JNIEnv *env,
                                                                            jclass clazz,
                                                                            jlong renderer) {
    (void)env;
    (void)clazz;
    opu_renderer_free((OpuRenderer *)(intptr_t)renderer);
}
