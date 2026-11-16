package org.opurom.mobile;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The crypto capability on Android, matching opurom-platform's Rust primitives:
 * SHA-256 hashing, AES-256-GCM sealing and a secure random source. Deterministic
 * given the same key, nonce and plaintext, so tests assert fixed vectors; only the
 * random source varies, by design. Backed by javax.crypto and SecureRandom.
 */
public final class CryptoBridge {
    /** AES-GCM nonce length in bytes (96-bit). */
    public static final int NONCE_LEN = 12;
    /** AES-256-GCM tag length in bytes. */
    public static final int TAG_LEN = 16;
    /** AES-256 key length in bytes. */
    public static final int KEY_LEN = 32;

    private static final SecureRandom RANDOM = new SecureRandom();

    private CryptoBridge() {
    }

    /** Lowercase hex SHA-256 of {@code data}. */
    public static String sha256Hex(byte[] data) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                out.append(Character.forDigit((b >> 4) & 0xF, 16));
                out.append(Character.forDigit(b & 0xF, 16));
            }
            return out.toString();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }

    /** Seal {@code plaintext} under {@code key} and {@code nonce}, returning ciphertext || tag. */
    public static byte[] aesGcmSeal(byte[] key, byte[] nonce, byte[] plaintext) {
        requireKeyAndNonce(key, nonce);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(TAG_LEN * 8, nonce));
            return cipher.doFinal(plaintext);
        } catch (Exception error) {
            throw new IllegalStateException("AES-GCM seal failed", error);
        }
    }

    /** Open a ciphertext || tag blob; a tampered tag throws {@link IllegalArgumentException}. */
    public static byte[] aesGcmOpen(byte[] key, byte[] nonce, byte[] sealed) {
        requireKeyAndNonce(key, nonce);
        if (sealed.length < TAG_LEN) {
            throw new IllegalArgumentException("ciphertext is truncated or failed authentication");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(TAG_LEN * 8, nonce));
            return cipher.doFinal(sealed);
        } catch (Exception error) {
            throw new IllegalArgumentException("ciphertext is truncated or failed authentication", error);
        }
    }

    /** Fill a fresh array with cryptographically secure random bytes. */
    public static byte[] secureRandom(int length) {
        if (length < 0) {
            throw new IllegalArgumentException("length must be non-negative");
        }
        byte[] out = new byte[length];
        RANDOM.nextBytes(out);
        return out;
    }

    /** A fresh 12-byte nonce from the secure random source. */
    public static byte[] secureRandomNonce() {
        return secureRandom(NONCE_LEN);
    }

    private static void requireKeyAndNonce(byte[] key, byte[] nonce) {
        if (key == null || key.length != KEY_LEN) {
            throw new IllegalArgumentException("AES-256 key must be 32 bytes");
        }
        if (nonce == null || nonce.length != NONCE_LEN) {
            throw new IllegalArgumentException("AES-GCM nonce must be 12 bytes");
        }
    }

    /** Whether two arrays are equal; exposed for self-checks in tests. */
    static boolean sameBytes(byte[] a, byte[] b) {
        return Arrays.equals(a, b);
    }
}
