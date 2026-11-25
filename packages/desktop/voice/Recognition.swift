import AVFoundation
import Foundation
import Speech

@MainActor
final class VoiceRecognition {
    struct Segment {
        let start: Double
        let end: Double
        let text: String
    }
    enum Utterance {
        case idle
        case capturing(String, Double, [Segment])
        case finishing(String, Double, [Segment])
    }

    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat
    private let converter: AVAudioConverter?
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var results: Task<Void, Never>?
    private var utterance: Utterance = .idle
    private var frames = 0
    private var voiced = 0
    private var quiet = 0
    private let activityDelayFrames: Int
    private let emit: ([String: Any]) -> Void

    init(language: String, activityDelay: Int = 1000, emit: @escaping ([String: Any]) -> Void) async throws {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)),
              await SpeechTranscriber.installedLocales.contains(locale) else { throw VoiceError.speechAsset }
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let natural = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: natural)
        else { throw VoiceError.speechAsset }
        self.activityDelayFrames = activityDelay * 16
        self.format = format
        self.converter = format == natural ? nil : AVAudioConverter(from: natural, to: format)
        self.emit = emit
        let stream = AsyncStream<AnalyzerInput>.makeStream()
        continuation = stream.continuation
        analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.prepareToAnalyze(in: format)
        results = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    self?.update(range: result.range, text: String(result.text.characters))
                }
            } catch {
                if !Task.isCancelled { self?.emit(["type": "failed", "reason": "recognition"]) }
            }
        }
        try await analyzer.start(inputSequence: stream.stream)
    }

    func append(_ samples: [Float]) {
        frames += samples.count
        let level = sqrt(samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(max(1, samples.count)))
        voiced = level > 0.012 ? voiced + samples.count : 0
        quiet = level > 0.012 ? 0 : quiet + samples.count
        if case .idle = utterance, voiced >= 2560 {
            let id = UUID().uuidString
            utterance = .capturing(id, Double(max(0, frames - 4800)) / 16000, [])
            emit(["type": "speech.started", "id": id])
        }

        let natural = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        guard let input = AVAudioPCMBuffer(pcmFormat: natural, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        input.frameLength = input.frameCapacity
        samples.withUnsafeBufferPointer { source in
            if let address = source.baseAddress { input.floatChannelData![0].update(from: address, count: samples.count) }
        }
        if let converter {
            let capacity = AVAudioFrameCount(Double(samples.count) * format.sampleRate / 16000 + 32)
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return input
            }
            if error == nil { continuation.yield(AnalyzerInput(buffer: converted)) }
        } else { continuation.yield(AnalyzerInput(buffer: input)) }

        if case .capturing(let id, let start, let parts) = utterance,
           quiet >= activityDelayFrames || Double(frames) / 16000 - start >= 20 {
            utterance = .finishing(id, start, parts)
            let end = CMTime(value: CMTimeValue(frames), timescale: 16000)
            Task { [weak self] in
                guard let self else { return }
                do { try await self.analyzer.finalize(through: end) }
                catch { self.emit(["type": "failed", "reason": "recognition"]); return }
                await Task.yield()
                self.finish(id: id)
            }
        }
    }

    private func update(range: CMTimeRange, text: String) {
        let start = CMTimeGetSeconds(range.start)
        // Recognition ranges include leading silence, sometimes beginning before the VAD pre-roll.
        // Use overlap at the end to reject old results without discarding the next utterance.
        let end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
        switch utterance {
        case .idle: return
        case .capturing(let id, let after, let parts):
            guard end >= after else { return }
            let next = parts.filter { $0.end <= start || $0.start >= end } + [Segment(start: start, end: end, text: text)]
            utterance = .capturing(id, after, next)
            emit(["type": "transcript.partial", "id": id, "text": joined(next)])
        case .finishing(let id, let after, let parts):
            guard end >= after else { return }
            let next = parts.filter { $0.end <= start || $0.start >= end } + [Segment(start: start, end: end, text: text)]
            utterance = .finishing(id, after, next)
            emit(["type": "transcript.partial", "id": id, "text": joined(next)])
        }
    }

    private func finish(id: String) {
        guard case .finishing(let current, _, let parts) = utterance, current == id else { return }
        let text = joined(parts)
        utterance = .idle; voiced = 0; quiet = 0
        emit(text.isEmpty ? ["type": "speech.discarded", "id": id] : ["type": "transcript.final", "id": id, "text": text])
    }

    private func joined(_ parts: [Segment]) -> String {
        parts.sorted { $0.start < $1.start }.map(\.text).joined(separator: " ").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    func discard() {
        switch utterance {
        case .idle: return
        case .capturing(let id, _, _), .finishing(let id, _, _):
            utterance = .idle; voiced = 0; quiet = 0
            emit(["type": "speech.discarded", "id": id])
        }
    }

    func stop() async {
        continuation.finish()
        results?.cancel()
        await analyzer.cancelAndFinishNow()
    }
}
