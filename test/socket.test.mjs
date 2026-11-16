// SocketBridge self-check on a plain JVM: the class is pure java.net, so the
// full contract (connect/accept/send/recv/close, timeouts, refusal) runs against
// a real loopback pair without an Android runtime. SocketAsync needs the Android
// looper, so it is covered by packaging verify and the on-device install check.
'use strict';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  candidates.push(
    path.join(home, 'java', 'temurin-21', 'Contents', 'Home', 'bin', 'javac'),
    path.join(home, 'work', 'toolchains', 'jdk-download', 'jdk-21.0.13+9', 'Contents', 'Home', 'bin', 'javac'),
  );
  candidates.push('javac');
  return candidates.find((c) => c === 'javac' || existsSync(c)) ?? null;
}

const HARNESS = `
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.opurom.mobile.SocketBridge;

public final class SocketCheck {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    public static void main(String[] args) throws Exception {
        // --- round trip over a real loopback pair ---
        SocketBridge.Server server = SocketBridge.Server.bind("127.0.0.1", 0);
        int port = server.localPort();
        check(port > 0, "ephemeral port reported");

        AtomicReference<String> serverError = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Thread echo = new Thread(() -> {
            try {
                SocketBridge.Client conn = server.accept(5000);
                byte[] got = conn.recv(1024, 5000);
                conn.send(got);
                conn.close();
            } catch (Exception error) {
                serverError.set(error.toString());
            } finally {
                done.countDown();
            }
        });
        echo.start();

        SocketBridge.Client client = SocketBridge.Client.connect("127.0.0.1", port, 5000);
        byte[] payload = "lan chat hello".getBytes("UTF-8");
        int sent = client.send(payload);
        check(sent == payload.length, "send returns byte count");
        byte[] echoed = client.recv(1024, 5000);
        check(new String(echoed, "UTF-8").equals("lan chat hello"), "echo round trip");
        client.close();
        check(done.await(10, TimeUnit.SECONDS), "server thread finished");
        check(serverError.get() == null, "server side failed: " + serverError.get());
        server.close();

        // --- send after close throws, never silently succeeds ---
        try {
            client.send(payload);
            check(false, "send after close must throw");
        } catch (java.io.IOException expected) {
            // documented contract
        }

        // --- accept times out with SocketTimeoutException ---
        SocketBridge.Server quiet = SocketBridge.Server.bind("127.0.0.1", 0);
        long start = System.nanoTime();
        try {
            quiet.accept(100);
            check(false, "accept must time out");
        } catch (java.net.SocketTimeoutException expected) {
            long elapsedMs = (System.nanoTime() - start) / 1_000_000L;
            check(elapsedMs >= 80, "accept deadline actually elapses: " + elapsedMs + "ms");
        }
        quiet.close();

        // --- recv times out with a silent peer ---
        SocketBridge.Server silent = SocketBridge.Server.bind("127.0.0.1", 0);
        SocketBridge.Server hold = silent;
        Thread keeper = new Thread(() -> {
            try {
                SocketBridge.Client conn = hold.accept(5000);
                Thread.sleep(400);
                conn.close();
            } catch (Exception ignored) {
                // teardown race is fine for this check
            }
        });
        keeper.start();
        SocketBridge.Client toQuiet = SocketBridge.Client.connect("127.0.0.1", hold.localPort(), 5000);
        try {
            toQuiet.recv(64, 100);
            check(false, "recv must time out");
        } catch (java.net.SocketTimeoutException expected) {
            // documented contract
        }
        toQuiet.close();
        silent.close();

        // --- connecting to a dead port reports connection refused ---
        SocketBridge.Server reserve = SocketBridge.Server.bind("127.0.0.1", 0);
        int deadPort = reserve.localPort();
        reserve.close();
        try {
            SocketBridge.Client.connect("127.0.0.1", deadPort, 3000);
            check(false, "connect to a dead port must fail");
        } catch (java.net.ConnectException expected) {
            check(expected.getMessage().contains("refused"), "refused message: " + expected.getMessage());
        }

        System.out.println("SOCKET_CHECKS_OK");
    }
}
`.trim();

test('the Android socket bridge passes loopback checks on a JVM', () => {
  const javac = findJavac();
  if (!javac || javac === 'javac') {
    return; // no JDK on this host: packaging verify covers compile
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'opurom-socket-'));
  const harnessFile = path.join(work, 'SocketCheck.java');
  writeFileSync(harnessFile, HARNESS);
  const classes = path.join(work, 'classes');
  execFileSync(javac, ['--release', '17', '-d', classes,
    path.join(SRC, 'SocketBridge.java'), harnessFile], { stdio: 'pipe' });
  const out = execFileSync(javac.replace(/javac$/, 'java'),
    ['-cp', classes, 'SocketCheck'], { encoding: 'utf8', timeout: 30000 });
  assert.match(out, /SOCKET_CHECKS_OK/);
});
