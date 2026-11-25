export const DEFAULT_VOICE_STYLE =
  "Perform TTS in American English using a female voice. Speak with a warm, friendly, professional tone, clear articulation, and a natural conversational pace. Keep the voice and accent consistent throughout."

export const DEFAULT_VOICE_DELIVERY =
  "When reading decimal numbers, say point for the decimal separator, then pronounce every following digit individually, including zeros. Examples: 3.14 is three point one four; 0.05 is zero point zero five; 2.0 is two point zero; -0.25 is minus zero point two five. Preserve signs, precision, and units. Read % as percent. Keep version numbers and identifiers distinct from decimal quantities."

export function voiceInstructions(preferences: { style?: string; delivery?: string }) {
  return [preferences.style, preferences.delivery].filter((value) => value?.trim()).join("\n\n")
}
