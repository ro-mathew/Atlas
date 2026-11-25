/** Short overlapping grains change pace without resampling (and therefore without shifting pitch). */
export class VoicePlayback {
  private pcm = new Float32Array(24000)
  private length = 0
  private position = 0
  private tail: Float32Array
  private hop: Float32Array
  private cursor: number
  private first = true
  private finished = false
  private paused = false
  private ending = false
  private volume = 1
  private rate = 1
  private fromVolume = 1
  private fromRate = 1
  private targetVolume = 1
  private targetRate = 1
  private ramp = 0
  private elapsed = 0
  private readonly size: number

  constructor(private readonly sampleRate: number) {
    this.size = Math.round(sampleRate * 0.02)
    this.tail = new Float32Array(this.size)
    this.hop = new Float32Array(this.size)
    this.cursor = this.size
  }

  append(pcm: Float32Array) {
    if (this.length + pcm.length > this.pcm.length) {
      const next = new Float32Array(Math.max(this.pcm.length * 2, this.length + pcm.length))
      next.set(this.pcm)
      this.pcm = next
    }

    this.pcm.set(pcm, this.length)
    this.length += pcm.length
  }

  finish() {
    this.finished = true
  }

  reset() {
    this.length = 0
    this.position = 0
    this.cursor = this.size
    this.first = true
    this.finished = false
    this.paused = false
    this.ending = false
    this.volume = this.rate = this.targetVolume = this.targetRate = 1
    this.ramp = this.elapsed = 0
    this.tail.fill(0)
  }

  interrupt(end = false) {
    this.ending = end
    this.envelope(0, 0.8, 0.24)

    if (this.first) {
      this.volume = 0
      this.rate = 0.8
      this.hold()
    }
  }

  resume() {
    if (this.ending) return
    this.envelope(1, 1, 0.4)
  }

  get drained() {
    return this.finished && this.cursor >= this.size && this.position >= this.length + this.size
  }

  render(output: Float32Array) {
    output.fill(0)

    for (let index = 0; index < output.length; index++) {
      if (this.paused) break

      if (this.elapsed < this.ramp) {
        const fraction = ++this.elapsed / this.ramp
        const progress = fraction * fraction * (3 - 2 * fraction)
        this.volume = this.fromVolume + (this.targetVolume - this.fromVolume) * progress
        this.rate = this.fromRate + (this.targetRate - this.fromRate) * progress
      }

      if (this.elapsed >= this.ramp && this.targetVolume === 0) {
        this.hold()
        break
      }

      // The envelope follows audio time even while model PCM is temporarily unavailable.
      if (this.cursor >= this.size && !this.grain()) continue
      output[index] = this.hop[this.cursor++] * this.volume
    }
  }

  private hold() {
    this.paused = true

    if (!this.ending) return
    this.length = 0
    this.position = this.size
    this.cursor = this.size
    this.finished = true
  }

  private envelope(volume: number, rate: number, seconds: number) {
    this.fromVolume = this.volume
    this.fromRate = this.rate
    this.targetVolume = volume
    this.targetRate = rate
    this.ramp = Math.round(seconds * this.sampleRate)
    this.elapsed = 0
    this.paused = false
  }

  private grain() {
    const expected = Math.round(this.position)
    const search = Math.round(this.sampleRate * 0.005)

    if (!this.finished && expected + this.size * 2 + search > this.length) return false

    if (this.finished && expected >= this.length + this.size) return false
    let start = expected

    if (!this.first && this.rate !== 1) {
      let best = -Infinity

      for (
        let offset = Math.max(0, expected - search);
        offset <= Math.min(this.length, expected + search);
        offset += 2
      ) {
        let correlation = 0
        let energy = 0.000001

        for (let index = 0; index < this.size; index += 4) {
          const value = this.pcm[offset + index] ?? 0
          correlation += this.tail[index] * value
          energy += value * value
        }

        const score = correlation / Math.sqrt(energy)

        if (score > best) {
          best = score
          start = offset
        }
      }
    }

    for (let index = 0; index < this.size; index++) {
      const value = this.pcm[start + index] ?? 0
      const weight = this.first ? 1 : index / this.size
      this.hop[index] = this.tail[index] * (1 - weight) + value * weight
      this.tail[index] = this.pcm[start + this.size + index] ?? 0
    }

    this.first = false
    this.cursor = 0
    this.position += this.size * this.rate

    return true
  }
}
