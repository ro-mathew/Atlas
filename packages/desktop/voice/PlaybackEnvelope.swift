import Foundation

/// The timer and offline checks share the same smooth gain/rate trajectory.
struct PlaybackEnvelope {
    let started: Double
    let duration: Double
    let initialVolume: Float
    let initialRate: Float
    let volume: Float
    let rate: Float

    func value(at time: Double) -> (volume: Float, rate: Float, finished: Bool) {
        let finished = time >= started + duration
        let elapsed = finished ? 1 : max(0, (time - started) / duration)
        let progress = Float(elapsed * elapsed * (3 - 2 * elapsed))
        return (initialVolume + (volume - initialVolume) * progress,
                initialRate + (rate - initialRate) * progress, finished)
    }
}
