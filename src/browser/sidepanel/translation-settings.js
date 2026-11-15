import { translateKnownMessage as labelText, t } from "../i18n/index.js"
import { requestHostPermissions } from "../permissions.js"
import { TranslationProvider } from "../translation/provider.js"
import * as Appearance from "../translation/shared/appearance.js"
import * as Settings from "../translation/shared/settings.js"
import { createTranslationApi } from "../translation/translation/api.js"
import { buildTranslationInput } from "../translation/translation/responses.js"
import { SearchableSelect } from "./searchable-select.js"

const optionLabels = {
  default: "Default",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  max: "Max",
  "calm-reading": "Calm reading",
  "high-contrast": "High contrast",
  custom: "Custom",
  serif: "Serif",
  "sans-serif": "Sans serif",
  monospace: "Monospace",
  inherit: "Use page font",
}
const appearanceLabels = {
  fontFamily: "Font family",
  fontSizePx: "Font size",
  fontWeight: "Font weight",
  lineHeight: "Line height",
  maxWidthPx: "Max width",
  marginTopPx: "Space above",
  marginBottomPx: "Space below",
  paddingVerticalPx: "Vertical padding",
  paddingHorizontalPx: "Horizontal padding",
  borderRadiusPx: "Border radius",
  accentWidthPx: "Accent width",
  showBackground: "Show background",
  showLabel: "Show label",
  enableFadeAnimation: "Fade animation",
  backgroundColor: "Background color",
  textColor: "Text color",
  accentColor: "Accent color",
  labelColor: "Label color",
  widthPx: "Width",
  surfaceOpacityPercent: "Surface opacity",
  surfaceColor: "Surface color",
}

