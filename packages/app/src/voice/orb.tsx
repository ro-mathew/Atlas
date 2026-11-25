import type { VoiceCallView } from "./call-machine"

/** Audio levels are already measured by the engine; this component never opens a capture device. */
export function VoiceOrb(props: Pick<VoiceCallView, "mic" | "speaker" | "muted" | "silenced" | "connecting" | "activity" | "failure">) {
  return (
    <div class="voice-orb-space" aria-hidden="true">
      <div
        class="voice-orb"
        data-muted={props.muted}
        data-silenced={props.silenced}
        data-connecting={props.connecting}
        data-activity={props.activity}
        data-failed={!!props.failure}
        style={{
          "--voice-mic": Math.min(1, Math.max(0, props.mic) * 5),
          "--voice-speaker": Math.min(1, Math.max(0, props.speaker) * 5),
        }}
      />
    </div>
  )
}
