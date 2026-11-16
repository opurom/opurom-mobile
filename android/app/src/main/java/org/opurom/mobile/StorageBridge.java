package org.opurom.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The storage capability on Android: a key-value store over {@link SharedPreferences}
 * plus structured-object files in the app's private files directory. Mirrors the
 * opurom-platform Rust model so the same .opu program persists on every target.
 *
 * <p>Determinism: keys are sorted before listing and object values are stored as
 * canonical JSON (object keys sorted, no insignificant whitespace), so the same
 * operations produce the same bytes. No wall clock enters a stored value.
 *
 * <p>Keys are restricted to {@code [A-Za-z0-9._-]} so a key can never escape the
 * objects directory. A rejected key throws {@link IllegalArgumentException}.
 */
public final class StorageBridge {
    private static final String PREFS = "opurom.storage";
    private static final String OBJECTS = "opurom-objects";
    private static final int MAX_KEY = 128;

    private final SharedPreferences prefs;
    private final File objectsDir;

    public StorageBridge(Context context) {
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.objectsDir = new File(context.getFilesDir(), OBJECTS);
        if (!objectsDir.isDirectory() && !objectsDir.mkdirs()) {
            throw new IllegalStateException("cannot create objects dir: " + objectsDir);
        }
    }

    private static boolean validKey(String key) {
        if (key == null || key.isEmpty() || key.length() > MAX_KEY) {
            return false;
        }
        for (int i = 0; i < key.length(); i += 1) {
            char c = key.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    private static void requireKey(String key) {
        if (!validKey(key)) {
            throw new IllegalArgumentException("invalid storage key: " + key);
        }
    }

    /** Set a key-value entry. */
    public void set(String key, String value) {
        requireKey(key);
        if (!prefs.edit().putString(key, value).commit()) {
            throw new IllegalStateException("cannot persist key: " + key);
        }
    }

    /** Get a key-value entry, or {@code null} when absent. */
    public String get(String key) {
        requireKey(key);
        return prefs.getString(key, null);
    }

    /** Remove a key-value entry and any matching object; absent keys are a no-op. */
    public void remove(String key) {
        requireKey(key);
        prefs.edit().remove(key).commit();
        File object = objectFile(key);
        if (object.isFile() && !object.delete()) {
            throw new IllegalStateException("cannot delete object: " + key);
        }
    }

    /** All keys in stable sorted order from both the kv map and the object dir. */
    public String[] list() {
        java.util.TreeSet<String> keys = new java.util.TreeSet<>(prefs.getAll().keySet());
        File[] files = objectsDir.listFiles();
        if (files != null) {
            for (File file : files) {
                String name = file.getName();
                if (name.endsWith(".json")) {
                    String stem = name.substring(0, name.length() - ".json".length());
                    if (validKey(stem)) {
                        keys.add(stem);
                    }
                }
            }
        }
        return keys.toArray(new String[0]);
    }

    /** Clear every key-value entry and drop all objects. */
    public void clear() {
        prefs.edit().clear().commit();
        File[] files = objectsDir.listFiles();
        if (files != null) {
            for (File file : files) {
                // best-effort: a leftover object file must not fail the clear
                file.delete();
            }
        }
    }

    /** Store a structured value as canonical JSON (object keys sorted). */
    public void setObject(String key, String json) {
        requireKey(key);
        String canonical = CanonicalJson.canonicalize(json);
        if (canonical == null) {
            throw new IllegalArgumentException("object value is not valid JSON");
        }
        try {
            Files.write(objectFile(key).toPath(), canonical.getBytes(StandardCharsets.UTF_8));
        } catch (IOException error) {
            throw new IllegalStateException("cannot write object: " + key, error);
        }
    }

    /** Read a structured value previously stored with {@link #setObject}. */
    public String getObject(String key) {
        requireKey(key);
        File file = objectFile(key);
        if (!file.isFile()) {
            return null;
        }
        try {
            return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new IllegalStateException("cannot read object: " + key, error);
        }
    }

    private File objectFile(String key) {
        return new File(objectsDir, key + ".json");
    }
}
