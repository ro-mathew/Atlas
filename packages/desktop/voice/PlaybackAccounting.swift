import Foundation

/// Called under the audio lock. Gaps are confirmed by resumed data, not a normal final drain.
struct PlaybackAccounting {
    struct Ticket: Equatable { let generation: Int; let producer: Int; let sequence: Int }
    private struct Pending { let producer: Int; let seconds: Double }
    private var generation = 0, producer = 0, sequence = 0
    private var open = false
    private var pending: [Int: Pending] = [:]
    private var gapStarted: Double?
    private(set) var queuedSeconds = 0.0
    private(set) var bufferDrains = 0
    private(set) var underruns = 0
    private(set) var starvationSeconds = 0.0
    var queuedBuffers: Int { pending.count }
    mutating func begin() { producer += 1; open = true; gapStarted = nil }
    mutating func append(seconds: Double, now: Double) -> (Ticket, Bool) {
        if !open { begin() }
        var resumed = false
        if let start = gapStarted {
            underruns += 1; starvationSeconds += max(0, now - start)
            gapStarted = nil; resumed = true
        }
        sequence += 1
        pending[sequence] = .init(producer: producer, seconds: seconds)
        queuedSeconds += seconds
        return (.init(generation: generation, producer: producer, sequence: sequence), resumed)
    }
    @discardableResult mutating func complete(_ ticket: Ticket, now: Double) -> Bool {
        guard ticket.generation == generation, let item = pending.removeValue(forKey: ticket.sequence) else { return false }
        queuedSeconds = max(0, queuedSeconds - item.seconds)
        guard pending.isEmpty else { return false }
        queuedSeconds = 0
        bufferDrains += 1
        if open && ticket.producer == producer { gapStarted = now }
        return true
    }
    mutating func discardTentativeGap() { gapStarted = nil }
    mutating func finish() { open = false; gapStarted = nil }
    mutating func interrupt() {
        generation += 1; open = false; gapStarted = nil; pending.removeAll(keepingCapacity: true); queuedSeconds = 0
    }
}
