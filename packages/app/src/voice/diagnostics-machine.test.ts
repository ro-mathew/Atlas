import { expect, test } from "bun:test"
import { transitionVoiceDiagnostics, type VoiceDiagnosticsState, type VoiceProfile } from "./diagnostics-machine"

const profile: VoiceProfile = {
  engine: "local",
  model: "/models/speech",
  voice: "",
  transcription: "",
  language: "en-US",
  delivery: "Speak calmly.",
}

const target = { server: "local", sessionID: "session-a" }

test("speech provenance stays attached to its model and original session when settings and navigation change", () => {
  const configured = transitionVoiceDiagnostics({ entries: [] }, { type: "configured", profile })

  const started = transitionVoiceDiagnostics(configured, {
    type: "started",
    time: 1000,
    target,
    output: { id: "answer:1", kind: "answer", text: "Fixed the issue." },
    author: { provider: "coding-provider", model: "coding-model", variant: "high" },
  })

  const switched = transitionVoiceDiagnostics(started, {
    type: "configured",
    profile: { ...profile, engine: "hosted", model: "hosted-speech", voice: "voice-a" },
  })

  const next = transitionVoiceDiagnostics(switched, {
    type: "started",
    time: 2000,
    target: { ...target, sessionID: "session-b" },
    output: { id: "filler:2", kind: "filler" },
  })

  expect(next.entries[0]).toEqual({
    id: "answer:1",
    time: 1000,
    target,
    kind: "answer",
    status: "active",
    profile,
    text: "Fixed the issue.",
    author: { provider: "coding-provider", model: "coding-model", variant: "high" },
  })
  expect(next.entries[1]).toMatchObject({
    target: { sessionID: "session-b" },
    profile: { model: "hosted-speech", voice: "voice-a" },
  })
})

test("waiting audio cannot acquire a transcript even if a provider supplies extra text", () => {
  const output = { id: "filler:1", kind: "filler" as const, text: "This must never enter a log." }
  const state = transitionVoiceDiagnostics({ profile, entries: [] }, { type: "started", time: 1000, target, output })
  expect(state.entries[0]).toEqual({ id: "filler:1", kind: "filler", status: "active", profile, target, time: 1000 })
  expect(JSON.stringify(state)).not.toContain(output.text)
})

test("playback completion, pause, cancellation and failure settle only the matching active output", () => {
  const started = transitionVoiceDiagnostics(
    { profile, entries: [] },
    {
      type: "started",
      time: 1000,
      target,
      output: { id: "filler:1", kind: "filler" },
    },
  )

  const paused = transitionVoiceDiagnostics(started, { type: "paused" })
  expect(paused.entries[0]?.status).toBe("paused")
  const resumed = transitionVoiceDiagnostics(paused, { type: "resumed" })
  expect(resumed.entries[0]?.status).toBe("active")
  expect(transitionVoiceDiagnostics(resumed, { type: "ended", id: "stale" })).toBe(resumed)
  const cancelled = transitionVoiceDiagnostics(resumed, { type: "cancelled" })
  expect(cancelled.entries[0]?.status).toBe("cancelled")
  expect(transitionVoiceDiagnostics(cancelled, { type: "ended", id: "filler:1" })).toBe(cancelled)
  expect(transitionVoiceDiagnostics(cancelled, { type: "failed", id: "filler:1" })).toBe(cancelled)
  expect(transitionVoiceDiagnostics(resumed, { type: "ended", id: "filler:1" }).entries[0]?.status).toBe("completed")
  expect(transitionVoiceDiagnostics(resumed, { type: "failed", id: "filler:1" }).entries[0]?.status).toBe("failed")
})

test("the call's recent trace is bounded and duplicate starts do not relabel an output", () => {
  const state = Array.from({ length: 15 }, (_, index) => index).reduce<VoiceDiagnosticsState>(
    (state, index) =>
      transitionVoiceDiagnostics(state, {
        type: "started",
        time: index,
        target,
        output: { id: `filler:${index}`, kind: "filler" },
      }),
    { profile, entries: [] },
  )

  expect(state.entries).toHaveLength(12)
  expect(state.entries[0]?.id).toBe("filler:3")
  expect(
    transitionVoiceDiagnostics(state, {
      type: "started",
      time: 99,
      target,
      output: { id: "filler:14", kind: "filler" },
    }),
  ).toBe(state)
})
