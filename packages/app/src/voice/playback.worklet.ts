import { VoicePlayback } from "./playback"

declare const sampleRate: number

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

type Command =
  | { type: "start"; id: string }
  | { type: "pcm"; pcm: Float32Array }
  | { type: "finish" | "pause" | "resume" | "cancel" }
  | { type: "fade" }

class VoicePlaybackProcessor extends AudioWorkletProcessor {
  private readonly playback = new VoicePlayback(sampleRate)
  private id?: string

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<Command>) => {
      const command = event.data

      if (command.type === "start") {
        this.playback.reset()
        this.id = command.id
      }

      if (command.type === "pcm") this.playback.append(command.pcm)

      if (command.type === "finish") this.playback.finish()

      if (command.type === "pause") this.playback.interrupt()

      if (command.type === "resume") this.playback.resume()

      if (command.type === "fade") this.playback.interrupt(true)

      if (command.type === "cancel") {
        this.playback.reset()
        this.id = undefined
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    this.playback.render(outputs[0][0])

    if (this.id && this.playback.drained) {
      this.port.postMessage({ type: "drained", id: this.id })
      this.id = undefined
    }

    return true
  }
}

registerProcessor("opencode-voice-playback", VoicePlaybackProcessor)
