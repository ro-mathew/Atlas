import { createEffect, createResource, onCleanup } from "solid-js"
import type { ServerCtx } from "@/runtime/server/runtime"

/** Catalog changes are observed by clients; server requests never wait for plugin activation. */
export function createVoiceCatalog(context: () => ServerCtx | undefined) {
  const [catalog, controls] = createResource(context, async (ctx) => ({
    context: ctx,
    ...(await ctx.sdk.api.experimental.voice.models({ signal: AbortSignal.timeout(15_000) })),
  }))

  createEffect(() => {
    const ctx = context()

    if (!ctx) return

    const stops = [
      ctx.sdk.event.on("model.updated", () => controls.refetch()),
      ctx.sdk.event.on("integration.updated", () => controls.refetch()),
      ctx.sdk.event.on("plugin.updated", () => controls.refetch()),
    ]

    onCleanup(() => stops.forEach((stop) => stop()))
  })

  const current = () =>
    (catalog.state === "ready" || catalog.state === "refreshing") && catalog.latest?.context === context()
      ? catalog.latest
      : undefined

  return { catalog, current, refresh: controls.refetch }
}
