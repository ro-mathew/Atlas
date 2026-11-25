import type { VoiceOutput } from "./engine"

type Text = { id: string; text: string; received: number; complete: boolean; fence?: string }

type Pending = {
  texts: readonly Text[]
  offsets: readonly Text[]
  finished: readonly string[]
  waiting?: string
  quiet?: boolean
}

export type VoiceSpeechState =
  | ({ status: "idle" } & Pending)
  | ({ status: "speaking"; output: VoiceOutput } & Pending)
  | ({ status: "paused"; output?: VoiceOutput } & Pending)
  | ({ status: "silenced" } & Pending)
  | { status: "closed" }

export type VoiceSpeechEvent =
  | { type: "silence.changed"; silenced: boolean }
  | { type: "request.admitted"; id: string }
  | { type: "filler.due"; id: string }
  | { type: "text.delta"; id: string; text: string }
  | { type: "text.ended"; id: string; text: string }
  | { type: "speech.started" | "speech.discarded" | "speech.accepted" | "speech.confirmed" }
  | { type: "output.ended"; id: string }
  | { type: "closed" }

export type VoiceSpeechEffect =
  | { type: "speak"; output: VoiceOutput }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel"; fade?: boolean }
  | { type: "filler.clear" }
  | { type: "filler.wait"; id: string }

type VoiceSpeechTransition = { state: VoiceSpeechState; effects: readonly VoiceSpeechEffect[] }

type VoiceSpeechPosition = { id: string; received: number; complete: boolean }

export function createVoiceSpeechState(positions: readonly VoiceSpeechPosition[] = []): VoiceSpeechState {
  return {
    status: "idle",
    texts: [],
    offsets: positions.flatMap((position) => (position.complete ? [] : [{ ...position, text: "" }])),
    finished: positions.flatMap((position) => (position.complete ? [position.id] : [])),
  }
}

