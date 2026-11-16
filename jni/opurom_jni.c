/*
 * JNI shim for the Opurom mobile C ABI.
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

#include <stdarg.h>

#include "opurom.h"
#include "platform_view.h"

/*
 * JNI_OnLoad exports a load-time anchor. JNI resolves entry points by dynamic
 * linker name lookup, so the Java_* functions need no registration; the anchor
 * makes a successful dlopen unambiguous. The Rust side builds with
 * panic=unwind and catches every panic across the FFI boundary (see the
 * ffi_guard calls in src/lib.rs), so a panic unwinds to Rust and returns
 * OPU_ERR_PANIC instead of aborting the process at load time.
 */
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)vm;
    (void)reserved;
    return JNI_VERSION_1_6;
}

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
                             jint width, jint height, OpuRenderer *renderer, int suppress) {
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
    } else if (suppress) {
        status = opu_frame_from_ir_suppressed((const uint8_t *)ir_bytes, (size_t)ir_len,
                                              (const uint8_t *)state_bytes, (size_t)state_len,
                                              (uint8_t *)out_bytes, (uint32_t)width,
                                              (uint32_t)height);
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
    return render_ir_arrays(env, ir, state, out, width, height, NULL, 0);
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

/*
 * Timed sibling of render_ir_route_arrays: identical byte[] lifecycle, but the
 * render call is opu_renderer_frame_at with a caller-owned elapsed_ms and a
 * renderer is mandatory (there is no one-shot timed entry point).
 */
static jint render_ir_route_arrays_at(JNIEnv *env, jbyteArray ir, jbyteArray state,
                                      jbyteArray route, jint elapsed_ms, jbyteArray out,
                                      jint width, jint height, OpuRenderer *renderer) {
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

    if (ir == NULL || state == NULL || out == NULL || width <= 0 || height <= 0
            || renderer == NULL) {
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

    status = opu_renderer_frame_at(renderer, (const uint8_t *)ir_bytes, (size_t)ir_len,
                                   (const uint8_t *)state_bytes, (size_t)state_len,
                                   route_ptr, (size_t)route_len, (int64_t)elapsed_ms,
                                   (uint8_t *)out_bytes, (uint32_t)width, (uint32_t)height);

    (*env)->ReleaseByteArrayElements(env, out, out_bytes, 0);
    if (route_bytes != NULL) {
        (*env)->ReleaseByteArrayElements(env, route, route_bytes, JNI_ABORT);
    }
    (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return (jint)status;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFrameAt(
    JNIEnv *env, jclass clazz, jlong renderer, jbyteArray ir, jbyteArray state, jbyteArray route,
    jint elapsed_ms, jbyteArray out, jint width, jint height) {
    (void)clazz;
    if (renderer == 0) {
        return (jint)OPU_ERR_NULL;
    }
    return render_ir_route_arrays_at(env, ir, state, route, elapsed_ms, out, width, height,
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
                            (OpuRenderer *)(intptr_t)renderer, 0);
}

JNIEXPORT void JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFree(JNIEnv *env,
                                                                            jclass clazz,
                                                                            jlong renderer) {
    (void)env;
    (void)clazz;
    opu_renderer_free((OpuRenderer *)(intptr_t)renderer);
}

/*
 * Capability calls are thin JNI delegates: the Java bridge owns the permission,
 * hardware and error decisions, so a typed status never becomes a pending Java
 * exception across the C boundary. Lookup failure is the only native error.
 */
static jint capability_call(JNIEnv *env, const char *class_name, const char *method,
                            const char *signature, ...) {
    jclass target = (*env)->FindClass(env, class_name);
    jmethodID entry;
    va_list args;
    jint status;

    if (target == NULL) {
        (*env)->ExceptionClear(env);
        return (jint)OPU_CAP_INTERNAL;
    }
    entry = (*env)->GetStaticMethodID(env, target, method, signature);
    if (entry == NULL) {
        (*env)->ExceptionClear(env);
        (*env)->DeleteLocalRef(env, target);
        return (jint)OPU_CAP_INTERNAL;
    }
    va_start(args, signature);
    status = (*env)->CallStaticIntMethodV(env, target, entry, args);
    va_end(args);
    (*env)->DeleteLocalRef(env, target);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
        return (jint)OPU_CAP_INTERNAL;
    }
    return status;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuNotifyPost(
    JNIEnv *env, jclass clazz, jobject context, jint id, jstring channel, jstring title,
    jstring body) {
    (void)clazz;
    return capability_call(env, "org/opurom/mobile/NotificationBridge", "callPost",
                           "(Landroid/content/Context;ILjava/lang/String;Ljava/lang/String;"
                           "Ljava/lang/String;)I",
                           context, id, channel, title, body);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuNotifyCancel(
    JNIEnv *env, jclass clazz, jobject context, jint id) {
    (void)clazz;
    return capability_call(env, "org/opurom/mobile/NotificationBridge", "callCancel",
                           "(Landroid/content/Context;I)I", context, id);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuCameraCapture(
    JNIEnv *env, jclass clazz, jobject context) {
    (void)clazz;
    return capability_call(env, "org/opurom/mobile/CameraBridge", "capture",
                           "(Landroid/content/Context;)I", context);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuLocationGet(
    JNIEnv *env, jclass clazz, jobject context, jdoubleArray out) {
    (void)clazz;
    return capability_call(env, "org/opurom/mobile/LocationBridge", "get",
                           "(Landroid/content/Context;[D)I", context, out);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuLocationGetText(
    JNIEnv *env, jclass clazz, jobject context, jbyteArray out) {
    (void)clazz;
    return capability_call(env, "org/opurom/mobile/LocationBridge", "getText",
                           "(Landroid/content/Context;[B)I", context, out);
}

/* Pin the two JSON inputs for one hit/tap call; both are read-only. */
static jint pin_ir_state(JNIEnv *env, jbyteArray ir, jbyteArray state, jbyte **ir_bytes,
                         jbyte **state_bytes, jsize *ir_len, jsize *state_len) {
    *ir_bytes = NULL;
    *state_bytes = NULL;
    if (ir == NULL || state == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    *ir_len = (*env)->GetArrayLength(env, ir);
    *state_len = (*env)->GetArrayLength(env, state);
    *ir_bytes = (*env)->GetByteArrayElements(env, ir, NULL);
    if (*ir_bytes == NULL) {
        return (jint)OPU_ERR_NULL;
    }
    *state_bytes = (*env)->GetByteArrayElements(env, state, NULL);
    if (*state_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, ir, *ir_bytes, JNI_ABORT);
        *ir_bytes = NULL;
        return (jint)OPU_ERR_NULL;
    }
    return (jint)OPU_OK;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuHitTest(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jint x, jint y, jint width,
    jint height) {
    jbyte *ir_bytes;
    jbyte *state_bytes;
    jsize ir_len;
    jsize state_len;
    jint node;

    (void)clazz;
    if (width <= 0 || height <= 0) {
        return 0;
    }
    if (pin_ir_state(env, ir, state, &ir_bytes, &state_bytes, &ir_len, &state_len) != OPU_OK) {
        return 0;
    }
    node = (jint)opu_hit_test((const uint8_t *)ir_bytes, (size_t)ir_len,
                              (const uint8_t *)state_bytes, (size_t)state_len,
                              x, y, (uint32_t)width, (uint32_t)height);
    (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return node;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuTapNode(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jint node_id, jbyteArray out) {
    jbyte *ir_bytes;
    jbyte *state_bytes;
    jbyte *out_bytes;
    jsize ir_len;
    jsize state_len;
    jint status;

    (void)clazz;
    if (out == NULL || node_id <= 0) {
        return (jint)OPU_ERR_NULL;
    }
    status = pin_ir_state(env, ir, state, &ir_bytes, &state_bytes, &ir_len, &state_len);
    if (status != OPU_OK) {
        return status;
    }
    out_bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (out_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return (jint)OPU_ERR_NULL;
    }
    status = (jint)opu_tap_node((const uint8_t *)ir_bytes, (size_t)ir_len,
                                (const uint8_t *)state_bytes, (size_t)state_len,
                                (uint32_t)node_id, (uint8_t *)out_bytes,
                                (size_t)(*env)->GetArrayLength(env, out));
    (*env)->ReleaseByteArrayElements(env, out, out_bytes, status == OPU_OK ? 0 : JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return status;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuTextSpans(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jint width, jint height,
    jbyteArray out) {
    jbyte *ir_bytes;
    jbyte *state_bytes;
    jbyte *out_bytes;
    jsize ir_len;
    jsize state_len;
    jint count;

    (void)clazz;
    if (width <= 0 || height <= 0) {
        return (jint)OPU_SPAN_ERR_DIMENSION;
    }
    if (out == NULL) {
        return (jint)OPU_SPAN_ERR_NULL;
    }
    if (pin_ir_state(env, ir, state, &ir_bytes, &state_bytes, &ir_len, &state_len) != OPU_OK) {
        return (jint)OPU_SPAN_ERR_NULL;
    }
    out_bytes = (*env)->GetByteArrayElements(env, out, NULL);
    if (out_bytes == NULL) {
        (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
        (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
        return (jint)OPU_SPAN_ERR_NULL;
    }
    count = opu_text_spans((const uint8_t *)ir_bytes, (size_t)ir_len,
                           (const uint8_t *)state_bytes, (size_t)state_len,
                           (uint32_t)width, (uint32_t)height,
                           (uint8_t *)out_bytes, (size_t)(*env)->GetArrayLength(env, out));
    (*env)->ReleaseByteArrayElements(env, out, out_bytes, count >= 0 ? 0 : JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, state, state_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, ir, ir_bytes, JNI_ABORT);
    return count;
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererSuppressText(
    JNIEnv *env, jclass clazz, jlong renderer, jboolean on) {
    (void)env;
    (void)clazz;
    if (renderer == 0) {
        return (jint)OPU_ERR_NULL;
    }
    return (jint)opu_renderer_set_suppress_text((OpuRenderer *)(intptr_t)renderer,
                                                on == JNI_TRUE ? 1 : 0);
}

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrameSuppressed(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jbyteArray out, jint width,
    jint height) {
    (void)clazz;
    return render_ir_arrays(env, ir, state, out, width, height, NULL, 1);
}
