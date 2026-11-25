import { Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import type { VoiceCallView } from "./call-machine"
import { VoiceSpeaker } from "./speaker"
import { VoiceMicrophone } from "./microphone"

export function VoiceControls(props: {
  view: VoiceCallView
  canStart: boolean
  start(): void
  silence(): void
  mute(): void
  end(): void
  rejoin(): void
}) {
  const language = useLanguage()

  return (
    <div class="voice-integrated-controls">
      <Show
        when={props.view.panelOpen}
        fallback={
          <Tooltip value={language.t("voice.start")}>
            <IconButton
              type="button"
              variant="submit"
              class="voice-session-action"
              aria-label={language.t("voice.start")}
              disabled={!props.canStart || !props.view.canStart}
              icon={<Icon name="waveform" />}
              onClick={props.start}
            />
          </Tooltip>
        }
      >
        <Show when={props.view.canRejoin}>
          <Button type="button" size="small" variant="ghost" onClick={props.rejoin}>
            {language.t("voice.rejoin")}
          </Button>
        </Show>
        <Tooltip value={language.t(props.view.silenced ? "voice.audio.enable" : "voice.audio.silence")}>
          <IconButton
            type="button"
            variant="ghost"
            class="voice-speaker-action"
            disabled={!props.view.canMute}
            aria-pressed={props.view.silenced}
            aria-label={language.t(props.view.silenced ? "voice.audio.enable" : "voice.audio.silence")}
            icon={<VoiceSpeaker silenced={props.view.silenced} />}
            onClick={props.silence}
          />
        </Tooltip>
        <Tooltip value={language.t(props.view.muted ? "voice.unmute" : "voice.mute")}>
          <IconButton
            type="button"
            variant="ghost"
            class="voice-mute-action"
            disabled={!props.view.canMute}
            aria-pressed={props.view.muted}
            aria-label={language.t(props.view.muted ? "voice.unmute" : "voice.mute")}
            icon={<VoiceMicrophone muted={props.view.muted} />}
            onClick={props.mute}
          />
        </Tooltip>
        <Tooltip value={language.t("voice.end")}>
          <IconButton
            type="button"
            variant="submit"
            class="voice-session-action"
            aria-label={language.t("voice.end")}
            icon={<Icon name="close" />}
            onClick={props.end}
          />
        </Tooltip>
      </Show>
    </div>
  )
}