export function transitionVoiceSpeech(state: VoiceSpeechState, event: VoiceSpeechEvent): VoiceSpeechTransition {
  if (state.status === "closed") return { state, effects: [] }

  if (event.type === "closed")
    return { state: { status: "closed" }, effects: [{ type: "filler.clear" }, { type: "cancel" }] }

  if (event.type === "silence.changed") {
    if (!event.silenced) {
      if (state.status !== "silenced") return { state, effects: [] }

      return { state: { ...state, status: "idle" }, effects: [] }
    }

    if (state.status === "silenced") return { state, effects: [] }

    return {
      state: {
        status: "silenced",
        texts: [],
        offsets: [
          ...state.offsets,
          ...state.texts.filter((text) => !text.complete).map((text) => ({ ...text, text: "" })),
        ],
        finished: [...state.finished, ...state.texts.filter((text) => text.complete).map((text) => text.id)],
      },
      effects: [{ type: "filler.clear" }, { type: "cancel" }],
    }
  }

  // Continue tracking streamed positions while silent, without queuing synthesis or replaying skipped text later.
  if (state.status === "silenced") {
    if (event.type !== "text.delta" && event.type !== "text.ended") return { state, effects: [] }

    if (state.finished.includes(event.id)) return { state, effects: [] }
    const previous = state.offsets.find((text) => text.id === event.id)
    const offsets = state.offsets.filter((text) => text.id !== event.id)

    if (event.type === "text.ended")
      return { state: { ...state, offsets, finished: [...state.finished, event.id] }, effects: [] }

    return {
      state: {
        ...state,
        offsets: [
          ...offsets,
          { id: event.id, text: "", received: (previous?.received ?? 0) + event.text.length, complete: false },
        ],
      },
      effects: [],
    }
  }

  if (event.type === "speech.started") {
    if (state.status === "paused") return { state, effects: [] }

    return {
      state: { ...state, status: "paused", output: state.status === "speaking" ? state.output : undefined },
      effects: [{ type: "pause" }, { type: "filler.clear" }],
    }
  }

  if (event.type === "speech.discarded") {
    if (state.status !== "paused") return { state, effects: [] }

    if (state.output)
      return { state: { ...state, status: "speaking", output: state.output }, effects: [{ type: "resume" }] }

    return advance({ ...state, status: "idle" })
  }

  if (event.type === "speech.confirmed" && state.status !== "paused") return { state, effects: [] }

  if (event.type === "speech.accepted" || event.type === "speech.confirmed") {
    const interrupted = state.status === "paused" && state.output !== undefined

    return {
      state: {
        status: "idle",
        texts: [],
        offsets: [],
        finished: [...state.finished, ...state.texts.map((text) => text.id), ...state.offsets.map((text) => text.id)],
        quiet: state.quiet || interrupted,
      },
      effects:
        state.quiet && !interrupted
          ? [{ type: "filler.clear" }]
          : [{ type: "filler.clear" }, interrupted ? { type: "cancel", fade: true } : { type: "cancel" }],
    }
  }

  if (event.type === "request.admitted")
    return {
      state: { ...state, quiet: false, waiting: state.quiet ? undefined : event.id },
      effects: state.quiet
        ? [{ type: "filler.clear" }]
        : [{ type: "filler.clear" }, { type: "filler.wait", id: event.id }],
    }

  if (event.type === "filler.due") {
    if (state.status !== "idle" || state.waiting !== event.id || state.texts.some((text) => text.text.trim()))
      return { state, effects: [] }
    const output: VoiceOutput = { id: `filler:${event.id}`, kind: "filler" }

    return { state: { ...state, status: "speaking", output, waiting: undefined }, effects: [{ type: "speak", output }] }
  }

  if (event.type === "output.ended") {
    if ((state.status !== "speaking" && state.status !== "paused") || state.output?.id !== event.id)
      return { state, effects: [] }

    if (state.status === "paused") return { state: { ...state, output: undefined }, effects: [] }

    return advance({ ...state, status: "idle" })
  }

  if (event.type === "text.delta" || event.type === "text.ended") {
    if (state.finished.includes(event.id)) return { state, effects: [] }

    const previous =
      state.texts.find((text) => text.id === event.id) ?? state.offsets.find((text) => text.id === event.id)

    const addition = event.type === "text.delta" ? event.text : event.text.slice(previous?.received ?? 0)

    const text = {
      id: event.id,
      text: (previous?.text ?? "") + addition,
      received: (previous?.received ?? 0) + addition.length,
      complete: event.type === "text.ended",
      fence: previous?.fence,
    }

    const next = {
      ...state,
      waiting: undefined,
      offsets: state.offsets.filter((item) => item.id !== event.id),
      texts: state.texts.some((item) => item.id === event.id)
        ? state.texts.map((item) => (item.id === event.id ? text : item))
        : [...state.texts, text],
    }

    if (state.status === "paused") return { state: next, effects: [{ type: "filler.clear" }] }

    // Both answer chunks and an already-started prelude own playback until its real completion acknowledgement.
    if (state.status === "speaking") return { state: next, effects: [{ type: "filler.clear" }] }

    return advance({ ...next, status: "idle" })
  }

  return { state, effects: [] }
}

function advance(
  state: Pending & { status: "idle" },
  effects: readonly VoiceSpeechEffect[] = [],
): VoiceSpeechTransition {
  const first = state.texts[0]

  if (!first) return { state, effects }
  const boundary = first.text.match(/^[\s\S]*?(?:[.!?](?:\s|$)|[。！？]|\n)/)?.[0].length

  const available = boundary ?? (first.complete ? first.text.length : 0)

  const length =
    first.text.length > 400 && (!available || available > 400)
      ? Math.max(0, first.text.lastIndexOf(" ", 400)) || 400
      : available

  if (!length) {
    if (!first.complete) return { state, effects }

    return advance(
      {
        ...state,
        texts: state.texts.slice(1),
        finished: [...state.finished, first.id],
      },
      effects,
    )
  }

  const chunk = first.text.slice(0, length)
  const marker = chunk.trimStart().match(/^(```|~~~)/)?.[1]
  const fence = marker ? (first.fence === marker ? undefined : marker) : first.fence

  const prose =
    first.fence || marker
      ? ""
      : chunk
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/[*_`#]/g, "")
          .trim()

  const next = { ...state, texts: [{ ...first, text: first.text.slice(length), fence }, ...state.texts.slice(1)] }

  if (!prose) return advance(next, effects)

  const output: VoiceOutput = {
    id: `${first.id}:${first.received - first.text.length + length}`,
    kind: "answer",
    text: prose,
  }

  return {
    state: { ...next, status: "speaking", output },
    effects: [...effects, { type: "filler.clear" }, { type: "speak", output }],
  }
}
