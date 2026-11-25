import AVFoundation
import Foundation
enum AudioIO {
    static func enableVoiceProcessingIfRequested(
        _ enabled: Bool,
        setEnabled: (Bool) throws -> Void
    ) throws {
        guard enabled else { return }
        try setEnabled(true)
    }

    static func resampleMicrophoneBuffer(
        _ inputBuffer: AVAudioPCMBuffer,
        with converter: AVAudioConverter,
        to targetFormat: AVAudioFormat
    ) -> [Float]? {
        let ratio = targetFormat.sampleRate / inputBuffer.format.sampleRate
        let capacity = AVAudioFrameCount(
            (Double(inputBuffer.frameLength) * ratio).rounded(.up) + 16)
        guard capacity > 0,
              let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat, frameCapacity: capacity)
        else { return nil }

        var conversionError: NSError?
        var consumed = false
        converter.convert(to: outputBuffer, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return inputBuffer
        }
        guard conversionError == nil else { return nil }

        let count = Int(outputBuffer.frameLength)
        guard count > 0, let data = outputBuffer.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: count))
    }
}
