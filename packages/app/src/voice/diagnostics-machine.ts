import { Match } from "effect"
import type { VoiceOutput } from "./engine"

export type VoiceProfile = {
  engine: "local" | "hosted"
  model: string
  voice: string
  transcription: string
  language: string
  delivery: string
  activityDelay?: number
  style?: string
}

type Author = { provider: string; model: string; variant?: string }

type Status = "active" | "paused" | "completed" | "cancelled" | "failed"

type Entry = {
  id: string
  time: number
  target: { server: string; sessionID: string }
  profile: VoiceProfile
  status: Status
} & ({ kind: "answer"; text: string; author?: Author } | { kind: "filler" })

export type VoiceDiagnosticsState = { profile?: VoiceProfile; entries: readonly Entry[] }

export type VoiceDiagnosticsEvent =
  | { type: "configured"; profile: VoiceProfile }
  | { type: "started"; output: VoiceOutput; time: number; target: Entry["target"]; author?: Author }
  | { type: "ended" | "failed"; id: string }
  | { type: "paused" | "resumed" | "cancelled" }

/** In-memory provenance only. In particular, filler never acquires a text field. */
export function transitionVoiceDiagnostics(
  state: VoiceDiagnosticsState,
  event: VoiceDiagnosticsEvent,
): VoiceDiagnosticsState {
  if (event.type === "configured") return { ...state, profile: event.profile }

  if (event.type === "started") {
    if (!state.profile || state.entries.some((entry) => entry.id === event.output.id)) return state

    const common = {
      id: event.output.id,
      time: event.time,
      target: event.target,
      profile: state.profile,
      status: "active" as const,
    }

    const entry: Entry =
      event.output.kind === "answer"
        ? { ...common, kind: "answer", text: event.output.text, author: event.author }
        : { ...common, kind: "filler" }

    return { ...state, entries: [...state.entries, entry].slice(-12) }
  }

  const status = Match.value(event.type).pipe(
    Match.when("ended", () => "completed" as const),
    Match.when("failed", () => "failed" as const),
    Match.when("paused", () => "paused" as const),
    Match.when("resumed", () => "active" as const),
    Match.when("cancelled", () => "cancelled" as const),
    Match.exhaustive,
  )

  const matches = (entry: Entry) =>
    (entry.status === "active" || entry.status === "paused") &&
    (!("id" in event) || event.id === entry.id) &&
    entry.status !== status

  if (!state.entries.some(matches)) return state

  return { ...state, entries: state.entries.map((entry) => (matches(entry) ? { ...entry, status } : entry)) }
}
