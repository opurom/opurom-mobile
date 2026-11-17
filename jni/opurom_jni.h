#ifndef Opurom_JNI_H
#define Opurom_JNI_H

/*
 * JNI declaration for the Java class org.opurom.mobile.OpuromNative.
 *
 * This header mirrors the Java native methods with the exact JNI C symbol names generated for the
 * default `-jni` javac output. It includes <jni.h> from a real JDK and is implemented by
 * jni/opurom_jni.c, which the Android NDK clang links into libopurom_mobile.so for
 * aarch64-linux-android and x86_64-linux-android.
 *
 * Ownership matches include/opurom.h: opuStateNew returns a heap state owned by the Java caller,
 * kept as an opaque jlong; opuStateFree must be called exactly once, and any nonzero jlong used
 * without a live opuStateNew result is invalid. The implementation must copy RGBA output into the
 * Java byte[] during the native call; no pointer into Rust memory may outlive that call.
 */

#include <jni.h>

/* Capability wire status; matches CapabilityStatus.java. */
#define OPU_CAP_INTERNAL 4

#ifdef __cplusplus
extern "C" {
#endif

JNIEXPORT jlong JNICALL Java_org_opurom_mobile_OpuromNative_opuStateNew(JNIEnv *env,
                                                                        jclass clazz);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuDispatch(JNIEnv *env,
                                                                       jclass clazz,
                                                                       jlong state,
                                                                       jint eventId);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrame(JNIEnv *env,
                                                                    jclass clazz,
                                                                    jlong state,
                                                                    jbyteArray out,
                                                                    jint width,
                                                                    jint height);

JNIEXPORT void JNICALL Java_org_opurom_mobile_OpuromNative_opuStateFree(JNIEnv *env,
                                                                        jclass clazz,
                                                                        jlong state);

JNIEXPORT jlong JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererNew(JNIEnv *env,
                                                                            jclass clazz,
                                                                            jint width,
                                                                            jint height);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFrame(JNIEnv *env,
                                                                             jclass clazz,
                                                                             jlong renderer,
                                                                             jbyteArray ir,
                                                                             jbyteArray state,
                                                                             jbyteArray out,
                                                                             jint width,
                                                                             jint height);

JNIEXPORT void JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFree(JNIEnv *env,
                                                                            jclass clazz,
                                                                            jlong renderer);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrameFromIr(JNIEnv *env,
                                                                           jclass clazz,
                                                                           jbyteArray ir,
                                                                           jbyteArray state,
                                                                           jbyteArray out,
                                                                           jint width,
                                                                           jint height);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFrameRoute(
    JNIEnv *env, jclass clazz, jlong renderer, jbyteArray ir, jbyteArray state, jbyteArray route,
    jbyteArray out, jint width, jint height);

/* Timed sibling of opuRendererFrameRoute: elapsed_ms drives the animation clock. */
JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererFrameAt(
    JNIEnv *env, jclass clazz, jlong renderer, jbyteArray ir, jbyteArray state, jbyteArray route,
    jint elapsed_ms, jbyteArray out, jint width, jint height);

/* Caller-owned press phase (ANIMATION_AND_PHYSICS.md 8); see OpuromNative.java. */
JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererSetPress(
    JNIEnv *env, jclass clazz, jlong renderer, jint node_id, jlong press_start_tick,
    jlong touch_x, jlong touch_y, jint on);

/* Caller-owned gesture arena: pointer, deadline query and logical tick. */
JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererPointer(
    JNIEnv *env, jclass clazz, jlong renderer, jint kind, jint pointer_id, jint node_id,
    jlong time_ms, jlong local_x, jlong local_y, jlong global_x, jlong global_y, jlongArray out);

JNIEXPORT jlong JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererNextDeadlineMs(
    JNIEnv *env, jclass clazz, jlong renderer);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererTick(
    JNIEnv *env, jclass clazz, jlong renderer, jlong t_ms, jlongArray out);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrameFromIrRoute(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jbyteArray route, jbyteArray out,
    jint width, jint height);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuIrInitialRoute(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray out);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuIrRouteAt(
    JNIEnv *env, jclass clazz, jbyteArray ir, jint index, jbyteArray out);

/* Capability calls delegate to the Java bridge and return a CapabilityStatus code. */
JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuNotifyPost(
    JNIEnv *env, jclass clazz, jobject context, jint id, jstring channel, jstring title,
    jstring body);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuNotifyCancel(
    JNIEnv *env, jclass clazz, jobject context, jint id);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuCameraCapture(
    JNIEnv *env, jclass clazz, jobject context);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuLocationGet(
    JNIEnv *env, jclass clazz, jobject context, jdoubleArray out);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuLocationGetText(
    JNIEnv *env, jclass clazz, jobject context, jbyteArray out);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuHitTest(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jint x, jint y, jint width,
    jint height);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuTapNode(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jint node_id, jbyteArray out);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuTextSpans(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jint width, jint height,
    jbyteArray out);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuRendererSuppressText(
    JNIEnv *env, jclass clazz, jlong renderer, jboolean on);

JNIEXPORT jint JNICALL Java_org_opurom_mobile_OpuromNative_opuFrameSuppressed(
    JNIEnv *env, jclass clazz, jbyteArray ir, jbyteArray state, jbyteArray out, jint width,
    jint height);

#ifdef __cplusplus
}
#endif

#endif
