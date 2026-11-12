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
