import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { clearConfirmationApprovals } from "../../src/browser/agent/confirmation-policy.js"
import { getLocale, setLanguagePreference } from "../../src/browser/i18n/index.js"
import { LOCALES } from "../../src/browser/i18n/locales.js"
import { initializeSettingsPage } from "../../src/browser/sidepanel/settings-page.js"
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  type SettingsUpdate,
} from "../../src/browser/storage.js"

const state = vi.hoisted(() => ({
  persisted: {} as AppSettings,
  loaded: {} as AppSettings,
  authBusy: false,
  confirm: vi.fn(async () => false),
  update: vi.fn<(update: SettingsUpdate) => Promise<void>>(),
}))

vi.mock("../../src/browser/configuration.js", () => ({
  BrowserConfiguration: class {
    get defaultModel() {
      return { provider: state.persisted.modelProvider, id: state.persisted.modelId }
    }
    get appSettings() {
      return { ...state.loaded }
    }
    async initialize() {
      state.loaded = { ...state.persisted }
      return this.defaultModel
    }
    async syncSettings() {
      state.loaded = { ...state.persisted }
    }
    updateSettings(update: SettingsUpdate) {
      return state.update(update)
    }
    getProviders() {
      return [{ id: state.persisted.modelProvider, name: "Provider", modelCount: 0 }]
    }
    getModels() {
      return []
    }
  },
}))
vi.mock("../../src/browser/sidepanel/authentication.js", () => ({
  AuthenticationController: class {
    get isBusy() {
      return state.authBusy
    }
    async refresh() {}
    abort() {}
  },
}))
vi.mock("../../src/browser/sidepanel/mcp-settings.js", () => ({
  initializeMcpSettings: async () => ({ hasDraft: () => false, isBusy: () => false }),
}))
vi.mock("../../src/browser/sidepanel/skills-settings.js", () => ({
  initializeSkillsSettings: async () => ({ hasDraft: () => false, isBusy: () => false }),
}))
vi.mock("../../src/browser/sidepanel/settings-confirmation.js", () => ({
  initializeSettingsConfirmation: () => state.confirm,
}))
vi.mock("../../src/browser/agent/confirmation-policy.js", () => ({
  clearConfirmationApprovals: vi.fn(async () => {}),
}))

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const windows: JSDOM[] = []

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  state.confirm.mockReset().mockResolvedValue(false)
  state.update.mockReset()
  state.authBusy = false
  setLanguagePreference("en")
})

async function setup() {
  state.persisted = { ...DEFAULT_SETTINGS, language: "en" }
  state.update.mockImplementation(async (update) => {
    const changes = typeof update === "function" ? await update({ ...state.persisted }) : update
    state.persisted = state.loaded = { ...state.persisted, ...changes }
  })
  const dom = new JSDOM(html)
  windows.push(dom)
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("Option", dom.window.Option)
  const close = vi.spyOn(dom.window, "close").mockImplementation(() => {})
  const sendMessage = vi.fn(async () => undefined)
  vi.stubGlobal("chrome", {
    tabs: { getCurrent: vi.fn(async () => undefined) },
    runtime: { sendMessage },
  })
  await initializeSettingsPage(new URLSearchParams())
  const get = <T extends HTMLElement>(id: string): T => {
    const value = dom.window.document.getElementById(id)
    if (!value) throw new Error(`Missing test element: ${id}`)
    return value as T
  }
  const language = get<HTMLSelectElement>("language")
  const changeLanguage = (value: string) => {
    language.value = value
    language.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  }
  return {
    dom,
    get,
    close,
    sendMessage,
    language,
    changeLanguage,
    save: get<HTMLButtonElement>("save-settings"),
    cancel: get<HTMLButtonElement>("cancel-settings"),
  }
}

