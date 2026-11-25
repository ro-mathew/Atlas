// Opt-in verification with controlled fixture audio; never opens a microphone.
import AVFoundation
import Foundation

enum VoiceError: Error { case speechAsset }

@main
struct CheckRecognition {
    @MainActor static func main() async throws {
        let results = AsyncStream<String>.makeStream()
        let recognition = try await VoiceRecognition(language: "en-US") { event in
            if event["type"] as? String == "failed" { results.continuation.finish() }
            if event["type"] as? String == "transcript.final", let text = event["text"] as? String {
                results.continuation.yield(text)
            }
        }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[1]))
        let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: input)
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        let converter = AVAudioConverter(from: file.processingFormat, to: format)!
        let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(file.length) * 16000 / file.processingFormat.sampleRate + 32))!
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied { status.pointee = .endOfStream; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error { throw error }
        let pcm = Array(UnsafeBufferPointer(start: converted.floatChannelData![0], count: Int(converted.frameLength)))
        let silence = [Float](repeating: 0, count: 24000)
        let samples = pcm + silence
        var iterator = results.stream.makeAsyncIterator()
        for _ in 0..<2 {
            for start in stride(from: 0, to: samples.count, by: 320) {
                recognition.append(Array(samples[start..<min(start + 320, samples.count)]))
                await Task.yield()
            }
            guard let text = await iterator.next(), ["blue", "cup", "beside", "window"].allSatisfy({ text.lowercased().components(separatedBy: $0).count == 2 }) else {
                fatalError("The production streaming recognizer lost the fixture utterance")
            }
            print(text)
        }
        await recognition.stop()
    }
}
