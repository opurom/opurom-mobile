package org.opurom.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * The runtime-permission capability on Android: declaration-aware grant checks
 * plus a single-slot request routed through the hosting activity. Mirrors the
 * storage/crypto/socket bridges: unsupported input throws
 * {@link IllegalArgumentException}, a denied grant is a value ({@code false}),
 * never an exception, and a foreign or stale result is dropped, not crashed.
 *
 * <p>Declared in the manifest: {@link #RECORD_AUDIO}, {@link #CAMERA}, the two
 * location grants and {@link #POST_NOTIFICATIONS} (runtime on API 33+; granted
 * implicitly below). Camera and location ask for one permission at a time.
 */
public final class PermissionBridge {
    public static final String RECORD_AUDIO = "android.permission.RECORD_AUDIO";
    public static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";
    public static final String CAMERA = "android.permission.CAMERA";
    public static final String ACCESS_FINE_LOCATION = "android.permission.ACCESS_FINE_LOCATION";
    public static final String ACCESS_COARSE_LOCATION = "android.permission.ACCESS_COARSE_LOCATION";

    /** Stable request code for every permission ask this bridge owns. */
    public static final int REQUEST_CODE = 7710;

    private static final String[] SUPPORTED = {
        RECORD_AUDIO, POST_NOTIFICATIONS, CAMERA, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION
    };

    /** Delivered on the UI thread with the final verdict for one permission. */
    public interface Callback {
        void onResult(String permission, boolean granted);
    }

    // shortcut: one in-flight request; a second begin() replaces the first.
    // Upgrade to a request-code map when the runtime needs concurrent asks.
    private static String pendingPermission;
    private static Callback pendingCallback;

    private PermissionBridge() {
    }

    /** True when the permission is one this build declares and can ask for. */
    public static boolean isSupported(String permission) {
        for (String supported : SUPPORTED) {
            if (supported.equals(permission)) {
                return true;
            }
        }
        return false;
    }

    static void require(String permission) {
        if (!isSupported(permission)) {
            throw new IllegalArgumentException(
                    "unsupported permission '" + permission + "'; supported: " + String.join(", ", SUPPORTED));
        }
    }

    /**
     * Current grant state. {@link #POST_NOTIFICATIONS} counts as granted on
     * API&nbsp;&lt;&nbsp;33, where the platform defines no such runtime
     * permission and notifications need none.
     */
    public static boolean has(Context context, String permission) {
        require(permission);
        if (POST_NOTIFICATIONS.equals(permission) && Build.VERSION.SDK_INT < 33) {
            return true;
        }
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Ask for one permission: an already-granted permission completes
     * synchronously, otherwise the system dialog posts the verdict to
     * {@code callback} through {@link #dispatch} from
     * {@code onRequestPermissionsResult}.
     */
    public static void request(Activity activity, String permission, Callback callback) {
        require(permission);
        if (callback == null) {
            throw new IllegalArgumentException("callback must not be null");
        }
        if (has(activity, permission)) {
            callback.onResult(permission, true);
            return;
        }
        begin(permission, callback);
        activity.requestPermissions(new String[] {permission}, REQUEST_CODE);
    }

    /** Arms the pending slot; package-private so the JVM test drives dispatch without an Activity. */
    static synchronized void begin(String permission, Callback callback) {
        pendingPermission = permission;
        pendingCallback = callback;
    }

    /**
     * Consume one system result: true when the code belonged to this bridge.
     * Unknown codes and results without an armed request are dropped silently —
     * they cannot be attributed to a live ask.
     */
    public static synchronized boolean dispatch(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQUEST_CODE || pendingCallback == null) {
            return false;
        }
        String permission = pendingPermission;
        Callback callback = pendingCallback;
        pendingPermission = null;
        pendingCallback = null;
        if (permission == null || permissions == null || results == null || permissions.length == 0) {
            return true;
        }
        callback.onResult(permission, granted(results));
        return true;
    }

    /** First verdict in a result array: PERMISSION_GRANTED is 0 by contract. */
    static boolean granted(int[] results) {
        return results != null && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
    }
}
