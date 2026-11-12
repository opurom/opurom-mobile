import COpuromMobile

public enum OpuromEvent {
    public static let tap = UInt32(OPU_EVENT_TAP)
    public static let reset = UInt32(OPU_EVENT_RESET)
}

public enum OpuromMobileError: Error, Equatable {
    case stateUnavailable
    case invalidBuffer
    case abi(Int32)
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
