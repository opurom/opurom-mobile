package org.opurom.mobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * The notification capability on Android, mirroring the opurom-platform Rust
 * contract method for method: {@code post / cancel / cancelAll /
 * hasPermission / requestPermission}, with the same four wire error codes.
 *
 * <p>Error mapping between the wire contract and Java:
 *
 * <ul>
 *   <li>{@link IllegalArgumentException} = {@code NotifyError::Invalid} —
 *       title or channel is blank after trimming; body may be empty or null
 *   <li>{@link UnsupportedOperationException} = {@code NotifyError::Unsupported}
 *       — API&nbsp;&lt;&nbsp;26 has no notification channels, so post refuses
 *       rather than silently dropping the channel grouping
 *   <li>{@link SecurityException} = {@code NotifyError::PermissionDenied} —
 *       post on API&nbsp;33+ without the {@code POST_NOTIFICATIONS} grant;
 *       the platform would otherwise swallow the notification silently
 *   <li>{@link IllegalStateException} = {@code NotifyError::Internal} —
 *       the notification service is unavailable
 * </ul>
 *
 * <p>Wire verdicts: {@link #hasPermission} always resolves to {@code Ok} on
 * Android (the grant is queryable at every supported API level);
 * {@link #requestPermission} delivers {@code Ok(true)} when granted and maps a
 * denial to {@code Err(PermissionDenied)}. The id is an unrestricted i32,
 * matching the Rust side.
 */
public final class NotificationBridge {
    private NotificationBridge() {
    }

    /** Stripped non-blank text, or {@link IllegalArgumentException} (= Invalid).
     *  strip() matches Rust's trim() on Unicode whitespace (trim() would let
     *  an ideographic space through as content). */
    static String requireText(String what, String value) {
        if (value == null || value.strip().isEmpty()) {
            throw new IllegalArgumentException("invalid notification " + what + ": must not be blank");
        }
        return value.strip();
    }

    /**
     * The wire error decision for post, without touching Android state, so the
     * JVM test drives it directly. Checks run in contract order: Invalid first
     * (pure input), then Unsupported, then PermissionDenied.
     */
    static void checkPost(int sdkInt, boolean granted) {
        if (sdkInt < 26) {
            throw new UnsupportedOperationException(
                    "notifications require API 26 channels, device is API " + sdkInt);
        }
        if (!granted) {
            throw new SecurityException("POST_NOTIFICATIONS not granted");
        }
    }

    /** True when notifications may be posted; always Ok on the wire. */
    public static boolean hasPermission(Context context) {
        return PermissionBridge.has(context, PermissionBridge.POST_NOTIFICATIONS);
    }

    /**
     * Ask for the notification grant through the system dialog; the verdict
     * arrives on {@code callback} via {@link PermissionBridge#dispatch}.
     * Granted maps to {@code Ok(true)} on the wire, denial to
     * {@code Err(PermissionDenied)}.
     */
    public static void requestPermission(Activity activity, PermissionBridge.Callback callback) {
        PermissionBridge.request(activity, PermissionBridge.POST_NOTIFICATIONS, callback);
    }

    /**
     * Post one local notification under {@code channel} (created with default
     * importance when first seen). A blank title/channel throws Invalid; an
     * empty body is allowed. Reusing an id replaces the previous notification,
     * exactly like the Rust side.
     */
    public static void post(Context context, int id, String channel, String title, String body) {
        String channelName = requireText("channel", channel);
        String heading = requireText("title", title);
        checkPost(Build.VERSION.SDK_INT, hasPermission(context));
        NotificationManager manager = manager(context);
        if (manager.getNotificationChannel(channelName) == null) {
            manager.createNotificationChannel(new NotificationChannel(
                    channelName, channelName, NotificationManager.IMPORTANCE_DEFAULT));
        }
        Notification.Builder builder = new Notification.Builder(context, channelName)
                .setSmallIcon(context.getApplicationInfo().icon)
                .setContentTitle(heading);
        if (body != null && !body.trim().isEmpty()) {
            builder.setContentText(body);
        }
        manager.notify(id, builder.build());
    }

    /** Remove one posted notification; absent ids are a no-op. */
    public static void cancel(Context context, int id) {
        manager(context).cancel(id);
    }

    /** Remove every notification this app posted. */
    public static void cancelAll(Context context) {
        manager(context).cancelAll();
    }

    private static NotificationManager manager(Context context) {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            throw new IllegalStateException("notification service unavailable");
        }
        return manager;
    }
}
