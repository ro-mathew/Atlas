import { expect, test } from "bun:test"
import { createClientDiagnostics } from "./diagnostics"

test("Context activity updates a single operation and keeps servers, sessions and window stores separate", () => {
  const log = createClientDiagnostics()
  const other = createClientDiagnostics()
  const target = { server: "server-a", sessionID: "session-a" }
  const session = { server: { id: target.server }, id: target.sessionID }
  const entry = { id: "operation", type: "voice.answer", time: 1000, model: "speech-model", data: { status: "active" } }
  log.record(target, entry)
  log.record({ ...target, server: "server-b" }, entry)
  log.record({ ...target, sessionID: "session-b" }, entry)
  log.record(target, { ...entry, data: { status: "completed" } })
  expect(log.list(session)).toEqual([{ ...entry, data: { status: "completed" } }])
  expect(log.list({ ...session, server: { id: "server-b" } })).toEqual([entry])
  expect(log.list({ ...session, id: "session-b" })).toEqual([entry])
  expect(other.list(session)).toEqual([])
})

test("the window retains only the newest 200 client operations", () => {
  const log = createClientDiagnostics()
  Array.from({ length: 205 }, (_, index) => index).forEach((index) =>
    log.record(
      { server: "local", sessionID: "session" },
      { id: `${index}`, type: "voice.filler", time: index, data: {} },
    ),
  )
  const entries = log.list({ server: { id: "local" }, id: "session" })
  expect(entries).toHaveLength(200)
  expect(entries[0]?.id).toBe("5")
  expect(entries.at(-1)?.id).toBe("204")
})
