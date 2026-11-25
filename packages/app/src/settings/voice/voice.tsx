import { createMemo, createResource, Show } from "solid-js"
import { TextField } from "@opencode/ui/text-field"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { SettingsRow } from "@/settings/row"
import { SettingsList } from "@/settings/list"
import { createVoiceCatalog } from "@/voice/catalog"

export function SettingsVoice() {
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()
  const surface = useSettingsSurface()
  const global = useGlobal()

  const context = createMemo(() => {
    const server = surface.server()

    return server ? global.serverCtx(server.key) : undefined
  })

  const catalog = createVoiceCatalog(context)
  const enabled = () => catalog.current()?.enabled === true

  const models = () =>
    catalog
      .current()
      ?.models.filter(
        (model) => model.engine === "openai-realtime" && model.available && model.transports.includes("websocket"),
      ) ?? []

  const [local, localControls] = createResource(() => platform.voice?.available() ?? Promise.resolve(false))
  const localReady = () => (local.state === "ready" || local.state === "refreshing") && local() === true
  const preferences = settings.voice.current
  const set = (value: Partial<ReturnType<typeof preferences>>) => settings.voice.set({ ...preferences(), ...value })

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.voice.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.voice.description")}</span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body">
        <div class="settings-section">
          <Show when={catalog.catalog.state === "pending"}>
            <Loader />
          </Show>
          <Show when={!enabled()}>
            <p role="status">{language.t("settings.voice.disabled")}</p>
          </Show>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.voice.enable")}
              description={language.t("settings.voice.enable.description")}
            >
              <Switch
                hideLabel
                checked={preferences().enabled}
                disabled={!enabled()}
                onChange={(value) => set({ enabled: value })}
              >
                {language.t("settings.voice.enable")}
              </Switch>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.voice.engine")}
              description={language.t("settings.voice.engine.description")}
            >
              <Select
                aria-label={language.t("settings.voice.engine")}
                options={["local", "hosted"] as const}
                current={preferences().engine}
                label={(value) => language.t(`settings.voice.engine.${value}`)}
                onSelect={(value) => value && set({ engine: value })}
              />
            </SettingsRow>
            <Show when={preferences().engine === "local"}>
              <Show when={!localReady()}>
                <p role="status">{language.t("settings.voice.local.unavailable")}</p>
              </Show>
              <SettingsRow
                title={language.t("settings.voice.runtime")}
                description={language.t("settings.voice.runtime.description")}
              >
                <TextField
                  value={preferences().runtime}
                  onChange={(runtime) => set({ runtime })}
                  aria-label={language.t("settings.voice.runtime")}
                />
              </SettingsRow>
              <SettingsRow
                title={language.t("settings.voice.local.model")}
                description={language.t("settings.voice.local.model.description")}
              >
                <TextField
                  value={preferences().localModel}
                  onChange={(localModel) => set({ localModel })}
                  aria-label={language.t("settings.voice.local.model")}
                />
              </SettingsRow>
            </Show>
            <Show when={preferences().engine === "hosted"}>
              <SettingsRow
                title={language.t("settings.voice.hosted.model")}
                description={language.t("settings.voice.hosted.model.description")}
              >
                <Select
                  aria-label={language.t("settings.voice.hosted.model")}
                  options={models()}
                  current={models().find((item) => item.model === preferences().model)}
                  label={(item) => `${item.name} · ${item.provider}`}
                  onSelect={(item) => item && set({ model: item.model })}
                />
              </SettingsRow>
              <Show when={!models().length}>
                <Button variant="outline" onClick={() => surface.open("providers")}>
                  {language.t("command.provider.connect")}
                </Button>
              </Show>
              <SettingsRow
                title={language.t("settings.voice.transcription")}
                description={language.t("settings.voice.transcription.description")}
              >
                <TextField
                  value={preferences().transcription}
                  onChange={(transcription) => set({ transcription })}
                  aria-label={language.t("settings.voice.transcription")}
                />
              </SettingsRow>
              <SettingsRow
                title={language.t("settings.voice.speaker")}
                description={language.t("settings.voice.speaker.description")}
              >
                <TextField
                  value={preferences().voice}
                  onChange={(voice) => set({ voice })}
                  aria-label={language.t("settings.voice.speaker")}
                />
              </SettingsRow>
            </Show>
            <SettingsRow
              title={language.t("settings.voice.style")}
              description={language.t("settings.voice.style.description")}
            >
              <TextField
                multiline
                maxLength={4000}
                value={preferences().style ?? ""}
                onChange={(style) => set({ style })}
                aria-label={language.t("settings.voice.style")}
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.voice.delivery")}
              description={language.t("settings.voice.delivery.description")}
            >
              <TextField
                multiline
                maxLength={4000}
                value={preferences().delivery ?? ""}
                onChange={(delivery) => set({ delivery })}
                placeholder={language.t("settings.voice.delivery.placeholder")}
                aria-label={language.t("settings.voice.delivery")}
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.voice.language")}
              description={language.t("settings.voice.language.description")}
            >
              <TextField
                value={preferences().language}
                onChange={(value) => set({ language: value })}
                aria-label={language.t("settings.voice.language")}
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.voice.activityDelay")}
              description={language.t("settings.voice.activityDelay.description")}
            >
              <Select
                aria-label={language.t("settings.voice.activityDelay")}
                options={[300, 500, 700, 1000, 1250, 1500, 2000, 3000]}
                current={preferences().activityDelay}
                label={(delay) => language.t("settings.voice.activityDelay.value", { delay })}
                onSelect={(activityDelay) => activityDelay != null && set({ activityDelay })}
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.voice.filler")}
              description={language.t("settings.voice.filler.description")}
            >
              <Switch hideLabel checked={preferences().filler} onChange={(filler) => set({ filler })}>
                {language.t("settings.voice.filler")}
              </Switch>
            </SettingsRow>
          </SettingsList>
          <Button
            variant="outline"
            onClick={() => {
              void catalog.refresh()
              void localControls.refetch()
            }}
          >
            {language.t("settings.voice.check")}
          </Button>
          <p>{language.t("settings.voice.continue")}</p>
        </div>
      </div>
    </>
  )
}
