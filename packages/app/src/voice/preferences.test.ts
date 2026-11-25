import { expect, test } from "bun:test"
import { resolveVoicePreferences, voiceDefaults } from "./preferences"
import { DEFAULT_VOICE_DELIVERY, DEFAULT_VOICE_STYLE, voiceInstructions } from "./prompts"

test("older voice profiles preserve speaker instructions while gaining separate number delivery guidance", () => {
  const legacy = { ...voiceDefaults, style: undefined }
  expect(resolveVoicePreferences({ ...legacy, delivery: "My existing speaker." })).toMatchObject({
    style: "My existing speaker.",
    delivery: DEFAULT_VOICE_DELIVERY,
  })
  expect(resolveVoicePreferences({ ...legacy, delivery: "" })).toMatchObject({
    style: DEFAULT_VOICE_STYLE,
    delivery: DEFAULT_VOICE_DELIVERY,
  })
})

test("independent prompt edits and explicitly empty prompts survive resolution and join in submission order", () => {
  const preferences = resolveVoicePreferences({ ...voiceDefaults, style: "My voice.", delivery: "My pronunciation." })
  expect(voiceInstructions(preferences)).toBe("My voice.\n\nMy pronunciation.")
  expect(resolveVoicePreferences({ ...preferences, style: "", delivery: "" })).toMatchObject({
    style: "",
    delivery: "",
  })
  expect(voiceInstructions({ style: "", delivery: "Only pronunciation." })).toBe("Only pronunciation.")
})

test("older profiles gain the slower activity delay and custom delays survive resolution", () => {
  expect(resolveVoicePreferences(undefined).activityDelay).toBe(1000)
  expect(resolveVoicePreferences({ ...voiceDefaults, activityDelay: undefined }).activityDelay).toBe(1000)
  expect(resolveVoicePreferences({ ...voiceDefaults, activityDelay: 1500 }).activityDelay).toBe(1500)
})
