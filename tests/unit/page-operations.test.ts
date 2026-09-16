// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest"
import { executePageOperation } from "../../src/browser/content/page-operations.js"
import { executeWebMcpOperation } from "../../src/browser/webmcp/adapter.js"

function makeVisible(element: HTMLElement): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom: 10,
    height: 10,
    left: 0,
    right: 10,
    top: 0,
    width: 10,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
}

describe("page operations", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: undefined,
      writable: true,
    })
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: undefined,
      writable: true,
    })
  })

  test("reads visible text without collecting input values", async () => {
    document.body.innerHTML = '<main>Hello browser</main><input value="private value">'
    Object.defineProperty(document.body, "innerText", {
      configurable: true,
      value: "Hello browser",
    })

    const result = await executePageOperation("getVisibleText", {}, false)
    expect(result).toMatchObject({ ok: true, result: { text: "Hello browser" } })
    expect(JSON.stringify(result)).not.toContain("private value")
  })

  test("requires confirmation before submit controls", async () => {
    document.body.innerHTML = '<form><button id="submit">Submit</button></form>'
    const button = document.querySelector<HTMLButtonElement>("#submit") as HTMLButtonElement
    makeVisible(button)
    const click = vi.spyOn(button, "click").mockImplementation(() => undefined)

    const blocked = await executePageOperation("click", { selector: "#submit" }, false)
    expect(blocked).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(click).not.toHaveBeenCalled()

    const allowed = await executePageOperation("click", { selector: "#submit" }, true)
    expect(allowed).toMatchObject({ ok: true })
    expect(click).toHaveBeenCalledOnce()
  })

  test("requires confirmation before cross-origin or download links", async () => {
    document.body.innerHTML = '<a id="external" href="https://example.test/file" download>File</a>'
    const link = document.querySelector<HTMLAnchorElement>("#external") as HTMLAnchorElement
    makeVisible(link)
    const click = vi.spyOn(link, "click").mockImplementation(() => undefined)

    const blocked = await executePageOperation("click", { selector: "#external" }, false)
    expect(blocked).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(click).not.toHaveBeenCalled()
  })

  test("detects submit controls when the selector targets a nested element", async () => {
    document.body.innerHTML =
      '<form><button id="submit"><span id="label">Submit</span></button></form>'
    const label = document.querySelector<HTMLElement>("#label") as HTMLElement
    makeVisible(label)
    const button = document.querySelector<HTMLButtonElement>("#submit") as HTMLButtonElement
    const click = vi.spyOn(label, "click").mockImplementation(() => undefined)
    vi.spyOn(button, "click").mockImplementation(() => undefined)

    const blocked = await executePageOperation("click", { selector: "#label" }, false)
    expect(blocked).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(click).not.toHaveBeenCalled()
  })

  test("never types into password, file, or hidden inputs", async () => {
    document.body.innerHTML =
      '<input id="password" type="password"><input id="file" type="file"><input id="hidden" type="hidden">'

    await expect(
      executePageOperation("type", { selector: "#password", text: "secret" }, false),
    ).resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    await expect(
      executePageOperation("type", { selector: "#file", text: "path" }, false),
    ).resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    await expect(
      executePageOperation("type", { selector: "#hidden", text: "secret" }, false),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
  })

  test("types into ordinary text inputs and dispatches input", async () => {
    document.body.innerHTML = '<input id="title" type="text">'
    const input = document.querySelector<HTMLInputElement>("#title") as HTMLInputElement
    makeVisible(input)
    const listener = vi.fn()
    input.addEventListener("input", listener)

    const result = await executePageOperation(
      "type",
      { selector: "#title", text: "new title" },
      false,
    )
    expect(result).toMatchObject({ ok: true })
    expect(input.value).toBe("new title")
    expect(listener).toHaveBeenCalledOnce()
  })

  test("feature-detects WebMCP and keeps the DOM fallback available", async () => {
    await expect(executeWebMcpOperation("webmcp.listTools", {}, false)).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })

    const executeTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] })
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        getTools: async () => [
          { name: "add-todo", description: "Add one todo", inputSchema: { type: "object" } },
        ],
        executeTool,
      },
    })

    await expect(executeWebMcpOperation("webmcp.listTools", {}, false)).resolves.toMatchObject({
      ok: true,
      result: [{ name: "add-todo" }],
    })
    await expect(
      executeWebMcpOperation(
        "webmcp.callTool",
        { name: "add-todo", arguments: { text: "Ship bridge" } },
        false,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    await expect(
      executeWebMcpOperation(
        "webmcp.callTool",
        { name: "add-todo", arguments: { text: "Ship bridge" } },
        true,
      ),
    ).resolves.toMatchObject({ ok: true })
    expect(executeTool).toHaveBeenCalledOnce()
  })

  test("lists the current WebMCP registry after toolchange without caching", async () => {
    let tools = [{ name: "first", description: "First tool", inputSchema: {} }]
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        getTools: async () => tools,
      },
    })

    await expect(executeWebMcpOperation("webmcp.listTools", {}, false)).resolves.toMatchObject({
      result: [{ name: "first" }],
    })
    tools = [{ name: "second", description: "Second tool", inputSchema: {} }]
    document.dispatchEvent(new Event("toolchange"))
    await expect(executeWebMcpOperation("webmcp.listTools", {}, false)).resolves.toMatchObject({
      result: [{ name: "second" }],
    })
  })

  test("supports the legacy navigator.modelContext shape", async () => {
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { getTools: async () => [{ name: "legacy", inputSchema: {} }] },
    })

    await expect(executeWebMcpOperation("webmcp.listTools", {}, false)).resolves.toMatchObject({
      result: [{ name: "legacy" }],
    })
  })
})
