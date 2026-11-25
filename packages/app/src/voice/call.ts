import type { Platform } from "@/runtime/platform/platform"
import type { ServerCtx } from "@/runtime/server/runtime"
import {
  isConnected,
  isConnecting,
  viewedSession,
  type VoiceCallState,
  type VoiceCallEvent,
  type VoiceViewedSession,
} from "./call-machine"
import type { VoiceEngine, VoiceEngineOptions, VoiceInput } from "./engine"
import type { VoiceComposerBinding } from "./input"
import { transitionVoiceInput, type VoiceInputState, type VoiceInputTarget } from "./input-machine"
import type { VoicePreferences } from "./preferences"
import { createVoiceSubmissionQueue } from "./submission"
import {
  createVoiceSpeechState,
  transitionVoiceSpeech,
  type VoiceSpeechState,
  type VoiceSpeechEvent,
  type VoiceSpeechEffect,
} from "./speech-machine"
import { VoiceFailure } from "./failure"
import type { VoiceDiagnosticsEvent } from "./diagnostics-machine"

type VoiceCallRuntime = {
  connection?: { attempt: number; controller: AbortController; engine: VoiceEngine }
  speech: VoiceSpeechState
  input: VoiceInputState
  bindings: Map<string, VoiceComposerBinding>
  submissions?: ReturnType<typeof createVoiceSubmissionQueue>
  filler?: ReturnType<typeof setTimeout>
  outputTimer?: ReturnType<typeof setTimeout>
}

