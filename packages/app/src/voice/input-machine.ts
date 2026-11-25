import type { VoiceInput } from "./engine"

export type VoiceInputTarget = { server: string } & (
  | { sessionID: string; draftID?: never }
  | { draftID: string; sessionID?: never }
)

export function voiceTargetKey(target: VoiceInputTarget) {
  return `${target.server}:${target.sessionID ?? `draft:${target.draftID}`}`
}

type UtteranceTarget = { id: string; target: VoiceInputTarget }

type PendingInput = { accepted: readonly string[]; targets?: readonly UtteranceTarget[] }

export type VoiceInputState =
  | ({ status: "idle" } & PendingInput)
  | ({ status: "hearing"; id: string; target: VoiceInputTarget } & PendingInput)
  | { status: "closed" }

export type VoiceInputEffect =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "partial" | "submit"; id: string; target: VoiceInputTarget; text: string }
  | { type: "discard"; id: string; target: VoiceInputTarget }

type VoiceInputTransition = { state: VoiceInputState; effects: readonly VoiceInputEffect[] }

export function transitionVoiceInput(
  state: VoiceInputState,
  event: VoiceInput | { type: "closed" },
  target: VoiceInputTarget,
): VoiceInputTransition {
  if (state.status === "closed") return { state, effects: [] }

  if (event.type === "closed") return { state: { status: "closed" }, effects: [] }

  if (state.accepted.includes(event.id)) return { state, effects: [] }

  // Progressive recognition can deliver the previous sentence's period as a new segment.
  // Strip only detached leading periods: decimal fractions and dot-prefixed names are meaningful input.
  const text =
    "text" in event
      ? event.text
          .trim()
          .replace(/^(?:\.\s+)+/u, "")
          .replace(/^\.+$/u, "")
      : ""

  if (event.type === "transcript.final" && !text)
    return transitionVoiceInput(state, { type: "speech.discarded", id: event.id }, target)

  const targets = state.targets ?? (state.status === "hearing" ? [{ id: state.id, target: state.target }] : [])
  const source = targets.find((item) => item.id === event.id)?.target ?? target

  if (event.type === "speech.started") {
    if (state.status === "hearing" && state.id === event.id) return { state, effects: [] }

    return {
      state: {
        status: "hearing",
        id: event.id,
        target: source,
        accepted: state.accepted,
        targets: [...targets, { id: event.id, target: source }],
      },
      effects: [{ type: "pause" }],
    }
  }

  const another = state.status === "hearing" && state.id !== event.id

  if (event.type === "transcript.partial") {
    if (another) return { state, effects: [] }

    return {
      state: { status: "hearing", id: event.id, target: source, accepted: state.accepted, targets },
      effects: [{ type: "partial", id: event.id, target: source, text }],
    }
  }

  const effects: VoiceInputEffect[] =
    event.type === "speech.discarded"
      ? [{ type: "discard", id: event.id, target: source }]
      : [{ type: "cancel" }, { type: "submit", id: event.id, target: source, text }]

  if (event.type === "speech.discarded" && !another) effects.push({ type: "resume" })

  if (event.type === "transcript.final" && another) effects.push({ type: "pause" })

  return {
    state: {
      ...(another ? state : { status: "idle" }),
      accepted: [...state.accepted, event.id],
      targets: targets.filter((item) => item.id !== event.id),
    },
    effects,
  }
}
