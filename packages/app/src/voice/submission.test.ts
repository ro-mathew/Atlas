import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { createMemoryComposerState } from "@/composer/state"
import { createVoiceComposerBinding } from "./input"
import { createVoiceSubmissionQueue } from "./submission"

beforeEach(() => jest.useFakeTimers())

afterEach(() => jest.useRealTimers())

function fixture(delay = 1000, send: (text: string) => Promise<void> = async () => undefined) {
  const draft = createMemoryComposerState({ prompt: "Typed draft" }).capture()
  const requests: string[] = []

  const binding = createVoiceComposerBinding({
    draft,
    submit: async (text) => {
      requests.push(text)
      await send(text)

      return { id: `message-${requests.length}`, sent: true }
    },
  })

  const queue = createVoiceSubmissionQueue({
    delay,
    submit: async (batch) => {
      await batch.binding.submit(batch.id, batch.text)
    },
  })

  return {
    queue,
    requests,
    binding,
    update: (id: string, text: string, final = false) =>
      queue.update({ id, text, target: { server: "local", sessionID: "session" }, binding }, final),
    shown: () =>
      draft
        .current()
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join(""),
  }
}

test.each([300, 1000, 1500, 3000])("combined text waits the configured %i ms before admission", (delay) => {
  const input = fixture(delay)
  input.update("one", "First sentence.", true)
  input.update("two", "Second sentence.", true)
  expect(input.shown()).toBe("Typed draft\nFirst sentence. Second sentence.")
  jest.advanceTimersByTime(delay - 1)
  expect(input.requests).toEqual([])
  jest.advanceTimersByTime(1)
  expect(input.requests).toEqual(["First sentence. Second sentence."])
  input.queue.close()
})

test("continued speech restarts the wait and revisions update the combined composer without duplication", () => {
  const input = fixture()
  input.update("one", "First sentence.", true)
  jest.advanceTimersByTime(900)
  input.queue.hearing(true)
  input.update("two", "Second")
  input.update("two", "Second sentence")
  expect(input.shown()).toBe("Typed draft\nFirst sentence. Second sentence")
  jest.advanceTimersByTime(3000)
  expect(input.requests).toEqual([])
  input.update("two", "Second sentence.", true)
  input.queue.hearing(false)
  jest.advanceTimersByTime(999)
  expect(input.requests).toEqual([])
  jest.advanceTimersByTime(1)
  expect(input.requests).toEqual(["First sentence. Second sentence."])
  input.queue.close()
})

test("late finals retain speech-start order and an unfinished segment cannot submit", () => {
  const input = fixture()
  input.update("one", "")
  input.update("two", "Second sentence.", true)
  jest.advanceTimersToNextTimer()
  expect(input.requests).toEqual([])
  input.update("one", "First sentence.", true)
  expect(input.shown()).toBe("Typed draft\nFirst sentence. Second sentence.")
  jest.advanceTimersToNextTimer()
  expect(input.requests).toEqual(["First sentence. Second sentence."])
  input.queue.close()
})

test("discarding an empty or muted segment preserves the earlier finalized text", () => {
  const input = fixture()
  input.update("one", "Keep this.", true)
  input.update("two", "Discard this")
  input.queue.discard("two")
  expect(input.shown()).toBe("Typed draft\nKeep this.")
  jest.advanceTimersToNextTimer()
  expect(input.requests).toEqual(["Keep this."])
  input.queue.close()
})

test("End leaves the combined transcript for review and cancels submission", () => {
  const input = fixture()
  input.update("one", "First sentence.", true)
  input.update("two", "Second sentence.", true)
  input.queue.close()
  input.update("late", "Late text", true)
  jest.runOnlyPendingTimers()
  expect(input.requests).toEqual([])
  expect(input.shown()).toBe("Typed draft\nFirst sentence. Second sentence.")
})

test("speech after admission starts a separate combined message and waits for the active submission", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()

  const input = fixture(1000, (text) => {
    if (text === "First message.") return first.promise
    second.resolve()

    return Promise.resolve()
  })

  input.update("one", "First message.", true)
  jest.advanceTimersToNextTimer()
  input.update("two", "Second", true)
  input.update("three", "message.", true)
  jest.advanceTimersToNextTimer()
  expect(input.requests).toEqual(["First message."])
  first.resolve()
  await second.promise
  expect(input.requests).toEqual(["First message.", "Second message."])
  input.queue.close()
})

test("End cancels a ready batch while already admitted work continues", async () => {
  const first = Promise.withResolvers<void>()
  const input = fixture(1000, () => first.promise)
  input.update("one", "Running request.", true)
  jest.advanceTimersToNextTimer()
  input.update("two", "Pending request.", true)
  jest.advanceTimersToNextTimer()
  input.queue.close()
  first.resolve()
  await first.promise
  expect(input.requests).toEqual(["Running request."])
})

test("pending speech in another chat keeps its own target, binding and message", async () => {
  const input = fixture()
  const otherRequests: string[] = []
  const submitted = Promise.withResolvers<void>()
  input.update("one", "First chat.", true)

  const binding = createVoiceComposerBinding({
    draft: createMemoryComposerState().capture(),
    submit: async (text) => {
      otherRequests.push(text)
      submitted.resolve()

      return { id: "other", sent: true }
    },
  })

  input.queue.update(
    { id: "two", text: "Second chat.", target: { server: "local", sessionID: "other" }, binding },
    true,
  )
  jest.advanceTimersToNextTimer()
  await submitted.promise
  expect(input.requests).toEqual(["First chat."])
  expect(otherRequests).toEqual(["Second chat."])
  input.queue.close()
})
