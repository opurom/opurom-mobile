package org.opurom.mobile;

import android.content.Context;
import android.content.pm.PackageManager;

/** The camera capability on Android: typed permission and hardware degradation. */
public final class CameraBridge {
    private CameraBridge() {
    }

    /** Pure verdict for the capability decision, so a JVM test can drive it. */
    static int decide(boolean hardware, boolean granted) {
        if (!hardware) {
            return CapabilityStatus.NO_HARDWARE;
        }
        if (!granted) {
            return CapabilityStatus.PERMISSION_DENIED;
        }
        // shortcut: no capture session is wired yet; say so instead of faking a photo.
        // Upgrade to a Camera2 ImageReader session when the runtime needs image data.
        return CapabilityStatus.UNSUPPORTED;
    }

    /**
     * Captures one photo. A device without a camera returns {@code NO_HARDWARE}
     * and can still install and run the app; a missing grant returns
     * {@code PERMISSION_DENIED}. Neither path throws.
     *
     * <p>shortcut: the IR request's facing and flash fields are accepted by the
     * call site but ignored here; the default camera and flash settings apply.
     * Upgrade to a Camera2 session when image data is needed.
     */
    public static int capture(Context context) {
        if (context == null) {
            return CapabilityStatus.INVALID;
        }
        boolean hardware = context.getPackageManager()
                .hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
        boolean granted = PermissionBridge.has(context, PermissionBridge.CAMERA);
        return decide(hardware, granted);
    }
}
