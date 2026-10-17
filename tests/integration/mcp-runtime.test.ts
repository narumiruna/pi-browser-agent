import { IDBFactory } from "fake-indexeddb"
import { afterEach, describe, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { DEFAULT_SETTINGS } from "../../src/browser/storage.js"
import { mcpEnvironment, mockMcpFetch } from "../support/mcp.js"

afterEach(() => vi.unstubAllGlobals())

describe("MCP browser runtime integration", () => {
  test("discovers only on explicit submission, works without a page, and does not restore connections", async () => {
    const env = mcpEnvironment()
    vi.stubGlobal("indexedDB", new IDBFactory())
    await env.server("private-token")
    const mock = mockMcpFetch()
    const runtime = new BrowserAgentRuntime({
      confirm: vi.fn(async () => true),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
    })
    await runtime.configuration.updateSettings({ ...DEFAULT_SETTINGS, enabledTools: [] })
    const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
    expect(mock.fetch).not.toHaveBeenCalled()
    await runtime.submit("Use remote tool", "steer", [], [], false)
    expect(prompt).toHaveBeenCalledWith("Use remote tool")
    expect(runtime.agent.state.tools).toHaveLength(1)
    const tool = runtime.agent.state.tools[0]
    if (!tool) throw new Error("Missing MCP tool")
    expect(tool.name).toMatch(/^mcp_/)
    await tool.execute("id", { text: "hello" }, undefined)
    expect(JSON.stringify(runtime.agent.state.messages)).not.toContain("private-token")
    runtime.abort()
    await expect(tool.execute("old", { text: "hello" }, undefined)).rejects.toThrow()
    // A new runtime starts with browser tools only, even if a saved transcript contains MCP data.
    const restored = new BrowserAgentRuntime({
      confirm: vi.fn(),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
    })
    expect(restored.agent.state.tools.some((t) => t.name.startsWith("mcp_"))).toBe(false)
  })

  test("rejects overlapping submissions during discovery and abort prevents model dispatch", async () => {
    const env = mcpEnvironment()
    vi.stubGlobal("indexedDB", new IDBFactory())
    await env.server()
    const mock = mockMcpFetch({
      response: (message, init) => {
        if (message.method !== "initialize") return
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
            once: true,
          }),
        )
      },
    })
    const runtime = new BrowserAgentRuntime({
      confirm: vi.fn(),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
    })
    await runtime.configuration.updateSettings(DEFAULT_SETTINGS)
    const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
    const pending = runtime.submit("First")
    const rejected = expect(pending).rejects.toThrow("MCP request failed")
    await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalled())
    await expect(runtime.submit("Second")).rejects.toThrow("discovery")
    runtime.abort()
    await rejected
    expect(prompt).not.toHaveBeenCalled()
  })

  test("defers model changes during discovery and applies them after a cancelled preparation", async () => {
    const env = mcpEnvironment()
    vi.stubGlobal("indexedDB", new IDBFactory())
    await env.server()
    const mock = mockMcpFetch({
      response: (message, init) => {
        if (message.method !== "initialize") return
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
            once: true,
          }),
        )
      },
    })
    const onPreparing = vi.fn()
    const runtime = new BrowserAgentRuntime({
      confirm: vi.fn(),
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
      onPreparing,
    })
    await runtime.initialize()
    try {
      const original = runtime.model
      const target = runtime.configuration.getModels("anthropic")[0]
      if (!target) throw new Error("Missing test model")
      const prompt = vi.spyOn(runtime.agent, "prompt").mockResolvedValue()
      const pending = runtime.submit("First")
      const rejected = expect(pending).rejects.toThrow("MCP request failed")
      await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalled())
      await runtime.configuration.updateSettings({
        ...runtime.configuration.appSettings,
        modelProvider: target.provider,
        modelId: target.id,
      })
      await runtime.syncSettings({ applyModelToActiveSession: true })
      expect(runtime.model).toBe(original)
      runtime.abort()
      await rejected
      expect(prompt).not.toHaveBeenCalled()
      expect(runtime.model.provider).toBe(target.provider)
      expect(runtime.model.id).toBe(target.id)
      expect(onPreparing.mock.calls).toEqual([[true], [false]])
    } finally {
      await runtime.shutdown()
    }
  })
})
