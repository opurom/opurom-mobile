package org.opurom.mobile;

import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The thread guard for {@link SocketBridge}: every socket operation runs on a
 * worker thread and its result is delivered back on the UI thread, so a caller
 * never trips {@code NetworkOnMainThreadException} by accident.
 *
 * <p>One shared bounded pool serves all socket work; the pool is shared so a
 * chat session and a file fetch do not each spin a thread. Callbacks always run
 * on the main looper, matching the Android UI contract.
 */
public final class SocketAsync {
    private static final AtomicInteger COUNTER = new AtomicInteger();
    private static final ExecutorService WORKERS = Executors.newFixedThreadPool(
            Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1)),
            runnable -> {
                Thread thread = new Thread(runnable, "opurom-socket-" + COUNTER.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            });
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Delivered on the UI thread with either a value or a failure. */
    public interface Callback<T> {
        void onResult(T value);

        void onError(Exception error);
    }

    private SocketAsync() {
    }

    /**
     * Run {@code work} off the main thread and deliver the outcome on the UI
     * thread. Calling this from the UI thread is the normal path; calling a
     * {@link SocketBridge} method directly on the UI thread is the mistake this
     * helper exists to avoid (the platform fails it with
     * {@code NetworkOnMainThreadException}).
     */
    public static <T> void runOffMain(final Callable<T> work, final Callback<T> callback) {
        WORKERS.execute(() -> {
            try {
                final T value = work.call();
                MAIN.post(() -> callback.onResult(value));
            } catch (Exception error) {
                MAIN.post(() -> callback.onError(error));
            }
        });
    }
}