/** Voice attaches to Session input/output. Its cancellation scope owns no Session execution. */
export function createVoiceCall(input: {
  ctx: ServerCtx
  platform: Platform
  preferences(): VoicePreferences
  binding(target: VoiceInputTarget): VoiceComposerBinding | undefined
  call(): VoiceCallState<ServerCtx>
  dispatch(event: VoiceCallEvent<ServerCtx>): void
}) {
  const runtime: VoiceCallRuntime = {
    speech: createVoiceSpeechState(),
    input: { status: "idle", accepted: [] },
    bindings: new Map(),
  }

  const target = (): VoiceInputTarget | undefined => {
    const state = input.call()
    const session = viewedSession(state)

    if (!session || !("server" in state)) return undefined

    return session.draftID
      ? { server: state.server, draftID: session.draftID }
      : { server: state.server, sessionID: session.id }
  }

  const attach = () => {
    const current = target()

    if (!current?.sessionID) return
    // Read history once on attachment, never for each token. Already visible words are not replayed.
    runtime.speech = createVoiceSpeechState(
      input.ctx.data.session.message.list(current.sessionID).flatMap((message) =>
        message.type === "assistant"
          ? message.content
              .filter((part) => part.type === "text")
              .map((part, ordinal) => ({
                id: `${message.id}:${ordinal}`,
                received: part.text.length,
                complete: message.time.completed !== undefined,
              }))
          : [],
      ),
    )
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- speech I/O rejects with opaque provider/native errors
  const fail = (error: unknown, attempt = runtime.connection?.attempt) => {
    const connection = runtime.connection

    if (connection?.attempt === attempt && connection)
      input.dispatch({
        type: "call.dropped",
        attempt: connection.attempt,
        failure: error instanceof VoiceFailure ? error.reason : "connection",
      })
  }

  const speech = (event: VoiceSpeechEvent) => {
    const previous = runtime.speech
    const next = transitionVoiceSpeech(previous, event)
    runtime.speech = next.state

    const previousOutput =
      previous.status === "speaking" || previous.status === "paused" ? previous.output?.id : undefined

    const nextOutput =
      next.state.status === "speaking" || next.state.status === "paused" ? next.state.output?.id : undefined

    if (
      runtime.connection &&
      (previous.status !== next.state.status || previousOutput !== nextOutput || event.type === "request.admitted")
    )
      input.dispatch({
        type: "activity.updated",
        attempt: runtime.connection.attempt,
        activity:
          next.state.status === "closed" || next.state.status === "paused"
            ? "listening"
            : next.state.status === "speaking" || next.state.waiting
              ? "processing"
              : "listening",
      })
    next.effects.forEach(perform)
  }

  const diagnostic = (event: VoiceDiagnosticsEvent) => {
    if (runtime.connection) input.dispatch({ type: "diagnostic", attempt: runtime.connection.attempt, event })
  }

  const perform = (effect: VoiceSpeechEffect) => {
    const connection = runtime.connection

    if (effect.type === "filler.clear") {
      clearTimeout(runtime.filler)

      return
    }

    if (!connection) return

    if (effect.type === "pause") {
      diagnostic({ type: "paused" })
      clearTimeout(runtime.outputTimer)

      return connection.engine.pause()
    }

    if (effect.type === "resume") {
      diagnostic({ type: "resumed" })
      runtime.outputTimer = setTimeout(() => fail(new VoiceFailure("connection"), connection.attempt), 60_000)

      return connection.engine.resume()
    }

    if (effect.type === "cancel") {
      diagnostic({ type: "cancelled" })
      clearTimeout(runtime.outputTimer)

      return connection.engine.cancel(effect.fade)
    }

    if (effect.type === "filler.wait") {
      if (input.preferences().filler)
        runtime.filler = setTimeout(() => speech({ type: "filler.due", id: effect.id }), 800)

      return
    }

    const current = target()

    if (!current?.sessionID) return

    const message =
      current && effect.output.kind === "answer"
        ? input.ctx.data.session.message.get(current.sessionID, effect.output.id.split(":")[0])
        : undefined

    diagnostic({
      type: "started",
      output: effect.output,
      time: Date.now(),
      target: current,
      author:
        message?.type === "assistant"
          ? { provider: message.model.providerID, model: message.model.id, variant: message.model.variant }
          : undefined,
    })
    clearTimeout(runtime.outputTimer)
    runtime.outputTimer = setTimeout(() => fail(new VoiceFailure("connection"), connection.attempt), 60_000)
    void connection.engine.speak(effect.output).then(
      () => {
        if (runtime.connection !== connection) return

        if (runtime.speech.status !== "speaking" && runtime.speech.status !== "paused") return

        if (runtime.speech.output?.id !== effect.output.id) return
        clearTimeout(runtime.outputTimer)
        diagnostic({ type: "ended", id: effect.output.id })
        speech({ type: "output.ended", id: effect.output.id })
      },
      (error) => {
        if (runtime.connection === connection) diagnostic({ type: "failed", id: effect.output.id })
        fail(error, connection.attempt)
      },
    )
  }

  const receive = (event: VoiceInput) => {
    const connection = runtime.connection
    const call = input.call()

    if (!connection) return

    if ("muted" in call && call.muted && event.type !== "speech.discarded") return
    const current = target()

    if (!current) return
    const next = transitionVoiceInput(runtime.input, event, current)
    runtime.input = next.state

    if (next.effects.length) runtime.submissions?.hearing(next.state.status === "hearing")

    if (event.type === "speech.started" && next.effects.length) {
      const binding = input.binding(current)

      if (binding) {
        runtime.bindings.set(event.id, binding)
        runtime.submissions?.update({ id: event.id, target: current, binding, text: "" })
      }
    }

    next.effects.forEach((effect) => {
      if (effect.type === "pause") return speech({ type: "speech.started" })

      if (effect.type === "resume") return speech({ type: "speech.discarded" })

      if (effect.type === "cancel") return speech({ type: "speech.accepted" })
      const binding = runtime.bindings.get(effect.id) ?? input.binding(effect.target)

      if (effect.type !== "partial") runtime.bindings.delete(effect.id)

      if (effect.type === "discard") return runtime.submissions?.discard(effect.id)

      if (effect.type === "partial") {
        if (!binding) return
        runtime.bindings.set(effect.id, binding)

        if (/[\p{L}\p{N}]/u.test(effect.text)) speech({ type: "speech.confirmed" })

        return runtime.submissions?.update({ id: effect.id, target: effect.target, binding, text: effect.text })
      }

      if (!binding) {
        fail(new VoiceFailure("submission"))

        return
      }

      runtime.submissions?.update({ id: effect.id, target: effect.target, binding, text: effect.text }, true)
    })
  }

  const stops = [
    input.ctx.sdk.event.on("session.text.delta", (event) => {
      if (!isConnected(input.call()) || event.data.sessionID !== target()?.sessionID) return
      speech({
        type: "text.delta",
        id: `${event.data.assistantMessageID}:${event.data.ordinal}`,
        text: event.data.delta,
      })
    }),
    input.ctx.sdk.event.on("session.text.ended", (event) => {
      if (!isConnected(input.call()) || event.data.sessionID !== target()?.sessionID) return
      speech({
        type: "text.ended",
        id: `${event.data.assistantMessageID}:${event.data.ordinal}`,
        text: event.data.text,
      })
    }),
  ]

  const release = async () => {
    speech({ type: "closed" })
    runtime.input = { status: "closed" }
    runtime.submissions?.close()
    runtime.bindings.clear()
    clearTimeout(runtime.filler)
    clearTimeout(runtime.outputTimer)
    const connection = runtime.connection
    runtime.connection = undefined

    if (!connection) return
    connection.controller.abort(new VoiceFailure("dropped"))
    await Promise.all([connection.engine.close(), input.platform.setVoiceCallActive?.(false)])
  }

  return {
    async connect(attempt: number, _viewing: VoiceViewedSession, muted: boolean) {
      if (!isConnecting(input.call(), attempt)) return
      const controller = new AbortController()

      const options: VoiceEngineOptions = {
        preferences: { ...input.preferences() },
        input: (event) => {
          if (runtime.connection?.attempt === attempt) receive(event)
        },
        levels: (mic, speaker) => input.dispatch({ type: "level.updated", attempt, mic, speaker }),
        dropped: (reason = "dropped") => fail(new VoiceFailure(reason), attempt),
        configured: (profile) =>
          input.dispatch({ type: "diagnostic", attempt, event: { type: "configured", profile } }),
      }

      options.configured?.({
        engine: options.preferences.engine,
        model: options.preferences.engine === "local" ? options.preferences.localModel : options.preferences.model,
        voice: options.preferences.engine === "local" ? "" : options.preferences.voice,
        transcription: options.preferences.engine === "local" ? "" : options.preferences.transcription,
        language: options.preferences.language,
        activityDelay: options.preferences.activityDelay ?? 1000,
        delivery: options.preferences.delivery ?? "",
        style: options.preferences.style,
      })

      runtime.speech = createVoiceSpeechState()
      runtime.input = { status: "idle", accepted: [] }

      const engine =
        options.preferences.engine === "local"
          ? await (async () => {
              const { createLocalVoice } = await import("./local")

              if (!input.platform.voice) throw new VoiceFailure("configuration")

              return createLocalVoice(input.platform.voice, options)
            })()
          : await (async () => {
              const { createHostedVoice } = await import("./hosted")

              return createHostedVoice(input.ctx.sdk.api.experimental.voice, options)
            })()

      if (!isConnecting(input.call(), attempt)) {
        await engine.close()

        return
      }

      runtime.submissions = createVoiceSubmissionQueue({
        delay: options.preferences.activityDelay ?? 1000,
        submit: (batch) => {
          // No voice AbortSignal reaches normal prompt admission: End cannot cancel admitted work.
          return batch.binding.submit(batch.id, batch.text).then(
            (result) => {
              if (runtime.connection?.attempt !== attempt) return

              if (!result.sent) {
                fail(new VoiceFailure("submission"), attempt)

                return
              }

              const viewing = target()

              if (batch.target.server !== viewing?.server) return

              if (batch.target.sessionID && batch.target.sessionID !== viewing.sessionID) return

              speech({ type: "request.admitted", id: result.id })
            },
            (error) => fail(error, attempt),
          )
        },
      })
      runtime.connection = { attempt, controller, engine }
      await (async () => {
        if (input.platform.requestMicrophone && !(await input.platform.requestMicrophone()))
          throw new VoiceFailure("microphone")

        if (!isConnecting(input.call(), attempt)) throw new VoiceFailure("connection")
        await input.platform.setVoiceCallActive?.(true)
        await engine.connect(controller.signal)
        controller.signal.throwIfAborted()
        engine.mute(muted)
      })().then(
        () => input.dispatch({ type: "connect.succeeded", attempt }),
        (error) =>
          input.dispatch({
            type: "connect.failed",
            attempt,
            failure: error instanceof VoiceFailure ? error.reason : "connection",
          }),
      )
    },
    activate(_attempt: number, _sync?: VoiceViewedSession) {
      attach()
      const call = input.call()

      if ("silenced" in call && call.silenced) speech({ type: "silence.changed", silenced: true })
    },
    instructions(_attempt: number, _viewing: VoiceViewedSession) {
      speech({ type: "speech.accepted" })
      attach()
      const call = input.call()

      if ("silenced" in call && call.silenced) speech({ type: "silence.changed", silenced: true })
    },
    silence(attempt: number, silenced: boolean) {
      if (runtime.connection?.attempt === attempt) speech({ type: "silence.changed", silenced })
    },
    mute(_attempt: number, muted: boolean) {
      if (muted && runtime.input.status === "hearing") receive({ type: "speech.discarded", id: runtime.input.id })
      runtime.connection?.engine.mute(muted)
    },
    disconnect(attempt: number) {
      return runtime.connection?.attempt === attempt ? release() : Promise.resolve()
    },
    async dispose() {
      stops.forEach((stop) => stop())
      await release()
    },
  }
}
