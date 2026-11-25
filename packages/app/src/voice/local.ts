import { Option, Schema } from "effect"
import { uuid } from "@opencode/util/uuid"
import type { VoiceBridge, VoiceEngine, VoiceEngineOptions, VoiceOutput, VoiceCommand } from "./engine"
import { VoiceFailure } from "./failure"
import { voiceInstructions } from "./prompts"

const Message = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("levels"), mic: Schema.Number, speaker: Schema.Number }),
  Schema.Struct({ type: Schema.Literals(["speech.started", "speech.discarded", "output.ended"]), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literals(["transcript.partial", "transcript.final"]),
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    reason: Schema.Literals(["runtime", "speechAsset", "microphone", "recognition"]),
  }),
])

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Message))

/** PCM remains in the native worker. This adapter moves only typed control and recognition events. */
export function createLocalVoice(bridge: VoiceBridge, options: VoiceEngineOptions): VoiceEngine {
  const id = uuid()
  const controller = new AbortController()
  const joined = Promise.withResolvers<void>()
  const outputs = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  let pollTimer: ReturnType<typeof setTimeout> | undefined

  const write = (command: VoiceCommand) => {
    if (controller.signal.aborted) return
    void bridge.write(id, command).catch(() => options.dropped())
  }

  const poll = async () => {
    const messages = await bridge.read(id).catch(() => undefined)

    if (controller.signal.aborted) return

    if (!messages) {
      joined.reject(new VoiceFailure("runtime"))
      options.dropped("runtime")

      return
    }

    messages.forEach((line) => {
      const message = Option.getOrUndefined(decode(line))

      if (!message) return

      if (message.type === "ready") return joined.resolve()

      if (message.type === "failed") {
        joined.reject(new VoiceFailure(message.reason))
        outputs.forEach((output) => output.reject(new VoiceFailure(message.reason)))
        options.dropped(message.reason)

        return
      }

      if (message.type === "levels") return options.levels(message.mic, message.speaker)

      if (message.type === "output.ended") {
        outputs.get(message.id)?.resolve()
        outputs.delete(message.id)

        return
      }

      if (message.type === "speech.started" || message.type === "speech.discarded")
        options.input({ type: message.type, id: message.id })

      if (message.type === "transcript.partial" || message.type === "transcript.final")
        options.input({ type: message.type, id: message.id, text: message.text })
    })
    pollTimer = setTimeout(poll, 50)
  }

  const cancel = (fade?: boolean) => {
    write(fade ? { type: "cancel", fade } : { type: "cancel" })
    outputs.forEach((output) => output.resolve())
    outputs.clear()
  }

  return {
    async connect(signal) {
      void joined.promise.catch(() => undefined)

      if (!(await bridge.available()) || !options.preferences.runtime || !options.preferences.localModel)
        throw new VoiceFailure("configuration")
      signal.throwIfAborted()
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal })
      controller.signal.addEventListener("abort", () => joined.reject(controller.signal.reason), { once: true })
      await bridge
        .start(id, {
          runtime: options.preferences.runtime,
          model: options.preferences.localModel,
          language: options.preferences.language,
          activityDelay: options.preferences.activityDelay,
          delivery: voiceInstructions(options.preferences),
        })
        .catch(() => {
          throw new VoiceFailure("configuration")
        })

      if (controller.signal.aborted) {
        await bridge.stop(id)
        controller.signal.throwIfAborted()
      }

      void poll()
      await joined.promise
    },
    mute: (muted) => write({ type: "mute", muted }),
    pause: () => write({ type: "pause" }),
    resume: () => write({ type: "resume" }),
    cancel,
    speak(output: VoiceOutput) {
      const done = Promise.withResolvers<void>()
      outputs.set(output.id, done)
      write({ type: "speak", output })

      return done.promise
    },
    async close() {
      cancel()
      controller.abort(new VoiceFailure("dropped"))
      clearTimeout(pollTimer)
      await bridge.stop(id)
    },
  }
}
