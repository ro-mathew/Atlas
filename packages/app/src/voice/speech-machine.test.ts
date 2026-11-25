import { expect, test } from "bun:test"
import { createVoiceSpeechState, transitionVoiceSpeech, type VoiceSpeechEvent } from "./speech-machine"

function replay(events: VoiceSpeechEvent[]) {
  return events.reduce((state, event) => transitionVoiceSpeech(state, event).state, createVoiceSpeechState())
}

test("streamed phrases are spoken once when final text arrives", () => {
  const first = transitionVoiceSpeech(createVoiceSpeechState(), {
    type: "text.delta",
    id: "answer",
    text: "The fix works. ",
  })

  expect(first.effects).toContainEqual({
    type: "speak",
    output: { id: "answer:15", kind: "answer", text: "The fix works." },
  })

  const final = transitionVoiceSpeech(first.state, {
    type: "text.ended",
    id: "answer",
    text: "The fix works. Tests pass.",
  })

  expect(final.effects.some((effect) => effect.type === "speak")).toBe(false)
  const next = transitionVoiceSpeech(final.state, { type: "output.ended", id: "answer:15" })
  expect(next.effects).toContainEqual({
    type: "speak",
    output: { id: "answer:26", kind: "answer", text: "Tests pass." },
  })
  const done = transitionVoiceSpeech(next.state, { type: "output.ended", id: "answer:26" })
  expect(done.state.status).toBe("idle")
  expect(
    transitionVoiceSpeech(done.state, { type: "text.ended", id: "answer", text: "The fix works. Tests pass." }).effects,
  ).toEqual([])
})

test("a response waits for prelude playback to finish without including filler in answer text", () => {
  const waiting = replay([
    { type: "request.admitted", id: "prompt" },
    { type: "filler.due", id: "prompt" },
  ])

  expect(waiting.status === "speaking" && waiting.output).toEqual({ id: "filler:prompt", kind: "filler" })
  const actual = transitionVoiceSpeech(waiting, { type: "text.delta", id: "answer", text: "Found it. " })
  expect(actual.effects).toEqual([{ type: "filler.clear" }])
  const final = transitionVoiceSpeech(actual.state, { type: "text.ended", id: "answer", text: "Found it. Tests pass." })
  expect(final.effects).toEqual([{ type: "filler.clear" }])
  expect(transitionVoiceSpeech(final.state, { type: "output.ended", id: "stale" }).state).toBe(final.state)
  const played = transitionVoiceSpeech(final.state, { type: "output.ended", id: "filler:prompt" })
  expect(played.effects).toContainEqual({
    type: "speak",
    output: { id: "answer:10", kind: "answer", text: "Found it." },
  })
  expect(transitionVoiceSpeech(played.state, { type: "output.ended", id: "filler:prompt" }).state).toBe(played.state)
  expect(transitionVoiceSpeech(played.state, { type: "output.ended", id: "answer:10" }).effects).toContainEqual({
    type: "speak",
    output: { id: "answer:21", kind: "answer", text: "Tests pass." },
  })
})

test("a paused prelude retains its queued answer, while user interruption and End can still cancel it", () => {
  const prelude = replay([
    { type: "request.admitted", id: "prompt" },
    { type: "filler.due", id: "prompt" },
  ])

  const paused = transitionVoiceSpeech(prelude, { type: "speech.started" })
  const queued = transitionVoiceSpeech(paused.state, { type: "text.ended", id: "answer", text: "Ready." })
  expect(queued.effects).toEqual([{ type: "filler.clear" }])
  const resumed = transitionVoiceSpeech(queued.state, { type: "speech.discarded" })
  expect(resumed.effects).toEqual([{ type: "resume" }])
  expect(transitionVoiceSpeech(resumed.state, { type: "output.ended", id: "filler:prompt" }).effects).toContainEqual({
    type: "speak",
    output: { id: "answer:6", kind: "answer", text: "Ready." },
  })

  for (const type of ["speech.accepted", "closed"] as const) {
    const cancelled = transitionVoiceSpeech(queued.state, { type })
    expect(cancelled.effects).toContainEqual(type === "closed" ? { type: "cancel" } : { type: "cancel", fade: true })
    expect(transitionVoiceSpeech(cancelled.state, { type: "output.ended", id: "filler:prompt" }).effects).toEqual([])
  }
})

