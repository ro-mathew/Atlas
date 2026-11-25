import { Show } from "solid-js"

/** The microphone and its mute slash share one footprint so toggling never shifts the controls. */
export function VoiceMicrophone(props: { muted: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5" />
      <Show when={props.muted}>
        <path d="M2 2l12 12" />
      </Show>
    </svg>
  )
}
