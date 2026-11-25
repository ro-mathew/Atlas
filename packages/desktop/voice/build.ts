import { mkdir } from "node:fs/promises"
import path from "node:path"

if (process.platform !== "darwin" || process.arch !== "arm64") process.exit(0)

const output = path.resolve(import.meta.dir, "../build/voice")

const sources = [
  "Main",
  "Recognition",
  "FullDuplexAudioIO",
  "PlaybackAccounting",
  "PlaybackEnvelope",
  "AudioHelpers",
].map((name) => path.join(import.meta.dir, `${name}.swift`))

const compiler = await new Response(
  Bun.spawn(["xcrun", "swiftc", "--version"], { stdout: "pipe", stderr: "inherit" }).stdout,
).text()

const hash = new Bun.CryptoHasher("sha256").update(compiler)

for (const source of sources) hash.update(await Bun.file(source).arrayBuffer())

const fingerprint = hash.digest("hex")

const previous = await Bun.file(path.join(output, "fingerprint"))
  .text()
  .catch(() => "")

await mkdir(path.join(output, "module-cache"), { recursive: true })

await mkdir(path.join(output, "tmp"), { recursive: true })

if (previous !== fingerprint || !(await Bun.file(path.join(output, "opencode-voice")).exists())) {
  const build = Bun.spawn(
    [
      "xcrun",
      "swiftc",
      "-O",
      "-parse-as-library",
      "-swift-version",
      "5",
      "-target",
      "arm64-apple-macos26.0",
      "-module-cache-path",
      path.join(output, "module-cache"),
      ...sources,
      "-o",
      path.join(output, "opencode-voice"),
    ],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, TMPDIR: path.join(output, "tmp") } },
  )

  if (await build.exited) process.exit(1)
  await Bun.write(path.join(output, "fingerprint"), fingerprint)
}

for (const name of ["runtime.py", "codec.py", "LICENSE-speech-swift"])
  await Bun.write(path.join(output, name), Bun.file(path.join(import.meta.dir, name)))
