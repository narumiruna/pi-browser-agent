// @vitest-environment jsdom
import { Value } from "typebox/value"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createBrowserTools } from "../../src/browser/agent/browser-tools.js"
import {
  executePageOperation,
  type PageOperation,
} from "../../src/browser/content/page-operations.js"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  ELEMENT_LIMITS,
  type ElementSnapshot,
  type JsonObject,
} from "../../src/browser/runtime/types.js"

const context = { tabId: 1, url: location.href, epoch: 0 }
const reference = { snapshotId: "11111111-1111-4111-8111-111111111111", ref: "e1" }
let snapshot: ElementSnapshot

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`Missing fixture element: ${selector}`)
  return found
}
function browserTool(name: string, pageEnabled = () => true) {
  const tool = createBrowserTools(vi.fn(), pageEnabled).find((tool) => tool.name === name)
  if (!tool) throw new Error(`Missing tool: ${name}`)
  return tool
}

function run(operation: PageOperation, params: JsonObject, confirmed = false) {
  return executePageOperation(operation, params, confirmed, null, context, snapshot)
}
async function discover() {
  snapshot = {
    id: crypto.randomUUID(),
    context,
    expiresAt: Date.now() + ELEMENT_LIMITS.lifetimeMs,
    limits: ELEMENT_LIMITS,
  }
  const result = await run("listElements", {})
  if (!result.ok) throw new Error(result.error.message)
  return result.result as {
    snapshotId: string
    elements: Array<{ ref: string; name: string; actions: string[] }>
  }
}
function target(ref = "e1") {
  return { snapshotId: snapshot.id, ref }
}
function scrollBox(element: HTMLElement, height = 100, content = 500) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: content },
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 100 },
    scrollTo: {
      configurable: true,
      value: vi.fn((options: ScrollToOptions) => {
        element.scrollTop = Math.max(0, Math.min(content - height, options.top ?? 0))
      }),
    },
  })
  return element
}

beforeEach(() => {
  document.body.innerHTML = ""
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: undefined })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 20,
    bottom: 20,
    width: 20,
    height: 20,
  } as DOMRect)
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ok: true })) } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("interaction input schemas and worker validation", () => {
  const scroll = { direction: "down", amount: "page" }
  test.each([
    [
      "browser_scroll",
      "page.scroll",
      [
        scroll,
        { ...scroll, ...reference },
        { direction: "up", amount: "half-page" },
        { direction: "down", amount: "pixels", pixels: 1 },
        { direction: "down", amount: "pixels", pixels: 10_000 },
      ],
      [
        {},
        { ...scroll, direction: "left" },
        { ...scroll, direction: ["up"] },
        { ...scroll, amount: ["page"] },
        { ...scroll, amount: "all" },
        { ...scroll, pixels: 1 },
        { ...scroll, ref: "e1" },
        { ...scroll, snapshotId: reference.snapshotId },
        { ...scroll, selector: "div" },
        { ...scroll, ...reference, extra: true },
        ...[0, -1, 10_001, 0.5, "2", Infinity].map((pixels) => ({
          direction: "down",
          amount: "pixels",
          pixels,
        })),
        { direction: "down", amount: "pixels" },
      ],
    ],
    [
      "browser_select_option",
      "page.selectOption",
      [
        { ...reference, value: "" },
        { ...reference, value: "x".repeat(256) },
        { ...reference, label: "Blue" },
      ],
      [
        reference,
        { ...reference, value: "x", label: "Blue" },
        { selector: "select", value: "x" },
        { ...reference, value: "x".repeat(257) },
        { ...reference, label: 1 },
      ],
    ],
    [
      "browser_get_element_details",
      "page.getElementDetails",
      [reference],
      [
        {},
        { ...reference, selector: "input" },
        { ...reference, ref: "e0" },
        { ...reference, ref: "e12345678" },
        { ...reference, snapshotId: "invalid" },
        { ...reference, extra: true },
      ],
    ],
  ])("keeps %s schema and parser aligned", (name, method, valid, invalid) => {
    const tool = browserTool(name)
    for (const params of valid) {
      expect(Value.Check(tool.parameters, params)).toBe(true)
      expect(() =>
        parseRuntimeRequest({ kind: "request", requestId: "1", method, params }),
      ).not.toThrow()
    }
    for (const params of invalid) {
      expect(Value.Check(tool.parameters, params)).toBe(false)
      expect(() =>
        parseRuntimeRequest({ kind: "request", requestId: "1", method, params }),
      ).toThrow("Malformed")
    }
    expect(tool.executionMode).toBe("sequential")
    expect(tool.replay).toBe(name === "browser_get_element_details" ? "safe" : "never")
  })

  test.each(["browser_scroll", "browser_select_option", "browser_get_element_details"])(
    "blocks %s in no-page turns",
    async (name) => {
      const tool = browserTool(name, () => false)
      await expect(tool.execute("1", reference, undefined)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      })
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    },
  )

  test.each([false, true])(
    "select confirmation approval=%s keeps original reference/context and never caches approval",
    async (approved) => {
      const sendMessage = vi.fn(async (request: { method: string; confirmed?: boolean }) => {
        if (request.method === "app.getState") return { ok: true, result: { tabContext: context } }
        return request.confirmed
          ? { ok: true, result: { selected: true } }
          : {
              ok: false,
              error: {
                code: "CONFIRMATION_REQUIRED",
                message: "Change option?",
                details: reference,
              },
            }
      })
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const confirm = vi.fn(async () => approved)
      const tool = createBrowserTools(confirm).find((tool) => tool.name === "browser_select_option")
      if (!tool) throw new Error("Missing select tool")
      const pending = tool.execute("1", { ...reference, label: "Blue" }, undefined)
      if (approved) {
        expect((await pending).content[0]).toMatchObject({
          text: expect.stringContaining("Untrusted browser option selection"),
        })
        expect(sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            method: "page.selectOption",
            params: { ...reference, label: "Blue" },
            tabContext: context,
            confirmed: true,
          }),
        )
      } else await expect(pending).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
      expect(confirm).toHaveBeenCalledExactlyOnceWith("Change option?", reference, undefined)
      expect(sendMessage).toHaveBeenCalledTimes(approved ? 3 : 2)
    },
  )
})