test("noise resumes a paused response; admitted speech discards its remaining audio", () => {
  const speaking = replay([{ type: "text.delta", id: "old", text: "First sentence. More text" }])
  const paused = transitionVoiceSpeech(speaking, { type: "speech.started" })
  expect(paused.effects).toContainEqual({ type: "pause" })
  expect(transitionVoiceSpeech(paused.state, { type: "speech.discarded" }).effects).toEqual([{ type: "resume" }])
  const accepted = transitionVoiceSpeech(paused.state, { type: "speech.accepted" })
  expect(accepted.effects).toContainEqual({ type: "cancel", fade: true })
  expect(transitionVoiceSpeech(accepted.state, { type: "text.delta", id: "old", text: " obsolete." }).effects).toEqual(
    [],
  )
  expect(
    transitionVoiceSpeech(accepted.state, { type: "text.ended", id: "new", text: "New answer." }).effects,
  ).toContainEqual({ type: "speak", output: { id: "new:11", kind: "answer", text: "New answer." } })
})

test("closing cancels voice only and rejects late output events", () => {
  const state = replay([{ type: "request.admitted", id: "prompt" }])
  const closed = transitionVoiceSpeech(state, { type: "closed" })
  expect(closed.effects).toEqual([{ type: "filler.clear" }, { type: "cancel" }])

  for (const event of [
    { type: "filler.due", id: "prompt" },
    { type: "text.ended", id: "answer", text: "Done." },
    { type: "output.ended", id: "answer:5" },
  ] satisfies VoiceSpeechEvent[])
    expect(transitionVoiceSpeech(closed.state, event).state).toBe(closed.state)
})

test("attaching during work speaks new words without replaying history on the final event", () => {
  const attached = createVoiceSpeechState([
    { id: "old", received: 10, complete: true },
    { id: "already-ended-block", received: 30, complete: false },
    { id: "active", received: 12, complete: false },
  ])

  expect(transitionVoiceSpeech(attached, { type: "text.ended", id: "old", text: "Old words." }).effects).toEqual([])
  const final = transitionVoiceSpeech(attached, { type: "text.ended", id: "active", text: "Old prefix. New result." })
  expect(final.effects).toContainEqual({
    type: "speak",
    output: { id: "active:23", kind: "answer", text: "New result." },
  })
})

test("streamed code fences stay silent and unspaced text has a bounded first phrase", () => {
  const code = transitionVoiceSpeech(createVoiceSpeechState(), {
    type: "text.delta",
    id: "code",
    text: "```ts\nconsole.log('private')\n```\nThe fix is ready. ",
  })

  expect(code.effects.filter((effect) => effect.type === "speak").map((effect) => effect.output)).toEqual([
    { id: "code:51", kind: "answer", text: "The fix is ready." },
  ])
  const cjk = transitionVoiceSpeech(createVoiceSpeechState(), { type: "text.delta", id: "cjk", text: "完成了。" })
  expect(cjk.effects).toContainEqual({ type: "speak", output: { id: "cjk:4", kind: "answer", text: "完成了。" } })

  const long = transitionVoiceSpeech(createVoiceSpeechState(), {
    type: "text.delta",
    id: "long",
    text: "a".repeat(500),
  })

  expect(long.effects).toContainEqual({
    type: "speak",
    output: { id: "long:400", kind: "answer", text: "a".repeat(400) },
  })

  const complete = transitionVoiceSpeech(createVoiceSpeechState(), {
    type: "text.ended",
    id: "large",
    text: "a".repeat(2100) + ".",
  })

  expect(complete.effects).toContainEqual({
    type: "speak",
    output: { id: "large:400", kind: "answer", text: "a".repeat(400) },
  })
})

