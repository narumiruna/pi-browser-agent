// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executeElementPicker,
  stopElementPickerInjection,
} from "../../src/browser/content/element-picker.js"
import { ELEMENT_PICKER_LIMITS } from "../../src/browser/runtime/element-context.js"
import type { TabContext } from "../../src/browser/runtime/types.js"

const context: TabContext = { tabId: 1, url: location.href, epoch: 0 }
const rectangle = {
  x: 20,
  y: 30,
  top: 30,
  right: 220,
  bottom: 130,
  left: 20,
  width: 200,
  height: 100,
  toJSON: () => ({}),
} as DOMRect
let hit: Element | null
let sent: Record<string, unknown>[]

function pickerHost(): HTMLElement | null {
  return document.querySelector("[data-pi-browser-agent-element-picker]")
}

beforeEach(() => {
  document.body.innerHTML = ""
  hit = null
  sent = []
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => hit,
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rectangle)
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    rectangle,
  ] as unknown as DOMRectList)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        sent.push(message)
        return { ok: true }
      }),
    },
  })
})

afterEach(() => {
  executeElementPicker("stop", "", context, ELEMENT_PICKER_LIMITS)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("injected element picker", () => {
  test("ignores synthetic page activation without triggering the underlying element", async () => {
    document.body.innerHTML = '<button id="destination">Visible target</button>'
    const target = document.querySelector("#destination") as HTMLButtonElement
    hit = target
    const clicked = vi.fn()
    target.addEventListener("click", clicked)

    expect(executeElementPicker("start", "picker-token", context, ELEMENT_PICKER_LIMITS)).toEqual({
      ok: true,
      result: { started: true },
    })
    const host = pickerHost()
    expect(host).not.toBeNull()
    host?.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, clientY: 60, bubbles: true }))
    const synthetic = new MouseEvent("click", {
      clientX: 50,
      clientY: 60,
      bubbles: true,
      cancelable: true,
    })
    host?.dispatchEvent(synthetic)
    await Promise.resolve()

    expect(synthetic.isTrusted).toBe(false)
    expect(synthetic.defaultPrevented).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
    expect(pickerHost()).toBe(host)
    expect(sent).toHaveLength(0)
  })

  test("ignores page-generated cleanup signals", () => {
    executeElementPicker("start", "protected", context, ELEMENT_PICKER_LIMITS)
    const host = pickerHost()

    window.dispatchEvent(new Event("__piBrowserAgentStopElementPicker"))

    expect(host?.isConnected).toBe(true)
    expect(
      (globalThis as typeof globalThis & { __piBrowserAgentElementPicker?: unknown })
        .__piBrowserAgentElementPicker,
    ).toBeDefined()
  })

  test("preserves page-owned nodes that use the overlay marker", () => {
    const pageOwned = document.createElement("div")
    pageOwned.dataset.piBrowserAgentElementPicker = ""
    document.body.append(pageOwned)

    executeElementPicker("start", "owned-node", context, ELEMENT_PICKER_LIMITS)
    const extensionHost = Array.from(
      document.querySelectorAll("[data-pi-browser-agent-element-picker]"),
    ).find((node) => node !== pageOwned)
    expect(pageOwned.isConnected).toBe(true)
    expect(extensionHost).toBeDefined()

    stopElementPickerInjection()

    expect(pageOwned.isConnected).toBe(true)
    expect(extensionHost?.isConnected).toBe(false)
  })

  test("replaces and stops picker state without leaving listeners or overlays", async () => {
    const disconnected = vi.spyOn(MutationObserver.prototype, "disconnect")
    executeElementPicker("start", "first", context, ELEMENT_PICKER_LIMITS)
    const first = pickerHost()
    executeElementPicker("start", "second", context, ELEMENT_PICKER_LIMITS)
    expect(first?.isConnected).toBe(false)
    expect(document.querySelectorAll("[data-pi-browser-agent-element-picker]")).toHaveLength(1)

    executeElementPicker("stop", "", context, ELEMENT_PICKER_LIMITS)
    expect(pickerHost()).toBeNull()
    expect(disconnected).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await Promise.resolve()
    expect(sent).toHaveLength(0)
  })

  test("cancels on Escape and removes its overlay once", async () => {
    executeElementPicker("start", "escape", context, ELEMENT_PICKER_LIMITS)
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true })
    window.dispatchEvent(event)
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(pickerHost()).toBeNull()
    expect(sent).toMatchObject([{ status: "cancelled", reason: "escape" }])
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(sent).toHaveLength(1)
  })

  test("updates the isolated highlight target after dynamic hit-test changes", async () => {
    document.body.innerHTML = "<button>First</button><div>Second</div>"
    const first = document.querySelector("button") as HTMLElement
    const second = document.querySelector("div") as HTMLElement
    hit = first
    executeElementPicker("start", "dynamic", context, ELEMENT_PICKER_LIMITS)
    const host = pickerHost()
    host?.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, clientY: 60 }))
    const isolated = globalThis as typeof globalThis & {
      __piBrowserAgentElementPicker?: { currentTag: string }
    }
    expect(isolated.__piBrowserAgentElementPicker?.currentTag).toBe("button")
    hit = second
    first.setAttribute("data-updated", "true")
    await Promise.resolve()
    expect(isolated.__piBrowserAgentElementPicker?.currentTag).toBe("div")
  })

  test("expires through the same one-shot cleanup path", async () => {
    vi.useFakeTimers()
    try {
      executeElementPicker("start", "expiry", context, ELEMENT_PICKER_LIMITS)
      vi.advanceTimersByTime(ELEMENT_PICKER_LIMITS.lifetimeMs)
      await Promise.resolve()
      expect(pickerHost()).toBeNull()
      expect(sent).toMatchObject([{ status: "cancelled", reason: "timeout" }])
    } finally {
      vi.useRealTimers()
    }
  })
})
