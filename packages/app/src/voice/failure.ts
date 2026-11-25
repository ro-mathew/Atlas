import type { VoiceJoinFailure } from "./transport-machine"

export class VoiceFailure extends Error {
  constructor(
    readonly reason:
      | VoiceJoinFailure
      | "dropped"
      | "configuration"
      | "runtime"
      | "speechAsset"
      | "recognition"
      | "submission",
  ) {
    super(reason)
  }
}
