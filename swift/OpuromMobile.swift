import COpuromMobile

public enum OpuromEvent {
    public static let tap = UInt32(OPU_EVENT_TAP)
    public static let reset = UInt32(OPU_EVENT_RESET)
}

public enum OpuromMobileError: Error, Equatable {
    case stateUnavailable
    case rendererUnavailable
    case invalidBuffer
    case abi(Int32)
}

/// One-shot real IR frame. `stateJSON` may be `{}` for the IR initial state.
public enum OpuromIRFrame {
    public static func frame(
        irJSON: String,
        stateJSON: String,
        into buffer: UnsafeMutableBufferPointer<UInt8>,
        width: UInt32,
        height: UInt32
    ) throws {
        guard let baseAddress = buffer.baseAddress else {
            throw OpuromMobileError.invalidBuffer
        }
        try checkBuffer(buffer, width: width, height: height)
        let ir = Array(irJSON.utf8)
        let state = Array(stateJSON.utf8)
        let status = ir.withUnsafeBufferPointer { irBytes in
            state.withUnsafeBufferPointer { stateBytes in
                opu_frame_from_ir(
                    irBytes.baseAddress, irBytes.count,
                    stateBytes.baseAddress, stateBytes.count,
                    baseAddress, width, height)
            }
        }
        guard status == Int32(OPU_OK) else {
            throw OpuromMobileError.abi(status)
        }
    }
}

/// Owns one reusable renderer; deinit is the single free site.
public final class OpuromIRRenderer {
    private var handle: OpaquePointer?
    private let width: UInt32
    private let height: UInt32

    public init(width: UInt32, height: UInt32) throws {
        guard let created = opu_renderer_new(width, height) else {
            throw OpuromMobileError.rendererUnavailable
        }
        handle = created
        self.width = width
        self.height = height
    }

    deinit {
        if let owned = handle {
            opu_renderer_free(owned)
        }
    }

    public func frame(
        irJSON: String,
        stateJSON: String,
        into buffer: UnsafeMutableBufferPointer<UInt8>
    ) throws {
        guard let owned = handle, let baseAddress = buffer.baseAddress else {
            throw OpuromMobileError.invalidBuffer
        }
        try checkBuffer(buffer, width: width, height: height)
        let ir = Array(irJSON.utf8)
        let state = Array(stateJSON.utf8)
        let status = ir.withUnsafeBufferPointer { irBytes in
            state.withUnsafeBufferPointer { stateBytes in
                opu_renderer_frame(
                    owned, irBytes.baseAddress, irBytes.count,
                    stateBytes.baseAddress, stateBytes.count,
                    baseAddress, width, height)
            }
        }
        guard status == Int32(OPU_OK) else {
            throw OpuromMobileError.abi(status)
        }
    }
}

private func checkBuffer(
    _ buffer: UnsafeMutableBufferPointer<UInt8>,
    width: UInt32,
    height: UInt32
) throws {
    let (pixels, pixelsOverflow) = width.multipliedReportingOverflow(by: height)
    guard !pixelsOverflow else {
        throw OpuromMobileError.invalidBuffer
    }
    let (bytes, bytesOverflow) = pixels.multipliedReportingOverflow(by: 4)
    guard !bytesOverflow, buffer.count >= Int(bytes) else {
        throw OpuromMobileError.invalidBuffer
    }
}

/// Owns one C state; deinit is the single free site.
public final class OpuromState {
    private var handle: OpaquePointer?

    public init() throws {
        guard let created = opu_state_new() else {
            throw OpuromMobileError.stateUnavailable
        }
        handle = created
    }

    deinit {
        if let owned = handle {
            opu_state_free(owned)
        }
    }

    public func dispatch(_ eventID: UInt32) throws {
        guard let owned = handle else {
            throw OpuromMobileError.stateUnavailable
        }
        let status = opu_dispatch(owned, eventID)
        guard status == Int32(OPU_OK) else {
            throw OpuromMobileError.abi(status)
        }
    }

    public func frame(
        into buffer: UnsafeMutableBufferPointer<UInt8>,
        width: UInt32,
        height: UInt32
    ) throws {
        guard let owned = handle else {
            throw OpuromMobileError.stateUnavailable
        }
        guard let baseAddress = buffer.baseAddress else {
            throw OpuromMobileError.invalidBuffer
        }
        let (pixels, pixelsOverflow) = width.multipliedReportingOverflow(by: height)
        guard !pixelsOverflow else {
            throw OpuromMobileError.invalidBuffer
        }
        let (bytes, bytesOverflow) = pixels.multipliedReportingOverflow(by: 4)
        guard !bytesOverflow, buffer.count >= Int(bytes) else {
            throw OpuromMobileError.invalidBuffer
        }
        let status = opu_frame(owned, baseAddress, width, height)
        guard status == Int32(OPU_OK) else {
            throw OpuromMobileError.abi(status)
        }
    }
}

/// PlatformView bridge contract, byte-for-byte with opurom-platform.
public enum OpuromPlatformView {
    /// Encodes a handle as the shared 8-byte `OPV1` little-endian frame.
    public static func encodeHandle(_ handle: UInt32) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: Int(OPU_PLATFORM_VIEW_HANDLE_LEN))
        let _ = opu_platform_view_encode_handle(handle, &bytes)
        return bytes
    }

    /// Decodes the shared 8-byte `OPV1` little-endian frame, or `nil` when invalid.
    public static func decodeHandle(_ bytes: [UInt8]) -> UInt32? {
        var handle: UInt32 = 0
        let ok = bytes.withUnsafeBufferPointer {
            opu_platform_view_decode_handle($0.baseAddress, $0.count, &handle)
        }
        guard ok == Int32(OPU_PLATFORM_VIEW_OK) else {
            return nil
        }
        return handle
    }

    /// True when every logical-pixel bound component is non-negative.
    public static func isBoundsValid(x: Int32, y: Int32, width: Int32, height: Int32) -> Bool {
        opu_platform_view_bounds_valid(x, y, width, height) != 0
    }

    /// True when the documented one-step lifecycle advance is legal.
    public static func canAdvanceLifecycle(from: Int, to: Int) -> Bool {
        opu_platform_view_lifecycle_advance(Int32(from), Int32(to)) != 0
    }
}
