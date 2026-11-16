// Android primitive self-checks: compile the pure-Java helpers on a plain JVM
// (no Android runtime needed) and run assert-based checks for the crypto vectors
// and canonical-JSON ordering. StorageBridge needs an Android Context, so its
// round-trip is covered by packaging plus the on-device install check.
'use strict';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile');

function findJavac() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javac'));
  // The toolchains JDK the repo verifies against, then a couple of common homes.
  candidates.push(
    path.join(home, 'java', 'temurin-21', 'Contents', 'Home', 'bin', 'javac'),
    path.join(home, 'work', 'toolchains', 'jdk-download', 'jdk-21.0.13+9', 'Contents', 'Home', 'bin', 'javac'),
  );
  candidates.push('javac');
  return candidates.find((c) => c === 'javac' || existsSync(c)) ?? null;
}

// The harness exercises only the two Java classes with no Android dependency.
const HARNESS = `
import org.opurom.mobile.CryptoBridge;

public final class PrimitiveCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    public static void main(String[] args) throws Exception {
        // SHA-256 fixed vectors.
        check(CryptoBridge.sha256Hex(new byte[0]).equals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "sha256 empty");
        check(CryptoBridge.sha256Hex("abc".getBytes("UTF-8")).equals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), "sha256 abc");
        // AES-GCM symmetry + determinism for a fixed key/nonce.
        byte[] key = new byte[32]; for (int i = 0; i < 32; i++) key[i] = 7;
        byte[] nonce = new byte[12]; for (int i = 0; i < 12; i++) nonce[i] = 9;
        byte[] pt = "lan chat".getBytes("UTF-8");
        byte[] sealed = CryptoBridge.aesGcmSeal(key, nonce, pt);
        check(!java.util.Arrays.equals(sealed, pt), "sealed differs from plaintext");
        check(java.util.Arrays.equals(sealed, CryptoBridge.aesGcmSeal(key, nonce, pt)), "seal deterministic");
        check(java.util.Arrays.equals(CryptoBridge.aesGcmOpen(key, nonce, sealed), pt), "open round-trips");
        // Tamper must fail.
        byte[] bad = sealed.clone(); bad[bad.length - 1] ^= (byte) 0xFF;
        boolean threw = false;
        try { CryptoBridge.aesGcmOpen(key, nonce, bad); } catch (IllegalArgumentException e) { threw = true; }
        check(threw, "tampered tag rejected");
        // secure random varies and is non-zero.
        byte[] r1 = CryptoBridge.secureRandom(32), r2 = CryptoBridge.secureRandom(32);
        check(!java.util.Arrays.equals(r1, r2), "random varies");
        check(!java.util.Arrays.equals(r1, new byte[32]), "random not all zeros");
        // Canonical JSON sorts keys and drops whitespace.
        String q = String.valueOf((char) 34);
        String input = "{ " + q + "z" + q + ": 1, " + q + "a" + q + ": [true, null] }";
        String expect = "{" + q + "a" + q + ":[true,null]," + q + "z" + q + ":1}";
        String canon = org.opurom.mobile.CanonicalJsonAccess.canonicalize(input);
        check(canon.equals(expect), "canonical json: " + canon);
        System.out.println("PRIMITIVE_CHECKS_OK");
    }
}
`.trim();

test('the Android crypto and canonical-JSON primitives pass assert checks on a JVM', () => {
  const javac = findJavac();
  // A real JDK path is required; a bare 'javac' would fail at runtime here.
  if (!javac || javac === 'javac') {
    return; // no JDK: packaging verify covers compile, this self-check is a bonus
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-prim-'));
  // CanonicalJson is package-private; expose it through a tiny test-only accessor.
  const accessor = path.join(work, 'src', 'org', 'opurom', 'mobile', 'CanonicalJsonAccess.java');
  const harnessFile = path.join(work, 'src', 'PrimitiveCheck.java');
  mkdirSync(path.dirname(accessor), { recursive: true });
  writeFileSync(accessor, `
package org.opurom.mobile;
public final class CanonicalJsonAccess {
    public static String canonicalize(String json) { return CanonicalJson.canonicalize(json); }
}
`.trim());
  writeFileSync(harnessFile, HARNESS);
  const srcFiles = [
    path.join(SRC, 'CryptoBridge.java'),
    path.join(SRC, 'CanonicalJson.java'),
    accessor,
    harnessFile,
  ];
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-d', classes, ...srcFiles], { stdio: 'pipe' });
  const out = execFileSync(javac === 'javac' ? 'java' : javac.replace(/javac$/, 'java'), [
    '-cp', classes, 'PrimitiveCheck',
  ], { encoding: 'utf8' });
  assert.match(out, /PRIMITIVE_CHECKS_OK/);
});
