import { expect, story } from "../../stories/playwright/story"

story("Context client activity exposes the voice request's source and playback snapshot", async ({ mount }) => {
  const root = await mount("context-client-activity--voice-calls")
  await expect(root.getByRole("heading", { name: "Client activity" })).toBeVisible()
  await root.getByRole("button", { name: /voice.answer/ }).click()
  await expect(root.getByText("coding-model", { exact: false }).last()).toBeVisible()
  await expect(root.getByText("voice-a", { exact: false }).last()).toBeVisible()
  await root.getByRole("button", { name: /voice.filler/ }).click()
  await expect(root.getByText('"cancelled"', { exact: false }).last()).toBeVisible()
})
