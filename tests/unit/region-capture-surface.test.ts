// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executeRegionCapture,
  stopRegionCaptureInjection,
} from "../../src/browser/content/region-capture.js"
import {
  REGION_CAPTURE_LIMITS,
  type RegionCaptureOperation,
  type RegionRectangle,
} from "../../src/browser/runtime/region-capture.js"
import { mockPageAnnotationSurface } from "../helpers/page-annotation-surface.js"

const context = { tabId: 1, url: location.href, epoch: 0 }
const rectangle = { x: 0, y: 0, width: 120, height: 160 }
let surface: ReturnType<typeof mockPageAnnotationSurface>
let shadow: ShadowRoot
let sent: Record<string, unknown>[]
const host = () => document.querySelector<HTMLElement>("[data-pi-browser-agent-region-capture]")
const execute = (
  action: RegionCaptureOperation,
  rect: RegionRectangle | null = null,
  token = "surface",
) => executeRegionCapture(action, token, context, rect, REGION_CAPTURE_LIMITS)
async function start(token = "surface") {
  const pending = execute("start", null, token)
  surface.advanceFrames()
  return pending
}
function drag() {
  surface.pointer("pointerdown", { clientX: 200, clientY: 200 })
  surface.pointer("pointermove", { clientX: 100, clientY: 80 })
  surface.pointer("pointerup", { clientX: 100, clientY: 80 })
}
beforeEach(() => {
  document.body.innerHTML = ""
  sent = []
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null })
  surface = mockPageAnnotationSurface()
  const attach = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
    shadow = attach.call(this, options)
    return shadow
  })
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(async (message) => {
        sent.push(message)
      }),
    },
  })
})
afterEach(() => {
  stopRegionCaptureInjection()
  surface.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("protected region selection surface", () => {
  test("permits initial scrollbar gutters and fractional visual viewport dimensions at normal scale", async () => {
    vi.stubGlobal("visualViewport", {
      width: innerWidth - 15.4,
      height: innerHeight - 15.2,
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      addEventListener: vi.fn(),
    })
    expect(await start()).toMatchObject({ result: { active: true } })
  })
  test.each([
    { scale: 2, offsetLeft: 0, offsetTop: 0 },
    { scale: 1, offsetLeft: 10, offsetTop: 0 },
    { scale: 1, offsetLeft: 0, offsetTop: 10 },
  ])(
    "rejects unsupported initial visual viewport before installing a surface: %j",
    async (geometry) => {
      vi.stubGlobal("visualViewport", {
        width: innerWidth / geometry.scale,
        height: innerHeight / geometry.scale,
        ...geometry,
      })
      expect(await execute("start")).toMatchObject({
        result: { active: false, reason: "unsupported-viewport" },
      })
      expect(host()).toBeNull()
      expect(sent).toEqual([])
    },
  )
  test("starts without selection or capture and keeps the required top-frame shield", async () => {
    expect(await start()).toMatchObject({
      result: { active: true, rectangle: null, frozen: false, dragging: false },
    })
    expect(host()?.shadowRoot).toBeNull()
    expect(document.activeElement).toBe(host())
    expect(host()?.style.backgroundColor).toBe("rgba(0, 0, 0, 0.01)")
    expect(sent).toEqual([])
  })
  test("is self-contained after Chrome serialization", async () => {
    const injected = new Function(
      `return (${executeRegionCapture.toString()})`,
    )() as typeof executeRegionCapture
    const pending = injected("start", "surface", context, null, REGION_CAPTURE_LIMITS)
    surface.advanceFrames()
    expect(await pending).toMatchObject({ result: { active: true } })
  })
  test("selects by reverse drag, allows reselection, clamps to viewport, and ignores untrusted pointers", async () => {
    await start()
    surface.pointer("pointerdown", { isTrusted: false })
    expect(surface.capture).not.toHaveBeenCalled()
    drag()
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 100, y: 80, width: 100, height: 120 }, dragging: false },
    })
    expect(surface.capture).toHaveBeenCalledWith(1)
    expect(surface.release).toHaveBeenCalledWith(1)
    surface.pointer("pointerdown", { clientX: 0, clientY: 0 })
    surface.pointer("pointerup", { clientX: 99999, clientY: 99999 })
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 0, y: 0, width: innerWidth, height: innerHeight } },
    })
    expect(sent.every((m) => m.kind === "region-capture-state" && !("dataUrl" in m))).toBe(true)
  })
  test("rejects tiny/empty drags and discards cancelled pointers", async () => {
    await start()
    surface.pointer("pointerdown")
    surface.pointer("pointerup", { clientX: 101, clientY: 121 })
    expect(await execute("state")).toMatchObject({ result: { rectangle: null } })
    surface.pointer("pointerdown")
    surface.pointer("pointercancel")
    expect(await execute("state")).toMatchObject({ result: { rectangle: null, dragging: false } })
  })
  test("updates numeric geometry without capture and rejects invalid rectangles", async () => {
    await start()
    expect(await execute("update", rectangle)).toMatchObject({ result: { rectangle, revision: 1 } })
    await execute("update", { ...rectangle, width: Infinity })
    expect(await execute("state")).toMatchObject({ result: { rectangle, revision: 1 } })
    expect(shadow.querySelector("div")?.style.left).toBe("0px")
  })
  test("freezes only a completed rectangle, hides only outline, waits two paints, resumes", async () => {
    await start()
    expect(await execute("freeze")).toMatchObject({ result: { frozen: false } })
    surface.pointer("pointerdown")
    expect(await execute("freeze")).toMatchObject({ result: { dragging: true, frozen: false } })
    surface.pointer("pointercancel")
    await execute("update", rectangle)
    let resolved = false
    const freezing = execute("freeze").then((value) => {
      resolved = true
      return value
    })
    surface.advanceFrames(1)
    await Promise.resolve()
    expect(resolved).toBe(false)
    surface.advanceFrames(1)
    expect(await freezing).toMatchObject({ result: { frozen: true, rectangle } })
    expect(shadow.querySelector("div")?.style.display).toBe("none")
    expect(host()?.style.pointerEvents).toBe("auto")
    expect(host()?.style.backgroundColor).toBe("rgba(0, 0, 0, 0.01)")
    drag()
    await execute("update", { ...rectangle, x: 50 })
    expect(await execute("state")).toMatchObject({ result: { rectangle, frozen: true } })
    await execute("resume")
    expect(shadow.querySelector("div")?.style.display).toBe("block")
  })
  test.each([
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
    "dragstart",
    "drop",
    "wheel",
    "touchstart",
    "touchmove",
    "touchend",
    "keydown",
    "keypress",
    "keyup",
  ])("intercepts %s activation", async (name) => {
    await start()
    const activated = vi.fn()
    const button = document.createElement("button")
    button.addEventListener(name, activated)
    document.body.append(button)
    const event = new Event(name, { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(activated).not.toHaveBeenCalled()
  })
  test.each(["scroll", "resize", "pagehide", "fullscreenchange"])(
    "cleans up on %s",
    async (name) => {
      await start()
      ;(name === "fullscreenchange" ? document : window).dispatchEvent(new Event(name))
      expect(host()).toBeNull()
      expect(surface.frames.size).toBe(0)
    },
  )
  test.each(["zoom", "dpr", "focus", "protection"])(
    "fails closed after %s changes",
    async (change) => {
      await start()
      if (change === "zoom") document.documentElement.style.zoom = "1.25"
      if (change === "dpr") vi.stubGlobal("devicePixelRatio", 2)
      if (change === "focus") {
        const frame = document.createElement("iframe")
        document.body.append(frame)
        frame.focus()
      }
      if (change === "protection") host()?.style.setProperty("pointer-events", "none", "important")
      expect(await execute("state")).toMatchObject({ result: { active: false } })
      expect(host()).toBeNull()
      document.documentElement.style.zoom = ""
    },
  )
  test("cleanup releases paint waits, is idempotent, and does not remove a replacement token", async () => {
    const pending = execute("start")
    stopRegionCaptureInjection("surface")
    expect(await pending).toMatchObject({ result: { active: false } })
    await start("replacement")
    stopRegionCaptureInjection("surface")
    expect(host()).not.toBeNull()
    stopRegionCaptureInjection("replacement")
    stopRegionCaptureInjection()
    expect(host()).toBeNull()
  })
  test("expires and restores earlier focus only when the shield still owns focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const button = document.createElement("button")
    document.body.append(button)
    button.focus()
    await start()
    vi.advanceTimersByTime(REGION_CAPTURE_LIMITS.lifetimeMs)
    expect(host()).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(sent.at(-1)).toMatchObject({ reason: "timeout" })
  })
})
