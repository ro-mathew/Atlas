import { Show } from "solid-js"

export function VoiceSpeaker(props: { silenced: boolean }) {
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
      <path d="M2 6h3l3-3v10l-3-3H2z" fill="currentColor" stroke="none" />
      <Show when={!props.silenced} fallback={<path d="m11 6 4 4m0-4-4 4" />}>
        <path d="M10.5 5.5a4 4 0 0 1 0 5M12.5 3.5a7 7 0 0 1 0 9" />
      </Show>
    </svg>
  )
}
