import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { BROWSER_TOOL_OPTIONS } from "../agent/browser-tools.js"
import { clearConfirmationApprovals } from "../agent/confirmation-policy.js"
import { BrowserConfiguration } from "../configuration.js"
import type { RuntimeEvent } from "../runtime/messages.js"
import {
  type ConfirmationMode,
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  type FontFamily,
  isConfirmationMode,
  isThinkingLevel,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "../storage.js"
import { AuthenticationController } from "./authentication.js"
import { initializeMcpSettings } from "./mcp-settings.js"
import { SearchableSelect } from "./searchable-select.js"
import { initializeSettingsConfirmation } from "./settings-confirmation.js"
import { initializeSettingsTabs } from "./settings-tabs.js"
import { initializeSkillsSettings } from "./skills-settings.js"
import { applyAppearance, element, run, setErrorOutput } from "./ui.js"

export async function initializeSettingsPage(params: URLSearchParams): Promise<void> {
  const settingsContextId = params.get("source") ?? crypto.randomUUID()
  const initialModelProvider = params.get("modelProvider")
  const initialModelId = params.get("modelId")
  const initialThinkingLevel = params.get("thinkingLevel")
  const initialModel =
    initialModelProvider && initialModelId
      ? { provider: initialModelProvider, id: initialModelId }
      : undefined

  const errorOutput = element<HTMLElement>("settings-error")
  const page = element<HTMLElement>("settings-page")
  const closeButton = element<HTMLButtonElement>("close-settings")
  const saveButton = element<HTMLButtonElement>("save-settings")
  const providerSelect = element<HTMLSelectElement>("provider")
  const modelSelect = element<HTMLSelectElement>("model")
  const modelCapabilities = element<HTMLElement>("model-capabilities")
  const thinkingLevelSelect = element<HTMLSelectElement>("thinking-level")
  const confirmationModeSelect = element<HTMLSelectElement>("confirmation-mode")
  const toolsContainer = element<HTMLElement>("available-tools")
  const toolCheckboxes = BROWSER_TOOL_OPTIONS.map((tool) => {
    const label = document.createElement("label")
    label.className = "tool-option"
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.value = tool.name
    const text = document.createElement("span")
    text.textContent = tool.label
    const name = document.createElement("small")
    name.textContent = tool.name
    text.append(name)
    label.append(checkbox, text)
    label.title = tool.description
    toolsContainer.append(label)
    return checkbox
  })
  const confirmationStatus = element<HTMLElement>("confirmation-approvals-status")
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
  let settingsThinkingChanged = false
  let savedFormState = ""
  let allowClosing = false
  let savingGeneral = false
  let hasMcpDraft = () => false
  let hasSkillDraft = () => false
  const confirmSettingsAction = initializeSettingsConfirmation()
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

  function selectedThinkingLevel(): ThinkingLevel {
    if (!isThinkingLevel(thinkingLevelSelect.value))
      throw new Error("Choose a valid thinking level")
    return thinkingLevelSelect.value
  }

  function selectedConfirmationMode(): ConfirmationMode {
    if (!isConfirmationMode(confirmationModeSelect.value))
      throw new Error("Choose a valid confirmation mode")
    return confirmationModeSelect.value
  }

  function selectedFontFamily(): FontFamily {
    return FONT_FAMILIES.find((fontFamily) => fontFamily === fontFamilySelect.value) ?? "system"
  }

  function selectedFontSize(): number {
    const value = Math.round(Number(fontSizeInput.value))
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.fontSize
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value))
  }

  function previewAppearance(): void {
    const fontSize = selectedFontSize()
    applyAppearance(selectedFontFamily(), fontSize)
    fontSizeOutput.value = `${fontSize} px`
  }

  function generalFormState(): string {
    return JSON.stringify([
      providerSelect.value,
      modelSelect.value,
      thinkingLevelSelect.value,
      confirmationModeSelect.value,
      toolCheckboxes.map((checkbox) => checkbox.checked),
      fontFamilySelect.value,
      fontSizeInput.value,
      systemPrompt.value,
      agentInstructions.value,
    ])
  }

  function hasUnsavedChanges(): boolean {
    return (
      savingGeneral || generalFormState() !== savedFormState || hasMcpDraft() || hasSkillDraft()
    )
  }

  function populateSettings(): void {
    renderModelControls(initialSelection.provider, initialSelection.id)
    thinkingLevelSelect.value =
      initialThinkingLevel && isThinkingLevel(initialThinkingLevel)
        ? initialThinkingLevel
        : configuration.appSettings.thinkingLevel
    confirmationModeSelect.value = configuration.appSettings.confirmationMode
    const enabledTools = new Set(configuration.appSettings.enabledTools)
    for (const checkbox of toolCheckboxes) checkbox.checked = enabledTools.has(checkbox.value)
    fontFamilySelect.value = configuration.appSettings.fontFamily
    fontSizeInput.value = String(configuration.appSettings.fontSize)
    fontSizeOutput.value = `${configuration.appSettings.fontSize} px`
    systemPrompt.value = configuration.appSettings.systemPrompt
    agentInstructions.value = configuration.appSettings.agentInstructions
    settingsModelChanged = false
    settingsThinkingChanged = false
    savedFormState = generalFormState()
  }

  function closeSettingsPage(): void {
    allowClosing = true
    void chrome.tabs
      .getCurrent()
      .then(async (tab) => {
        if (tab?.openerTabId !== undefined)
          await chrome.tabs.update(tab.openerTabId, { active: true })
      })
      .catch(setError)
      .finally(() => window.close())
  }

  async function discardSettingsChanges(): Promise<void> {
    if (savingGeneral || allowClosing) return
    if (
      hasUnsavedChanges() &&
      !(await confirmSettingsAction({
        title: "Discard unsaved changes?",
        message:
          "Unsaved general settings, MCP edits, and reviewed skill content will be discarded. Saved MCP and Skills changes will remain.",
        confirmLabel: "Discard changes",
      }))
    )
      return
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
  thinkingLevelSelect.addEventListener("change", () => {
    settingsThinkingChanged = true
  })
  fontSizeInput.addEventListener("input", previewAppearance)
  fontFamilySelect.addEventListener("change", previewAppearance)
  element<HTMLButtonElement>("clear-confirmation-approvals").addEventListener("click", () => {
    void run(async () => {
      await clearConfirmationApprovals()
      confirmationStatus.textContent = "Remembered approvals cleared"
    }, setError)
  })
  closeButton.addEventListener("click", () => void run(discardSettingsChanges, setError))
  element<HTMLButtonElement>("cancel-settings").addEventListener(
    "click",
    () => void run(discardSettingsChanges, setError),
  )
  saveButton.addEventListener("click", () => {
    if (savingGeneral || allowClosing) return
    void run(async () => {
      if (
        (hasMcpDraft() || hasSkillDraft()) &&
        !(await confirmSettingsAction({
          title: "Unsaved MCP or Skills changes",
          message:
            "Save general settings does not save MCP edits or import a reviewed skill. Use their save controls first, or discard those drafts and continue.",
          confirmLabel: "Discard drafts and save",
        }))
      )
        return
      if (savingGeneral || allowClosing) return
      savingGeneral = true
      page.inert = true
      page.setAttribute("aria-busy", "true")
      saveButton.textContent = "Saving…"
      try {
        const applyModelToActiveSession = settingsModelChanged
        const applyThinkingToActiveSession = settingsThinkingChanged
        let providerId = providerSelect.value
        let modelId = modelSelect.value
        await configuration.syncSettings()
        if (!applyModelToActiveSession) {
          providerId = configuration.appSettings.modelProvider
          modelId = configuration.appSettings.modelId
        }
        if (!modelId) throw new Error("Configure the selected provider and choose a model")

        const fontFamily = selectedFontFamily()
        const fontSize = selectedFontSize()
        const confirmationMode = selectedConfirmationMode()
        if (confirmationMode !== configuration.appSettings.confirmationMode) {
          await clearConfirmationApprovals()
        }
        await configuration.updateSettings({
          confirmationMode,
          enabledTools: toolCheckboxes
            .filter((checkbox) => checkbox.checked)
            .map((checkbox) => checkbox.value),
          systemPrompt: systemPrompt.value,
          agentInstructions: agentInstructions.value,
          fontFamily,
          fontSize,
          modelProvider: providerId,
          modelId,
          thinkingLevel: applyThinkingToActiveSession
            ? selectedThinkingLevel()
            : configuration.appSettings.thinkingLevel,
        })
        savedFormState = generalFormState()
        await chrome.runtime
          .sendMessage({
            kind: "event",
            name: "settings.saved",
            payload: { settingsContextId, applyModelToActiveSession, applyThinkingToActiveSession },
          } satisfies RuntimeEvent)
          .catch(() => undefined)
        applyAppearance(fontFamily, fontSize)
        await authentication?.refresh()
        closeSettingsPage()
      } finally {
        savingGeneral = false
        if (!allowClosing) {
          page.inert = false
          page.removeAttribute("aria-busy")
          saveButton.textContent = "Save general settings"
          saveButton.focus()
        }
      }
    }, setError)
  })
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      savingGeneral ||
      allowClosing ||
      document.querySelector("dialog[open]") !== null
    )
      return
    event.preventDefault()
    void run(discardSettingsChanges, setError)
  })
  window.addEventListener("pagehide", () => authentication?.abort())

  document.title = "Settings · Pi Browser Agent"
  document.body.dataset.view = "settings"
  initialSelection = await configuration.initialize(initialModel)
  populateSettings()
  hasMcpDraft = await initializeMcpSettings(confirmSettingsAction)
  hasSkillDraft = await initializeSkillsSettings()
  applyAppearance(configuration.appSettings.fontFamily, configuration.appSettings.fontSize)
  initializeSettingsTabs(page)
  page.hidden = false
  window.addEventListener("beforeunload", (event) => {
    if (allowClosing || !hasUnsavedChanges()) return
    event.preventDefault()
    event.returnValue = ""
  })
  await authentication.refresh()
  closeButton.focus()
}
