import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, test, vi } from "vitest"
import type { BridgeServer } from "../../src/pi/bridge-server.js"
import { registerBrowserTools } from "../../src/pi/tools.js"
import { BridgeError } from "../../src/protocol/index.js"

interface CapturedTool {
  name: string
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>
}

function captureTools(server: Pick<BridgeServer, "getStatus" | "request">): CapturedTool[] {
  const tools: CapturedTool[] = []
  const api = {
    registerTool(tool: unknown) {
      tools.push(tool as CapturedTool)
    },
  } as unknown as ExtensionAPI
  registerBrowserTools(api, () => server as BridgeServer)
  return tools
}

function findTool(tools: CapturedTool[], name: string): CapturedTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not registered: ${name}`)
  return tool
}

describe("pi browser tool mapping", () => {
  test("maps read tools to stable bridge methods and labels output untrusted", async () => {
    const request = vi.fn().mockResolvedValue({ text: "page text" })
    const tools = captureTools({ getStatus: vi.fn(), request })
    const tool = findTool(tools, "browser_read_page")

    const result = await tool.execute("call", {}, undefined, undefined, {})

    expect(request).toHaveBeenCalledWith("page.getVisibleText", {}, { signal: undefined })
    expect(result.content[0]?.text).toContain("Untrusted browser content")
  })

  test("retries sensitive mutations only for the originally inspected tab context", async () => {
    const originalContext = { tabId: 7, url: "https://example.test/form", epoch: 3 }
    const changedContext = { tabId: 7, url: "https://example.test/other", epoch: 4 }
    let currentContext = originalContext
    const getStatus = vi.fn(() => ({
      listening: true,
      port: 17_373,
      paired: true,
      connected: true,
      tabContext: currentContext,
    }))
    const request = vi
      .fn()
      .mockRejectedValueOnce(new BridgeError("CONFIRMATION_REQUIRED", "This click submits a form"))
      .mockResolvedValueOnce({ clicked: true })
    const tools = captureTools({ getStatus, request })
    const tool = findTool(tools, "browser_click")
    const confirm = vi.fn(async () => {
      currentContext = changedContext
      return true
    })
    const ctx = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext

    await tool.execute("call", { selector: "#submit" }, undefined, undefined, ctx)

    expect(confirm).toHaveBeenCalledOnce()
    expect(request).toHaveBeenNthCalledWith(
      1,
      "page.click",
      { selector: "#submit" },
      { signal: undefined, tabContext: originalContext },
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      "page.click",
      { selector: "#submit" },
      { confirmed: true, signal: undefined, tabContext: originalContext },
    )
  })

  test("routes WebMCP through one stable tool and confirms calls", async () => {
    const tabContext = { tabId: 9, url: "https://example.test/tools", epoch: 1 }
    const request = vi
      .fn()
      .mockRejectedValueOnce(new BridgeError("CONFIRMATION_REQUIRED", "Page tool may mutate state"))
      .mockResolvedValueOnce({ content: "done" })
    const tools = captureTools({
      getStatus: vi.fn(() => ({
        listening: true,
        port: 17_373,
        paired: true,
        connected: true,
        tabContext,
      })),
      request,
    })
    const tool = findTool(tools, "browser_webmcp")
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(true) },
    } as unknown as ExtensionContext

    await tool.execute(
      "call",
      { action: "call", name: "add-todo", arguments: { text: "Ship" } },
      undefined,
      undefined,
      ctx,
    )

    expect(request).toHaveBeenLastCalledWith(
      "webmcp.callTool",
      { name: "add-todo", arguments: { text: "Ship" } },
      { confirmed: true, signal: undefined, tabContext },
    )
  })

  test("rejects missing names and non-object WebMCP arguments", async () => {
    const request = vi.fn()
    const tools = captureTools({ getStatus: vi.fn(), request })
    const tool = findTool(tools, "browser_webmcp")
    const ctx = {} as ExtensionContext

    await expect(
      tool.execute("call", { action: "call", name: "   " }, undefined, undefined, ctx),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(
      tool.execute(
        "call",
        { action: "call", name: "add-todo", arguments: [] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(request).not.toHaveBeenCalled()
  })

  test("does not execute a sensitive mutation when confirmation is declined", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new BridgeError("CONFIRMATION_REQUIRED", "This click submits a form"))
    const tools = captureTools({
      getStatus: vi.fn(() => ({
        listening: true,
        port: 17_373,
        paired: true,
        connected: true,
        tabContext: { tabId: 7, url: "https://example.test/form", epoch: 3 },
      })),
      request,
    })
    const tool = findTool(tools, "browser_click")
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(false) },
    } as unknown as ExtensionContext

    await expect(
      tool.execute("call", { selector: "#submit" }, undefined, undefined, ctx),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    expect(request).toHaveBeenCalledOnce()
  })
})
