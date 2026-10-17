import { afterEach, describe, expect, test, vi } from "vitest"
import { McpManager } from "../../src/browser/mcp/manager.js"
import { MCP_LIMITS } from "../../src/browser/mcp/policy.js"
import { removeMcpServer, saveMcpServer, setMcpConnection } from "../../src/browser/mcp/store.js"
import { mcpEnvironment, mockMcpFetch, remoteTool } from "../support/mcp.js"

afterEach(() => vi.unstubAllGlobals())

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test tool")
  return value
}

describe("remote MCP tool ownership", () => {
  test("exposes stable collision-free namespaces independent of page tools and confirms every call", async () => {
    const env = mcpEnvironment()
    await env.server()
    await env.server()
    const mock = mockMcpFetch()
    const confirm = vi.fn(async () => true)
    const manager = new McpManager(confirm)
    const tools = await manager.prepare()
    expect(tools).toHaveLength(2)
    expect(new Set(tools.map((t) => t.name)).size).toBe(2)
    for (const tool of tools) {
      expect(tool).toMatchObject({ replay: "never", executionMode: "sequential" })
      expect(tool.name.length).toBeLessThanOrEqual(64)
      expect(tool.description).toContain("Untrusted")
    }
    const result = await required(tools[0]).execute("one", { text: "x" }, undefined)
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("remote MCP result"),
    })
    await required(tools[0]).execute("two", { text: "x" }, undefined)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[0]).toHaveLength(3) // No reusable ApprovalScope in any mode.
    expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(2)
    const names = tools.map((t) => t.name)
    expect((await manager.prepare()).map((t) => t.name)).toEqual(names)
    await expect(required(tools[0]).execute("stale", { text: "x" }, undefined)).rejects.toThrow()
    manager.dispose()
    expect(env.storageListeners.size).toBe(0)
    expect(env.permissionListeners.size).toBe(0)
  })

  test("rejects invalid arguments before confirmation, and denied calls before network dispatch", async () => {
    const env = mcpEnvironment()
    await env.server()
    const mock = mockMcpFetch()
    const confirm = vi.fn(async () => false)
    const manager = new McpManager(confirm)
    const [tool] = await manager.prepare()
    await expect(required(tool).execute("invalid", { text: 4 }, undefined)).rejects.toThrow(
      "arguments",
    )
    expect(confirm).not.toHaveBeenCalled()
    await expect(required(tool).execute("denied", { text: "x" }, undefined)).rejects.toThrow(
      "declined",
    )
    expect(mock.messages.some((m) => m.method === "tools/call")).toBe(false)
    manager.dispose()
  })

  test.each(["disable", "remove", "endpoint", "token", "revoke", "shutdown"])(
    "%s invalidates pending confirmation and old declarations",
    async (change) => {
      const env = mcpEnvironment()
      const server = await env.server()
      const mock = mockMcpFetch()
      let confirmationSignal: AbortSignal | undefined
      const manager = new McpManager(async (_message, _details, signal) => {
        confirmationSignal = signal
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve(false), { once: true }),
        )
      })
      const [tool] = await manager.prepare()
      const pending = required(tool).execute("pending", { text: "x" }, undefined)
      const rejected = expect(pending).rejects.toThrow()
      await vi.waitFor(() => expect(confirmationSignal).toBeDefined())
      switch (change) {
        case "disable":
          await setMcpConnection(server.id, false)
          break
        case "remove":
          await removeMcpServer(server.id)
          break
        case "endpoint":
          await saveMcpServer({ ...server, endpoint: `${server.endpoint}/new` })
          break
        case "token":
          await saveMcpServer({ ...server, token: "new-secret" })
          break
        case "revoke":
          env.revoke()
          break
        case "shutdown":
          manager.dispose()
          break
      }
      await rejected
      expect(confirmationSignal?.aborted).toBe(true)
      expect(mock.messages.some((m) => m.method === "tools/call")).toBe(false)
      await expect(required(tool).execute("stale", { text: "x" }, undefined)).rejects.toThrow()
      manager.dispose()
    },
  )

  test("revalidates consent after confirmation and snapshots arguments", async () => {
    const env = mcpEnvironment()
    const server = await env.server()
    const mock = mockMcpFetch()
    const input = { text: "original" }
    const manager = new McpManager(async () => {
      input.text = "changed"
      return true
    })
    const [tool] = await manager.prepare()
    await required(tool).execute("id", input, undefined)
    expect(mock.messages.find((m) => m.method === "tools/call")?.params).toMatchObject({
      arguments: { text: "original" },
    })
    manager.dispose()
    const blocked = new McpManager(async () => {
      await setMcpConnection(server.id, false)
      return true
    })
    const [blockedTool] = await blocked.prepare()
    await expect(required(blockedTool).execute("stale", { text: "x" }, undefined)).rejects.toThrow()
    expect(mock.messages.filter((m) => m.method === "tools/call")).toHaveLength(1)
    blocked.dispose()
  })

  test("bounds aggregate declarations and exposes new metadata only in a later run", async () => {
    const env = mcpEnvironment()
    await env.server()
    let description = "Original"
    mockMcpFetch({ list: () => ({ tools: [{ ...remoteTool, description }] }) })
    const manager = new McpManager(async () => true)
    const [first] = await manager.prepare()
    description = "Changed"
    expect(first?.description).toContain("Original")
    expect((await manager.prepare())[0]?.description).toContain("Changed")
    await env.server()
    // Each server fits its individual tool count, but combined declarations do not.
    mockMcpFetch({
      list: () => ({
        tools: Array.from({ length: MCP_LIMITS.tools }, (_, i) => ({
          ...remoteTool,
          name: `tool${i}`,
        })),
      }),
    })
    await expect(manager.prepare()).rejects.toThrow("MCP request failed")
    manager.dispose()
  })
})
