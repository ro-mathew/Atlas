import type { Prompt } from "@/composer/state"
import type { ComposerStateTarget } from "@/composer/submission-state"
import { promptLength } from "@/composer/prompt-parts"

export type VoiceComposerBinding = {
  partial(id: string, text: string): void
  discard(id: string): void
  submit(id: string, text: string): Promise<{ id: string; sent: boolean }>
}

type Draft = { status: "idle" } | { status: "showing"; id: string; base: Prompt; shown: Prompt }

type ComposerDraft = { draft: Draft }

/** The visible voice segment uses the real composer; admission sends only the finalized speech snapshot. */
export function createVoiceComposerBinding(input: {
  draft: ComposerStateTarget
  submit(text: string, base: Prompt): Promise<{ id: string; sent: boolean }>
}): VoiceComposerBinding {
  const state: ComposerDraft = { draft: { status: "idle" } }

  const partial = (id: string, text: string) => {
    const previous = state.draft

    if (previous.status === "showing" && previous.id === id && input.draft.current() !== previous.shown) return

    const base =
      previous.status === "showing" && input.draft.current() === previous.shown ? previous.base : input.draft.current()

    const prefix = base
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("")
      .trim()
      ? "\n"
      : ""

    const length = promptLength(base)

    const shown: Prompt = [
      ...base,
      { type: "text", content: prefix + text, start: length, end: length + prefix.length + text.length },
    ]

    input.draft.set(shown)
    state.draft = { status: "showing", id, base, shown: input.draft.current() }
  }

  const discard = (id: string) => {
    const previous = state.draft

    if (previous.status !== "showing" || previous.id !== id) return

    if (input.draft.current() === previous.shown) input.draft.set(previous.base)
    state.draft = { status: "idle" }
  }

  return {
    partial,
    discard,
    async submit(id, text) {
      // A hosted recognizer may finalize the previous utterance after the next one starts.
      // Admit that text without replacing the new utterance's visible composer segment.
      if (state.draft.status === "showing" && state.draft.id !== id) return input.submit(text, input.draft.current())
      partial(id, text)
      const previous = state.draft
      state.draft = { status: "idle" }

      const base =
        previous.status === "showing" && input.draft.current() === previous.shown
          ? previous.base
          : input.draft.current()

      const result = await input.submit(text, base)

      // Admission belongs to the Session. This promise deliberately has no call AbortSignal.
      if (
        result.sent &&
        previous.status === "showing" &&
        previous.id === id &&
        input.draft.current() === previous.shown
      )
        input.draft.set(previous.base)

      return result
    },
  }
}
