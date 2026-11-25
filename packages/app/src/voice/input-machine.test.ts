import { expect, test } from "bun:test"
import { transitionVoiceInput, type VoiceInputState } from "./input-machine"

test("detached recognition periods cannot become messages or prefix the next utterance", () => {
  const target = { server: "local", sessionID: "first" }
  const hearing = transitionVoiceInput({ status: "idle", accepted: [] }, { type: "speech.started", id: "u" }, target)

  expect(
    transitionVoiceInput(hearing.state, { type: "transcript.partial", id: "u", text: "." }, target).effects,
  ).toEqual([{ type: "partial", id: "u", target, text: "" }])
  const discarded = transitionVoiceInput(hearing.state, { type: "transcript.final", id: "u", text: " . " }, target)

  expect(discarded.effects).toEqual([{ type: "discard", id: "u", target }, { type: "resume" }])
  expect(
    transitionVoiceInput(discarded.state, { type: "transcript.final", id: "u", text: "." }, target).effects,
  ).toEqual([])
  const next = transitionVoiceInput(discarded.state, { type: "speech.started", id: "next" }, target)

  expect(
    transitionVoiceInput(next.state, { type: "transcript.partial", id: "next", text: ". not really." }, target).effects,
  ).toEqual([{ type: "partial", id: "next", target, text: "not really." }])
  expect(
    transitionVoiceInput(next.state, { type: "transcript.final", id: "next", text: ". not really." }, target).effects,
  ).toContainEqual({ type: "submit", id: "next", target, text: "not really." })
})

test.each([".5", ".env", ".gitignore", "3.14", "No. Keep that."])(
  "speech cleanup preserves meaningful punctuation in %s",
  (text) => {
    const target = { server: "local", sessionID: "first" }

    const result = transitionVoiceInput(
      { status: "idle", accepted: [] },
      { type: "transcript.final", id: "u", text },
      target,
    )

    expect(result.effects).toContainEqual({ type: "submit", id: "u", target, text })
  },
)

test("one utterance keeps its original session and cannot submit twice after navigation", () => {
  const original = { server: "local", sessionID: "first" }
  const next = { server: "local", sessionID: "second" }
  const hearing = transitionVoiceInput({ status: "idle", accepted: [] }, { type: "speech.started", id: "u" }, original)
  const partial = transitionVoiceInput(hearing.state, { type: "transcript.partial", id: "u", text: "Change" }, next)
  expect(partial.effects).toEqual([{ type: "partial", id: "u", target: original, text: "Change" }])
  const final = transitionVoiceInput(partial.state, { type: "transcript.final", id: "u", text: "Change it" }, next)
  expect(final.effects).toContainEqual({ type: "submit", id: "u", target: original, text: "Change it" })
  expect(
    transitionVoiceInput(final.state, { type: "transcript.final", id: "u", text: "Change it" }, next).effects,
  ).toEqual([])
})

test("empty recognition resumes playback; closing rejects late finals", () => {
  const target = { server: "local", sessionID: "first" }
  const state: VoiceInputState = { status: "hearing", id: "u", target, accepted: [] }
  expect(transitionVoiceInput(state, { type: "transcript.final", id: "u", text: "  " }, target).effects).toEqual([
    { type: "discard", id: "u", target },
    { type: "resume" },
  ])
  const discarded = transitionVoiceInput(state, { type: "speech.discarded", id: "u" }, target).state
  expect(
    transitionVoiceInput(discarded, { type: "transcript.final", id: "u", text: "Late muted speech" }, target).effects,
  ).toEqual([])
  const closed = transitionVoiceInput(state, { type: "closed" }, target).state
  expect(transitionVoiceInput(closed, { type: "transcript.final", id: "u", text: "Late" }, target).effects).toEqual([])
})

test("a delayed final keeps its original target without ending a newer utterance", () => {
  const first = { server: "local", sessionID: "first" }
  const second = { server: "local", sessionID: "second" }
  const start = transitionVoiceInput({ status: "idle", accepted: [] }, { type: "speech.started", id: "one" }, first)
  const next = transitionVoiceInput(start.state, { type: "speech.started", id: "two" }, second)

  const delayed = transitionVoiceInput(
    next.state,
    { type: "transcript.final", id: "one", text: "First request" },
    second,
  )

  expect(delayed.effects).toContainEqual({ type: "submit", id: "one", text: "First request", target: first })
  expect(delayed.effects.at(-1)).toEqual({ type: "pause" })
  expect(delayed.state).toMatchObject({ status: "hearing", id: "two", target: second })
})

test("an utterance captured in a draft retains that binding through session promotion", () => {
  const draft = { server: "local", draftID: "new-chat" }
  const session = { server: "local", sessionID: "created-session" }
  const hearing = transitionVoiceInput({ status: "idle", accepted: [] }, { type: "speech.started", id: "first" }, draft)

  const final = transitionVoiceInput(
    hearing.state,
    { type: "transcript.final", id: "first", text: "Build it" },
    session,
  )

  expect(final.effects).toContainEqual({ type: "submit", id: "first", target: draft, text: "Build it" })
  expect(
    transitionVoiceInput(final.state, { type: "transcript.final", id: "first", text: "Build it" }, session).effects,
  ).toEqual([])
})