test("silence cancels current speech and suppresses answer synthesis and preludes until enabled", () => {
  const prelude = replay([
    { type: "request.admitted", id: "prompt" },
    { type: "filler.due", id: "prompt" },
  ])

  const silent = transitionVoiceSpeech(prelude, { type: "silence.changed", silenced: true })
  expect(silent.effects).toEqual([{ type: "filler.clear" }, { type: "cancel" }])

  const skipped = [
    { type: "request.admitted", id: "next" },
    { type: "filler.due", id: "next" },
    { type: "speech.started" },
    { type: "speech.accepted" },
    { type: "text.delta", id: "answer", text: "Silent answer. " },
    { type: "text.ended", id: "answer", text: "Silent answer. " },
    { type: "output.ended", id: "filler:prompt" },
  ] satisfies VoiceSpeechEvent[]

  const state = skipped.reduce((state, event) => {
    const next = transitionVoiceSpeech(state, event)
    expect(next.effects).toEqual([])

    return next.state
  }, silent.state)

  const enabled = transitionVoiceSpeech(state, { type: "silence.changed", silenced: false })
  expect(enabled.effects).toEqual([])
  expect(
    transitionVoiceSpeech(enabled.state, { type: "text.ended", id: "answer", text: "Silent answer. " }).effects,
  ).toEqual([])
  expect(
    transitionVoiceSpeech(enabled.state, { type: "text.ended", id: "new", text: "Speak now." }).effects,
  ).toContainEqual({ type: "speak", output: { id: "new:10", kind: "answer", text: "Speak now." } })
})

test("enabling audio during a stream skips text received while silent and ignores late playback acknowledgements", () => {
  const speaking = replay([{ type: "text.delta", id: "answer", text: "First. " }])
  const silent = transitionVoiceSpeech(speaking, { type: "silence.changed", silenced: true })
  const skipped = transitionVoiceSpeech(silent.state, { type: "text.delta", id: "answer", text: "Skip this. " })
  const enabled = transitionVoiceSpeech(skipped.state, { type: "silence.changed", silenced: false })
  expect(transitionVoiceSpeech(enabled.state, { type: "output.ended", id: "answer:7" }).state).toBe(enabled.state)

  const next = transitionVoiceSpeech(enabled.state, {
    type: "text.ended",
    id: "answer",
    text: "First. Skip this. New speech.",
  })

  expect(next.effects).toContainEqual({
    type: "speak",
    output: { id: "answer:29", kind: "answer", text: "New speech." },
  })
  expect(transitionVoiceSpeech(skipped.state, { type: "closed" }).state.status).toBe("closed")
})

test("confirmed interruption yields early, ignores a late discard, and suppresses the next waiting prelude", () => {
  const speaking = replay([{ type: "text.delta", id: "old", text: "First sentence. More text" }])
  const paused = transitionVoiceSpeech(speaking, { type: "speech.started" })
  const confirmed = transitionVoiceSpeech(paused.state, { type: "speech.confirmed" })
  expect(confirmed.effects).toEqual([{ type: "filler.clear" }, { type: "cancel", fade: true }])
  expect(transitionVoiceSpeech(confirmed.state, { type: "speech.discarded" }).effects).toEqual([])
  expect(transitionVoiceSpeech(confirmed.state, { type: "speech.confirmed" }).effects).toEqual([])
  const final = transitionVoiceSpeech(confirmed.state, { type: "speech.accepted" })
  expect(final.effects).toEqual([{ type: "filler.clear" }])
  const admitted = transitionVoiceSpeech(final.state, { type: "request.admitted", id: "interrupt" })
  expect(admitted.effects).toEqual([{ type: "filler.clear" }])
  expect(transitionVoiceSpeech(admitted.state, { type: "filler.due", id: "interrupt" }).effects).toEqual([])
  expect(transitionVoiceSpeech(admitted.state, { type: "text.delta", id: "old", text: " Obsolete." }).effects).toEqual(
    [],
  )
  expect(
    transitionVoiceSpeech(admitted.state, { type: "text.ended", id: "new", text: "New answer." }).effects,
  ).toContainEqual({ type: "speak", output: { id: "new:11", kind: "answer", text: "New answer." } })
})

test("a false alarm restores the same output and leaves ordinary waiting preludes enabled", () => {
  const speaking = replay([{ type: "text.delta", id: "answer", text: "Keep speaking." }])
  const paused = transitionVoiceSpeech(speaking, { type: "speech.started" })
  const resumed = transitionVoiceSpeech(paused.state, { type: "speech.discarded" })
  expect(resumed.effects).toEqual([{ type: "resume" }])
  expect(resumed.state).toEqual(speaking)
  expect(
    transitionVoiceSpeech(createVoiceSpeechState(), { type: "request.admitted", id: "normal" }).effects,
  ).toContainEqual({ type: "filler.wait", id: "normal" })
})
