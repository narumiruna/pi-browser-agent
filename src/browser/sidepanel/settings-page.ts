import { BrowserConfiguration } from "../configuration.js"
import type { RuntimeEvent } from "../runtime/messages.js"
import {
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  type FontFamily,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "../storage.js"
import { AuthenticationController } from "./authentication.js"
import { SearchableSelect } from "./searchable-select.js"
import { applyAppearance, element, run, setErrorOutput } from "./ui.js"

export async function initializeSettingsPage(params: URLSearchParams): Promise<void> {
  const settingsContextId = params.get("source") ?? crypto.randomUUID()
  const initialModelProvider = params.get("modelProvider")
  const initialModelId = params.get("modelId")
  const initialModel =
    initialModelProvider && initialModelId
      ? { provider: initialModelProvider, id: initialModelId }
      : undefined

  const errorOutput = element<HTMLElement>("settings-error")
  const page = element<HTMLElement>("settings-page")
  const closeButton = element<HTMLButtonElement>("close-settings")
  const providerSelect = element<HTMLSelectElement>("provider")
  const modelSelect = element<HTMLSelectElement>("model")
  const modelCapabilities = element<HTMLElement>("model-capabilities")
  const fontFamilySelect = element<HTMLSelectElement>("font-family")
  const fontSizeInput = element<HTMLInputElement>("font-size")
  const fontSizeOutput = element<HTMLOutputElement>("font-size-value")
  const systemPrompt = element<HTMLTextAreaElement>("system-prompt")
  const agentInstructions = element<HTMLTextAreaElement>("agent-instructions")
  const providerPicker = new SearchableSelect({
    container: element<HTMLElement>("provider-picker"),
    input: element<HTMLInputElement>("provider-search"),
    select: providerSelect,
    listbox: element<HTMLElement>("provider-options"),
    emptyText: "No providers available",
  })
  const modelPicker = new SearchableSelect({
    container: element<HTMLElement>("model-picker"),
    input: element<HTMLInputElement>("model-search"),
    select: modelSelect,
    listbox: element<HTMLElement>("model-options"),
    emptyText: "Configure provider to load models",
  })
  const setError = (error?: unknown): void => setErrorOutput(errorOutput, error)
  let settingsModelChanged = false
  let authentication: AuthenticationController | undefined
  const configuration = new BrowserConfiguration((event) => authentication?.onAuthEvent(event))
  let initialSelection = configuration.defaultModel

  function renderProviderOptions(preferredId?: string): void {
    providerPicker.setOptions(
      configuration.getProviders().map((provider) => ({
        value: provider.id,
        label: `${provider.name} (${provider.modelCount})`,
        keywords: [provider.id],
      })),
      preferredId,
    )
  }

  function updateModelCapabilities(): void {
    const model = configuration
      .getModels(providerSelect.value)
      .find((candidate) => candidate.id === modelSelect.value)
    modelCapabilities.textContent = model
      ? [
          model.reasoning ? "Reasoning" : "No reasoning",
          model.imageInput ? "Image input" : "Text input",
        ].join(" · ")
      : ""
  }

  function renderModelOptions(providerId: string, preferredId?: string): void {
    modelPicker.setOptions(
      configuration.getModels(providerId).map((model) => ({
        value: model.id,
        label: model.name === model.id ? model.id : `${model.name} — ${model.id}`,
      })),
      preferredId,
    )
    updateModelCapabilities()
  }

  function renderModelControls(providerId: string, modelId: string): void {
    renderProviderOptions(providerId)
    renderModelOptions(providerId, modelId)
  }

  function selectedFontFamily(): FontFamily {
    return FONT_FAMILIES.find((fontFamily) => fontFamily === fontFamilySelect.value) ?? "system"
  }

  function selectedFontSize(): number {
    const value = Math.round(Number(fontSizeInput.value))
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.fontSize
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value))
  }

  function applyFontSize(fontSize: number): void {
    document.documentElement.dataset.fontSize = String(fontSize)
    document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`)
    fontSizeOutput.value = `${fontSize} px`
  }

  function populateSettings(): void {
    renderModelControls(initialSelection.provider, initialSelection.id)
    fontFamilySelect.value = configuration.appSettings.fontFamily
    fontSizeInput.value = String(configuration.appSettings.fontSize)
    fontSizeOutput.value = `${configuration.appSettings.fontSize} px`
    systemPrompt.value = configuration.appSettings.systemPrompt
    agentInstructions.value = configuration.appSettings.agentInstructions
    settingsModelChanged = false
  }

  function closeSettingsPage(): void {
    void chrome.tabs
      .getCurrent()
      .then(async (tab) => {
        if (tab?.openerTabId !== undefined)
          await chrome.tabs.update(tab.openerTabId, { active: true })
      })
      .catch(setError)
      .finally(() => window.close())
  }

  function discardSettingsChanges(): void {
    populateSettings()
    applyAppearance(configuration.appSettings.fontFamily, configuration.appSettings.fontSize)
    closeSettingsPage()
  }

  authentication = new AuthenticationController({
    configuration,
    currentProviderId: () => providerSelect.value,
    updateError: setError,
    mode: "settings",
    onProvidersChanged: () => {
      const providerId = providerSelect.value
      const modelId = modelSelect.value
      renderProviderOptions(providerId)
      renderModelOptions(providerId, modelId)
    },
  })

  providerSelect.addEventListener("change", () => {
    settingsModelChanged = true
    renderModelOptions(providerSelect.value)
    void authentication?.refresh()
  })
  modelSelect.addEventListener("change", () => {
    settingsModelChanged = true
    updateModelCapabilities()
  })
  fontSizeInput.addEventListener("input", () => applyFontSize(selectedFontSize()))
  closeButton.addEventListener("click", discardSettingsChanges)
  element<HTMLButtonElement>("cancel-settings").addEventListener("click", discardSettingsChanges)
  element<HTMLButtonElement>("save-settings").addEventListener("click", () => {
    void run(async () => {
      const applyModelToActiveSession = settingsModelChanged
      let providerId = providerSelect.value
      let modelId = modelSelect.value
      if (!applyModelToActiveSession) {
        await configuration.syncSettings()
        providerId = configuration.appSettings.modelProvider
        modelId = configuration.appSettings.modelId
      }
      if (!modelId) throw new Error("Configure the selected provider and choose a model")
      const fontFamily = selectedFontFamily()
      const fontSize = selectedFontSize()
      await configuration.updateSettings({
        systemPrompt: systemPrompt.value,
        agentInstructions: agentInstructions.value,
        fontFamily,
        fontSize,
        modelProvider: providerId,
        modelId,
      })
      await chrome.runtime
        .sendMessage({
          kind: "event",
          name: "settings.saved",
          payload: { settingsContextId, applyModelToActiveSession },
        } satisfies RuntimeEvent)
        .catch(() => undefined)
      applyAppearance(fontFamily, fontSize)
      await authentication?.refresh()
      closeSettingsPage()
    }, setError)
  })
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("dialog[open]") !== null) return
    event.preventDefault()
    discardSettingsChanges()
  })
  window.addEventListener("pagehide", () => authentication?.abort())

  document.title = "Settings · Pi Browser Agent"
  document.body.dataset.view = "settings"
  initialSelection = await configuration.initialize(initialModel)
  populateSettings()
  applyAppearance(configuration.appSettings.fontFamily, configuration.appSettings.fontSize)
  page.hidden = false
  await authentication.refresh()
  closeButton.focus()
}
