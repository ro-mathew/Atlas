import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { VoiceCallView } from "./call-machine"
import { VoiceOrb } from "./orb"

export function VoiceIndicator(props: { view: VoiceCallView }) {
  const language = useLanguage()

  return (
    <Show when={props.view.panelOpen}>
      <div class="voice-integrated-indicator">
        <VoiceOrb
          mic={props.view.mic}
          speaker={props.view.speaker}
          muted={props.view.muted}
          silenced={props.view.silenced}
          connecting={props.view.connecting}
          activity={props.view.activity}
          failure={props.view.failure}
        />
        <p
          role="status"
          class="voice-integrated-status"
          classList={{
            "sr-only": !props.view.failure,
          }}
        >
          {language.t(statusKey(props.view))}
        </p>
      </div>
    </Show>
  )
}

function statusKey(view: VoiceCallView) {
  if (view.failure) return `voice.failure.${view.failure}` as const

  if (view.connecting) return "voice.connecting"

  if (view.muted) return "voice.status.muted"

  return `voice.status.${view.activity}` as const
}
