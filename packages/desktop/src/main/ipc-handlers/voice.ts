import { app, type WebContents } from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { VoiceRpcs } from "../../shared/ipc-rpc/voice"
import { IpcPortHandoff } from "../ipc-transport"
import { sender } from "./context"

type Helper = { id: string; child: ChildProcessWithoutNullStreams; events: string[] }

export const voiceHandlers = VoiceRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const helpers = new Map<WebContents, Helper>()

    const executable = path.join(
      app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "build"),
      "voice/opencode-voice",
    )

    const available = () =>
      process.platform === "darwin" &&
      process.arch === "arm64" &&
      Number.parseInt(process.getSystemVersion()) >= 26 &&
      existsSync(executable)

    const stop = (contents: WebContents, id: string) => {
      const helper = helpers.get(contents)

      if (helper?.id !== id) return
      helpers.delete(contents)
      helper.child.stdin.end(JSON.stringify({ type: "stop" }) + "\n")
      const timer = setTimeout(() => helper.child.kill("SIGKILL"), 1500)
      helper.child.once("exit", () => clearTimeout(timer))
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => helpers.forEach((helper, contents) => stop(contents, helper.id))),
    )

    return VoiceRpcs.of({
      VoiceAvailable: () => Effect.sync(available),
      VoiceStart: ({ id, options }, context) =>
        Effect.sync(() => {
          if (!available() || !existsSync(options.runtime) || !existsSync(path.join(options.model, "config.json")))
            throw new Error("voice.configuration")
          const contents = sender(handoff, context)
          const previous = helpers.get(contents)

          if (previous) stop(contents, previous.id)

          const child = spawn(
            executable,
            [
              options.runtime,
              options.model,
              options.language,
              options.delivery ?? "",
              String(options.activityDelay ?? 1000),
            ],
            {
              stdio: "pipe",
            },
          )

          const helper: Helper = { id, child, events: [] }
          helpers.set(contents, helper)
          const release = () => stop(contents, id)
          contents.once("destroyed", release)
          contents.once("did-start-navigation", release)
          child.stdin.on("error", () => undefined)
          const lines = createInterface({ input: child.stdout })
          lines.on("line", (line) => {
            if (helper.events.length >= 1000) return stop(contents, id)
            helper.events.push(line)
          })
          child.stderr.on("data", (data: Buffer) => console.error("[voice]", data.toString()))
          child.on("error", () => helper.events.push('{"type":"failed","reason":"runtime"}'))
          child.once("exit", () => {
            lines.close()
            contents.removeListener("destroyed", release)
            contents.removeListener("did-start-navigation", release)
            helper.events.push('{"type":"failed","reason":"runtime"}')
          })
        }),
      VoiceRead: ({ id }, context) =>
        Effect.sync(() => {
          const helper = helpers.get(sender(handoff, context))

          return helper?.id === id ? helper.events.splice(0) : ['{"type":"failed","reason":"runtime"}']
        }),
      VoiceWrite: ({ id, command }, context) =>
        Effect.sync(() => {
          const helper = helpers.get(sender(handoff, context))

          if (helper?.id === id) helper.child.stdin.write(JSON.stringify(command) + "\n")
        }),
      VoiceStop: ({ id }, context) => Effect.sync(() => stop(sender(handoff, context), id)),
    })
  }),
)
