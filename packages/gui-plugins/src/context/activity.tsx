import { createMemo, For, Show } from "solid-js"
import { checksum } from "@opencode/util/encode"
import { Accordion } from "@opencode/ui/accordion"
import { File } from "@opencode/session-ui/file"
import { usePlugin } from "@opencode/plugin/gui"
import type { BuiltinDiagnostic } from "@opencode/plugin/gui/builtin"

/** Client operations are inspectable without becoming model-visible raw messages. */
export function ClientActivity(props: { entries: readonly BuiltinDiagnostic[]; time(value: number): string }) {
  const ctx = usePlugin()

  return (
    <Show when={props.entries.length}>
      <section class="flex flex-col gap-2">
        <h3 class="text-12-regular text-text-weak">{ctx.t("activity.title")}</h3>
        <p class="text-12-regular text-text-weak">{ctx.t("activity.description")}</p>
        <Accordion multiple>
          <For each={props.entries}>
            {(entry) => {
              const file = createMemo(() => {
                const contents = JSON.stringify(entry, null, 2)

                return { name: `${entry.id}.json`, contents, cacheKey: checksum(contents) }
              })

              return (
                <Accordion.Item value={entry.id}>
                  <Accordion.Trigger>
                    <div class="flex min-w-0 w-full items-center justify-between gap-2">
                      <div class="min-w-0 text-left">
                        <div>{entry.type}</div>
                        <div class="break-all text-text-weak">{entry.model}</div>
                      </div>
                      <span class="shrink-0 text-text-weak">{props.time(entry.time)}</span>
                    </div>
                  </Accordion.Trigger>
                  <Accordion.Content>
                    <div class="p-3">
                      <File mode="text" file={file()} overflow="wrap" class="select-text" />
                    </div>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
      </section>
    </Show>
  )
}
