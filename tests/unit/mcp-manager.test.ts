import { afterEach, describe, expect, test, vi } from "vitest"
import type { ConfirmationHandler } from "../../src/browser/agent/browser-tools.js"
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
    const confirm = vi.fn<ConfirmationHandler>(async () => true)
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
    expect(confirm.mock.calls[0]).toHaveLength(5)
    expect(confirm.mock.calls[0]?.[3]).toBeUndefined() // No reusable ApprovalScope in any mode.
    expect(confirm.mock.calls[0]?.[4]).toEqual({
      message: expect.stringContaining("Every call requires confirmation."),
    })
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
          await removeMcpServer(server.id, server.revision)
          break
        case "endpoint":
          await saveMcpServer({ ...server, endpoint: `${server.endpoint}/new` })
          break
        case "token":
          await saveMcpServer({ ...server, token: "new-secret-token-1" })
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

  for (const removed of [
    { permissions: ["bookmarks" as const] },
    { origins: ["https://unrelated.example.org/*"] },
    { origins: ["<all_urls>"] },
    { origins: ["https://*.example.com/*"] },
  ]) {
    for (const phase of ["discovery", "confirmation", "call"]) {
      test(`${JSON.stringify(removed)} keeps ${phase} active while endpoint access remains granted`, async () => {
        const env = mcpEnvironment()
        await env.server()
        let signal: AbortSignal | undefined
        let release = (): void => undefined
        const mock = mockMcpFetch({
          response: (message, init) => {
            if (
              (phase === "discovery" && message.method === "initialize") ||
              (phase === "call" && message.method === "tools/call")
            ) {
              signal = init.signal ?? undefined
              return new Promise<Response | undefined>((resolve, reject) => {
                release = () => resolve(undefined)
                init.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
                  once: true,
                })
              })
            }
            return undefined
          },
        })
        const manager = new McpManager(async (_message, _details, confirmationSignal) => {
          if (phase !== "confirmation") return true
          signal = confirmationSignal
          return new Promise<boolean>((resolve) => {
            release = () => resolve(true)
            confirmationSignal?.addEventListener("abort", () => resolve(false), { once: true })
          })
        })
        const pending =
          phase === "discovery"
            ? manager.prepare()
            : required((await manager.prepare())[0]).execute("call", { text: "x" }, undefined)
        const completed = pending.then(
          () => true,
          () => false,
        )
        await vi.waitFor(() => expect(signal).toBeDefined())
        for (const listener of env.permissionListeners) listener(removed)
        expect(signal?.aborted).toBe(false)
        release()
        expect(await completed).toBe(true)
        expect(mock.messages.filter((message) => message.method === "initialize")).toHaveLength(1)
        expect(mock.messages.filter((message) => message.method === "tools/call")).toHaveLength(
          phase === "discovery" ? 0 : 1,
        )
        manager.dispose()
      })
    }
  }

  test.each(["<all_urls>", "https://*.example.com/*"])(
    "lost endpoint access after removing %s cancels confirmation",
    async (origin) => {
      const env = mcpEnvironment()
      await env.server()
      mockMcpFetch()
      let signal: AbortSignal | undefined
      const manager = new McpManager(async (_message, _details, confirmationSignal) => {
        signal = confirmationSignal
        return new Promise<boolean>((resolve) =>
          confirmationSignal?.addEventListener("abort", () => resolve(false), { once: true }),
        )
      })
      const [tool] = await manager.prepare()
      const pending = required(tool).execute("pending", { text: "x" }, undefined)
      const rejected = expect(pending).rejects.toThrow()
      await vi.waitFor(() => expect(signal).toBeDefined())
      env.revoke({ origins: [origin] })
      await rejected
      expect(signal?.aborted).toBe(true)
      manager.dispose()
    },
  )

  test("a late permission result cannot invalidate a newer run", async () => {
    const env = mcpEnvironment()
    await env.server()
    mockMcpFetch()
    const manager = new McpManager(async () => true)
    await manager.prepare()
    let release = (_allowed: boolean): void => undefined
    vi.mocked(chrome.permissions.contains).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )
    for (const listener of env.permissionListeners)
      listener({ origins: ["https://unrelated.example.org/*"] })
    const [tool] = await manager.prepare()
    release(false)
    await expect(required(tool).execute("fresh", { text: "x" }, undefined)).resolves.toBeDefined()
    manager.dispose()
  })

  test("an endpoint permission query failure cancels current declarations", async () => {
    const env = mcpEnvironment()
    await env.server()
    mockMcpFetch()
    const manager = new McpManager(async () => true)
    const [tool] = await manager.prepare()
    const invalidated = vi.spyOn(manager, "invalidate")
    vi.mocked(chrome.permissions.contains).mockRejectedValueOnce(
      new Error("Permission query failed"),
    )
    for (const listener of env.permissionListeners) listener({ origins: ["<all_urls>"] })
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1))
    await expect(required(tool).execute("closed", { text: "x" }, undefined)).rejects.toThrow()
    manager.dispose()
  })

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

  test("Stop during graceful cleanup cannot start another discovery", async () => {
    const env = mcpEnvironment()
    await env.server()
    const mock = mockMcpFetch({
      response: (message, init) => {
        if (message.method === "session/delete")
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
              once: true,
            })
          })
        return
      },
    })
    const manager = new McpManager(async () => true)
    await manager.prepare()
    const pending = manager.prepare()
    const rejected = expect(pending).rejects.toThrow("MCP request failed")
    await vi.waitFor(() =>
      expect(mock.messages.some((m) => m.method === "session/delete")).toBe(true),
    )
    manager.invalidate()
    await rejected
    expect(mock.messages.filter((m) => m.method === "initialize")).toHaveLength(1)
    expect(await manager.prepare()).toHaveLength(1)
    manager.dispose()
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
