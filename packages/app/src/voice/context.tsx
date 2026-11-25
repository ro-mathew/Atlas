import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode/ui/context"
import { createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { usePlatform } from "@/runtime/platform/platform"
import type { ServerCtx } from "@/runtime/server/runtime"
import type { ServerConnection } from "@/runtime/server/registry"
import type { createVoiceCall } from "./call"
import { useSettings } from "@/settings/model"
import { voiceTargetKey, type VoiceInputTarget } from "./input-machine"
import type { VoiceComposerBinding } from "./input"
import { VoiceFailure } from "./failure"
import { useHostApis } from "@/runtime/plugin/root"
import {
  createVoiceCallState,
  isConnecting,
  transitionVoiceCall,
  voiceCallView,
  type VoiceCallEffect,
  type VoiceCallEvent,
} from "./call-machine"

export const { provider: VoiceProvider, use: useVoice } = createSimpleContext({
  name: "Voice",
  init: () => {
    const platform = usePlatform()
    const settings = useSettings()
    const diagnostics = useHostApis().diagnostics
    const bindings = new Map<string, VoiceComposerBinding>()
    const [presentation, setPresentation] = createStore({ hosts: 0 })

    const [call, setCall] = createSignal(createVoiceCallState<ServerCtx>())
    const view = createMemo(() => voiceCallView(call()))

    // The call's transports and tools, loaded on its first connect and kept across Rejoin.
    let session: ReturnType<typeof createVoiceCall> | undefined
    // The latest transport close; the next join waits for it so the active-call IPC is released in order.
    let closing: Promise<unknown> = Promise.resolve()

    const dispatch = (event: VoiceCallEvent<ServerCtx>) => {
      const current = untrack(call)
      const next = transitionVoiceCall(current, event)

      if (next.state === current) return

      if (
        "viewing" in next.state &&
        !next.state.viewing.draftID &&
        next.state.diagnostics?.profile &&
        ((event.type === "diagnostic" && event.event.type === "configured") ||
          event.type === "connect.succeeded" ||
          event.type === "call.dropped" ||
          event.type === "connect.failed" ||
          event.type === "session.viewed")
      ) {
        const target = { server: next.state.server, sessionID: next.state.viewing.id }
        const id = `voice:${next.state.attempt}:connection`

        const previous = diagnostics
          .list({ server: { id: target.server }, id: target.sessionID })
          .find((entry) => entry.id === id)

        diagnostics.record(target, {
          id,
          type: "voice.connection",
          time: previous?.time ?? Date.now(),
          model: next.state.diagnostics.profile.model,
          data: {
            profile: next.state.diagnostics.profile,
            status: next.state.status,
            failure: next.state.status === "dropped" ? next.state.failure : null,
          },
        })
      }

      const previous = "diagnostics" in current ? current.diagnostics?.entries : undefined
      const entries = "diagnostics" in next.state ? next.state.diagnostics?.entries : undefined
      const recent = entries ?? previous
      // End removes the call state. Keep its final snapshots inspectable in the Context panel.
      recent?.forEach((entry) => {
        const stopped = !entries && (entry.status === "active" || entry.status === "paused")

        if (!stopped && previous?.includes(entry)) return
        diagnostics.record(entry.target, {
          id: `${current.attempt}:${entry.id}`,
          type: `voice.${entry.kind}`,
          time: entry.time,
          model: entry.profile.model,
          data: { ...entry, status: stopped ? "cancelled" : entry.status },
        })
      })

      setCall(next.state)
      next.effects.forEach(perform)
    }

    const perform = (effect: VoiceCallEffect<ServerCtx>) => {
      if (effect.type === "connect") return connect(effect)

      if (effect.type === "teardown") return teardown(effect)

      if (effect.type === "disconnect") {
        closing = Promise.all([closing, session?.disconnect(effect.attempt)])

        return
      }

      if (effect.type === "activate") return session?.activate(effect.attempt, effect.sync)

      if (effect.type === "silence") return session?.silence(effect.attempt, effect.silenced)

      if (effect.type === "instructions") return session?.instructions(effect.attempt, effect.viewing)
      session?.mute(effect.attempt, effect.muted)
    }

    const connect = (effect: Extract<VoiceCallEffect<ServerCtx>, { type: "connect" }>) => {
      const timer = setTimeout(() => dispatch({ type: "connect.timeout", attempt: effect.attempt }), effect.timeout)
      void closing
        .then(() => import("./call"))
        .then(({ createVoiceCall }) => {
          // A call that ended while the module loaded must not leave a session listening behind it.
          if (!isConnecting(untrack(call), effect.attempt)) return
          session ??= createVoiceCall({
            ctx: effect.ctx,
            platform,
            preferences: settings.voice.current,
            binding: (target) => bindings.get(voiceTargetKey(target)),
            call: () => untrack(call),
            dispatch,
          })

          return session.connect(effect.attempt, effect.viewing, effect.muted)
        })
        .catch((error) =>
          dispatch({
            type: "connect.failed",
            attempt: effect.attempt,
            failure: error instanceof VoiceFailure ? error.reason : "connection",
          }),
        )
        .finally(() => clearTimeout(timer))
    }

    const teardown = (effect: Extract<VoiceCallEffect<ServerCtx>, { type: "teardown" }>) => {
      const done = Promise.all([closing, session?.dispose()])
      const timer = setTimeout(() => dispatch({ type: "end.timeout", attempt: effect.attempt }), effect.timeout)
      session = undefined
      closing = done
      void done.finally(() => {
        clearTimeout(timer)
        dispatch({ type: "end.settled", attempt: effect.attempt })
      })
    }

    const end = () => dispatch({ type: "end" })

    window.addEventListener("pagehide", end)
    window.addEventListener("beforeunload", end)
    onCleanup(() => {
      window.removeEventListener("pagehide", end)
      window.removeEventListener("beforeunload", end)
      dispatch({ type: "disposed" })
    })

    return {
      bind(target: VoiceInputTarget, binding: VoiceComposerBinding) {
        const key = voiceTargetKey(target)
        bindings.set(key, binding)

        return () => {
          if (bindings.get(key) === binding) bindings.delete(key)
        }
      },
      present() {
        setPresentation("hosts", (count) => count + 1)

        return () => setPresentation("hosts", (count) => count - 1)
      },
      presented: () => presentation.hosts > 0,
      view,
      startDraft(server: ServerConnection.Key, ctx: ServerCtx, draftID: string, title: string) {
        dispatch({ type: "start", server, ctx, session: { id: draftID, draftID, title } })
      },
      promoteDraft(server: ServerConnection.Key, draftID: string, sessionID: string) {
        const current = untrack(call)

        if (!("viewing" in current) || current.server !== server || current.viewing.draftID !== draftID) return
        dispatch({ type: "session.viewed", server, session: { id: sessionID } })
      },
      end,
      mute: () => dispatch({ type: "mute.toggled" }),
      silence: () => dispatch({ type: "silence.toggled" }),
      rejoin: () => dispatch({ type: "rejoin" }),
      /** Tells the call which session is on screen; ignored unless a call on that server is open. */
      syncSession(server: ServerConnection.Key, session: SessionInfo) {
        dispatch({ type: "session.viewed", server, session: { id: session.id, title: session.title } })
      },
      start(server: ServerConnection.Key, ctx: ServerCtx, session: SessionInfo) {
        dispatch({ type: "start", server, ctx, session: { id: session.id, title: session.title } })
      },
    }
  },
})
