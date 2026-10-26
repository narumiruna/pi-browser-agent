import { afterEach, describe, expect, test, vi } from "vitest"
import {
  DEFAULT_SETTINGS,
  getActiveSessionId,
  getSettings,
  saveActiveSessionId,
  savePendingSelection,
  saveSettings,
  takePendingSelection,
} from "../../src/browser/storage.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser storage", () => {
  test("an Azure migration re-reads inside the settings lock instead of overwriting a newer language save", async () => {
    const values: Record<string, unknown> = {
      piBrowserAgentSettings: {
        ...DEFAULT_SETTINGS,
        modelProvider: "azure-openai-responses",
        language: "en",
      },
    }
    let release: (() => void) | undefined
    const initialRead = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0
    const get = vi.fn(async (key: string) => {
      const snapshot = structuredClone(values[key])
      if (++reads === 1) await initialRead
      return { [key]: snapshot }
    })
    const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items))
    vi.stubGlobal("chrome", { storage: { local: { get, set } } })
    const migration = getSettings()
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
    await saveSettings({ ...DEFAULT_SETTINGS, modelProvider: "azure", language: "ja" })
    release?.()
    await expect(migration).resolves.toMatchObject({ modelProvider: "azure", language: "ja" })
    expect(set).toHaveBeenCalledOnce()
    expect(values.piBrowserAgentSettings).toMatchObject({ modelProvider: "azure", language: "ja" })
  })

  test("merges untouched language inside the serialized commit, after earlier writers finish", async () => {
    const values: Record<string, unknown> = {}
    let release: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const set = vi.fn(async (items: Record<string, unknown>) => {
      if (++writes === 1) await firstWrite
      Object.assign(values, items)
    })
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set,
        },
      },
    })
    const languageSave = saveSettings({ ...DEFAULT_SETTINGS, language: "ja" })
    const unrelatedSave = saveSettings({ ...DEFAULT_SETTINGS, fontSize: 19 }, true)
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    release?.()
    await languageSave
    await expect(unrelatedSave).resolves.toMatchObject({ language: "ja", fontSize: 19 })
    await expect(getSettings()).resolves.toMatchObject({ language: "ja", fontSize: 19 })
    await saveSettings({ ...DEFAULT_SETTINGS, language: "pt-BR" })
    await expect(getSettings()).resolves.toMatchObject({ language: "pt-BR" })
  })

  test("persists validated appearance and thinking preferences and migrates older settings", async () => {
    const values: Record<string, unknown> = {}
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
        },
      },
    })

    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
    await saveSettings({
      ...DEFAULT_SETTINGS,
      fontFamily: "serif",
      fontSize: 19,
      thinkingLevel: "high",
      confirmationMode: "convenient",
    })
    await expect(getSettings()).resolves.toMatchObject({
      fontFamily: "serif",
      fontSize: 19,
      thinkingLevel: "high",
      confirmationMode: "convenient",
    })

    values.piBrowserAgentSettings = {
      systemPrompt: "Older prompt",
      agentInstructions: "Older instructions",
    }
    await expect(getSettings()).resolves.toEqual({
      language: "en",
      systemPrompt: "Older prompt",
      agentInstructions: "Older instructions",
      fontFamily: "system",
      fontSize: 16,
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
      confirmationMode: "strict",
      enabledTools: DEFAULT_SETTINGS.enabledTools,
    })

    values.piBrowserAgentSettings = {
      ...DEFAULT_SETTINGS,
      fontFamily: "invalid",
      fontSize: 25,
      thinkingLevel: "invalid",
      confirmationMode: "invalid",
    }
    await expect(getSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      confirmationMode: "strict",
    })

    values.piBrowserAgentSettings = { ...DEFAULT_SETTINGS, enabledTools: "browser_read_page" }
    await expect(getSettings()).resolves.toMatchObject({
      enabledTools: DEFAULT_SETTINGS.enabledTools,
    })
  })

  test("enables added tools in legacy settings and preserves original-tool opt-outs", async () => {
    const addedTools = [
      "browser_scroll",
      "browser_select_option",
      "browser_get_element_details",
      "browser_find_text",
      "browser_wait_for",
      "browser_set_checked",
      "browser_get_select_options",
    ]
    const originalTools = DEFAULT_SETTINGS.enabledTools.filter((name) => !addedTools.includes(name))
    const values: Record<string, unknown> = {
      piBrowserAgentSettings: { ...DEFAULT_SETTINGS, enabledTools: originalTools },
    }
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
        },
      },
    })

    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
    values.piBrowserAgentSettings = {
      ...DEFAULT_SETTINGS,
      enabledTools: ["browser_read_page", "browser_read_page", "unknown_tool", 42],
    }
    await expect(getSettings()).resolves.toMatchObject({
      enabledTools: DEFAULT_SETTINGS.enabledTools.filter(
        (name) => name === "browser_read_page" || addedTools.includes(name),
      ),
    })
    values.piBrowserAgentSettings = { ...DEFAULT_SETTINGS, enabledTools: [] }
    await expect(getSettings()).resolves.toMatchObject({
      enabledTools: DEFAULT_SETTINGS.enabledTools.filter((name) => addedTools.includes(name)),
    })
  })

  test("saves explicit opt-outs so later additions are enabled without losing choices", async () => {
    const values: Record<string, unknown> = {}
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
        },
      },
    })
    const enabledTools = DEFAULT_SETTINGS.enabledTools.filter(
      (name) => name !== "browser_click" && name !== "browser_set_checked",
    )
    await saveSettings({ ...DEFAULT_SETTINGS, enabledTools })
    expect(values.piBrowserAgentSettings).toEqual({
      ...DEFAULT_SETTINGS,
      enabledTools,
      disabledTools: ["browser_set_checked", "browser_click"],
    })
    await expect(getSettings()).resolves.toMatchObject({ enabledTools })

    const originalTools = DEFAULT_SETTINGS.enabledTools
    DEFAULT_SETTINGS.enabledTools = [...originalTools, "browser_future_tool"]
    try {
      await expect(getSettings()).resolves.toMatchObject({
        enabledTools: [...enabledTools, "browser_future_tool"],
      })
    } finally {
      DEFAULT_SETTINGS.enabledTools = originalTools
    }

    await saveSettings({ ...DEFAULT_SETTINGS, enabledTools: [] })
    await expect(getSettings()).resolves.toMatchObject({ enabledTools: [] })
    await saveSettings(DEFAULT_SETTINGS)
    expect(values.piBrowserAgentSettings).toEqual({ ...DEFAULT_SETTINGS, disabledTools: [] })
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  test("prefers validated disabled names over a stale enabled snapshot", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({
            piBrowserAgentSettings: {
              ...DEFAULT_SETTINGS,
              enabledTools: [],
              disabledTools: ["browser_set_checked", "browser_set_checked", "unknown_tool", 42],
            },
          })),
        },
      },
    })

    await expect(getSettings()).resolves.toMatchObject({
      enabledTools: DEFAULT_SETTINGS.enabledTools.filter((name) => name !== "browser_set_checked"),
    })
  })

  test("persists the active session ID in local extension storage", async () => {
    const values: Record<string, unknown> = {}
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
        },
      },
    })

    await expect(getActiveSessionId()).resolves.toBeUndefined()
    await saveActiveSessionId("session-1")
    await expect(getActiveSessionId()).resolves.toBe("session-1")
    await expect(saveActiveSessionId("")).rejects.toThrow("Invalid session ID")
  })

  test("takes a pending context-menu selection exactly once", async () => {
    const values: Record<string, unknown> = {}
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
          remove: vi.fn(async (key: string) => {
            delete values[key]
          }),
        },
      },
    })
    const selection = {
      windowId: 3,
      payload: { text: "selected", untrusted: true },
      tabContext: { tabId: 4, url: "https://example.test", epoch: 0 },
    }

    await savePendingSelection(selection)

    await expect(takePendingSelection(4)).resolves.toBeUndefined()
    await expect(takePendingSelection(3)).resolves.toEqual(selection)
    await expect(takePendingSelection(3)).resolves.toBeUndefined()
  })
})
