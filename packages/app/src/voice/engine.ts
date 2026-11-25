import type { VoicePreferences } from "./preferences"
import type { VoiceFailure } from "./failure"
import type { VoiceProfile } from "./diagnostics-machine"

export type VoiceInput =
  | { type: "speech.started"; id: string }
  | { type: "transcript.partial" | "transcript.final"; id: string; text: string }
  | { type: "speech.discarded"; id: string }

export type VoiceOutput = { id: string; kind: "answer"; text: string } | { id: string; kind: "filler" }

export type VoiceEngine = {
  connect(signal: AbortSignal): Promise<void>
  mute(value: boolean): void
  pause(): void
  resume(): void
  cancel(fade?: boolean): void
  speak(output: VoiceOutput): Promise<void>
  close(): Promise<void>
}

export type VoiceEngineOptions = {
  preferences: VoicePreferences
  input(event: VoiceInput): void
  levels(mic: number, speaker: number): void
  dropped(reason?: VoiceFailure["reason"]): void
  configured?(profile: VoiceProfile): void
}

/** Desktop owns native capture and inference; this contract crosses its existing typed IPC bridge. */
export type VoiceBridge = {
  available(): Promise<boolean>
  start(
    id: string,
    options: { runtime: string; model: string; language: string; delivery?: string; activityDelay?: number },
  ): Promise<void>
  read(id: string): Promise<readonly string[]>
  write(id: string, command: VoiceCommand): Promise<void>
  stop(id: string): Promise<void>
}

export type VoiceCommand =
  | { type: "mute"; muted: boolean }
  | { type: "pause" | "resume" }
  | { type: "cancel"; fade?: boolean }
  | { type: "speak"; output: VoiceOutput }
