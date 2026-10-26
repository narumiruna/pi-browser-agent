import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { clearConfirmationApprovals } from "../agent/confirmation-policy.js"
import { BrowserConfiguration } from "../configuration.js"
import { getLocale, t } from "../i18n/index.js"
import { isLanguagePreference, type LanguagePreference, LOCALES } from "../i18n/locales.js"
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
import { renderToolOptions } from "./settings-tools.js"
import { initializeSkillsSettings } from "./skills-settings.js"
import { applyAppearance, element, run, type SettingsSectionState, setErrorOutput } from "./ui.js"

const THINKING_LABELS = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
} as const

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
  const confirmationModes = [
    ...page.querySelectorAll<HTMLInputElement>('input[name="confirmation-mode"]'),
  ]
  const toolCheckboxes = renderToolOptions(element<HTMLElement>("available-tools"))
  const cancelButton = element<HTMLButtonElement>("cancel-settings")
  const saveStatus = element<HTMLElement>("settings-save-status")
  const draftStatus = element<HTMLElement>("settings-draft-status")
  const thinkingHint = element<HTMLElement>("thinking-level-hint")
  const thinkingError = element<HTMLElement>("thinking-level-error")
  const modelError = element<HTMLElement>("model-error")
  const confirmationStatus = element<HTMLElement>("confirmation-approvals-status")
  const languageSelect = element<HTMLSelectElement>("language")
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
    emptyText: t("No providers available"),
  })
  const modelPicker = new SearchableSelect({
    container: element<HTMLElement>("model-picker"),
    input: element<HTMLInputElement>("model-search"),
    select: modelSelect,
    listbox: element<HTMLElement>("model-options"),
    emptyText: t("Configure provider to load models"),
  })
  const setError = (error?: unknown): void => setErrorOutput(errorOutput, error)
  let settingsModelChanged = false
  let settingsThinkingChanged = false
  let savedLanguage: LanguagePreference = "en"
  let savedFormState = ""
  let allowClosing = false
  let savingGeneral = false
  let ready = false
  let clearingApprovals = false
  let mcpState: SettingsSectionState = { hasDraft: () => false, isBusy: () => false }
  let skillState: SettingsSectionState = { hasDraft: () => false, isBusy: () => false }
  const confirmSettingsAction = initializeSettingsConfirmation()
  let authentication: AuthenticationController | undefined
  const configuration = new BrowserConfiguration((event) => authentication?.onAuthEvent(event))
  let initialSelection = configuration.defaultModel
  languageSelect.replaceChildren(
    new Option(t("Follow browser"), "auto"),
    ...LOCALES.map((locale) => new Option(`${locale.name} (${locale.code})`, locale.code)),
  )

  function renderProviderOptions(preferredId?: string): void {
    providerPicker.setOptions(
      configuration.getProviders().map((provider) => ({
        value: provider.id,
        label: `${provider.name} (${provider.modelCount.toLocaleString(getLocale())})`,
        keywords: [provider.id],
      })),
      preferredId,
    )
  }

  function selectedModel() {
    return configuration
      .getModels(providerSelect.value)
      .find((model) => model.id === modelSelect.value)
  }

  function updateThinkingControls(preferred = thinkingLevelSelect.value): void {
    const levels = (selectedModel()?.thinkingLevels ?? []).filter(
      (level): level is keyof typeof THINKING_LABELS => level !== "off",
    )
    const desired = preferred || configuration.appSettings.thinkingLevel
    const needsExplicitChoice =
      settingsModelChanged &&
      !settingsThinkingChanged &&
      levels.length > 0 &&
      !levels.some((level) => level === configuration.appSettings.thinkingLevel)
    const options = levels.map((level) => new Option(t(THINKING_LABELS[level]), level))
    if (levels.length === 0) {
      options.push(new Option(t("Not applicable"), desired))
      thinkingHint.textContent = t(
        "This model does not use a thinking level. Your saved preference is retained.",
      )
    } else {
      if (needsExplicitChoice || !levels.some((level) => level === desired)) {
        const placeholder = new Option(t("Choose a supported level"), "")
        placeholder.disabled = true
        options.unshift(placeholder)
      }
      thinkingHint.textContent = t(
        "Choose a supported level. Higher levels may use more tokens. Unrelated saves keep your saved preference.",
      )
    }
    thinkingLevelSelect.replaceChildren(...options)
    thinkingLevelSelect.value =
      !needsExplicitChoice && options.some((option) => option.value === desired) ? desired : ""
    thinkingLevelSelect.disabled = levels.length === 0
    thinkingLevelSelect.removeAttribute("aria-invalid")
    thinkingError.hidden = true
  }

  function updateModelCapabilities(): void {
    const model = selectedModel()
    modelCapabilities.textContent = model
      ? [
          model.reasoning ? t("Reasoning") : t("No reasoning"),
          model.imageInput ? t("Image input") : t("Text input"),
        ].join(" · ")
      : t("No models available. Add a credential to load this provider's catalog.")
    modelError.hidden = true
    element<HTMLInputElement>("model-search").removeAttribute("aria-invalid")
    updateThinkingControls()
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
      throw new Error(t("Choose a valid thinking level"))
    return thinkingLevelSelect.value
  }

  function selectedConfirmationMode(): ConfirmationMode {
    const value = confirmationModes.find((radio) => radio.checked)?.value
    if (!isConfirmationMode(value)) throw new Error(t("Choose a valid confirmation mode"))
    return value
  }

  function selectedLanguage(): LanguagePreference {
    if (!isLanguagePreference(languageSelect.value)) throw new Error(t("Choose a valid language"))
    return languageSelect.value
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
      confirmationModes.find((radio) => radio.checked)?.value,
      toolCheckboxes.map((checkbox) => checkbox.checked),
      languageSelect.value,
      fontFamilySelect.value,
      fontSizeInput.value,
      systemPrompt.value,
      agentInstructions.value,
    ])
  }

  function hasGeneralChanges(): boolean {
    return generalFormState() !== savedFormState || settingsModelChanged || settingsThinkingChanged
  }

  function isActionBusy(): boolean {
    return (
      savingGeneral ||
      clearingApprovals ||
      mcpState.isBusy() ||
      skillState.isBusy() ||
      Boolean(authentication?.isBusy)
    )
  }

  function updateSaveState(): void {
    const busy = isActionBusy()
    saveButton.disabled = !ready || busy || !hasGeneralChanges()
    closeButton.disabled = cancelButton.disabled = busy
    saveStatus.textContent = savingGeneral
      ? t("Saving general settings…")
      : busy
        ? t("Separate action in progress…")
        : hasGeneralChanges()
          ? t("Unsaved general changes")
          : t("No unsaved general changes")
    draftStatus.textContent = [
      mcpState.hasDraft() ? t("Server edits not saved") : "",
      skillState.hasDraft() ? t("Skill review not imported") : "",
    ]
      .filter(Boolean)
      .join(" · ")
  }

  function hasUnsavedChanges(): boolean {
    return isActionBusy() || hasGeneralChanges() || mcpState.hasDraft() || skillState.hasDraft()
  }

  function validateGeneralChanges(): HTMLElement | undefined {
    if (settingsModelChanged && !modelSelect.value) {
      modelError.textContent = t(
        "Add a credential and choose a model before saving this selection.",
      )
      modelError.hidden = false
      element<HTMLInputElement>("model-search").setAttribute("aria-invalid", "true")
      element<HTMLButtonElement>("settings-tab-model").click()
      return element<HTMLButtonElement>("configure-provider")
    }
    const levels = selectedModel()?.thinkingLevels ?? []
    const persistedLevel = settingsThinkingChanged
      ? thinkingLevelSelect.value
      : configuration.appSettings.thinkingLevel
    const invalidPersistedLevel =
      settingsModelChanged && levels.length > 0 && !levels.some((level) => level === persistedLevel)
    if (
      levels.length > 0 &&
      (invalidPersistedLevel ||
        ((settingsModelChanged || settingsThinkingChanged) &&
          !levels.some((level) => level === thinkingLevelSelect.value)))
    ) {
      if (invalidPersistedLevel) updateThinkingControls(persistedLevel)
      thinkingError.textContent = t("Choose a thinking level supported by this model.")
      thinkingError.hidden = false
      thinkingLevelSelect.setAttribute("aria-invalid", "true")
      element<HTMLButtonElement>("settings-tab-model").click()
      return thinkingLevelSelect
    }
    return undefined
  }

  function populateSettings(): void {
    settingsModelChanged = false
    settingsThinkingChanged = false
    renderModelControls(initialSelection.provider, initialSelection.id)
    updateThinkingControls(
      initialThinkingLevel && isThinkingLevel(initialThinkingLevel)
        ? initialThinkingLevel
        : configuration.appSettings.thinkingLevel,
    )
    for (const radio of confirmationModes)
      radio.checked = radio.value === configuration.appSettings.confirmationMode
    const enabledTools = new Set(configuration.appSettings.enabledTools)
    for (const checkbox of toolCheckboxes) checkbox.checked = enabledTools.has(checkbox.value)
    savedLanguage = configuration.appSettings.language
    languageSelect.value = savedLanguage
    fontFamilySelect.value = configuration.appSettings.fontFamily
    fontSizeInput.value = String(configuration.appSettings.fontSize)
    fontSizeOutput.value = `${configuration.appSettings.fontSize} px`
    systemPrompt.value = configuration.appSettings.systemPrompt
    agentInstructions.value = configuration.appSettings.agentInstructions
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
    if (isActionBusy() || allowClosing) return
    if (
      hasUnsavedChanges() &&
      !(await confirmSettingsAction({
        title: t("Discard unsaved changes?"),
        message: t(
          "Unsaved general settings, MCP edits, and reviewed skill content will be discarded. Saved MCP and Skills changes will remain.",
        ),
        confirmLabel: t("Discard changes"),
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
    onStateChanged: updateSaveState,
    onProvidersChanged: () => {
      const providerId = providerSelect.value
      const modelId = modelSelect.value
      renderProviderOptions(providerId)
      renderModelOptions(providerId, modelId)
      updateSaveState()
    },
  })

  providerSelect.addEventListener("change", () => {
    settingsModelChanged = true
    renderModelOptions(providerSelect.value)
    void authentication?.refresh()
    updateSaveState()
  })
  modelSelect.addEventListener("change", () => {
    settingsModelChanged = true
    updateModelCapabilities()
    updateSaveState()
  })
  thinkingLevelSelect.addEventListener("change", () => {
    settingsThinkingChanged = !thinkingLevelSelect.disabled
    thinkingError.hidden = true
    thinkingLevelSelect.removeAttribute("aria-invalid")
    updateSaveState()
  })
  fontSizeInput.addEventListener("input", previewAppearance)
  fontFamilySelect.addEventListener("change", previewAppearance)
  element<HTMLButtonElement>("clear-confirmation-approvals").addEventListener("click", () => {
    if (isActionBusy()) return
    clearingApprovals = true
    updateSaveState()
    void run(async () => {
      try {
        await clearConfirmationApprovals()
        confirmationStatus.textContent = t("Remembered approvals cleared")
      } finally {
        clearingApprovals = false
        updateSaveState()
      }
    }, setError)
  })
  closeButton.addEventListener("click", () => void run(discardSettingsChanges, setError))
  cancelButton.addEventListener("click", () => void run(discardSettingsChanges, setError))
  page.addEventListener("input", updateSaveState)
  page.addEventListener("change", updateSaveState)
  saveButton.addEventListener("click", () => {
    if (isActionBusy() || allowClosing || !hasGeneralChanges()) return
    void run(async () => {
      if (
        (mcpState.hasDraft() || skillState.hasDraft()) &&
        !(await confirmSettingsAction({
          title: t("Unsaved MCP or Skills changes"),
          message: t(
            "Save general settings does not save MCP edits or import a reviewed skill. Use their save controls first, or discard those drafts and continue.",
          ),
          confirmLabel: t("Discard drafts and save"),
        }))
      )
        return
      if (isActionBusy() || allowClosing) return
      const invalidControl = validateGeneralChanges()
      if (invalidControl) {
        invalidControl.focus()
        return
      }
      let validationFocus: HTMLElement | undefined
      savingGeneral = true
      updateSaveState()
      page.inert = true
      page.setAttribute("aria-busy", "true")
      saveButton.textContent = t("Saving…")
      try {
        const applyModelToActiveSession = settingsModelChanged
        let providerId = providerSelect.value
        let modelId = modelSelect.value
        await configuration.syncSettings()
        validationFocus = validateGeneralChanges()
        if (validationFocus) return
        const applyThinkingToActiveSession =
          settingsThinkingChanged && (selectedModel()?.thinkingLevels.length ?? 0) > 0
        if (!applyModelToActiveSession) {
          providerId = configuration.appSettings.modelProvider
          modelId = configuration.appSettings.modelId
        }
        if (!modelId) throw new Error(t("Configure the selected provider and choose a model"))

        const fontFamily = selectedFontFamily()
        const fontSize = selectedFontSize()
        const confirmationMode = selectedConfirmationMode()
        const language =
          languageSelect.value !== savedLanguage
            ? selectedLanguage()
            : configuration.appSettings.language
        if (confirmationMode !== configuration.appSettings.confirmationMode) {
          await clearConfirmationApprovals()
        }
        await configuration.updateSettings(
          {
            language,
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
          },
          languageSelect.value === savedLanguage,
        )
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
          saveButton.textContent = t("Save general settings")
          updateSaveState()
          ;(validationFocus ?? saveButton).focus()
        }
      }
    }, setError)
  })
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      isActionBusy() ||
      allowClosing ||
      document.querySelector("dialog[open]") !== null
    )
      return
    event.preventDefault()
    void run(discardSettingsChanges, setError)
  })
  window.addEventListener("pagehide", () => authentication?.abort())

  document.title = t("Settings · Pi Browser Agent")
  document.body.dataset.view = "settings"
  initialSelection = await configuration.initialize(initialModel)
  populateSettings()
  mcpState = await initializeMcpSettings(confirmSettingsAction, updateSaveState)
  skillState = await initializeSkillsSettings(updateSaveState)
  applyAppearance(configuration.appSettings.fontFamily, configuration.appSettings.fontSize)
  initializeSettingsTabs(page)
  page.hidden = false
  ready = true
  updateSaveState()
  window.addEventListener("beforeunload", (event) => {
    if (allowClosing || !hasUnsavedChanges()) return
    event.preventDefault()
    event.returnValue = ""
  })
  await authentication.refresh()
  closeButton.focus()
}