export async function initializeTranslationSettings(configuration, authentication, changed) {
  const root = document.getElementById("translation-settings")
  let saved = await Settings.getSettings()
  let draft = structuredClone(saved)
  let busy = false
  let disposed = false
  let connectionAbort
  let generation = 0
  let endpoints = []
  let connectionProvider
  const provider = new TranslationProvider(configuration)
  const bindings = []
  const groups = new Map()
  const element = (tag, text, parent = root) => {
    const node = document.createElement(tag)
    if (text) node.textContent = labelText(text)
    parent.append(node)
    return node
  }
  const action = (title, icon, parent) => {
    const button = element("button", "", parent)
    element("span", icon, button).setAttribute("aria-hidden", "true")
    button.type = "button"
    button.className = "icon-button"
    button.title = button.ariaLabel = labelText(title)
    return button
  }
  const section = (title) => {
    const details = element("details")
    element("summary", title, details)
    const body = element("div", "", details)
    groups.set(title, details)
    return body
  }
  const general = section("Translation model and language")
  groups.get("Translation model and language").open = true
  const appearanceBody = section("Translation appearance")
  const prompts = section("Translation prompt templates")
  const advanced = section("Subtitle and domain options")
  const status = element("p")
  status.setAttribute("role", "status")
  const error = element("p")
  error.setAttribute("role", "alert")
  const valueAt = (path) => path.reduce((object, key) => object?.[key], draft)
  const setAt = (path, value) => {
    if (path[0] !== "translationAppearance") {
      connectionAbort?.abort()
      status.textContent = ""
    }
    const object = path.slice(0, -1).reduce((object, key) => object[key], draft)
    object[path.at(-1)] = value
    if (path[0] === "translationAppearance" && path[1] !== "presetId")
      draft.translationAppearance.presetId = "custom"
    updatePreview()
    if (["customBaseUrl", "model"].includes(path[0])) void updateEndpoints()
    changed()
  }
  function field(title, path, options = {}, parent = general) {
    const label = element("label", title, parent)
    const control = document.createElement(
      options.values ? "select" : options.multiline ? "textarea" : "input",
    )
    const id = `translation-${path.join("-")}`
    control.id = id
    label.htmlFor = id
    if (options.values)
      for (const [value, name] of options.values)
        control.append(new Option(labelText(optionLabels[value] ?? name), value))
    else if (!options.multiline) control.type = options.type ?? "text"
    if (options.min !== undefined) control.min = String(options.min)
    if (options.max !== undefined) control.max = String(options.max)
    if (control.type === "number") control.step = options.step ?? "1"
    parent.append(control)
    const binding = { control, path }
    bindings.push(binding)
    const sync = () => {
      const value = valueAt(path)
      if (control.type === "checkbox") control.checked = value
      else control.value = String(value ?? "")
    }
    sync()
    control.addEventListener(options.values ? "change" : "input", () => {
      setAt(
        path,
        control.type === "checkbox"
          ? control.checked
          : control.type === "number"
            ? Number(control.value)
            : control.value,
      )
    })
    return control
  }
  function picker(title, key) {
    const label = element("label", title, general)
    const container = element("div", "", general)
    container.className = "searchable-select"
    const input = element("input", "", container)
    input.type = "search"
    input.setAttribute("role", "combobox")
    input.setAttribute("aria-autocomplete", "list")
    input.setAttribute("aria-controls", `translation-${key}-options`)
    input.setAttribute("aria-expanded", "false")
    input.id = `translation-${key}-search`
    label.htmlFor = input.id
    const select = element("select", "", container)
    select.id = `translation-${key}`
    select.setAttribute("aria-hidden", "true")
    select.tabIndex = -1
    const listbox = element("div", "", container)
    listbox.id = `translation-${key}-options`
    listbox.className = "searchable-select-options"
    listbox.setAttribute("role", "listbox")
    listbox.hidden = true
    const search = new SearchableSelect({
      container,
      input,
      select,
      listbox,
      emptyText: labelText("No matching models or providers"),
    })
    select.addEventListener("change", () => {
      connectionAbort?.abort()
      status.textContent = ""
      draft[key] = select.value
      if (key === "provider" || key === "model") updateModels()
      updateEndpoints()
      changed()
    })
    return search
  }
  const providerPicker = picker("Provider", "provider")
  const modelPicker = picker("Model", "model")
  const customModel = field("Custom model ID", ["model"])
  customModel.id = "translation-custom-model"
  customModel.previousElementSibling.htmlFor = customModel.id
  const customUrl = field("Custom Responses base URL", ["customBaseUrl"])
  const thinking = field("Thinking Level", ["thinkingLevel"], {
    values: Settings.THINKING_LEVELS.map((level) => [level, level]),
  })
  field("Target language", ["targetLanguage"])
  const credential = action("Add or update provider credential", "+", general)
  credential.type = "button"
  credential.addEventListener("click", () => {
    void authentication
      .configure(undefined, draft.provider)
      .then(async (configured) => {
        if (configured) {
          updateModels()
          changed()
        }
        await updateEndpoints()
      })
      .catch(showError)
  })
  const connection = action("Test Connection", "↗", general)
  connection.type = "button"
  connection.addEventListener("click", () => {
    if (busy || !endpoints.length || !connectionProvider) return
    const snapshotProvider = connectionProvider
    const snapshot = structuredClone(draft)
    const controller = new AbortController()
    connectionAbort = controller
    busy = true
    connection.disabled = true
    changed()
    const permission = requestHostPermissions(endpoints)
    void (async () => {
      if (!(await permission)) throw new Error("Translation endpoint access was denied")
      const api = createTranslationApi(snapshotProvider)
      const result = await api.requestTranslations({
        settings: snapshot,
        bypassCache: true,
        items: [{ id: "connection", kind: "selection", text: "Hello, world." }],
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      })
      if (!controller.signal.aborted && !disposed)
        status.textContent = result[0]?.translation ?? labelText("Connection test completed")
    })()
      .catch((cause) => {
        if (!controller.signal.aborted && !disposed) showError(cause)
      })
      .finally(() => {
        if (connectionAbort !== controller) return
        busy = false
        connectionAbort = undefined
        connection.disabled = !endpoints.length
        if (!disposed) changed()
      })
  })
  async function updateEndpoints() {
    const current = ++generation
    endpoints = []
    connectionProvider = undefined
    connection.disabled = true
    try {
      const scoped = await provider.scoped(draft)
      const origins = await scoped.getModelEndpointPatterns(draft)
      if (current === generation) {
        endpoints = origins
        connectionProvider = scoped
      }
    } catch {
      if (current === generation) endpoints = []
    }
    connection.disabled = busy || !endpoints.length
  }
  function updateModels() {
    const custom = draft.provider === "openai-compatible"
    customModel.hidden = customUrl.hidden = !custom
    customModel.previousElementSibling.hidden = customUrl.previousElementSibling.hidden = !custom
    const modelSearch = document.getElementById("translation-model-search")
    modelSearch.closest(".searchable-select").hidden = custom
    document.querySelector('label[for="translation-model-search"]').hidden = custom
    const models = configuration.getModels(draft.provider)
    modelPicker.setOptions(
      models.map((model) => ({ value: model.id, label: model.name, keywords: [model.id] })),
      draft.model,
    )
    if (!custom && !models.some((model) => model.id === draft.model) && models[0])
      draft.model = models[0].id
    const supported = models.find((model) => model.id === draft.model)?.thinkingLevels ?? []
    thinking.replaceChildren(
      ...Settings.THINKING_LEVELS.filter((level) =>
        level === "default" || custom
          ? ["default", ...Settings.BASIC_THINKING_LEVELS].includes(level)
          : supported.includes(level) || level === draft.thinkingLevel,
      ).map((level) => new Option(labelText(optionLabels[level] ?? level), level)),
    )
    thinking.value = draft.thinkingLevel
    thinking.title =
      draft.thinkingLevel !== "default" && !custom && !supported.includes(draft.thinkingLevel)
        ? labelText("Unsupported thinking level; Default will be used")
        : ""
  }
  providerPicker.setOptions(
    configuration
      .getProviders()
      .map((provider) => ({ value: provider.id, label: provider.name, keywords: [provider.id] })),
    draft.provider,
  )
  updateModels()
  const systemTemplate = field(
    "System prompt template",
    ["systemPromptTemplate"],
    { multiline: true },
    prompts,
  )
  const userTemplate = field(
    "User prompt template",
    ["userPromptTemplate"],
    { multiline: true },
    prompts,
  )
  for (const [name, key, value] of [
    ["Reset System Template", "systemPromptTemplate", Settings.DEFAULT_SYSTEM_PROMPT_TEMPLATE],
    ["Reset User Template", "userPromptTemplate", Settings.DEFAULT_USER_PROMPT_TEMPLATE],
  ]) {
    const reset = action(name, "↺", prompts)
    reset.type = "button"
    reset.addEventListener("click", () => {
      draft[key] = value
      syncBindings()
      updatePreview()
      changed()
    })
  }
  const promptPreview = element("pre", "", prompts)
  const warnings = element("p", "", prompts)
  const preset = field(
    "Reading preset",
    ["translationAppearance", "presetId"],
    { values: Appearance.ALL_PRESET_IDS.map((id) => [id, id]) },
    appearanceBody,
  )
  preset.addEventListener("change", () => {
    if (preset.value !== "custom")
      draft.translationAppearance = Appearance.createTranslationAppearancePreset(preset.value)
    syncBindings()
    updatePreview()
    changed()
  })
  for (const scope of ["inline", "selection"]) {
    const group = element("fieldset", "", appearanceBody)
    element("legend", scope === "inline" ? "Inline translations" : "Selection panel", group)
    for (const [key, value] of Object.entries(draft.translationAppearance[scope])) {
      if (key === "light" || key === "dark") {
        const colors = element("fieldset", "", group)
        colors.dataset.translationTheme = key
        colors.hidden = key === "dark"
        element("legend", key === "light" ? "Light colors" : "Dark colors", colors)
        for (const color of Object.keys(value))
          field(
            appearanceLabels[color] ?? color,
            ["translationAppearance", scope, key, color],
            { type: "color" },
            colors,
          )
      } else {
        const limits = Appearance.APPEARANCE_LIMITS[scope][key]
        field(
          appearanceLabels[key] ?? key,
          ["translationAppearance", scope, key],
          {
            ...(typeof value === "boolean"
              ? { type: "checkbox" }
              : typeof value === "number"
                ? {
                    type: "number",
                    min: limits?.[0] ?? 400,
                    max: limits?.[1] ?? 600,
                    step: key === "lineHeight" ? ".05" : "1",
                  }
                : {
                    values: Object.keys(Appearance.FONT_FAMILY_STACKS).map((font) => [font, font]),
                  }),
          },
          group,
        )
      }
    }
  }
  const mode = action("Preview dark colors", "◐", appearanceBody)
  mode.type = "button"
  let dark = false
  mode.addEventListener("click", () => {
    dark = !dark
    for (const group of root.querySelectorAll("[data-translation-theme]"))
      group.hidden = (group.dataset.translationTheme === "dark") !== dark
    updatePreview()
  })
  const preview = element("p", "Translation preview", appearanceBody)
  const selectionPreview = element("p", "Selection translation preview", appearanceBody)
  const previewLabel = element("small", "Translation", preview)
  preview.prepend(previewLabel)
  const contrast = element("p", "", appearanceBody)
  const resetAppearance = action("Reset Appearance", "↺", appearanceBody)
  resetAppearance.type = "button"
  resetAppearance.addEventListener("click", () => {
    draft.translationAppearance = Appearance.createTranslationAppearancePreset("calm-reading")
    syncBindings()
    updatePreview()
    changed()
  })
  field(
    "Selection panel position",
    ["selectionPanelPositionMode"],
    {
      values: [
        ["near-selection", "Near selected text"],
        ["bottom-right", "Bottom-right corner"],
      ],
    },
    advanced,
  )
  field(
    "YouTube subtitle display",
    ["youtubeSubtitleDisplayMode"],
    {
      values: [
        ["translation-only", "Translation only"],
        ["bilingual", "Original and translation"],
      ],
    },
    advanced,
  )
  field("Disabled domains", ["disabledDomains"], { multiline: true }, advanced)
  field("Show extraction diagnostics", ["showTranslationDebugInfo"], { type: "checkbox" }, advanced)
  function showError(cause) {
    error.textContent =
      cause instanceof Error ? cause.message : labelText("Translation settings action failed")
  }
  function syncBindings() {
    for (const { control, path } of bindings)
      if (control.type === "checkbox") control.checked = valueAt(path)
      else control.value = String(valueAt(path) ?? "")
  }
  function updatePreview() {
    if (!preview) return
    const appearance = Appearance.normalizeTranslationAppearance(draft.translationAppearance)
    const theme = dark ? "dark" : "light"
    const inline = appearance.inline
    Object.assign(preview.style, {
      fontFamily: Appearance.FONT_FAMILY_STACKS[inline.fontFamily],
      fontSize: `${inline.fontSizePx}px`,
      lineHeight: String(inline.lineHeight),
      fontWeight: String(inline.fontWeight),
      maxWidth: `${inline.maxWidthPx}px`,
      marginTop: `${inline.marginTopPx}px`,
      marginBottom: `${inline.marginBottomPx}px`,
      padding: `${inline.paddingVerticalPx}px ${inline.paddingHorizontalPx}px`,
      borderRadius: `${inline.borderRadiusPx}px`,
      borderInlineStart: `${inline.accentWidthPx}px solid ${inline[theme].accentColor}`,
      color: inline[theme].textColor,
      backgroundColor: inline.showBackground ? inline[theme].backgroundColor : "transparent",
    })
    previewLabel.style.display = inline.showLabel ? "block" : "none"
    previewLabel.style.color = inline[theme].labelColor
    preview.classList.toggle("translation-preview-fade", inline.enableFadeAnimation)
    const selection = appearance.selection
    Object.assign(selectionPreview.style, {
      fontSize: `${selection.fontSizePx}px`,
      lineHeight: String(selection.lineHeight),
      color: selection[theme].textColor,
      backgroundColor: `color-mix(in srgb, ${selection[theme].surfaceColor} ${selection.surfaceOpacityPercent}%, transparent)`,
      borderRadius: `${selection.borderRadiusPx}px`,
      borderInlineStart: `2px solid ${selection[theme].accentColor}`,
      padding: "12px",
      maxWidth: "100%",
      width: `${selection.widthPx}px`,
    })
    const ratio = Appearance.calculateContrastRatio(
      inline[theme].textColor,
      inline[theme].backgroundColor,
    )
    mode.title = mode.ariaLabel = labelText(dark ? "Preview light colors" : "Preview dark colors")
    mode.setAttribute("aria-pressed", String(dark))
    contrast.textContent = inline.showBackground
      ? t("Contrast: {ratio}:1", { ratio }) +
        (ratio < 4.5 ? ` — ${labelText("Below WCAG AA")}` : "")
      : labelText("Host-page contrast cannot be verified without a background")
    const selectionRatio = Appearance.calculateContrastRatio(
      selection[theme].textColor,
      selection[theme].surfaceColor,
    )
    contrast.textContent += `\n${labelText("Selection panel")} · ${selection.surfaceOpacityPercent < 100 ? "~" : ""}${t("Contrast: {ratio}:1", { ratio: selectionRatio })}${selectionRatio < 4.5 ? ` — ${labelText("Below WCAG AA")}` : ""}`
    const prompt = buildTranslationInput({
      ...draft,
      items: [{ id: "preview", kind: "paragraph", text: "Example source text" }],
    })
    promptPreview.textContent = prompt.map((item) => item.content).join("\n\n")
    warnings.textContent = Settings.lintPromptTemplates(draft).join("\n")
    preset.value = draft.translationAppearance.presetId
  }
  systemTemplate.addEventListener("input", updatePreview)
  userTemplate.addEventListener("input", updatePreview)
  const clearCache = action("Clear PDF cache", "×", advanced)
  clearCache.type = "button"
  clearCache.addEventListener("click", () => {
    void import("../pdf/cache.js")
      .then((cache) => cache.clearPdfCache())
      .then(() => {
        if (!disposed) status.textContent = labelText("PDF cache cleared")
      })
      .catch(showError)
  })
  const onStorage = (changes, area) => {
    const previous = changes.piBrowserAgentCredentialsV1?.oldValue?.[draft.provider]
    const next = changes.piBrowserAgentCredentialsV1?.newValue?.[draft.provider]
    if (
      area === "local" &&
      previous &&
      (!next ||
        previous.type !== next.type ||
        (next.type === "api_key" && JSON.stringify(previous) !== JSON.stringify(next)) ||
        (next.type === "oauth" && previous.accountId !== next.accountId))
    )
      connectionAbort?.abort()
    if (
      area === "local" &&
      changes.piBrowserAgentAuthChangeV1?.newValue?.providerId === draft.provider
    )
      connectionAbort?.abort()
  }
  chrome.storage.onChanged.addListener(onStorage)
  const onRemoved = () => connectionAbort?.abort()
  chrome.permissions?.onRemoved?.addListener(onRemoved)
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true
      connectionAbort?.abort()
      chrome.storage.onChanged.removeListener(onStorage)
      chrome.permissions?.onRemoved?.removeListener(onRemoved)
    },
    { once: true },
  )
  updatePreview()
  await updateEndpoints()
  return {
    hasDraft: () => JSON.stringify(saved) !== JSON.stringify(draft),
    isBusy: () => busy,
    async save() {
      const invalid = bindings.find(({ control }) => !control.checkValidity())
      if (invalid) {
        const details = invalid.control.closest("details")
        if (details) details.open = true
        document.getElementById("settings-tab-translation").click()
        invalid.control.focus()
        throw new Error(labelText("Correct the invalid translation setting before saving"))
      }
      const result = Settings.validateSettings(draft)
      if (!result.isValid) {
        showError(new Error(result.errors.join(" ")))
        throw new Error(result.errors.join(" "))
      }
      const difference = (before, after) =>
        Object.fromEntries(
          Object.entries(after)
            .filter(([key, value]) => JSON.stringify(before?.[key]) !== JSON.stringify(value))
            .map(([key, value]) => [
              key,
              value && typeof value === "object" && !Array.isArray(value)
                ? difference(before?.[key], value)
                : value,
            ]),
        )
      const edits = Object.fromEntries(
        Object.keys(draft)
          .filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]))
          .map((key) => [
            key,
            key === "translationAppearance" ? difference(saved[key], draft[key]) : draft[key],
          ]),
      )
      if (
        saved.provider !== draft.provider ||
        saved.model !== draft.model ||
        (draft.provider === Settings.CUSTOM_PROVIDER && saved.customBaseUrl !== draft.customBaseUrl)
      ) {
        edits.provider = draft.provider
        edits.model = draft.model
        if (draft.provider === Settings.CUSTOM_PROVIDER) edits.customBaseUrl = draft.customBaseUrl
      }
      if (!Object.keys(edits).length) return
      saved = await Settings.saveSettings(edits)
      draft = structuredClone(saved)
      syncBindings()
      updatePreview()
    },
  }
}
