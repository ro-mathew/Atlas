#if canImport(AVFoundation)
import AVFoundation
import Foundation
import os

/// Microphone capture and scheduled low-latency playback on one audio engine.
///
/// Unlike ``StreamingAudioPlayer``, playback uses `AVAudioPlayerNode`. Apple's
/// Voice Processing I/O can therefore inspect scheduled output buffers and use
/// them as the acoustic-echo reference for a true full-duplex conversation.
public final class FullDuplexAudioIO: @unchecked Sendable {
    public struct Configuration: Sendable, Equatable {
        public var inputSampleRate: Int
        public var outputSampleRate: Int
        public var inputBufferFrames: UInt32
        public var playbackPrebufferFrames: Int
        public var enableAEC: Bool

        public init(
            inputSampleRate: Int = 16_000,
            outputSampleRate: Int = 22_050,
            inputBufferFrames: UInt32 = 1_024,
            playbackPrebufferFrames: Int = 3,
            enableAEC: Bool = true
        ) {
            self.inputSampleRate = inputSampleRate
            self.outputSampleRate = outputSampleRate
            self.inputBufferFrames = inputBufferFrames
            self.playbackPrebufferFrames = playbackPrebufferFrames
            self.enableAEC = enableAEC
        }

        public func validate() throws {
            guard inputSampleRate > 0 else {
                throw FullDuplexAudioError.invalidConfiguration(
                    "input sample rate must be positive")
            }
            guard outputSampleRate > 0 else {
                throw FullDuplexAudioError.invalidConfiguration(
                    "output sample rate must be positive")
            }
            guard inputBufferFrames > 0 else {
                throw FullDuplexAudioError.invalidConfiguration(
                    "input buffer size must be positive")
            }
            guard playbackPrebufferFrames > 0,
                  playbackPrebufferFrames <= 32 else {
                throw FullDuplexAudioError.invalidConfiguration(
                    "playback prebuffer must be between 1 and 32 frames")
            }
        }
    }

    public struct Statistics: Sendable, Equatable {
        public let scheduledBuffers: Int
        public let completedBuffers: Int
        public let underruns: Int
        public let microphoneLevel: Float
        public let playbackLevel: Float
        public let capturedSamples: Int
        public let outputSamples: Int
        public let queuedSeconds: Double
        public let bufferDrains: Int
        public let starvationSeconds: Double

        public init(scheduledBuffers: Int, completedBuffers: Int, underruns: Int, microphoneLevel: Float,
                    playbackLevel: Float = 0, capturedSamples: Int = 0, outputSamples: Int = 0, queuedSeconds: Double = 0, bufferDrains: Int = 0, starvationSeconds: Double = 0) {
            self.scheduledBuffers = scheduledBuffers; self.completedBuffers = completedBuffers
            self.underruns = underruns; self.microphoneLevel = microphoneLevel
            self.playbackLevel = playbackLevel; self.capturedSamples = capturedSamples; self.outputSamples = outputSamples
            self.queuedSeconds = queuedSeconds; self.bufferDrains = bufferDrains; self.starvationSeconds = starvationSeconds
        }
    }

    public enum State: Sendable, Equatable {
        case stopped
        case running
        case failed(String)
    }

    public let configuration: Configuration
    public var state: State {
        lock.lock()
        defer { lock.unlock() }
        return audioState
    }

    public var microphoneName: String {
        AVCaptureDevice.default(for: .audio)?.localizedName ?? "Default microphone"
    }

    private let lock = NSLock()
    private let playbackQueue: DispatchQueue
    private let playbackQueueKey = DispatchSpecificKey<Void>()
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var timePitch: AVAudioUnitTimePitch?
    private var playbackEnvelope: DispatchSourceTimer?
    private var playbackSourceFormat: AVAudioFormat?
    private var playbackFormat: AVAudioFormat?
    private var playbackConverter: AVAudioConverter?
    private var audioState: State = .stopped
    private struct PendingPlayback { let buffer: AVAudioPCMBuffer; let ticket: PlaybackAccounting.Ticket }
    private var prebuffer: [PendingPlayback] = []
    private var accounting = PlaybackAccounting()
    private var playbackPrebufferTarget = 0
    private var playbackStarted = false
    private var playbackPaused = false
    private var playbackGeneration = 0
    private var stopping = false
    private var scheduledBuffers = 0
    private var completedBuffers = 0
    private var underruns = 0
    private var microphoneLevel: Float = 0
    private var playbackLevel: Float = 0
    private var firstOutputTime = 0.0
    private var capturedSamples = 0
    private var outputSamples = 0
    private var outputTapInstalled = false

