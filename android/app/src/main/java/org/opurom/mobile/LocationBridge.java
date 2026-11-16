package org.opurom.mobile;

import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import java.nio.charset.StandardCharsets;
import java.util.List;

/** The location capability on Android: typed permission and no-fix degradation. */
public final class LocationBridge {
    private LocationBridge() {
    }

    /** Formats one fix as the single IR result string, without spaces. */
    static String format(double[] coordinates) {
        return Double.toString(coordinates[0]) + "," + Double.toString(coordinates[1]);
    }

    /**
     * IR result form: one string {@code "<lat>,<lon>"} with a decimal point and
     * no spaces. An unsuccessful read leaves the result empty.
     */
    public static int getText(Context context, byte[] out) {
        if (out == null || out.length == 0) {
            return CapabilityStatus.INVALID;
        }
        double[] coordinates = new double[2];
        int status = get(context, coordinates);
        if (status != CapabilityStatus.OK) {
            out[0] = 0;
            return status;
        }
        byte[] text = format(coordinates).getBytes(StandardCharsets.UTF_8);
        if (text.length > out.length) {
            return CapabilityStatus.INTERNAL;
        }
        System.arraycopy(text, 0, out, 0, text.length);
        return CapabilityStatus.OK;
    }

    /** Pure verdict for the two gates before a provider read. */
    static int decide(boolean granted, boolean hardware) {
        if (!granted) {
            return CapabilityStatus.PERMISSION_DENIED;
        }
        if (!hardware) {
            return CapabilityStatus.NO_HARDWARE;
        }
        return CapabilityStatus.OK;
    }

    /**
     * Writes latitude and longitude into {@code out}. A device without location
     * hardware returns {@code NO_HARDWARE}; an absent fix returns {@code INTERNAL}.
     * Neither path throws or returns a silent empty success.
     *
     * <p>shortcut: the IR request's accuracy and timeout fields are accepted by
     * the call site but ignored; the default enabled provider is used.
     */
    public static int get(Context context, double[] out) {
        if (context == null || out == null || out.length < 2) {
            return CapabilityStatus.INVALID;
        }
        PackageManager features = context.getPackageManager();
        boolean hardware = features.hasSystemFeature(PackageManager.FEATURE_LOCATION);
        boolean granted = PermissionBridge.has(context, PermissionBridge.ACCESS_FINE_LOCATION)
                || PermissionBridge.has(context, PermissionBridge.ACCESS_COARSE_LOCATION);
        int gate = decide(granted, hardware);
        if (gate != CapabilityStatus.OK) {
            return gate;
        }
        LocationManager manager =
                (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            return CapabilityStatus.INTERNAL;
        }
        List<String> providers;
        try {
            providers = manager.getProviders(true);
        } catch (SecurityException denied) {
            return CapabilityStatus.PERMISSION_DENIED;
        }
        if (providers.isEmpty()) {
            return CapabilityStatus.NO_HARDWARE;
        }
        Location location = null;
        for (String provider : providers) {
            try {
                location = manager.getLastKnownLocation(provider);
            } catch (SecurityException denied) {
                return CapabilityStatus.PERMISSION_DENIED;
            }
            if (location != null) {
                break;
            }
        }
        if (location == null) {
            return CapabilityStatus.INTERNAL;
        }
        out[0] = location.getLatitude();
        out[1] = location.getLongitude();
        return CapabilityStatus.OK;
    }
}
