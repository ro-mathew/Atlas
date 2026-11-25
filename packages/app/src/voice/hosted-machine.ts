import type { VoiceOutput } from "./engine"

export type HostedSpeechState =
  | { status: "idle" }
  | { status: "closed" }
  | { status: "requested"; output: VoiceOutput }
  | { status: "generating" | "draining"; output: VoiceOutput; response: string }

export type HostedSpeechEvent =
  | { type: "requested"; output: VoiceOutput }
  | { type: "created"; response: string; output: string }
  | { type: "audio"; response: string; audio: string }
  | { type: "done"; response: string; failed: boolean }
  | { type: "drained" | "cancelled" | "closed" }

export type HostedSpeechEffect =
  | { type: "request"; output: VoiceOutput }
  | { type: "audio"; audio: string }
  | { type: "resolve"; id: string }
  | { type: "reject"; id: string }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "drain" }

type HostedSpeechTransition = { state: HostedSpeechState; effects: readonly HostedSpeechEffect[] }

/** Correlates provider replies with playback jobs; delayed packets never revive cancelled speech. */
export function transitionHostedSpeech(state: HostedSpeechState, event: HostedSpeechEvent): HostedSpeechTransition {
  if (state.status === "closed") return { state, effects: [] }

  if (event.type === "closed" || event.type === "cancelled" || event.type === "requested") {
    const effects: HostedSpeechEffect[] =
      state.status === "idle" ? [] : [{ type: "stop" }, { type: "cancel" }, { type: "resolve", id: state.output.id }]

    if (event.type === "requested")
      return {
        state: { status: "requested", output: event.output },
        effects: [...effects, { type: "request", output: event.output }],
      }

    return { state: { status: event.type === "closed" ? "closed" : "idle" }, effects }
  }

  if (event.type === "created" && state.status === "requested" && state.output.id === event.output)
    return { state: { ...state, status: "generating", response: event.response }, effects: [] }

  if (event.type === "audio" && state.status === "generating" && event.response === state.response)
    return { state, effects: [{ type: "audio", audio: event.audio }] }

  if (event.type === "done" && state.status === "generating" && event.response === state.response) {
    if (event.failed)
      return { state: { status: "idle" }, effects: [{ type: "stop" }, { type: "reject", id: state.output.id }] }

    return { state: { ...state, status: "draining" }, effects: [{ type: "drain" }] }
  }

  if (event.type === "drained" && state.status === "draining")
    return { state: { status: "idle" }, effects: [{ type: "resolve", id: state.output.id }] }

  return { state, effects: [] }
}
