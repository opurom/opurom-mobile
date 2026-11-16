package org.opurom.mobile;

/** Wire result codes for native capability calls, shared with the JNI call surface. */
public final class CapabilityStatus {
    public static final int OK = 0;
    public static final int UNSUPPORTED = 1;
    public static final int PERMISSION_DENIED = 2;
    public static final int NO_HARDWARE = 3;
    public static final int INTERNAL = 4;
    public static final int INVALID = 5;

    private CapabilityStatus() {
    }

    /** Maps the existing bridge exception vocabulary onto the wire codes. */
    static int from(RuntimeException error) {
        if (error instanceof IllegalArgumentException) {
            return INVALID;
        }
        if (error instanceof UnsupportedOperationException) {
            return UNSUPPORTED;
        }
        if (error instanceof SecurityException) {
            return PERMISSION_DENIED;
        }
        return INTERNAL;
    }
}
