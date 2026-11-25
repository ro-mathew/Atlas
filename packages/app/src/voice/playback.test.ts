import { expect, test } from "bun:test"
import { VoicePlayback } from "./playback"

const sampleRate = 24000

const tone = (seconds: number, frequency = 400) =>
  Float32Array.from(
    { length: seconds * sampleRate },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.5,
  )

const crossings = (pcm: Float32Array) =>
  pcm.reduce((count, value, index) => count + (index > 0 && value > 0 && pcm[index - 1] <= 0 ? 1 : 0), 0)

const energy = (pcm: Float32Array) => pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length

function render(playback: VoicePlayback, seconds: number) {
  const pcm = new Float32Array(Math.round(seconds * sampleRate))
  playback.render(pcm)

  return pcm
}

test("normal streamed playback preserves PCM and reports completion only after the final tail", () => {
  const playback = new VoicePlayback(sampleRate)
  const pcm = tone(1)
  playback.append(pcm)
  const output = render(playback, 0.5)
  expect(output).toEqual(pcm.slice(0, output.length))
  expect(playback.drained).toBe(false)
  playback.finish()
  render(playback, 0.6)
  expect(playback.drained).toBe(true)
})

test("a tentative interruption slows without shifting pitch and fades into a held cursor", () => {
  const playback = new VoicePlayback(sampleRate)
  playback.append(tone(3))
  render(playback, 0.1)
  playback.interrupt()
  const fading = render(playback, 0.2)
  expect(crossings(fading)).toBeGreaterThanOrEqual(76)
  expect(crossings(fading)).toBeLessThanOrEqual(84)
  expect(energy(fading.slice(-1200))).toBeLessThan(energy(fading.slice(0, 1200)))
  render(playback, 0.1)
  expect(energy(render(playback, 0.5))).toBe(0)
  expect(playback.drained).toBe(false)
  playback.resume()
  const recovery = render(playback, 0.4)
  expect(crossings(recovery)).toBeGreaterThan(150)
  expect(energy(recovery.slice(-1200))).toBeGreaterThan(energy(recovery.slice(0, 1200)))
  playback.finish()
  render(playback, 4)
  expect(playback.drained).toBe(true)
})

test("a false alarm during the fade reverses smoothly instead of jumping to full volume", () => {
  const playback = new VoicePlayback(sampleRate)
  playback.append(Float32Array.from({ length: sampleRate }, () => 0.5))
  playback.interrupt()
  const fading = render(playback, 0.1)
  playback.resume()
  const resumed = render(playback, 0.4)
  expect(Math.abs(resumed[0] - fading.at(-1)!)).toBeLessThan(0.001)
  expect(resumed.at(-1)!).toBeCloseTo(0.5)
})

test("a genuine interruption trails off, discards the tail and cannot resume it", () => {
  const playback = new VoicePlayback(sampleRate)
  playback.append(tone(3))
  render(playback, 0.1)
  playback.interrupt(true)
  const fading = render(playback, 0.24)
  expect(energy(fading)).toBeGreaterThan(0)
  expect(playback.drained).toBe(true)
  playback.resume()
  expect(energy(render(playback, 0.5))).toBe(0)
  playback.reset()
  playback.append(tone(0.1))
  playback.finish()
  expect(energy(render(playback, 0.1))).toBeGreaterThan(0.1)
})

test("stream starvation preserves the pending cursor until more PCM arrives", () => {
  const playback = new VoicePlayback(sampleRate)
  const pcm = tone(0.2)
  playback.append(pcm.slice(0, 1200))
  const output = render(playback, 0.02)
  expect(output).toEqual(pcm.slice(0, 480))
  render(playback, 0.1)
  playback.append(pcm.slice(1200))
  playback.finish()
  const continued = render(playback, 0.02)
  expect(continued).toEqual(pcm.slice(480, 960))
})

test("false-alarm recovery continues in the current phrase instead of replaying earlier audio", () => {
  const playback = new VoicePlayback(sampleRate)
  playback.append(tone(1, 400))
  playback.append(tone(2, 800))
  render(playback, 1.3)
  playback.interrupt()
  render(playback, 0.3)
  playback.resume()
  const resumed = render(playback, 0.4)
  expect(crossings(resumed)).toBeGreaterThan(310)
  expect(crossings(resumed)).toBeLessThan(330)
})

test("a possible interruption before the first audio packet holds playback until recovery", () => {
  const playback = new VoicePlayback(sampleRate)
  playback.interrupt()
  playback.append(tone(1))
  expect(energy(render(playback, 0.5))).toBe(0)
  playback.resume()
  expect(energy(render(playback, 0.4))).toBeGreaterThan(0.01)
})

test("the hesitation finishes during a stream gap and holds later packets until recovery", () => {
  const playback = new VoicePlayback(sampleRate)
  playback.append(tone(0.08))
  render(playback, 0.1)
  playback.interrupt()
  render(playback, 0.3)
  playback.append(tone(1))
  expect(energy(render(playback, 0.3))).toBe(0)
  playback.resume()
  expect(energy(render(playback, 0.4))).toBeGreaterThan(0.01)
})