    private static let log = Logger(
        subsystem: "audio.soniqo", category: "FullDuplexAudioIO")

    public init(configuration: Configuration = .init()) {
        self.configuration = configuration
        let queue = DispatchQueue(
            label: "audio.soniqo.full-duplex-playback",
            qos: .userInteractive)
        self.playbackQueue = queue
        queue.setSpecific(key: playbackQueueKey, value: ())
    }

    #if os(macOS)
    /// A cold Voice Processing graph can report running without delivering tap
    /// callbacks. Resolve and clock the physical input before negotiating the
    /// aggregate voice-processing device. No microphone samples are retained.
    private static func initializeInputRoute() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw FullDuplexAudioError.invalidDeviceFormat
        }
        let ready = DispatchSemaphore(value: 0)
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: nil)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            if buffer.frameLength > 0 { ready.signal() }
        }
        defer {
            engine.stop()
            input.removeTap(onBus: 0)
            engine.disconnectNodeOutput(player)
            engine.detach(player)
        }
        try engine.start()
        guard ready.wait(timeout: .now() + 2) == .success else {
            throw FullDuplexAudioError.invalidConfiguration(
                "the physical microphone route delivered no audio during initialization")
        }
    }
    #endif

    static func recoveryPrebufferFrames(initial: Int) -> Int {
        min(32, max(3, initial * 2))
    }

    /// Start capture, resampled to `configuration.inputSampleRate`.
    ///
    /// The callback executes on Core Audio's capture thread. It should only
    /// copy/enqueue samples; model inference belongs on a separate worker.
    public func start(onSamples: @escaping @Sendable ([Float]) -> Void) throws {
        try configuration.validate()
        stop()

        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: configuration.enableAEC ? .voiceChat : .default,
            options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        #endif

        #if os(macOS)
        if configuration.enableAEC {
            try Self.initializeInputRoute()
        }
        #endif

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let playerNode = AVAudioPlayerNode()
        let timePitch = AVAudioUnitTimePitch()
        timePitch.pitch = 0

        do {
            try AudioIO.enableVoiceProcessingIfRequested(
                configuration.enableAEC
            ) { enabled in
                try inputNode.setVoiceProcessingEnabled(enabled)
            }
        } catch {
            setState(.failed(
                "Cannot enable acoustic echo cancellation: \(error.localizedDescription)"))
            throw error
        }

        if configuration.enableAEC {
            inputNode.isVoiceProcessingBypassed = false
            inputNode.isVoiceProcessingInputMuted = false
            inputNode.isVoiceProcessingAGCEnabled = true
            inputNode.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                    enableAdvancedDucking: false, duckingLevel: .min)
        }

        // Capture can be configured immediately after Voice Processing is
        // enabled. Playback is attached only after `engine.start()` below:
        // on macOS the output-side Voice Processing format settles
        // asynchronously and a pre-start player connection can retain the
        // stale hardware rate, causing AUVP initialization to fail.
        let hardwareFormat = inputNode.outputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0,
              hardwareFormat.channelCount > 0,
              let monoFormat = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: hardwareFormat.sampleRate,
                  channels: 1,
                  interleaved: false),
              let targetFormat = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: Double(configuration.inputSampleRate),
                  channels: 1,
                  interleaved: false),
              let converter = AVAudioConverter(
                  from: monoFormat, to: targetFormat),
              let playbackSourceFormat = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: Double(configuration.outputSampleRate),
                  channels: 1,
                  interleaved: false)
        else {
            let error = FullDuplexAudioError.invalidDeviceFormat
            setState(.failed(error.description))
            throw error
        }

        inputNode.installTap(
            onBus: 0,
            bufferSize: AVAudioFrameCount(configuration.inputBufferFrames),
            format: hardwareFormat
        ) { [weak self] buffer, _ in
            guard let self,
                  let source = buffer.floatChannelData,
                  buffer.frameLength > 0,
                  let mono = AVAudioPCMBuffer(
                      pcmFormat: monoFormat,
                      frameCapacity: buffer.frameCapacity)
            else { return }

            mono.frameLength = buffer.frameLength
            memcpy(
                mono.floatChannelData![0], source[0],
                Int(buffer.frameLength) * MemoryLayout<Float>.size)

            guard let samples = AudioIO.resampleMicrophoneBuffer(
                mono, with: converter, to: targetFormat),
                !samples.isEmpty
            else { return }

            var sum: Float = 0
            for sample in samples { sum += sample * sample }
            guard self.setMicrophoneLevelIfRunning(
                sqrt(sum / Float(max(samples.count, 1))), samples: samples.count)
            else { return }
            onSamples(samples)
        }

        var playerAttached = false
        var meterAttached = false
        let attachPlayer = {
            engine.attach(playerNode)
            engine.attach(timePitch)
            engine.connect(playerNode, to: timePitch, format: nil)
            engine.connect(timePitch, to: engine.mainMixerNode, format: nil)
        }
        do {
            // The two paths need opposite orderings, and using the Voice
            // Processing ordering for both is what made `--no-aec` capture
            // nothing at all.
            //
            // With Voice Processing, the capture graph must start before any
            // playback source is added: `setVoiceProcessingEnabled` returns
            // before the macOS output client has finished moving from the
            // hardware rate to its negotiated rate, and starting here is the
            // synchronization boundary that makes the live format safe.
            //
            // Without it, the engine is an ordinary input/output graph, and
            // attaching a player after `start()` leaves the input tap silent
            // forever — measured as zero tap callbacks, on matched and
            // mismatched devices alike, while the same graph attached before
            // `start()` delivers ~10 callbacks per second. The session then
            // hangs, because frame-driven limits like `--max-seconds` never
            // advance without captured frames.
            if !configuration.enableAEC {
                attachPlayer()
                playerAttached = true
            }

            try engine.start()

            if !playerAttached {
                attachPlayer()
                playerAttached = true
            }
            if configuration.enableAEC {
                guard inputNode.isVoiceProcessingEnabled,
                      engine.outputNode.isVoiceProcessingEnabled,
                      !inputNode.isVoiceProcessingBypassed else {
                    throw FullDuplexAudioError.invalidConfiguration(
                        "Voice Processing is inactive or bypassed on the audio route")
                }
            }
            let playbackFormat = playerNode.outputFormat(forBus: 0)
            guard playbackFormat.sampleRate > 0,
                  playbackFormat.channelCount > 0,
                  let playbackConverter = AVAudioConverter(
                      from: playbackSourceFormat, to: playbackFormat)
            else {
                throw FullDuplexAudioError.invalidDeviceFormat
            }

            engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1_024, format: nil) { [weak self] buffer, _ in
                guard let self, let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
                var sum: Float = 0
                for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
                self.lock.withLock {
                    guard self.audioState == .running, !self.stopping else { return }
                    self.playbackLevel = sqrt(sum / Float(buffer.frameLength))
                    if self.playbackLevel > 0.001 && self.firstOutputTime == 0 && self.scheduledBuffers > self.completedBuffers { self.firstOutputTime = ProcessInfo.processInfo.systemUptime }
                    self.outputSamples += Int(buffer.frameLength)
                }
            }
            meterAttached = true

            lock.lock()
            self.engine = engine
            self.playerNode = playerNode
            self.timePitch = timePitch
            self.playbackSourceFormat = playbackSourceFormat
            self.playbackFormat = playbackFormat
            self.playbackConverter = playbackConverter
            self.prebuffer = []
            self.playbackPrebufferTarget = configuration.playbackPrebufferFrames
            self.playbackStarted = false
            self.playbackPaused = false
            self.playbackGeneration &+= 1
            self.stopping = false
            self.scheduledBuffers = 0
            self.completedBuffers = 0
            self.underruns = 0
            self.accounting = .init()
            self.capturedSamples = 0
            self.outputSamples = 0
            self.microphoneLevel = 0
            self.playbackLevel = 0
            self.outputTapInstalled = true
            self.audioState = .running
            lock.unlock()
            Self.log.info(
                "Full-duplex audio started: input \(self.configuration.inputSampleRate) Hz, output \(self.configuration.outputSampleRate) Hz, AEC \(self.configuration.enableAEC ? "on" : "off")")
        } catch {
            inputNode.removeTap(onBus: 0)
            if meterAttached { engine.mainMixerNode.removeTap(onBus: 0) }
            if playerAttached {
                engine.disconnectNodeOutput(playerNode)
                engine.detach(playerNode)
                engine.detach(timePitch)
            }
            engine.stop()
            setState(.failed(error.localizedDescription))
            throw error
        }
    }

    /// Queue one contiguous model-audio chunk for echo-reference-aware output.
    public func schedulePlayback(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        lock.lock()
        let format = playbackSourceFormat
        let running = audioState == .running && !stopping
        lock.unlock()
        guard running, let format,
              let buffer = AVAudioPCMBuffer(
                  pcmFormat: format,
                  frameCapacity: AVAudioFrameCount(samples.count))
        else { return }

        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            guard let base = source.baseAddress else { return }
            buffer.floatChannelData![0].update(
                from: base, count: samples.count)
        }

        playbackQueue.async { [weak self] in
            self?.convertAndEnqueue(buffer)
        }
    }

    /// Ease into a pause while recognition validates a possible interruption.
    public func pausePlayback() {
        withPlaybackQueue {
            lock.lock(); playbackPaused = true; accounting.discardTentativeGap()
            let node = playerNode; lock.unlock()
            guard let node else { return }
            envelope(node, volume: 0, rate: 0.8, duration: 0.24) { node.pause() }
        }
    }

    /// Continue the existing player cursor; never replay buffers or rewind words.
    public func resumePlayback() {
        withPlaybackQueue {
            lock.lock(); playbackPaused = false; accounting.discardTentativeGap()
            let node = playerNode
            let shouldPlay = audioState == .running && !stopping && playbackStarted && scheduledBuffers > completedBuffers
            lock.unlock()
            guard let node else { return }
            if shouldPlay { node.play() }
            envelope(node, volume: 1, rate: 1, duration: 0.4)
        }
    }

    /// A cancellable envelope leaves the capture and control queues responsive during a fade.
    private func envelope(_ node: AVAudioPlayerNode, volume: Float, rate: Float, duration: Double,
                          completed: @escaping () -> Void = {}) {
        playbackEnvelope?.setEventHandler {}; playbackEnvelope?.cancel()
        let envelope = PlaybackEnvelope(started: ProcessInfo.processInfo.systemUptime, duration: duration,
                                        initialVolume: node.volume, initialRate: timePitch?.rate ?? 1,
                                        volume: volume, rate: rate)
        let timer = DispatchSource.makeTimerSource(queue: playbackQueue)
        playbackEnvelope = timer
        timer.schedule(deadline: .now(), repeating: .milliseconds(10))
        timer.setEventHandler { [weak self, weak node] in
            guard let self, let node else { timer.setEventHandler {}; timer.cancel(); return }
            let value = envelope.value(at: ProcessInfo.processInfo.systemUptime)
            node.volume = value.volume
            self.timePitch?.rate = value.rate
            if value.finished {
                timer.setEventHandler {}; timer.cancel(); self.playbackEnvelope = nil
                completed()
            }
        }
        timer.resume()
    }

    private func playUnlessPaused(_ node: AVAudioPlayerNode) {
        lock.lock(); let allowed = !playbackPaused && audioState == .running && !stopping; lock.unlock()
        if allowed && !node.isPlaying { node.play() }
    }

    /// Discard queued speech without stopping microphone capture or AEC.
    /// Work already on the serial playback queue completes before this reset;
    /// completion callbacks from the old generation cannot restart playback.
    public func interruptPlayback(fade: Bool = false) {
        withPlaybackQueue {
            if fade, let node = playerNode, node.isPlaying {
                envelope(node, volume: 0, rate: 0.8, duration: 0.24) { [weak self] in self?.interruptPlayback() }
                return
            }
            playbackEnvelope?.setEventHandler {}; playbackEnvelope?.cancel(); playbackEnvelope = nil
            timePitch?.rate = 1
            lock.lock()
            playbackGeneration &+= 1
            accounting.interrupt()
            let node = playerNode
            scheduledBuffers = 0
            completedBuffers = 0
            playbackStarted = false
            playbackPaused = false
            playbackLevel = 0
            firstOutputTime = 0
            lock.unlock()
            node?.stop()
            timePitch?.reset()
            node?.volume = 1
            prebuffer.removeAll(keepingCapacity: true)
            playbackPrebufferTarget = configuration.playbackPrebufferFrames
            playbackConverter?.reset()
        }
    }

    /// Report the negotiated engine state, rather than the requested flag.
    public var voiceProcessingStatus: String {
        lock.lock()
        defer { lock.unlock() }
        guard let engine else { return "audio engine stopped" }
        return "AEC input=\(engine.inputNode.isVoiceProcessingEnabled) "
            + "output=\(engine.outputNode.isVoiceProcessingEnabled) "
            + "bypassed=\(engine.inputNode.isVoiceProcessingBypassed) "
            + "capture=\(engine.inputNode.outputFormat(forBus: 0)) "
            + "playback=\(engine.outputNode.inputFormat(forBus: 0))"
    }

    public func statistics() -> Statistics {
        lock.lock()
        defer { lock.unlock() }
        return Statistics(
            scheduledBuffers: scheduledBuffers,
            completedBuffers: completedBuffers,
            underruns: accounting.underruns,
            microphoneLevel: microphoneLevel,
            playbackLevel: playbackLevel,
            capturedSamples: capturedSamples,
            outputSamples: outputSamples,
            queuedSeconds: accounting.queuedSeconds, bufferDrains: accounting.bufferDrains, starvationSeconds: accounting.starvationSeconds)
    }

    public func stop() {
        lock.lock()
        guard engine != nil || playerNode != nil else {
            audioState = .stopped
            lock.unlock()
            return
        }
        stopping = true
        playbackGeneration &+= 1
        accounting.interrupt()
        let engine = self.engine
        let node = playerNode
        let timePitch = self.timePitch
        let hadOutputTap = outputTapInstalled
        outputTapInstalled = false
        self.engine = nil
        playerNode = nil
        self.timePitch = nil
        playbackSourceFormat = nil
        playbackFormat = nil
        playbackConverter = nil
        audioState = .stopped
        microphoneLevel = 0
        playbackLevel = 0
        lock.unlock()

        if hadOutputTap { engine?.mainMixerNode.removeTap(onBus: 0) }
        engine?.inputNode.removeTap(onBus: 0)
        withPlaybackQueue {
            playbackEnvelope?.setEventHandler {}; playbackEnvelope?.cancel(); playbackEnvelope = nil
            node?.stop()
            prebuffer.removeAll(keepingCapacity: false)
            playbackPrebufferTarget = configuration.playbackPrebufferFrames
            playbackStarted = false
            playbackPaused = false
        }
        if let engine, let node {
            engine.disconnectNodeOutput(node)
            engine.detach(node)
        }
        if let timePitch { engine?.detach(timePitch) }
        engine?.stop()
    }

    deinit {
        stop()
    }

    public func synchronizePlayback() { withPlaybackQueue {} }
    public var benchmarkFirstOutputTime: Double { lock.lock(); defer { lock.unlock() }; return firstOutputTime }

    /// Start an audio utterance without treating a preceding tool wait as starvation.
    public func beginPlayback() {
        playbackQueue.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.accounting.begin(); self.lock.unlock()
            if !self.playbackStarted { self.playbackPrebufferTarget = self.configuration.playbackPrebufferFrames }
        }
    }

    /// Flush a completed producer's short tail below the restart threshold.
    public func finishPlayback() {
        playbackQueue.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            guard self.audioState == .running, !self.stopping, let node = self.playerNode else { self.lock.unlock(); return }
            let generation = self.playbackGeneration
            self.accounting.finish()
            self.lock.unlock()
            let pending = self.prebuffer
            self.prebuffer.removeAll(keepingCapacity: true)
            guard !pending.isEmpty else { return }
            for item in pending { self.schedule(item.buffer, on: node, generation: generation, ticket: item.ticket) }
            self.lock.lock(); self.playbackStarted = true; self.lock.unlock()
            playUnlessPaused(node)
        }
    }

    private func convertAndEnqueue(_ source: AVAudioPCMBuffer) {
        lock.lock()
        let format = playbackFormat
        let converter = playbackConverter
        let running = audioState == .running && !stopping
        lock.unlock()
        guard running, let format, let converter,
              let buffer = Self.convertPlaybackBuffer(
                  source, with: converter, to: format),
              buffer.frameLength > 0
        else { return }
        enqueue(buffer)
    }

    /// Convert model-rate mono audio to the exact Voice Processing playback
    /// client format. Returning the PCM buffer directly preserves every
    /// output channel produced by `AVAudioConverter` (normally stereo on Mac).
    private static func convertPlaybackBuffer(
        _ inputBuffer: AVAudioPCMBuffer,
        with converter: AVAudioConverter,
        to targetFormat: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
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
        return outputBuffer
    }

    private func enqueue(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard audioState == .running, !stopping, let node = playerNode else {
            lock.unlock()
            return
        }
        let started = playbackStarted
        let generation = playbackGeneration
        let (ticket, resumed) = accounting.append(seconds: Double(buffer.frameLength) / buffer.format.sampleRate, now: ProcessInfo.processInfo.systemUptime)
        lock.unlock()
        if resumed { playbackPrebufferTarget = Self.recoveryPrebufferFrames(initial: configuration.playbackPrebufferFrames) }

        if !started {
            prebuffer.append(.init(buffer: buffer, ticket: ticket))
            guard prebuffer.count >= playbackPrebufferTarget else {
                return
            }
            let pending = prebuffer
            prebuffer.removeAll(keepingCapacity: true)
            for item in pending {
                schedule(item.buffer, on: node, generation: generation, ticket: item.ticket)
            }
            lock.lock()
            playbackStarted = true
            lock.unlock()
            playUnlessPaused(node)
            return
        }

        schedule(buffer, on: node, generation: generation, ticket: ticket)
        playUnlessPaused(node)
    }

    private func schedule(
        _ buffer: AVAudioPCMBuffer,
        on node: AVAudioPlayerNode,
        generation: Int,
        ticket: PlaybackAccounting.Ticket
    ) {
        lock.lock()
        guard generation == playbackGeneration,
              playerNode === node,
              audioState == .running,
              !stopping else {
            lock.unlock()
            return
        }
        scheduledBuffers += 1
        lock.unlock()
        node.scheduleBuffer(
            buffer,
            completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            self?.playbackQueue.async { [weak self] in
                self?.bufferCompleted(node: node, generation: generation, ticket: ticket)
            }
        }
    }

    private func bufferCompleted(
        node: AVAudioPlayerNode,
        generation: Int,
        ticket: PlaybackAccounting.Ticket
    ) {
        lock.lock()
        guard generation == playbackGeneration,
              playerNode === node else {
            lock.unlock()
            return
        }
        completedBuffers += 1
        let drained = accounting.complete(ticket, now: ProcessInfo.processInfo.systemUptime)
            && audioState == .running && !stopping
        if drained { playbackStarted = false }
        lock.unlock()
        if drained { node.pause() }
    }

    private func setState(_ newState: State) {
        lock.lock()
        audioState = newState
        lock.unlock()
    }

    /// Publish capture state only while this engine generation is active, so
    /// an in-flight tap callback cannot deliver samples after `stop()`.
    private func setMicrophoneLevelIfRunning(_ level: Float, samples: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard audioState == .running, !stopping else { return false }
        microphoneLevel = level
        capturedSamples += samples
        return true
    }

    /// Run teardown in-order without synchronously dispatching back onto the
    /// playback queue when the final strong reference is released there.
    private func withPlaybackQueue(_ body: () -> Void) {
        if DispatchQueue.getSpecific(key: playbackQueueKey) != nil {
            body()
        } else {
            playbackQueue.sync(execute: body)
        }
    }
}

public enum FullDuplexAudioError: Error, CustomStringConvertible, LocalizedError {
    case invalidConfiguration(String)
    case invalidDeviceFormat

    public var description: String {
        switch self {
        case .invalidConfiguration(let message):
            return "invalid full-duplex audio configuration: \(message)"
        case .invalidDeviceFormat:
            return "the selected audio device has no usable input/output format"
        }
    }

    public var errorDescription: String? { description }
}
#endif
