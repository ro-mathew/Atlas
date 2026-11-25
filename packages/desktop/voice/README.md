# Desktop realtime speech

Voice is an attachment to the selected coding session. Recognition accumulates in the real composer. Segments captured before the configured quiet interval expires send together through its normal model, agent, variant, permissions, and admission path. The coding model owns tools and answers. Speech workers receive only text to read or a request for a short waiting cue; they cannot invoke coding tools.

End, mute, disconnection, and voice disposal release audio resources without interrupting Session execution. Use the existing Session Stop control to stop work. Rejoin resumes listening without resubmitting a prompt or replaying visible history. Waiting audio never enters captions, history, or the coding model's context. Spoken delivery uses prose from the actual streamed answer and skips fenced code; pronunciation remains model dependent.

Possible interruptions slow playback toward 80% speed while fading to silence over 240 ms. Playback stays at
its existing cursor while recognition checks the sound. A false alarm restores normal speed and volume over
400 ms without rewinding words. Recognized speech confirms the interruption early; the remaining spoken
response trails off and is discarded. The next interrupted request has no waiting prelude. End and the speaker
silence control still cancel output immediately; coding work continues. Interruption timing is independent of
Voice Activity Delay, which continues to govern admission of the combined transcript.

Local playback uses a pitch-preserving time effect and cancellable envelopes on its playback queue. Hosted
playback uses a dedicated audio worklet with overlapping, waveform-aligned PCM grains; completion is acknowledged
after actual output drains. Neither implementation requests new model-generated audio to recover from noise.

Once a waiting prelude starts, answer speech queues until playback finishes. The answer can continue generating
and appearing in chat during the prelude. Confirmed speech still yields through the short fade; End cancels audio immediately.

## Configuration

From the repository root, run the current source with the project-local development profile:

```bash
./run-desktop.sh
```

The shortcut uses the existing Desktop development task, prepares the native helper, and reuses the development
profile and background service under `tmp/build/voice-desktop`. Voice settings, connected providers and sessions
carry over from the earlier development build. Keep the terminal open while using the app. To load new source
after using the built app, close that OpenCode Dev window first, then run the shortcut. Use `./run-desktop.sh --help`
for usage; other arguments are forwarded to the Desktop development task.

Open **Settings → Voice**, enable calls, and choose Local or Hosted. Start voice appears inside the composer in existing chats and new-chat drafts. The experimental `voice_calls` flag is on in local/dev builds and off in releases, following the repository rollout policy. For release builds opt in through the server's `OPENCODE_FLAGS=voice_calls` or `experimental.voice_calls: true` configuration. Voice settings are always accessible.

Local and hosted model selections are retained separately. Switching engines never silently falls back to a hosted service. Settings contain no API keys; hosted credentials stay with the server's existing provider connections.

Voice style and Voice delivery are separate settings, concatenated in that order for answer speech and waiting
audio on the next call. The default style requests a warm, friendly, professional American female voice. Delivery
guidance covers decimal digits, zeros, signs, precision, units and percentages. Existing custom speaker guidance
migrates into Voice style. Both sections can be edited independently and appear separately in diagnostics.
Local synthesis starts a fresh generation for each phrase; delivery guidance does not
provide a fixed speaker identity. Hosted Voice identifier selects a provider-supported speaker for the call.

**Voice Activity Delay** controls the silence threshold for speech detection and the submission wait after final
transcription. Final text stays visible in the composer for that interval before model admission. Speaking again
restarts the submission wait; End cancels unsubmitted requests without stopping work already admitted.
Recognition segments captured before the quiet interval expires accumulate in the composer and submit as one
combined message. Partial revisions replace their own segment. Speech after admission starts a new message,
which waits for the earlier admission to settle without waiting for the coding model to finish its response.
Speech captured in different chats retains its original target and is never combined across chats.
It defaults to 1,000 ms (previously 700 ms locally), with choices from 300 to 3,000 ms for local and hosted calls.
Changes apply on the next call. Increase it to allow longer pauses within an utterance.

During a call, an orb above the composer reacts to measured microphone and playback levels. Microphone mute,
End and retry controls are part of the composer. Reduced motion disables orb scaling. Screens without a composer
keep a compact inline control strip so an active microphone never loses its End control. New-chat speech uses
normal first-message Session creation; starting a call alone creates no conversation. End never stops Session work.

