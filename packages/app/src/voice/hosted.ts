import type { OpenCodeClient } from "@opencode/client/promise"
import { Option, Schema } from "effect"
import type { VoiceEngine, VoiceEngineOptions } from "./engine"
import { VoiceFailure } from "./failure"
import { voiceInstructions } from "./prompts"
import playbackWorklet from "./playback.worklet.ts?worker&url"
import {
  transitionHostedSpeech,
  type HostedSpeechEffect,
  type HostedSpeechEvent,
  type HostedSpeechState,
} from "./hosted-machine"

const Event = Schema.Struct({
  type: Schema.String,
  item_id: Schema.optional(Schema.String),
  response_id: Schema.optional(Schema.String),
  delta: Schema.optional(Schema.String),
  transcript: Schema.optional(Schema.String),
  session: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      audio: Schema.optional(
        Schema.Struct({
          output: Schema.optional(Schema.Struct({ voice: Schema.optional(Schema.String) })),
        }),
      ),
    }),
  ),
  response: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      status: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String), type: Schema.optional(Schema.String) })),
})

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

type HostedHandles = {
  socket?: WebSocket
  stream?: MediaStream
  processor?: ScriptProcessorNode
  muted: boolean
}

/** Server-brokered realtime speech. Response creation is explicit; session coding never runs here. */
export function createHostedVoice(
  api: OpenCodeClient["experimental"]["voice"],
  options: VoiceEngineOptions,
): VoiceEngine {
  const capture = new AudioContext({ sampleRate: 24000 })
  const playback = new AudioContext({ sampleRate: 24000 })
  const meter = playback.createAnalyser()
  let player: AudioWorkletNode | undefined
  const joined = Promise.withResolvers<void>()
  const handles: HostedHandles = { muted: false }
  const controller = new AbortController()
  const command = (type: "pause" | "resume" | "cancel" | "fade" | "finish") => player?.port.postMessage({ type })
  const transcripts = new Map<string, string>()
  const complete = new Set<string>()
  const jobs = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  let output: HostedSpeechState = { status: "idle" }

  const send = (event: typeof Schema.Json.Type) => {
    if (handles.socket?.readyState !== WebSocket.OPEN) throw new VoiceFailure("dropped")
    handles.socket.send(JSON.stringify(event))
  }

  const dispatch = (event: HostedSpeechEvent) => {
    const next = transitionHostedSpeech(output, event)
    output = next.state
    next.effects.forEach(perform)
  }

  const perform = (effect: HostedSpeechEffect) => {
    if (effect.type === "resolve" || effect.type === "reject") {
      const job = jobs.get(effect.id)
      jobs.delete(effect.id)

      if (effect.type === "resolve") return job?.resolve()

      return job?.reject(new VoiceFailure("connection"))
    }

    if (effect.type === "cancel") {
      if (handles.socket?.readyState === WebSocket.OPEN) send({ type: "response.cancel" })

      return
    }

    if (effect.type === "stop") return command("cancel")

    if (effect.type === "drain") return command("finish")

    if (effect.type === "audio") {
      const bytes = Uint8Array.from(atob(effect.audio), (char) => char.charCodeAt(0))
      const pcm = Float32Array.from(new Int16Array(bytes.buffer), (value) => value / 32768)
      player?.port.postMessage({ type: "pcm", pcm }, [pcm.buffer])

      return
    }

    const next = effect.output
    player?.port.postMessage({ type: "start", id: next.id })
    send({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        max_output_tokens: next.kind === "filler" ? 64 : 2048,
        metadata: { speech_id: next.id },
        instructions: [
          next.kind === "answer"
            ? "Read the supplied text exactly, naturally. Do not answer it, add words, or use tools."
            : "Say one very short neutral acknowledgement, at most five words, while a coding agent prepares its reply. Do not invent progress, actions or results.",
          voiceInstructions(options.preferences),
        ]
          .filter(Boolean)
          .join(" "),
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: next.kind === "answer" ? next.text : "Acknowledge briefly." }],
          },
        ],
      },
    })
  }

  const cancel = (fade = false) => {
    if (!fade) return dispatch({ type: "cancelled" })
    // Stop generation now but let the worklet complete its short trailing fade.
    command("fade")

    if (handles.socket?.readyState === WebSocket.OPEN) send({ type: "response.cancel" })
    jobs.forEach((job) => job.resolve())
    jobs.clear()
    output = { status: "idle" }
  }

  const receive = (raw: string) => {
    const event = Option.getOrUndefined(decode(raw))

    if (!event || controller.signal.aborted) return

    if (event.type === "session.updated") {
      options.configured?.({
        engine: "hosted",
        model: event.session?.model ?? options.preferences.model,
        voice: event.session?.audio?.output?.voice ?? options.preferences.voice,
        transcription: options.preferences.transcription,
        language: options.preferences.language,
        activityDelay: options.preferences.activityDelay ?? 1000,
        delivery: options.preferences.delivery ?? "",
        style: options.preferences.style,
      })

      return joined.resolve()
    }

    if (event.type === "input_audio_buffer.speech_started" && event.item_id)
      return options.input({ type: "speech.started", id: event.item_id })

    if (event.type === "conversation.item.input_audio_transcription.delta" && event.item_id) {
      const text = (transcripts.get(event.item_id) ?? "") + (event.delta ?? "")
      transcripts.set(event.item_id, text)

      return options.input({ type: "transcript.partial", id: event.item_id, text })
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.item_id) {
      if (complete.has(event.item_id)) return
      complete.add(event.item_id)
      const text = (event.transcript ?? transcripts.get(event.item_id) ?? "").trim()
      transcripts.delete(event.item_id)

      return options.input(
        text ? { type: "transcript.final", id: event.item_id, text } : { type: "speech.discarded", id: event.item_id },
      )
    }

    if (event.type === "conversation.item.input_audio_transcription.failed" && event.item_id)
      return options.input({ type: "speech.discarded", id: event.item_id })

    if (event.type === "response.created" && event.response && event.response.metadata?.speech_id)
      return dispatch({ type: "created", output: event.response.metadata.speech_id, response: event.response.id })

    if (
      (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") &&
      event.delta &&
      event.response_id
    )
      return dispatch({ type: "audio", response: event.response_id, audio: event.delta })

    if (event.type === "response.done" && event.response)
      return dispatch({ type: "done", response: event.response.id, failed: event.response.status === "failed" })

    if (event.type === "error" && event.error?.code !== "response_cancel_not_active") {
      const reason = ["authentication_error", "permission_error"].includes(event.error?.type ?? "")
        ? "unavailable"
        : "configuration"

      joined.reject(new VoiceFailure(reason))
      options.dropped(reason)
    }
  }

  return {
    async connect(signal) {
      void joined.promise.catch(() => undefined)
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal })
      controller.signal.addEventListener("abort", () => joined.reject(controller.signal.reason), { once: true })
      const models = await api.models({ signal })

      const model = models.models.find(
        (item) =>
          item.model === options.preferences.model &&
          item.engine === "openai-realtime" &&
          item.available &&
          item.transports.includes("websocket"),
      )

      if (!model || !options.preferences.transcription) throw new VoiceFailure("configuration")
      await playback.audioWorklet.addModule(playbackWorklet)
      player = new AudioWorkletNode(playback, "opencode-voice-playback", { numberOfInputs: 0, outputChannelCount: [1] })
      player.connect(meter)
      meter.connect(playback.destination)
      player.port.onmessage = (event: MessageEvent<{ type: "drained"; id: string }>) => {
        if (output.status === "draining" && output.output.id === event.data.id) dispatch({ type: "drained" })
      }

      player.onprocessorerror = () => options.dropped("runtime")
      await Promise.all([capture.resume(), playback.resume()])
      const connection = await api.session({ model: model.model, transport: { type: "websocket" } }, { signal })
      signal.throwIfAborted()

      if (connection.transport.type !== "websocket") throw new VoiceFailure("connection")

      const socket = new WebSocket(connection.transport.url, [
        "realtime",
        `openai-insecure-api-key.${connection.transport.token}`,
      ])

      handles.socket = socket
      socket.onmessage = (event: MessageEvent<string>) => receive(event.data)
      socket.onclose = () => {
        if (!controller.signal.aborted) {
          joined.reject(new VoiceFailure("connection"))
          options.dropped()
        }
      }

      socket.onerror = () => joined.reject(new VoiceFailure("connection"))
      const transcription = { model: options.preferences.transcription }

      if (options.preferences.language)
        Object.assign(transcription, { language: options.preferences.language.split("-")[0] })
      const audio = { format: { type: "audio/pcm", rate: 24000 } }

      if (options.preferences.voice) Object.assign(audio, { voice: options.preferences.voice })
      socket.onopen = () =>
        send({
          type: "session.update",
          session: {
            type: "realtime",
            model: model.model,
            instructions:
              "Render speech only when explicitly requested. The coding conversation is handled by the selected OpenCode session.",
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription,
                turn_detection: {
                  type: "server_vad",
                  silence_duration_ms: options.preferences.activityDelay ?? 1000,
                  create_response: false,
                  interrupt_response: false,
                },
              },
              output: audio,
            },
          },
        })
      await joined.promise

      const stream = await navigator.mediaDevices
        .getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        })
        .catch(() => {
          throw new VoiceFailure("microphone")
        })

      handles.stream = stream

      if (controller.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop())
        controller.signal.throwIfAborted()
      }

      const processor = capture.createScriptProcessor(2048, 1, 1)
      handles.processor = processor
      capture.createMediaStreamSource(stream).connect(processor)
      processor.connect(capture.destination)
      processor.onaudioprocess = (event) => {
        if (handles.muted || socket.readyState !== WebSocket.OPEN) return
        const samples = event.inputBuffer.getChannelData(0)
        const pcm = Int16Array.from(samples, (value) => Math.round(Math.max(-1, Math.min(1, value)) * 32767))
        send({ type: "input_audio_buffer.append", audio: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))) })
        const mic = Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length)
        const levels = new Float32Array(meter.fftSize)
        meter.getFloatTimeDomainData(levels)
        options.levels(mic, Math.sqrt(levels.reduce((total, sample) => total + sample * sample, 0) / levels.length))
      }
    },
    mute(value) {
      handles.muted = value
      handles.stream?.getAudioTracks().forEach((track) => {
        track.enabled = !value
      })
    },
    pause: () => command("pause"),
    resume: () => command("resume"),
    cancel,
    async speak(next) {
      void playback.resume()
      const done = Promise.withResolvers<void>()
      jobs.set(next.id, done)
      dispatch({ type: "requested", output: next })

      return done.promise
    },
    async close() {
      dispatch({ type: "closed" })
      controller.abort(new VoiceFailure("dropped"))
      handles.socket?.close()
      handles.stream?.getTracks().forEach((track) => track.stop())
      handles.processor?.disconnect()
      player?.disconnect()
      player?.port.close()
      await Promise.all([capture.close(), playback.close()])
    },
  }
}
