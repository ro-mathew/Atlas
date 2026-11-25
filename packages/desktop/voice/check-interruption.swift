// Controlled offline audio only; never creates a capture route or opens a microphone.
import AVFoundation
import Foundation

@main
struct CheckInterruption {
    static func main() throws {
        try FileManager.default.createDirectory(atPath: "build/voice/verification", withIntermediateDirectories: true)
        let fade = PlaybackEnvelope(started: 1, duration: 0.24, initialVolume: 1, initialRate: 1, volume: 0, rate: 0.8)
        precondition(fade.value(at: 1).volume == 1)
        precondition(abs(fade.value(at: 1.12).rate - 0.9) < 0.001)
        precondition(fade.value(at: 1.24).finished && fade.value(at: 1.24).volume == 0)
        let recovery = PlaybackEnvelope(started: 1.12, duration: 0.4, initialVolume: fade.value(at: 1.12).volume,
                                       initialRate: fade.value(at: 1.12).rate, volume: 1, rate: 1)
        precondition(recovery.value(at: 1.12).volume == fade.value(at: 1.12).volume)
        precondition(recovery.value(at: 1.52).finished && recovery.value(at: 1.52).rate == 1)

        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
        for genuine in [false, true] {
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            let pitch = AVAudioUnitTimePitch()
            engine.attach(player); engine.attach(pitch)
            engine.connect(player, to: pitch, format: format)
            engine.connect(pitch, to: engine.mainMixerNode, format: format)
            try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 240)
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48000)!
            pcm.frameLength = 48000
            for index in 0..<48000 { pcm.floatChannelData![0][index] = 0.5 * sin(Float(index) * 2 * .pi * 400 / 24000) }
            player.scheduleBuffer(pcm)
            try engine.start(); player.play()
            let block = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 240)!
            let output = try AVAudioFile(forWriting: URL(fileURLWithPath: "build/voice/verification/interruption-\(genuine ? "genuine" : "false-alarm").wav"), settings: format.settings)
            var envelope: PlaybackEnvelope?
            var samples: [Float] = []
            for frame in 0..<300 {
                let time = Double(frame) * 0.01
                if frame == 50 { envelope = .init(started: time, duration: 0.24, initialVolume: player.volume, initialRate: pitch.rate, volume: 0, rate: 0.8) }
                if frame == 90 && !genuine {
                    player.play()
                    envelope = .init(started: time, duration: 0.4, initialVolume: player.volume, initialRate: pitch.rate, volume: 1, rate: 1)
                }
                if let envelope {
                    let value = envelope.value(at: time)
                    player.volume = value.volume; pitch.rate = value.rate
                    if value.finished && value.volume == 0 { player.pause() }
                }
                guard try engine.renderOffline(240, to: block) == .success else { fatalError("Offline playback did not render") }
                samples += Array(UnsafeBufferPointer(start: block.floatChannelData![0], count: Int(block.frameLength)))
                try output.write(from: block)
            }
            let tone = Array(samples[6000..<9600])
            let crossings = zip(tone, tone.dropFirst()).filter { $0 <= 0 && $1 > 0 }.count
            precondition((55...65).contains(crossings), "The native time stretcher shifted the test tone's pitch")
            let after = samples[36000..<42000].reduce(Float(0)) { $0 + $1 * $1 }
            precondition(genuine ? after < 0.001 : after > 1, "Interruption recovery did not match its outcome")
            engine.stop()
            print("\(genuine ? "Genuine interruption" : "False alarm"): pitch and envelope verified")
        }
    }
}
