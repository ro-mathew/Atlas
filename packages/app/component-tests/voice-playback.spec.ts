import { expect, sourceURL, story } from "../../stories/playwright/story"

const fixture = sourceURL(new URL("./voice-playback.fixture.ts", import.meta.url))

story(
  "the hosted worklet holds and resumes false alarms, and trails off for genuine interruptions",
  async ({ mount, page }) => {
    await mount("opencode-composer-flow--integrated-voice")
    await page.locator("#story-root").click({ position: { x: 2, y: 2 } })

    const results = await page.evaluate(async (fixture) => {
      const { renderInterruption } = await import(fixture)

      return { falseAlarm: await renderInterruption(false), genuine: await renderInterruption(true) }
    }, fixture)

    ;[results.falseAlarm, results.genuine].forEach((result) => {
      expect(result.initial).toBeGreaterThan(0.1)
      expect(result.held).toBe(0)
      expect(result.drained).toEqual(["controlled"])
    })
    expect(results.falseAlarm.recovered).toBeGreaterThan(0.05)
    expect(results.genuine.recovered).toBe(0)
  },
)
