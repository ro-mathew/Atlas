import { ClientActivity } from "./activity"

export default { title: "Plugins/Context/Client activity", id: "context-client-activity" }

export const VoiceCalls = {
  render: () => (
    <ClientActivity
      time={() => "10:30"}
      entries={[
        {
          id: "call:filler",
          type: "voice.filler",
          time: 1000,
          model: "speech-model",
          data: {
            kind: "filler",
            status: "cancelled",
            profile: { engine: "hosted", model: "speech-model", voice: "voice-a" },
          },
        },
        {
          id: "call:answer",
          type: "voice.answer",
          time: 2000,
          model: "speech-model",
          data: {
            kind: "answer",
            status: "completed",
            text: "The change is ready.",
            author: { provider: "coding-provider", model: "coding-model" },
            profile: { engine: "hosted", model: "speech-model", voice: "voice-a" },
          },
        },
      ]}
    />
  ),
}
