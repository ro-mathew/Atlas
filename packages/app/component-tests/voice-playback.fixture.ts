import playbackWorklet from "../src/voice/playback.worklet.ts?worker&url"

/** Runs the real worklet through a silent output route; never opens a microphone or calls a provider. */
export async function renderInterruption(genuine: boolean) {
  const context = new AudioContext({ sampleRate: 24000 })
  await context.audioWorklet.addModule(playbackWorklet)

  const player = new AudioWorkletNode(context, "opencode-voice-playback", {
    numberOfInputs: 0,
    outputChannelCount: [1],
  })

  const analyser = context.createAnalyser()
  const silent = context.createGain()
  silent.gain.value = 0
  player.connect(analyser)
  analyser.connect(silent)
  silent.connect(context.destination)
  const drained: string[] = []
  const finished = Promise.withResolvers<void>()

  const timeout = setTimeout(
    () => finished.reject(new Error("The worklet did not acknowledge playback completion")),
    5000,
  )

  player.port.onmessage = (event: MessageEvent<{ id: string }>) => {
    drained.push(event.data.id)
    finished.resolve()
  }

  player.onprocessorerror = () => finished.reject(new Error("The hosted playback worklet failed"))
  await context.resume()

  const pcm = Float32Array.from(
    { length: 24000 * 1.2 },
    (_, index) => Math.sin((2 * Math.PI * 400 * index) / 24000) * 0.5,
  )

  player.port.postMessage({ type: "start", id: "controlled" })
  player.port.postMessage({ type: "pcm", pcm }, [pcm.buffer])
  player.port.postMessage({ type: "finish" })

  const energy = () => {
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)

    return samples.reduce((sum, value) => sum + value * value, 0) / samples.length
  }

  // These waits observe actual audio rendering; fake timers cannot advance the audio thread.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const initial = energy()
  player.port.postMessage({ type: genuine ? "fade" : "pause" })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const held = energy()
  player.port.postMessage({ type: "resume" })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const recovered = energy()
  await finished.promise
  clearTimeout(timeout)
  player.port.close()
  player.disconnect()
  await context.close()

  return { drained, initial, held, recovered }
}
