import AppKit
import Foundation

/// Utilities that turn renderer output into CGImages with a stable, owned backing store.
public enum OpuromAppKitImage {
    /// Decodes a Netpbm P6 payload (`P6\n<w> <h>\n255\n<rgb bytes>...`).
    public static func decodeP6(_ data: Data) -> (width: Int, height: Int, rgb: Data)? {
        var tokens: [Data] = []
        var index = 0
        while tokens.count < 4, index < data.count {
            while index < data.count, isWhitespace(data[index]) { index += 1 }
            guard index < data.count else { break }
            let start = index
            while index < data.count, !isWhitespace(data[index]) { index += 1 }
            tokens.append(data[start..<index])
        }
        guard tokens.count == 4,
              tokens[0] == Data("P6".utf8),
              let width = Int(String(decoding: tokens[1], as: UTF8.self)),
              let height = Int(String(decoding: tokens[2], as: UTF8.self)),
              tokens[3] == Data("255".utf8),
              width > 0, height > 0 else { return nil }
        // Exactly one whitespace byte separates the max-value token from pixel data.
        let rgb = data.subdata(in: min(index, data.count)..<data.count)
        guard rgb.count >= width * height * 3 else { return nil }
        return (width, height, rgb)
    }

    /// Builds a CGImage whose bytes are owned by the image, not by a temporary caller buffer.
    /// CoreGraphics requires a 16-byte-aligned row stride and a supported alpha layout.
    public static func makeCGImage(rgb: Data, width: Int, height: Int) -> CGImage? {
        guard width > 0, height > 0, rgb.count >= width * height * 3 else { return nil }
        let sourceStride = width * 3
        let stride = (width * 4 + 15) & ~15
        let (totalBytes, overflow) = height.multipliedReportingOverflow(by: stride)
        guard !overflow, totalBytes > 0 else { return nil }
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
        rgb.withUnsafeBytes { source in
            let src = source.baseAddress!.assumingMemoryBound(to: UInt8.self)
            for y in 0..<height {
                let dst = buffer.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
                let srcRow = src.advanced(by: y * sourceStride)
                for x in 0..<width {
                    dst[x * 4] = srcRow[x * 3]
                    dst[x * 4 + 1] = srcRow[x * 3 + 1]
                    dst[x * 4 + 2] = srcRow[x * 3 + 2]
                    dst[x * 4 + 3] = 255
                }
            }
        }
        let release: CGDataProviderReleaseDataCallback = { _, data, _ in
            data.assumingMemoryBound(to: UInt8.self).deallocate()
        }
        guard let provider = CGDataProvider(dataInfo: buffer, data: buffer, size: totalBytes,
                                            releaseData: release) else {
            buffer.deallocate()
            return nil
        }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: stride, space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: false,
                       intent: .defaultIntent)
    }

    private static func isWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d
    }
}
