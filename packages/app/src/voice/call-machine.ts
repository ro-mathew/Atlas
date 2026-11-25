import type { ServerConnection } from "@/runtime/server/registry"
import type { VoiceFailure } from "./failure"
import {
  transitionVoiceDiagnostics,
  type VoiceDiagnosticsEvent,
  type VoiceDiagnosticsState,
} from "./diagnostics-machine"

/** Bounds the module load, microphone prompt, active-call IPC and WebRTC join; above the join's own 35 s timeout. */
export const CONNECT_TIMEOUT = 45_000

/** Bounds the teardown before Call is offered again; above the transport's 1 s close handshake. */
export const END_TIMEOUT = 2_000

export type VoiceFailureReason = VoiceFailure["reason"]

export type VoiceViewedSession = { id: string; title?: string; draftID?: string }

/** What a call keeps from Call until End, across drops and Rejoin. */
type Call<TCtx> = {
  attempt: number
  server: ServerConnection.Key
  ctx: TCtx
  viewing: VoiceViewedSession
  muted: boolean
  silenced: boolean
  diagnostics?: VoiceDiagnosticsState
}

export type VoiceCallState<TCtx = unknown> =
  | { status: "idle"; attempt: number }
  /** `joined` is the session the backend was given; navigation while connecting syncs it once connected. */
  | ({ status: "connecting"; joined: VoiceViewedSession } & Call<TCtx>)
  | ({
      status: "connected"
      level: number
      mic?: number
      speaker?: number
      activity?: "listening" | "processing" | "speaking"
    } & Call<TCtx>)
  | ({ status: "dropped"; failure: VoiceFailureReason } & Call<TCtx>)
  /** End was pressed; Call stays unavailable until the previous call's audio and IPC are released. */
  | { status: "ending"; attempt: number }

export type VoiceCallEvent<TCtx = unknown> =
  | { type: "start"; server: ServerConnection.Key; ctx: TCtx; session: VoiceViewedSession }
  | { type: "rejoin" }
  | { type: "end" }
  | { type: "disposed" }
  | { type: "mute.toggled" }
  | { type: "silence.toggled" }
  | { type: "session.viewed"; server: ServerConnection.Key; session: VoiceViewedSession }
  | { type: "connect.succeeded"; attempt: number }
  | { type: "connect.failed"; attempt: number; failure: VoiceFailureReason }
  | { type: "connect.timeout"; attempt: number }
  /** The transport closed, or a send on it failed. */
  | { type: "call.dropped"; attempt: number; failure: VoiceFailureReason }
  | { type: "level.updated"; attempt: number; mic: number; speaker: number }
  | { type: "activity.updated"; attempt: number; activity: "listening" | "processing" | "speaking" }
  | { type: "diagnostic"; attempt: number; event: VoiceDiagnosticsEvent }
  | { type: "end.settled"; attempt: number }
  | { type: "end.timeout"; attempt: number }

export type VoiceCallEffect<TCtx = unknown> =
  /** Opens a transport; dispatch `connect.succeeded` or `connect.failed`, and `connect.timeout` after `timeout`. */
  | {
      type: "connect"
      attempt: number
      server: ServerConnection.Key
      ctx: TCtx
      viewing: VoiceViewedSession
      muted: boolean
      timeout: number
    }
  /** The transport is live; `sync` is a session the user moved to while it connected. */
  | { type: "activate"; attempt: number; sync?: VoiceViewedSession }
  | { type: "instructions"; attempt: number; viewing: VoiceViewedSession }
  | { type: "mute"; attempt: number; muted: boolean }
  | { type: "silence"; attempt: number; silenced: boolean }
  /** Closes the dropped attempt's transport; the call keeps its delegation-free state for Rejoin. */
  | { type: "disconnect"; attempt: number }
  /** Releases the whole call; dispatch `end.settled` once done, or `end.timeout` after `timeout`. */
  | { type: "teardown"; attempt: number; timeout: number }

export type VoiceCallTransition<TCtx = unknown> = {
  state: VoiceCallState<TCtx>
  effects: VoiceCallEffect<TCtx>[]
}

