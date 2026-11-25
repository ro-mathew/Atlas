import { expect, test } from "bun:test"
import { transitionHostedSpeech } from "./hosted-machine"

test("provider completion waits for physical playback and cancellation rejects old packets", () => {
  const requested = transitionHostedSpeech(
    { status: "idle" },
    { type: "requested", output: { id: "first", kind: "filler" } },
  )

  const speaking = transitionHostedSpeech(requested.state, { type: "created", output: "first", response: "r1" })
  const draining = transitionHostedSpeech(speaking.state, { type: "done", response: "r1", failed: false })
  expect(draining.effects).toEqual([{ type: "drain" }])
  expect(transitionHostedSpeech(draining.state, { type: "drained" }).effects).toEqual([
    { type: "resolve", id: "first" },
  ])

  const replacement = transitionHostedSpeech(speaking.state, {
    type: "requested",
    output: { id: "second", kind: "answer", text: "Done." },
  })

  expect(replacement.effects).toContainEqual({ type: "stop" })
  expect(
    transitionHostedSpeech(replacement.state, { type: "audio", response: "r1", audio: "obsolete" }).effects,
  ).toEqual([])
  const closed = transitionHostedSpeech(replacement.state, { type: "closed" })
  expect(transitionHostedSpeech(closed.state, { type: "created", output: "second", response: "r2" }).state).toBe(
    closed.state,
  )
})
