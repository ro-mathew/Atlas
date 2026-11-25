import { createStore } from "solid-js/store"
import type { BuiltinDiagnostic } from "@opencode/plugin/gui/builtin"

/** Window-local activity. Feature owners provide snapshots; this store owns no operation lifecycle. */
export function createClientDiagnostics() {
  const [store, setStore] = createStore<{
    entries: { server: string; sessionID: string; entry: BuiltinDiagnostic }[]
  }>({ entries: [] })

  return {
    list(session: { id: string; server: { id: string } }) {
      return store.entries
        .filter((item) => item.server === session.server.id && item.sessionID === session.id)
        .map((item) => item.entry)
    },
    record(target: { server: string; sessionID: string }, entry: BuiltinDiagnostic) {
      setStore("entries", (entries) => {
        const index = entries.findIndex(
          (item) => item.server === target.server && item.sessionID === target.sessionID && item.entry.id === entry.id,
        )

        const item = { ...target, entry }

        if (index === -1) return [...entries, item].slice(-200)

        return entries.map((previous, ordinal) => (ordinal === index ? item : previous))
      })
    },
  }
}