describe("Settings language drafts", () => {
  test("offers Follow browser and exactly the approved locales without a preview", async () => {
    const ui = await setup()
    expect([...ui.language.options].map((option) => option.value)).toEqual([
      "auto",
      ...LOCALES.map((locale) => locale.code),
    ])
    expect(ui.language.value).toBe("en")
    expect(ui.save.disabled).toBe(true)
    ui.changeLanguage("ja")
    expect(ui.save.disabled).toBe(false)
    expect(getLocale()).toBe("en")
    expect(state.update).not.toHaveBeenCalled()
    ui.changeLanguage("en")
    expect(ui.save.disabled).toBe(true)
  })

  test.each(["auto", ...LOCALES.map((locale) => locale.code)])(
    "saves %s without a credential or an available model",
    async (language) => {
      const ui = await setup()
      if (language === "en") ui.get<HTMLTextAreaElement>("agent-instructions").value = "Changed"
      ui.changeLanguage(language)
      ui.save.click()
      await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
      expect(state.persisted.language).toBe(language)
      expect(state.persisted.modelId).toBe(DEFAULT_SETTINGS.modelId)
      expect(ui.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            applyModelToActiveSession: false,
            applyThinkingToActiveSession: false,
          }),
        }),
      )
      expect(getLocale()).toBe("en")
    },
  )

  test("Cancel keeps the draft when discard is declined and never saves it", async () => {
    const ui = await setup()
    ui.changeLanguage("ja")
    ui.cancel.click()
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce())
    expect(ui.language.value).toBe("ja")
    expect(ui.close).not.toHaveBeenCalled()
    state.confirm.mockResolvedValue(true)
    ui.cancel.click()
    await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
    expect(state.persisted.language).toBe("en")
    expect(state.update).not.toHaveBeenCalled()
    expect(getLocale()).toBe("en")
  })

  test("a failed Save retains the draft without changing the effective language", async () => {
    const ui = await setup()
    state.update.mockRejectedValue(new Error("Storage unavailable"))
    ui.changeLanguage("ja")
    ui.save.click()
    await vi.waitFor(() =>
      expect(ui.get("settings-error").textContent).toContain("Storage unavailable"),
    )
    expect(ui.language.value).toBe("ja")
    expect(ui.save.disabled).toBe(false)
    expect(ui.close).not.toHaveBeenCalled()
    expect(state.persisted.language).toBe("en")
    expect(getLocale()).toBe("en")
  })

  test("an unrelated Save preserves a concurrent persisted language after synchronization", async () => {
    const ui = await setup()
    state.persisted = { ...state.persisted, language: "tr" }
    const instructions = ui.get<HTMLTextAreaElement>("agent-instructions")
    instructions.value = "Changed instructions"
    instructions.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }))
    expect(ui.language.value).toBe("en")
    ui.save.click()
    await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
    expect(state.persisted.language).toBe("tr")
  })

  test("retains a concurrent language saved while approval clearing is awaited", async () => {
    const ui = await setup()
    const strict = ui.dom.window.document.querySelector<HTMLInputElement>('input[value="strict"]')
    if (!strict) throw new Error("Missing Strict mode")
    strict.click()
    vi.mocked(clearConfirmationApprovals).mockImplementationOnce(async () => {
      state.persisted = { ...state.persisted, language: "ja" }
    })
    ui.save.click()
    await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
    expect(state.persisted.language).toBe("ja")
    expect(state.persisted.confirmationMode).toBe("strict")
  })

  test("an unrelated save preserves all untouched fields and does not clear approvals", async () => {
    const ui = await setup()
    vi.mocked(clearConfirmationApprovals).mockClear()
    state.persisted = {
      ...state.persisted,
      language: "ja",
      confirmationMode: "strict",
      enabledTools: state.persisted.enabledTools.filter((name) => name !== "browser_type"),
      fontFamily: "serif",
      systemPrompt: "Prompt from another tab",
      agentInstructions: "Instructions from another tab",
    }
    const current = { ...state.persisted }
    const fontSize = ui.get<HTMLInputElement>("font-size")
    fontSize.value = "19"
    fontSize.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }))
    ui.save.click()
    await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
    expect(state.persisted).toEqual({ ...current, fontSize: 19 })
    expect(clearConfirmationApprovals).not.toHaveBeenCalled()
  })

  test("a reverted field preserves the latest stored value on an unrelated save", async () => {
    const ui = await setup()
    const strict = ui.dom.window.document.querySelector<HTMLInputElement>('input[value="strict"]')
    const balanced =
      ui.dom.window.document.querySelector<HTMLInputElement>('input[value="balanced"]')
    if (!strict || !balanced) throw new Error("Missing confirmation mode")
    strict.click()
    balanced.click()
    state.persisted = { ...state.persisted, confirmationMode: "convenient" }
    ui.changeLanguage("ja")
    ui.save.click()
    await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
    expect(state.persisted.confirmationMode).toBe("convenient")
    expect(state.persisted.language).toBe("ja")
  })

  test("a locally changed language overrides a concurrent persisted language", async () => {
    const ui = await setup()
    ui.changeLanguage("ja")
    state.persisted = { ...state.persisted, language: "tr" }
    ui.save.click()
    await vi.waitFor(() => expect(ui.close).toHaveBeenCalledOnce())
    expect(state.persisted.language).toBe("ja")
  })

  test("rejects an invalid language without saving or applying it", async () => {
    const ui = await setup()
    ui.changeLanguage("unsupported")
    ui.save.click()
    await vi.waitFor(() =>
      expect(ui.get("settings-error").textContent).toContain("Choose a valid language"),
    )
    expect(state.update).not.toHaveBeenCalled()
    expect(state.persisted.language).toBe("en")
    expect(getLocale()).toBe("en")
    expect(ui.close).not.toHaveBeenCalled()
  })

  test("pending authentication blocks Save and Cancel", async () => {
    const ui = await setup()
    state.authBusy = true
    ui.changeLanguage("ja")
    expect(ui.save.disabled).toBe(true)
    expect(ui.cancel.disabled).toBe(true)
    ui.save.click()
    ui.cancel.click()
    expect(state.update).not.toHaveBeenCalled()
    expect(state.confirm).not.toHaveBeenCalled()
  })

  test("language changes do not bypass validation of an explicit missing model", async () => {
    const ui = await setup()
    ui.get<HTMLSelectElement>("provider").dispatchEvent(new ui.dom.window.Event("change"))
    ui.changeLanguage("ja")
    ui.save.click()
    await vi.waitFor(() => expect(ui.get("model-error").hidden).toBe(false))
    expect(state.update).not.toHaveBeenCalled()
    expect(ui.close).not.toHaveBeenCalled()
  })
})
