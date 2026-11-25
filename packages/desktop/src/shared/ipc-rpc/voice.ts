import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const Output = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("answer"),
    text: Schema.String.check(Schema.isMaxLength(2000)),
  }),
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("filler") }),
])

const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("mute"), muted: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literals(["pause", "resume"]) }),
  Schema.Struct({ type: Schema.Literal("cancel"), fade: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("speak"), output: Output }),
])

export const VoiceRpcs = RpcGroup.make(
  Rpc.make("VoiceAvailable", { success: Schema.Boolean }),
  Rpc.make("VoiceStart", {
    payload: {
      id: Schema.String,
      options: Schema.Struct({
        runtime: Schema.NonEmptyString,
        model: Schema.NonEmptyString,
        language: Schema.NonEmptyString,
        activityDelay: Schema.optional(
          Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 300, maximum: 3000 })),
        ),
        delivery: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
      }),
    },
  }),
  Rpc.make("VoiceRead", { payload: { id: Schema.String }, success: Schema.Array(Schema.String) }),
  Rpc.make("VoiceWrite", { payload: { id: Schema.String, command: Command } }),
  Rpc.make("VoiceStop", { payload: { id: Schema.String } }),
)
