#ifndef OPUROM_JNI_H
#define OPUROM_JNI_H

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

#ifdef __cplusplus
}
#endif

#endif
