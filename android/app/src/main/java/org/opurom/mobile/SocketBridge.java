package org.opurom.mobile;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;

/**
 * The socket capability on Android, mirroring the opurom-platform Rust contract
 * method for method: {@code connect / bind / accept / send / recv / close} with
 * an explicit timeout on every blocking call. Java returns object references
 * where the Rust API returns struct values; the semantics match otherwise.
 *
 * <p>Error mapping between the two platforms:
 *
 * <ul>
 *   <li>{@link SocketTimeoutException} = Rust {@code SocketError::Timeout}</li>
 *   <li>"Connection refused" {@link java.net.ConnectException} =
 *       {@code SocketError::Refused}</li>
 *   <li>an empty {@code recv} (0 bytes) = peer closed cleanly, exactly like the
 *       Rust {@code recv} returning an empty vector</li>
 *   <li>any other {@link IOException} = {@code SocketError::Io}</li>
 * </ul>
 *
 * <p><b>Thread contract:</b> every method here performs network IO and must be
 * called off the main thread — the platform enforces it with
 * {@code NetworkOnMainThreadException}. Use {@link SocketAsync} to run an
 * operation on the worker pool and deliver the result back to the UI thread.
 * A timed-out call throws {@link SocketTimeoutException} and never returns an
 * empty success; closing twice is harmless.
 */
public final class SocketBridge {
    private SocketBridge() {
    }

    /** A connected TCP stream: send, receive and close with per-call timeouts. */
    public static final class Client implements Closeable {
        private final Socket socket;
        private final InputStream input;
        private final OutputStream output;

        private Client(Socket socket) throws IOException {
            this.socket = socket;
            this.input = socket.getInputStream();
            this.output = socket.getOutputStream();
        }

        /**
         * Connect to {@code host:port}, waiting at most {@code timeoutMs}
         * (0 = no timeout) for the handshake.
         */
        public static Client connect(String host, int port, int timeoutMs) throws IOException {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(host, port), timeoutMs);
                return new Client(socket);
            } catch (IOException error) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                    // the connect already failed; the best-effort close must not mask it
                }
                throw error;
            }
        }

        /**
         * Send every byte and flush; returns the number written. A blocking
         * stream write is all-or-throw, so this takes no timeout: java.net
         * exposes no write deadline (the Rust side bounds writes with a socket
         * write timeout instead). A closed socket throws IOException.
         */
        public synchronized int send(byte[] bytes) throws IOException {
            output.write(bytes);
            output.flush();
            return bytes.length;
        }

        /**
         * Receive up to {@code max} bytes with a read timeout in milliseconds
         * (0 = block until data arrives). An empty array means the peer closed
         * cleanly; a timeout throws {@link SocketTimeoutException}.
         */
        public synchronized byte[] recv(int max, int timeoutMs) throws IOException {
            socket.setSoTimeout(timeoutMs);
            byte[] buffer = new byte[max];
            int read = input.read(buffer);
            if (read < 0) {
                return new byte[0]; // peer closed cleanly
            }
            byte[] out = new byte[read];
            System.arraycopy(buffer, 0, out, 0, read);
            return out;
        }

        /** Shut the connection down; idempotent, later sends throw IOException. */
        @Override
        public synchronized void close() throws IOException {
            socket.close();
        }

        /** The peer's address once connected. */
        public String peerAddress() {
            return String.valueOf(socket.getRemoteSocketAddress());
        }
    }

    /** A bound, listening TCP socket with a timeout-aware accept. */
    public static final class Server implements Closeable {
        private final ServerSocket server;

        private Server(ServerSocket server) {
            this.server = server;
        }

        /**
         * Bind and listen on {@code host:port}; port 0 binds an ephemeral port,
         * then {@link #localPort()} reports which one was chosen.
         */
        public static Server bind(String host, int port) throws IOException {
            ServerSocket server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(host, port));
            return new Server(server);
        }

        /**
         * Wait up to {@code timeoutMs} (0 = block) for the next connection;
         * a deadline hit throws {@link SocketTimeoutException}.
         */
        public Client accept(int timeoutMs) throws IOException {
            server.setSoTimeout(timeoutMs);
            return new Client(server.accept());
        }

        /** The local address actually bound, for an ephemeral port. */
        public int localPort() {
            return server.getLocalPort();
        }

        /** Stop listening; idempotent, a later accept throws IOException. */
        @Override
        public void close() throws IOException {
            server.close();
        }
    }
}
