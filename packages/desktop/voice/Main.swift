import AVFoundation
import Foundation

enum VoiceError: Error { case speechAsset, runtime }

@MainActor
final class NativeVoice {
    enum State { case loading, running(FullDuplexAudioIO, VoiceRecognition), stopped }
    enum Output { case idle, generating(String), draining(String) }
    private var state: State = .loading
    private var output: Output = .idle
    private let process = Process(), input = Pipe(), pipe = Pipe()
    private var timer: Timer?
    private var muted = false

    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }

    func send(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        do { try input.fileHandleForWriting.write(contentsOf: data + Data([10])) }
        catch { fail("runtime") }
    }

    func start(python: String, model: String, language: String, delivery: String, activityDelay: Int) throws {
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-u", URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("runtime.py").path, "--model", model]
        if !delivery.isEmpty { process.arguments?.append(contentsOf: ["--delivery", delivery]) }
        process.standardInput = input; process.standardOutput = pipe; process.standardError = FileHandle.standardError
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        process.environment = environment
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.fail("runtime") } }
        try process.run()
        let handle = pipe.fileHandleForReading
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var bytes = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                bytes.append(chunk)
                while let end = bytes.firstIndex(of: 10) {
                    let line = Data(bytes[..<end]); bytes.removeSubrange(...end)
                    guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    Task { @MainActor in await self?.event(value, language: language, activityDelay: activityDelay) }
                }
            }
        }
    }

    private func event(_ value: [String: Any], language: String, activityDelay: Int) async {
        if case .stopped = state { return }
        if value["type"] as? String == "ready" {
            guard case .loading = state else { return }
            do {
                let recognition = try await VoiceRecognition(language: language, activityDelay: activityDelay) { [weak self] event in self?.emit(event) }
                let audio = FullDuplexAudioIO(configuration: .init(outputSampleRate: 24000, playbackPrebufferFrames: 1))
                guard case .loading = state else { await recognition.stop(); return }
                state = .running(audio, recognition)
                try audio.start { [weak self] samples in
                    Task { @MainActor in
                        guard let self, case .running(_, let recognizer) = self.state, !self.muted else { return }
                        recognizer.append(samples)
                    }
                }
                timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
                emit(["type": "ready"])
            } catch VoiceError.speechAsset { fail("speechAsset") }
            catch { fail("microphone") }
            return
        }
        guard case .running(let audio, _) = state,
              let id = value["id"] as? String,
              case .generating(let current) = output, id == current else { return }
        if value["type"] as? String == "audio",
           let encoded = value["pcm"] as? String, let data = Data(base64Encoded: encoded) {
            audio.schedulePlayback(data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) })
        }
        if value["type"] as? String == "done" {
            audio.finishPlayback(); output = .draining(id)
        }
    }

    private func tick() {
        guard case .running(let audio, _) = state else { return }
        let stats = audio.statistics()
        emit(["type": "levels", "mic": muted ? 0 : stats.microphoneLevel, "speaker": stats.playbackLevel])
        if case .draining(let id) = output, stats.queuedSeconds <= 0, stats.scheduledBuffers == stats.completedBuffers {
            output = .idle; emit(["type": "output.ended", "id": id])
        }
    }

    func command(_ value: [String: Any]) {
        guard case .running(let audio, let recognition) = state else {
            if value["type"] as? String == "stop" { stop(); exit(0) }
            return
        }
        switch value["type"] as? String {
        case "mute":
            muted = value["muted"] as? Bool ?? true
            if muted { recognition.discard() }
        case "pause": audio.pausePlayback()
        case "resume": audio.resumePlayback()
        case "cancel":
            output = .idle; audio.interruptPlayback(fade: value["fade"] as? Bool ?? false); send(["type": "cancel"])
        case "speak":
            guard let next = value["output"] as? [String: Any], let id = next["id"] as? String else { return }
            audio.interruptPlayback(); audio.beginPlayback(); output = .generating(id)
            send(value)
        case "stop": stop(); exit(0)
        default: break
        }
    }

    func fail(_ reason: String) {
        if case .stopped = state { return }
        emit(["type": "failed", "reason": reason]); stop(); exit(1)
    }

    func stop() {
        let previous = state
        state = .stopped; timer?.invalidate(); timer = nil
        if case .running(let audio, let recognition) = previous {
            audio.stop(); Task { await recognition.stop() }
        }
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }
}

@main
struct VoiceMain {
    @MainActor static func main() {
        guard (4...6).contains(CommandLine.arguments.count) else { exit(2) }
        guard let activityDelay = CommandLine.arguments.count == 6 ? Int(CommandLine.arguments[5]) : 1000, (300...3000).contains(activityDelay) else { exit(2) }
        let voice = NativeVoice()
        do { try voice.start(python: CommandLine.arguments[1], model: CommandLine.arguments[2], language: CommandLine.arguments[3], delivery: CommandLine.arguments.count >= 5 ? CommandLine.arguments[4] : "", activityDelay: activityDelay) }
        catch { voice.fail("runtime") }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                Task { @MainActor in voice.command(value) }
            }
            Task { @MainActor in voice.stop(); exit(0) }
        }
        RunLoop.main.run()
    }
}
