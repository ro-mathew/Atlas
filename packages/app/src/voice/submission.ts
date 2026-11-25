import type { VoiceComposerBinding } from "./input"
import { voiceTargetKey, type VoiceInputTarget } from "./input-machine"

export type VoiceSubmission = {
  id: string
  target: VoiceInputTarget
  binding: VoiceComposerBinding
  text: string
}

type SpeechBatch = Omit<VoiceSubmission, "text"> & {
  segments: { id: string; text: string; final: boolean }[]
}

type SubmissionQueue = {
  status: "waiting" | "ready" | "closed"
  hearing: boolean
  active: boolean
  pending: SpeechBatch[]
  timer?: ReturnType<typeof setTimeout>
}

/** Recognition segments within one quiet interval become one visible prompt and one admission. */
export function createVoiceSubmissionQueue(input: { delay: number; submit(batch: VoiceSubmission): Promise<void> }) {
  const state: SubmissionQueue = { status: "waiting", hearing: false, active: false, pending: [] }

  const text = (batch: SpeechBatch) =>
    batch.segments
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(" ")

  const preview = (batch: SpeechBatch) => {
    const value = text(batch)

    if (value) return batch.binding.partial(batch.id, value)
    batch.binding.discard(batch.id)
  }

  const drain = () => {
    if (state.status !== "ready" || state.active) return
    const batch = state.pending[0]

    if (!batch || batch.segments.some((segment) => !segment.final)) return
    state.pending.shift()
    state.active = true
    // Detach the batch before admission so new speech starts the next message.
    // The owning call reports admission failures before this task settles.
    void input.submit({ id: batch.id, target: batch.target, binding: batch.binding, text: text(batch) }).then(() => {
      state.active = false
      drain()
    })
  }

  const arm = () => {
    clearTimeout(state.timer)

    if (state.status === "closed") return
    state.status = "waiting"

    if (state.hearing || !state.pending.length) return
    state.timer = setTimeout(() => {
      state.status = "ready"
      drain()
    }, input.delay)
  }

  return {
    hearing(value: boolean) {
      state.hearing = value
      arm()
    },
    update(segment: VoiceSubmission, final = false) {
      if (state.status === "closed") return
      const existing = state.pending.find((batch) => batch.segments.some((part) => part.id === segment.id))
      const last = state.pending.at(-1)

      const batch =
        existing ??
        (last && last.binding === segment.binding && voiceTargetKey(last.target) === voiceTargetKey(segment.target)
          ? last
          : { id: segment.id, target: segment.target, binding: segment.binding, segments: [] })

      if (!existing && batch !== last) state.pending.push(batch)
      const part = batch.segments.find((part) => part.id === segment.id)

      if (part) Object.assign(part, { text: segment.text, final })

      if (!part) batch.segments.push({ id: segment.id, text: segment.text, final })
      preview(batch)
      arm()
    },
    discard(id: string) {
      if (state.status === "closed") return
      const batch = state.pending.find((batch) => batch.segments.some((part) => part.id === id))

      if (!batch) return
      batch.segments = batch.segments.filter((part) => part.id !== id)
      preview(batch)
      state.pending = state.pending.filter((batch) => batch.segments.length)
      arm()
    },
    close() {
      state.status = "closed"
      clearTimeout(state.timer)
      state.pending = []
    },
  }
}
