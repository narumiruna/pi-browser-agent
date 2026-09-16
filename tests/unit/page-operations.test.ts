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
    Object.defineProperty(document, "elementFromPoint", {
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

  test("requires confirmation for a label associated with a submit control", async () => {
    document.body.innerHTML =
      '<form><button id="submit" type="submit">Submit</button><label id="label" for="submit">Go</label></form>'
    const label = document.querySelector<HTMLLabelElement>("#label") as HTMLLabelElement
    makeVisible(label)
    const click = vi.spyOn(label, "click").mockImplementation(() => undefined)

    const blocked = await executePageOperation("click", { selector: "#label" }, false)

    expect(blocked).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(click).not.toHaveBeenCalled()
  })

  test("rejects elements hidden by ancestors, outside the viewport, or covered", async () => {
    document.body.innerHTML =
      '<div id="hidden" style="opacity: 0"><button id="inside">Inside</button></div><button id="outside">Outside</button><button id="covered">Covered</button><div id="overlay"></div>'
    const inside = document.querySelector<HTMLButtonElement>("#inside") as HTMLButtonElement
    const outside = document.querySelector<HTMLButtonElement>("#outside") as HTMLButtonElement
    const covered = document.querySelector<HTMLButtonElement>("#covered") as HTMLButtonElement
    const overlay = document.querySelector<HTMLDivElement>("#overlay") as HTMLDivElement
    makeVisible(inside)
    vi.spyOn(outside, "getBoundingClientRect").mockReturnValue({
      bottom: -10,
      height: 10,
      left: 0,
      right: 10,
      top: -20,
      width: 10,
      x: 0,
      y: -20,
      toJSON: () => ({}),
    })
    makeVisible(covered)

    await expect(
      executePageOperation("click", { selector: "#inside" }, false),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    await expect(
      executePageOperation("click", { selector: "#outside" }, false),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => overlay),
    })
    await expect(
      executePageOperation("click", { selector: "#covered" }, false),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
  })

  test("accepts a selected child when hit testing finds its clickable ancestor", async () => {
    document.body.innerHTML =
      '<button id="button" type="button"><span id="label">Go</span></button>'
    const button = document.querySelector<HTMLButtonElement>("#button") as HTMLButtonElement
    const label = document.querySelector<HTMLSpanElement>("#label") as HTMLSpanElement
    makeVisible(label)
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => button),
    })
    const click = vi.fn()
    button.addEventListener("click", click)

    await expect(
      executePageOperation("click", { selector: "#label" }, false),
    ).resolves.toMatchObject({ ok: true })
    expect(click).toHaveBeenCalledOnce()
  })

  test("accepts an element when its center is covered but another point is clickable", async () => {
    document.body.innerHTML =
      '<button id="target" type="button">Go</button><div id="overlay"></div>'
    const target = document.querySelector<HTMLButtonElement>("#target") as HTMLButtonElement
    const overlay = document.querySelector<HTMLDivElement>("#overlay") as HTMLDivElement
    makeVisible(target)
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn((x: number, y: number) => (x === 5 && y === 5 ? overlay : target)),
    })
    const click = vi.spyOn(target, "click").mockImplementation(() => undefined)

    await expect(
      executePageOperation("click", { selector: "#target" }, false),
    ).resolves.toMatchObject({ ok: true })
    expect(click).toHaveBeenCalledOnce()
  })

  test("checks each visible client rectangle for wrapped elements", async () => {
    document.body.innerHTML = '<span id="target">Wrapped target</span><div id="overlay"></div>'
    const target = document.querySelector<HTMLSpanElement>("#target") as HTMLSpanElement
    const overlay = document.querySelector<HTMLDivElement>("#overlay") as HTMLDivElement
    const rect = (left: number, right: number): DOMRect => ({
      bottom: 10,
      height: 10,
      left,
      right,
      top: 0,
      width: right - left,
      x: left,
      y: 0,
      toJSON: () => ({}),
    })
    vi.spyOn(target, "getClientRects").mockReturnValue([
      rect(0, 10),
      rect(20, 30),
    ] as unknown as DOMRectList)
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn((x: number) => (x >= 20 ? target : overlay)),
    })
    const click = vi.spyOn(target, "click").mockImplementation(() => undefined)

    await expect(
      executePageOperation("click", { selector: "#target" }, false),
    ).resolves.toMatchObject({ ok: true })
    expect(click).toHaveBeenCalledOnce()
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

  test("uses the native value setter for framework-controlled inputs", async () => {
    document.body.innerHTML = '<input id="controlled" type="text">'
    const input = document.querySelector<HTMLInputElement>("#controlled") as HTMLInputElement
    makeVisible(input)
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
    if (!descriptor?.get) throw new Error("Native input value getter unavailable")
    const trackedSetter = vi.fn()
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => descriptor.get?.call(input),
      set: trackedSetter,
    })
    const listener = vi.fn()
    input.addEventListener("input", listener)

    await expect(
      executePageOperation("type", { selector: "#controlled", text: "updated" }, false),
    ).resolves.toMatchObject({ ok: true })
    expect(trackedSetter).not.toHaveBeenCalled()
    expect(input.value).toBe("updated")
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
