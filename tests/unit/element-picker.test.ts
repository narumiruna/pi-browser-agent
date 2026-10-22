// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executeElementPicker,
  stopElementPickerInjection,
} from "../../src/browser/content/element-picker.js"
import { ELEMENT_PICKER_LIMITS } from "../../src/browser/runtime/element-context.js"
import type { TabContext } from "../../src/browser/runtime/types.js"
import { mockElementPickerSurface } from "../helpers/element-picker-surface.js"

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
let restoreSurface: () => void

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
  restoreSurface = mockElementPickerSurface()
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function bounds(
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-pi-browser-agent-element-picker")) {
      return {
        x: 0,
        y: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
        toJSON: () => ({}),
      } as DOMRect
    }
    return rectangle
  })
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
  restoreSurface()
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

    expect(
      await executeElementPicker("start", "picker-token", context, ELEMENT_PICKER_LIMITS),
    ).toEqual({
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

  test.each([
    ["pointer-events", "none"],
    ["background-color", "transparent"],
    ["opacity", "0.001"],
    ["filter", "opacity(0)"],
    ["mask-image", "linear-gradient(transparent, transparent)"],
  ])("cancels when the page tampers with shield %s", async (property, value) => {
    executeElementPicker("start", "tampered", context, ELEMENT_PICKER_LIMITS)
    const host = pickerHost()
    if (!host) throw new Error("Missing picker host")
    host.style.setProperty(property, value, "important")

    await vi.waitFor(() => {
      expect(sent).toMatchObject([{ status: "cancelled", reason: "overlay-tampered" }])
    })
    expect(host.isConnected).toBe(false)
  })

  test("cancels when the page detaches the extension overlay", async () => {
    executeElementPicker("start", "detached", context, ELEMENT_PICKER_LIMITS)
    pickerHost()?.remove()

    await vi.waitFor(() => {
      expect(sent).toMatchObject([{ status: "cancelled", reason: "overlay-detached" }])
    })
    expect(
      (globalThis as typeof globalThis & { __piBrowserAgentElementPicker?: unknown })
        .__piBrowserAgentElementPicker,
    ).toBeUndefined()
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

  test("blocks non-Escape keyboard interaction while active", () => {
    const input = document.createElement("input")
    document.body.append(input)
    const received = vi.fn()
    input.addEventListener("keydown", received)
    executeElementPicker("start", "keyboard", context, ELEMENT_PICKER_LIMITS)
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })

    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(received).not.toHaveBeenCalled()
    expect(pickerHost()).not.toBeNull()
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

  test.each(["legacy", "current"] as const)(
    "normalizes %s CSS-zoom rectangles without changing page styles",
    async (mode) => {
      const previous = document.documentElement.style.zoom
      document.documentElement.style.zoom = "0.9"
      const computed = window.getComputedStyle.bind(window)
      vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
        const style = computed(element, pseudo)
        return new Proxy(style, {
          get(target, property) {
            if (
              property === "width" &&
              element.hasAttribute("data-pi-browser-agent-element-picker")
            )
              return `${window.innerWidth + 1}px`
            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        })
      })
      const attach = Element.prototype.attachShadow
      let shadow: ShadowRoot | undefined
      vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
        this: Element,
        options,
      ) {
        const root = attach.call(this, options)
        shadow = root
        return root
      })
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.hasAttribute("data-pi-browser-agent-element-picker")) {
          const scale = mode === "legacy" ? 1 : Number.parseFloat(this.style.zoom) * 0.9
          return new DOMRect(
            0,
            0,
            (window.innerWidth + 1) * scale,
            (window.innerHeight + 1) * scale,
          )
        }
        return mode === "legacy" ? rectangle : new DOMRect(18, 27, 180, 90)
      })
      const target = document.createElement("button")
      document.body.append(target)
      hit = target
      try {
        expect(await executeElementPicker("start", "zoom", context, ELEMENT_PICKER_LIMITS)).toEqual(
          { ok: true, result: { started: true } },
        )
        pickerHost()?.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, clientY: 60 }))
        const highlight = shadow?.querySelector<HTMLElement>("#highlight")
        expect(Number.parseFloat(highlight?.style.left ?? "")).toBeCloseTo(18)
        expect(Number.parseFloat(highlight?.style.top ?? "")).toBeCloseTo(27)
        expect(Number.parseFloat(highlight?.style.width ?? "")).toBeCloseTo(180)
        expect(Number.parseFloat(highlight?.style.height ?? "")).toBeCloseTo(90)
        expect(document.documentElement.style.zoom).toBe("0.9")
      } finally {
        stopElementPickerInjection()
        document.documentElement.style.zoom = previous
      }
    },
  )

  test.each(["missing API", "failed geometry"] as const)(
    "rejects unsafe startup with %s without leaving a surface",
    async (failure) => {
      if (failure === "missing API") Reflect.deleteProperty(HTMLElement.prototype, "showPopover")
      else vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rectangle)
      expect(await executeElementPicker("start", "unsafe", context, ELEMENT_PICKER_LIMITS)).toEqual(
        {
          ok: true,
          result: { started: false, reason: "overlay-unavailable" },
        },
      )
      expect(pickerHost()).toBeNull()
      expect(sent).toHaveLength(0)
    },
  )

  test("stop releases startup even when no compositor frame arrives", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    )
    const start = executeElementPicker("start", "pending-paint", context, ELEMENT_PICKER_LIMITS)
    expect(pickerHost()).not.toBeNull()
    stopElementPickerInjection()
    expect(await start).toEqual({ ok: true, result: { started: false, reason: "cancelled" } })
    expect(pickerHost()).toBeNull()
    expect(sent).toHaveLength(0)
  })

  test("waits for an early result acknowledgment before resolving startup", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    )
    let acknowledge: () => void = () => undefined
    const acknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => acknowledgment)
    const start = executeElementPicker("start", "early-result", context, ELEMENT_PICKER_LIMITS)
    let settled = false
    void start.then(() => {
      settled = true
    })
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await Promise.resolve()
    await Promise.resolve()
    expect(pickerHost()).toBeNull()
    expect(settled).toBe(false)
    acknowledge()
    expect(await start).toEqual({ ok: true, result: { started: false, reason: "cancelled" } })
  })

  test("waits for acknowledgment of a failure found only after the last paint frame", async () => {
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return callbacks.length
    })
    const computed = window.getComputedStyle.bind(window)
    let protectionLost = false
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo)
      return new Proxy(style, {
        get(target, property) {
          if (
            protectionLost &&
            property === "backgroundColor" &&
            element.hasAttribute("data-pi-browser-agent-element-picker")
          )
            return "transparent"
          const value = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    })
    let acknowledge: () => void = () => undefined
    const acknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => acknowledgment)
    const start = executeElementPicker("start", "post-paint-loss", context, ELEMENT_PICKER_LIMITS)
    let settled = false
    void start.then(() => {
      settled = true
    })
    expect(callbacks).toHaveLength(1)
    callbacks[0]?.(0)
    expect(callbacks).toHaveLength(2)
    protectionLost = true
    callbacks[1]?.(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(pickerHost()).toBeNull()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", reason: "overlay-tampered" }),
    )
    expect(settled).toBe(false)
    acknowledge()
    expect(await start).toEqual({ ok: true, result: { started: false, reason: "cancelled" } })
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
