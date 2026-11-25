import { createEffect, onCleanup, Show, type JSX } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import type { SessionInfo } from "@opencode/client/promise"
import { useServer } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { useVoice } from "./context"
import { createVoiceCatalog } from "./catalog"
import { VoiceIndicator } from "./indicator"
import { VoiceControls } from "./controls"
import { VoiceSpeaker } from "./speaker"
import { VoiceMicrophone } from "./microphone"
import "./voice.css"

export function VoiceComposer(props: {
  session?: SessionInfo
  draft?: { id: string; ready: boolean }
  children(voice: { indicator: JSX.Element; controls: JSX.Element; active: boolean }): JSX.Element
}) {
  const voice = useVoice()
  onCleanup(voice.present())
  const server = useServer()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const catalog = createVoiceCatalog(() => (settings.voice.current().enabled ? server.ctx : undefined))

  const enabled = () =>
    platform.platform === "desktop" && settings.voice.current().enabled && catalog.current()?.enabled === true

  createEffect(() => {
    const session = props.session

    if (session) voice.syncSession(server.key, session)
  })

  return props.children({
    get active() {
      return voice.view().panelOpen
    },
    indicator: <VoiceIndicator view={voice.view()} />,
    controls: (
      <Show when={enabled() || voice.view().panelOpen}>
        <VoiceControls
          view={voice.view()}
          canStart={!!props.session || !!props.draft?.ready}
          start={() => {
            const session = props.session

            if (session) return voice.start(server.key, server.ctx, session)

            if (props.draft) voice.startDraft(server.key, server.ctx, props.draft.id, language.t("voice.newChat"))
          }}
          silence={voice.silence}
          mute={voice.mute}
          end={voice.end}
          rejoin={voice.rejoin}
        />
      </Show>
    ),
  })
}

/** Call controls remain reachable on screens without a composer. */
export function VoiceDock() {
  const voice = useVoice()
  const language = useLanguage()

  return (
    <Show when={voice.view().panelOpen && !voice.presented()}>
      <div class="voice-inline-dock" role="region" aria-label={language.t("voice.panel")}>
        <span>{voice.view().title}</span>
        <IconButton
          type="button"
          variant="ghost"
          class="voice-speaker-action"
          disabled={!voice.view().canMute}
          aria-pressed={voice.view().silenced}
          aria-label={language.t(voice.view().silenced ? "voice.audio.enable" : "voice.audio.silence")}
          icon={<VoiceSpeaker silenced={voice.view().silenced} />}
          onClick={voice.silence}
        />
        <IconButton
          type="button"
          variant="ghost"
          aria-label={language.t(voice.view().muted ? "voice.unmute" : "voice.mute")}
          disabled={!voice.view().canMute}
          aria-pressed={voice.view().muted}
          icon={<VoiceMicrophone muted={voice.view().muted} />}
          onClick={voice.mute}
        />
        <IconButton
          type="button"
          variant="submit"
          aria-label={language.t("voice.end")}
          icon={<Icon name="close" />}
          onClick={voice.end}
        />
      </div>
    </Show>
  )
}