export type VoiceCallView = {
  canStart: boolean
  panelOpen: boolean
  connecting: boolean
  canMute: boolean
  canRejoin: boolean
  muted: boolean
  silenced: boolean
  level: number
  activity: "listening" | "processing" | "speaking"
  mic: number
  speaker: number
  title: string
  failure: VoiceFailureReason | undefined
  diagnostics?: VoiceDiagnosticsState
}

type Active<TCtx> = Exclude<VoiceCallState<TCtx>, { status: "idle" | "ending" }>

export function createVoiceCallState<TCtx = unknown>(): VoiceCallState<TCtx> {
  return { status: "idle", attempt: 0 }
}

export function transitionVoiceCall<TCtx>(
  state: VoiceCallState<TCtx>,
  event: VoiceCallEvent<TCtx>,
): VoiceCallTransition<TCtx> {
  if (event.type === "start") {
    if (state.status !== "idle") return unchanged(state)

    return connect({
      attempt: state.attempt + 1,
      server: event.server,
      ctx: event.ctx,
      viewing: event.session,
      muted: false,
      silenced: false,
    })
  }

  if (event.type === "rejoin") {
    if (state.status !== "dropped") return unchanged(state)

    return connect({ ...call(state), attempt: state.attempt + 1 })
  }

  if (event.type === "end") {
    if (state.status === "idle" || state.status === "ending") return unchanged(state)
    const attempt = state.attempt + 1

    return { state: { status: "ending", attempt }, effects: [{ type: "teardown", attempt, timeout: END_TIMEOUT }] }
  }

  if (event.type === "disposed") {
    if (state.status === "idle") return unchanged(state)
    const attempt = state.attempt + 1

    // An ending call is already tearing down.
    if (state.status === "ending") return { state: { status: "idle", attempt }, effects: [] }

    return { state: { status: "idle", attempt }, effects: [{ type: "teardown", attempt, timeout: END_TIMEOUT }] }
  }

  if (event.type === "end.settled" || event.type === "end.timeout") {
    if (state.status !== "ending" || state.attempt !== event.attempt) return unchanged(state)

    return { state: { status: "idle", attempt: state.attempt }, effects: [] }
  }

  if (event.type === "session.viewed") {
    if (
      state.status === "idle" ||
      state.status === "ending" ||
      state.server !== event.server ||
      sameSession(state.viewing, event.session)
    )
      return unchanged(state)
    const next = { ...state, viewing: event.session }

    if (
      next.status !== "connected" ||
      (state.viewing.id === event.session.id && state.viewing.draftID === event.session.draftID)
    )
      return { state: next, effects: [] }

    return { state: next, effects: [{ type: "instructions", attempt: next.attempt, viewing: event.session }] }
  }

  if (event.type === "silence.toggled") {
    if (state.status !== "connected") return unchanged(state)

    return {
      state: { ...state, silenced: !state.silenced },
      effects: [{ type: "silence", attempt: state.attempt, silenced: !state.silenced }],
    }
  }

  if (event.type === "mute.toggled") {
    if (state.status !== "connected") return unchanged(state)

    return {
      state: { ...state, muted: !state.muted },
      effects: [{ type: "mute", attempt: state.attempt, muted: !state.muted }],
    }
  }

  if (state.status === "idle" || state.status === "ending" || state.attempt !== event.attempt) return unchanged(state)

  if (event.type === "activity.updated") {
    if (state.status !== "connected" || state.activity === event.activity) return unchanged(state)

    return { state: { ...state, activity: event.activity }, effects: [] }
  }

  if (event.type === "diagnostic") {
    if (state.status === "dropped") return unchanged(state)
    const diagnostics = transitionVoiceDiagnostics(state.diagnostics ?? { entries: [] }, event.event)

    return diagnostics === state.diagnostics ? unchanged(state) : { state: { ...state, diagnostics }, effects: [] }
  }

  if (event.type === "connect.succeeded") {
    if (state.status !== "connecting") return unchanged(state)

    return {
      state: { status: "connected", ...call(state), level: 0 },
      effects: [
        {
          type: "activate",
          attempt: state.attempt,
          sync: sameSession(state.joined, state.viewing) ? undefined : state.viewing,
        },
      ],
    }
  }

  if (event.type === "connect.failed" || event.type === "connect.timeout") {
    if (state.status !== "connecting") return unchanged(state)

    return drop(state, event.type === "connect.failed" ? event.failure : "connection")
  }

  if (event.type === "call.dropped") {
    // The first failure wins: the close it causes makes the join and later sends fail too.
    if (state.status === "dropped") return unchanged(state)

    return drop(state, event.failure)
  }

  if (event.type === "level.updated") {
    if (state.status !== "connected") return unchanged(state)
    const level = Math.min(1, (state.muted ? event.speaker : Math.max(event.mic, event.speaker)) * 5)

    if (level === state.level && event.mic === state.mic && event.speaker === state.speaker) return unchanged(state)

    return {
      state: {
        ...state,
        level,
        mic: event.mic,
        speaker: event.speaker,
        activity: state.activity === "processing" && event.speaker > 0.001 ? "speaking" : state.activity,
      },
      effects: [],
    }
  }

  return unchanged(state)
}

