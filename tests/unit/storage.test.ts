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
    })
    await expect(getSettings()).resolves.toMatchObject({
      fontFamily: "serif",
      fontSize: 19,
      thinkingLevel: "high",
    })

    values.piBrowserAgentSettings = {
      systemPrompt: "Older prompt",
      agentInstructions: "Older instructions",
    }
    await expect(getSettings()).resolves.toEqual({
      systemPrompt: "Older prompt",
      agentInstructions: "Older instructions",
      fontFamily: "system",
      fontSize: 16,
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
    })

    values.piBrowserAgentSettings = {
      ...DEFAULT_SETTINGS,
      fontFamily: "invalid",
      fontSize: 25,
      thinkingLevel: "invalid",
    }
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
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