The speaker control silences output independently of microphone mute. It cancels current playback and suppresses
answer and prelude synthesis while normal text generation, transcription and submission continue. Re-enabling
audio speaks subsequent text without replaying the silent backlog. This choice lasts through a call's rejoin and
resets for a new call. Active controls use speaker–microphone–End order with 12px gaps and a 28px End button.

**Context → Client activity** records `voice.connection`, `voice.answer` and `voice.filler` entries with model,
configuration and playback details. Filler entries never contain filler words. The newest 200 client operations
remain available across the current window after End and clear when the window closes. They are separate from
conversation context, token totals, costs and Session exports. Credentials and raw audio are omitted.

| Speech engine | Requirements | Current support |
| --- | --- | --- |
| Local | Apple Silicon, macOS 26+, installed SpeechTranscriber locale, Python with `requirements.txt`, compatible MLX audio model directory | Native duplex capture/AEC, streaming recognition, synthesis, waiting cues, pause/resume and cancellation |
| Hosted | Connected OpenAI API provider, catalog-listed Realtime model with WebSocket transport, configured transcription model ID | Browser duplex capture/AEC, streaming transcription and PCM playback; server-brokered ephemeral session credential |

Other hosted engines in the server catalog require adapters for controlled speech and are not offered by this flow yet. Local model compatibility requires MLX-VLM's streaming audio-slot generation, audio-only synthesis, and causal codec APIs; arbitrary text models and audio architectures are not interchangeable. No model identifier is baked into orchestration. The coding session can use any normally supported conversation model.

For a new local environment, create it under a project-local build directory and install `requirements.txt`. In Voice settings choose that Python executable, the installed model folder, and the installed recognition locale. Weights and Python are user-managed and are not downloaded or bundled automatically. The worker is owned and launched by Desktop; a separate voice application does not need to run.

## Ownership

- `app/src/voice` owns call, input, and speech state machines, composer binding, and engine adapters.
- Desktop's existing typed MessagePort IPC owns native process control. PCM stays inside the native worker; only controls, recognition, levels and playback acknowledgements cross IPC.
- `Main.swift` owns native audio and a persistent inference subprocess. `Recognition.swift` owns incremental on-device recognition and utterance finalization.
- `runtime.py` and `codec.py` own streaming synthesis, causal codec state, and cancelled-job rejection. They have no Session API or hosted reasoning client.
- Native capture/playback was ported from the standalone voice implementation, derived from speech-swift under the accompanying Apache 2.0 license. Runtime/model dependencies retain their own terms.

## Verification

Build the helper with `bun run voice/build.ts` from `packages/desktop` using Xcode's macOS 26 SDK. Outputs, compiler caches and intermediates stay under `packages/desktop/build/voice`. Unchanged native sources reuse the cached executable. Desktop dev/build scripts prepare it automatically; the packaging configuration includes it only for Apple Silicon macOS.

The following optional real-model checks use installed weights, generate only controlled fixture audio, and make no hosted requests. Run from `packages/desktop`; substitute your Python and model paths:

```sh
<python> voice/check-runtime.py --model <model-directory>
TMPDIR="$PWD/build/voice/tmp" xcrun swiftc -parse-as-library -swift-version 5 \
  -target arm64-apple-macos26.0 -module-cache-path build/voice/module-cache \
  voice/Recognition.swift voice/check-recognition.swift -o build/voice/check-recognition
build/voice/check-recognition build/voice/verification/answer.wav
TMPDIR="$PWD/build/voice/tmp" xcrun swiftc -parse-as-library -swift-version 5 \
  -target arm64-apple-macos26.0 -module-cache-path build/voice/module-cache \
  voice/PlaybackEnvelope.swift voice/check-interruption.swift -o build/voice/check-interruption
build/voice/check-interruption
```

The runtime check verifies non-silent finite answer and filler PCM and an audio-only output protocol. The recognition check feeds two successive utterances through the production streaming recognizer. The interruption check verifies the production envelope and native pitch preservation using offline tones, and writes false-alarm and genuine-interruption WAVs under `build/voice/verification`. The browser worklet check uses a muted output route and controlled tones, with no microphone or provider. Unit tests cover submission ownership/failure recovery, routing, deduplication, stale results, barge-in, code suppression and actual-playback completion. Desktop tests exercise raw IPC validation and packaging; the Voice settings story exercises normal settings controls.

Real microphone echo cancellation/barge-in, hosted provider audio, release signing, and Windows/Linux hosted audio still need device/provider checks before a release-quality parity claim. No claim of identical ChatGPT/Codex latency or prosody follows from automated tests. Standalone dictation remains P2.