export function voiceCallView(state: VoiceCallState): VoiceCallView {
  if (state.status === "idle" || state.status === "ending")
    return {
      canStart: state.status === "idle",
      panelOpen: false,
      connecting: false,
      canMute: false,
      canRejoin: false,
      muted: false,
      silenced: false,
      level: 0,
      activity: "listening",
      mic: 0,
      speaker: 0,
      title: "",
      failure: undefined,
    }

  return {
    canStart: false,
    panelOpen: true,
    connecting: state.status === "connecting",
    canMute: state.status === "connected",
    canRejoin: state.status === "dropped",
    muted: state.muted,
    silenced: state.silenced,
    level: state.status === "connected" ? state.level : 0,
    activity: state.status === "connected" ? (state.activity ?? "listening") : "listening",
    mic: state.status === "connected" && !state.muted ? (state.mic ?? 0) : 0,
    speaker: state.status === "connected" ? (state.speaker ?? 0) : 0,
    title: state.viewing.title ?? state.viewing.id,
    failure: state.status === "dropped" ? state.failure : undefined,
    diagnostics: state.diagnostics,
  }
}

/** The session voice treats as on screen, while a call is open. */
export function viewedSession(state: VoiceCallState) {
  if (state.status === "idle" || state.status === "ending") return undefined

  return state.viewing
}

export function isMuted(state: VoiceCallState) {
  return state.status !== "idle" && state.status !== "ending" && state.muted
}

export function isConnecting(state: VoiceCallState, attempt: number) {
  return state.status === "connecting" && state.attempt === attempt
}

export function isConnected(state: VoiceCallState) {
  return state.status === "connected"
}

function connect<TCtx>(next: Call<TCtx>): VoiceCallTransition<TCtx> {
  return {
    state: { status: "connecting", ...next, joined: next.viewing },
    effects: [
      {
        type: "connect",
        attempt: next.attempt,
        server: next.server,
        ctx: next.ctx,
        viewing: next.viewing,
        muted: next.muted,
        timeout: CONNECT_TIMEOUT,
      },
    ],
  }
}

function drop<TCtx>(state: Active<TCtx>, failure: VoiceFailureReason): VoiceCallTransition<TCtx> {
  return {
    state: {
      status: "dropped",
      ...call(state),
      failure,
      diagnostics: state.diagnostics && transitionVoiceDiagnostics(state.diagnostics, { type: "cancelled" }),
    },
    effects: [{ type: "disconnect", attempt: state.attempt }],
  }
}

function call<TCtx>(state: Active<TCtx>): Call<TCtx> {
  return {
    attempt: state.attempt,
    server: state.server,
    ctx: state.ctx,
    viewing: state.viewing,
    muted: state.muted,
    silenced: state.silenced,
    diagnostics: state.diagnostics,
  }
}

function sameSession(a: VoiceViewedSession, b: VoiceViewedSession) {
  return a.id === b.id && a.title === b.title && a.draftID === b.draftID
}

function unchanged<TCtx>(state: VoiceCallState<TCtx>): VoiceCallTransition<TCtx> {
  return { state, effects: [] }
}