describe("bounded page interactions", () => {
  test("scrolls the viewport with actual signed distance and top/bottom boundaries", async () => {
    const root = scrollBox(document.documentElement, window.innerHeight, window.innerHeight + 1000)
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: root })
    root.scrollTop = 0
    await discover()
    expect(await run("scroll", { direction: "up", amount: "page" })).toMatchObject({
      ok: true,
      result: { distance: 0, atTop: true, atBottom: false, snapshotInvalidated: true },
    })
    expect(await run("scroll", { direction: "down", amount: "half-page" })).toMatchObject({
      ok: true,
      result: {
        distance: window.innerHeight / 2,
        position: window.innerHeight / 2,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        url: location.href,
      },
    })
    const remaining = 1000 - root.scrollTop
    expect(
      await run("scroll", { direction: "down", amount: "pixels", pixels: 10000 }),
    ).toMatchObject({
      ok: true,
      result: { distance: remaining, atBottom: true, maxPosition: 1000 },
    })
    expect(await run("scroll", { direction: "down", amount: "page" })).toMatchObject({
      ok: true,
      result: { distance: 0, atBottom: true },
    })
    expect(await run("scroll", { direction: "up", amount: "pixels", pixels: 10000 })).toMatchObject(
      { ok: true, result: { distance: -1000, atTop: true } },
    )
    expect(root.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "instant" }))
  })

  test("reports both boundaries for a viewport without overflow", async () => {
    const root = scrollBox(document.documentElement, window.innerHeight, window.innerHeight)
    root.scrollTop = 0
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: root })
    await discover()
    expect(await run("scroll", { direction: "down", amount: "page" })).toMatchObject({
      ok: true,
      result: { distance: 0, atTop: true, atBottom: true, maxPosition: 0 },
    })
  })

  test("discovers only supported visible scroll containers and invalidates nested refs at boundaries", async () => {
    document.body.innerHTML =
      '<div id="outer" aria-label="Outer" style="overflow-y:auto"><div id="inner" aria-label="Inner" style="overflow-y:scroll"></div></div><div id="hidden" style="overflow:auto;display:none"></div><div id="not-scrollable" style="overflow:hidden"></div>'
    const outer = scrollBox(element("#outer"))
    const inner = scrollBox(element("#inner"))
    scrollBox(element("#hidden"))
    scrollBox(element("#not-scrollable"))
    const found = await discover()
    expect(found.elements.map((element) => [element.name, element.actions])).toEqual([
      ["Outer", ["scroll"]],
      ["Inner", ["scroll"]],
    ])
    const ref = target("e2")
    expect(await run("scroll", { ...ref, direction: "up", amount: "page" })).toMatchObject({
      ok: true,
      result: { distance: 0, atTop: true },
    })
    expect(await run("getElementDetails", ref)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
    await discover()
    expect(
      await run("scroll", { ...target("e2"), direction: "down", amount: "page" }),
    ).toMatchObject({ ok: true, result: { distance: 100 } })
    expect(inner.scrollTop).toBe(100)
    expect(outer.scrollTop).toBe(0)
  })

  test("rejects non-scroll targets, invalid amounts, and replaced refs without fallback", async () => {
    document.body.innerHTML = '<button type="button" aria-label="Button"></button>'
    await discover()
    expect(await run("scroll", { ...target(), direction: "down", amount: "page" })).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    })
    expect(
      await run("scroll", { direction: "down", amount: "pixels", pixels: 10001 }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    element("button").replaceWith(document.createElement("button"))
    expect(await run("getElementDetails", target())).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test("returns bounded names, native roles, geometry/state and scrollability but never field values", async () => {
    document.body.innerHTML =
      '<input type="checkbox" checked required aria-label="Accept"><input aria-label="Title" value="private-text"><input type="password" value="secret"><textarea aria-label="Notes">private-notes</textarea>'
    expect((await discover()).elements.map((element) => element.name)).toEqual([
      "Accept",
      "Title",
      "Notes",
    ])
    const details = await run("getElementDetails", target())
    expect(details).toMatchObject({
      ok: true,
      result: {
        name: "Accept",
        role: "checkbox",
        visible: true,
        rect: { width: 20, height: 20 },
        state: { checked: true, required: true, disabled: false, expanded: null },
        scrollability: { vertical: false },
      },
    })
    for (const ref of ["e1", "e2", "e3"])
      expect(JSON.stringify(await run("getElementDetails", target(ref)))).not.toMatch(
        /private-|secret|value/,
      )
  })

  test("selects by label with native index setter even for duplicate values; confirms before events and expires refs", async () => {
    document.body.innerHTML =
      '<select aria-label="Color"><option value="same">Red</option><option value="same">Blue</option></select>'
    const select = element<HTMLSelectElement>("select")
    const events: string[] = []
    select.addEventListener("input", () => events.push("input"))
    select.addEventListener("change", () => events.push("change"))
    const getIndex = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "selectedIndex",
    )?.get
    if (!getIndex) throw new Error("Missing native selectedIndex getter")
    Object.defineProperty(select, "selectedIndex", {
      get: () => getIndex.call(select),
      set: () => {
        throw new Error("page setter must not run")
      },
      configurable: true,
    })
    // Inspect native selected state below through options; the instance setter must be bypassed.
    await discover()
    const ref = target()
    expect(await run("selectOption", { ...ref, label: "Blue" })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    expect(events).toEqual([])
    expect(select.options[0]?.selected).toBe(true)
    expect(await run("selectOption", { ...ref, value: "same" }, true)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    expect(await run("selectOption", { ...ref, label: "Blue" }, true)).toMatchObject({
      ok: true,
      result: { selected: true, snapshotInvalidated: true },
    })
    expect(select.options[1]?.selected).toBe(true)
    expect(events).toEqual(["input", "change"])
    expect(await run("getElementDetails", ref)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })

  test.each([
    [
      '<select aria-label="Color" multiple><option value="b">Blue</option></select>',
      "NOT_SUPPORTED",
    ],
    ['<button aria-label="Color"></button>', "NOT_SUPPORTED"],
    [
      '<select aria-label="Color" disabled><option value="b">Blue</option></select>',
      "PERMISSION_DENIED",
    ],
    [
      '<select aria-label="Color"><option value="b" disabled>Blue</option></select>',
      "PERMISSION_DENIED",
    ],
    [
      '<select aria-label="Color"><optgroup disabled label="Group"><option value="b">Blue</option></optgroup></select>',
      "PERMISSION_DENIED",
    ],
    ['<select aria-label="Color"><option value="a">Red</option></select>', "INVALID_REQUEST"],
    [
      '<select aria-label="Color"><option value="b">Blue</option><option value="c">Blue</option></select>',
      "INVALID_REQUEST",
    ],
  ])("rejects unsupported or ambiguous native select changes %#", async (html, code) => {
    document.body.innerHTML = html
    await discover()
    expect(await run("selectOption", { ...target(), label: "Blue" }, true)).toMatchObject({
      ok: false,
      error: { code },
    })
  })

  test.each(["scroll", "selectOption", "getElementDetails"] as const)(
    "%s rejects expired and superseded references",
    async (operation) => {
      document.body.innerHTML =
        operation === "scroll"
          ? '<div aria-label="Container" style="overflow-y:auto"></div>'
          : '<select aria-label="Choice"><option value="b">Blue</option></select>'
      if (operation === "scroll") scrollBox(element("div"))
      await discover()
      const old = target()
      const params: JsonObject =
        operation === "scroll"
          ? { ...old, direction: "down", amount: "page" }
          : operation === "selectOption"
            ? { ...old, value: "b" }
            : old
      snapshot.expiresAt = Date.now() - 1
      expect(await run(operation, params, true)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
      await discover()
      expect(await run(operation, params, true)).toMatchObject({
        ok: false,
        error: { code: "STALE_CONTEXT" },
      })
    },
  )

  test("option metadata changes invalidate a pending confirmed selection", async () => {
    document.body.innerHTML = '<select aria-label="Color"><option value="b">Blue</option></select>'
    await discover()
    expect(await run("selectOption", { ...target(), value: "b" })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    element<HTMLOptionElement>("option").label = "Changed"
    expect(await run("selectOption", { ...target(), value: "b" }, true)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT" },
    })
  })
})
