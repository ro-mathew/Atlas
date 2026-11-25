import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { DEFAULT_VOICE_DELIVERY, DEFAULT_VOICE_STYLE } from "./prompts"

export const VoicePreferences = Persistence.struct({
  enabled: Schema.Boolean,
  engine: Schema.Literals(["local", "hosted"]),
  model: Schema.String,
  localModel: Schema.String,
  runtime: Schema.String,
  language: Schema.String,
  voice: Schema.String,
  transcription: Schema.String,
  filler: Schema.Boolean,
  activityDelay: Persistence.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 300, maximum: 3000 })),
  ),
  delivery: Persistence.optional(Schema.String),
  style: Persistence.optional(Schema.String),
})

export type VoicePreferences = typeof VoicePreferences.Type

export const voiceDefaults: VoicePreferences = {
  enabled: false,
  engine: "local",
  model: "",
  localModel: "",
  runtime: "",
  language: "en-US",
  voice: "",
  transcription: "",
  filler: true,
  activityDelay: 1000,
  style: DEFAULT_VOICE_STYLE,
  delivery: DEFAULT_VOICE_DELIVERY,
}

/** Older profiles used delivery for speaker guidance. Preserve that customization as style. */
export function resolveVoicePreferences(value: VoicePreferences | undefined): VoicePreferences {
  return {
    ...voiceDefaults,
    ...value,
    activityDelay: value?.activityDelay ?? voiceDefaults.activityDelay,
    style: value?.style ?? (value?.delivery?.trim() || DEFAULT_VOICE_STYLE),
    delivery: value?.style === undefined ? DEFAULT_VOICE_DELIVERY : (value.delivery ?? DEFAULT_VOICE_DELIVERY),
  }
}
