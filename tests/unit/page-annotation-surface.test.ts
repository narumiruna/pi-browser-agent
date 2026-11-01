// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executePageAnnotation,
  stopPageAnnotationInjection,
} from "../../src/browser/content/page-annotation.js"
import { PageAnnotationWorker } from "../../src/browser/page-annotation-worker.js"
import {
  PAGE_ANNOTATION_COLORS,
  PAGE_ANNOTATION_LIMITS,
  PAGE_ANNOTATION_TOOLS,
  type PageAnnotationOperation,
  type PageAnnotationSettings,
} from "../../src/browser/runtime/page-annotation.js"
import type { TabContext } from "../../src/browser/runtime/types.js"
import { mockPageAnnotationSurface } from "../helpers/page-annotation-surface.js"

const context: TabContext = { tabId: 1, url: location.href, epoch: 0 }
const limits = { ...PAGE_ANNOTATION_LIMITS, colors: PAGE_ANNOTATION_COLORS }
const settings: PageAnnotationSettings = { color: "red", width: 8 }
let surface: ReturnType<typeof mockPageAnnotationSurface>
let sent: Record<string, unknown>[]
let stopListener:
  | ((
      message: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (value: unknown) => void,
    ) => boolean)
  | undefined
const host = () => document.querySelector<HTMLElement>("[data-pi-browser-agent-page-annotation]")
const execute = (operation: PageAnnotationOperation, value = settings, token = "surface") =>
  executePageAnnotation(operation, token, context, value, limits)
async function start(token = "surface") {
  const pending = execute("start", settings, token)
  surface.advanceFrames()
  return pending
}
function stroke() {
  surface.pointer("pointerdown")
  surface.pointer("pointermove", { clientX: 180, clientY: 160 })
  surface.pointer("pointerup", { clientX: 200, clientY: 180 })
}

beforeEach(() => {
  document.body.innerHTML = ""
  sent = []
  stopListener = undefined
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null })
  surface = mockPageAnnotationSurface()
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension",
      onMessage: {
        addListener: vi.fn((listener: NonNullable<typeof stopListener>) => {
          stopListener = listener
        }),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn(async (message) => {
        sent.push(message)
      }),
    },
  })
})
afterEach(() => {
  stopPageAnnotationInjection()
  surface.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("isolated page annotation surface", () => {
  test("accepts only an extension-owned token-scoped stop message and acknowledges cleanup", async () => {
    await start()
    const respond = vi.fn()
    stopListener?.({ kind: "page-annotation-stop", token: "surface" }, { id: "other" }, respond)
    expect(host()).not.toBeNull()
    expect(respond).not.toHaveBeenCalled()
    stopListener?.({ kind: "page-annotation-stop", token: "older" }, { id: "extension" }, respond)
    expect(host()).not.toBeNull()
    stopListener?.({ kind: "page-annotation-stop", token: "surface" }, { id: "extension" }, respond)
    expect(host()).toBeNull()
    expect(respond).toHaveBeenLastCalledWith({ active: false })
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(stopListener)
  })

  test("starts empty with a closed-shadow canvas and no toolbar or custom cursor", async () => {
    expect(await start()).toMatchObject({
      ok: true,
      result: {
        active: true,
        hasStrokes: false,
        drawing: false,
        frozen: false,
        revision: 0,
        width: innerWidth,
        height: innerHeight,
      },
    })
    expect(host()?.shadowRoot).toBeNull()
    expect(host()?.textContent).toBe("")
    expect(host()?.style.backgroundColor).toBe("rgba(0, 0, 0, 0.01)")
    expect(document.activeElement).toBe(host())
  })
  test("runs after serialization without module-scope runtime helpers", async () => {
    const injected = new Function(
      `return (${executePageAnnotation.toString()})`,
    )() as typeof executePageAnnotation
    const pending = injected("start", "surface", context, settings, limits)
    surface.advanceFrames()
    expect(await pending).toMatchObject({ result: { active: true } })
    const stop = new Function(
      `return (${stopPageAnnotationInjection.toString()})`,
    )() as typeof stopPageAnnotationInjection
    expect(stop("surface")).toEqual({ ok: true, result: { active: false } })
    expect(host()).toBeNull()
  })
  test("places the important-style shield inside a zoomed modal without changing it", async () => {
    const modal = document.createElement("dialog")
    modal.open = true
    modal.style.zoom = "1.25"
    document.documentElement.style.zoom = "0.9"
    document.body.append(modal)
    const before = modal.outerHTML
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => modal })
    vi.spyOn(Element.prototype, "closest").mockReturnValue(modal)
    await start()
    expect(host()?.parentElement).toBe(modal)
    expect(Number(host()?.style.zoom)).toBeCloseTo(1 / 1.125)
    for (const property of [
      "pointer-events",
      "background-color",
      "position",
      "width",
      "height",
      "zoom",
      "touch-action",
    ])
      expect(host()?.style.getPropertyPriority(property)).toBe("important")
    stopPageAnnotationInjection()
    expect(modal.outerHTML).toBe(before)
    document.documentElement.style.zoom = ""
  })
  test.each(PAGE_ANNOTATION_TOOLS)(
    "uses all six colors and 2/8/32 px widths with %s",
    async (tool) => {
      await start()
      await execute("tool", { ...settings, tool })
      for (const color of Object.keys(
        PAGE_ANNOTATION_COLORS,
      ) as (keyof typeof PAGE_ANNOTATION_COLORS)[]) {
        for (const width of [2, 8, 32]) {
          await execute("color", { color, width })
          await execute("width", { color, width })
          stroke()
          expect(surface.paint.strokeStyle).toBe(PAGE_ANNOTATION_COLORS[color])
          expect(surface.paint.lineWidth).toBe(width)
          expect(await execute("state")).toMatchObject({
            result: { hasStrokes: true, drawing: false },
          })
          await execute("clear")
        }
      }
    },
  )

  test("retains each stroke color and width through redraw, undo, and clear", async () => {
    await start()
    stroke()
    expect(surface.paint.strokeStyle).toBe(PAGE_ANNOTATION_COLORS.red)
    expect(surface.paint.lineWidth).toBe(8)
    await execute("color", { color: "blue", width: 8 })
    await execute("width", { color: "blue", width: 24 })
    stroke()
    expect(surface.paint.strokeStyle).toBe(PAGE_ANNOTATION_COLORS.blue)
    expect(surface.paint.lineWidth).toBe(24)
    expect(await execute("undo")).toMatchObject({ result: { hasStrokes: true, revision: 7 } })
    expect(surface.paint.strokeStyle).toBe(PAGE_ANNOTATION_COLORS.red)
    expect(surface.paint.lineWidth).toBe(8)
    expect(await execute("clear")).toMatchObject({ result: { hasStrokes: false, revision: 8 } })
    expect(await execute("undo")).toMatchObject({ result: { revision: 8 } })
  })
  test.each([
    [40, 50, 240, 150],
    [240, 50, 40, 150],
    [40, 150, 240, 50],
    [240, 150, 40, 50],
  ])("previews a normalized rectangle without a trail: %j", async (x1, y1, x2, y2) => {
    await start()
    await execute("tool", { ...settings, tool: "rectangle" })
    surface.pointer("pointerdown", { clientX: x1, clientY: y1 })
    for (const fraction of [0.2, 0.4, 0.8])
      surface.pointer("pointermove", {
        clientX: x1 + (x2 - x1) * fraction,
        clientY: y1 + (y2 - y1) * fraction,
      })
    expect(await execute("state")).toMatchObject({ result: { drawing: true, hasStrokes: false } })
    surface.paint.rect.mockClear()
    surface.pointer("pointermove", { clientX: x2, clientY: y2 })
    expect(surface.paint.rect).toHaveBeenCalledExactlyOnceWith(40, 50, 200, 100)
    expect(surface.paint.fill).not.toHaveBeenCalled()
    surface.pointer("pointerup", { clientX: x2, clientY: y2 })
    expect(await execute("state")).toMatchObject({ result: { drawing: false, hasStrokes: true } })
    await execute("undo")
    expect(await execute("state")).toMatchObject({ result: { hasStrokes: false } })
  })

  test.each([
    [100, 120],
    [-100, 120],
    [100, -120],
    [-100, -120],
    [4, 0],
    [0, 4],
  ])("points the bounded arrowhead toward release: %j", async (dx, dy) => {
    await start()
    await execute("tool", { ...settings, tool: "arrow" })
    surface.pointer("pointerdown", { clientX: 300, clientY: 300 })
    surface.pointer("pointermove", { clientX: 350, clientY: 350 })
    surface.paint.lineTo.mockClear()
    surface.pointer("pointerup", { clientX: 300 + dx, clientY: 300 + dy })
    const lines = surface.paint.lineTo.mock.calls.slice(-3)
    expect(lines[0]).toEqual([300 + dx, 300 + dy])
    expect(lines[1]).toEqual(lines[0])
    const [x, y] = lines[2] as [number, number]
    const length = Math.hypot(dx, dy)
    const behindTip = ((300 + dx - x) * dx + (300 + dy - y) * dy) / length
    expect(behindTip).toBeGreaterThan(0)
    expect(behindTip).toBeLessThanOrEqual(Math.min(48, length * 0.4) + 0.00001)
    expect(surface.paint.lineTo.mock.calls.every((call) => call.every(Number.isFinite))).toBe(true)
  })

  test.each(["arrow", "rectangle"] as const)(
    "discards undersized %s and retains a 4 px mark",
    async (tool) => {
      await start()
      await execute("tool", { ...settings, tool })
      for (const end of [
        { x: 103.99, y: 120 },
        { x: 100, y: 120 },
      ]) {
        surface.pointer("pointerdown")
        surface.pointer("pointerup", { clientX: end.x, clientY: end.y })
        expect(await execute("state")).toMatchObject({
          result: { hasStrokes: false, drawing: false },
        })
      }
      if (tool === "rectangle") {
        surface.pointer("pointerdown")
        surface.pointer("pointerup", { clientX: 200, clientY: 123.99 })
        expect(await execute("state")).toMatchObject({ result: { hasStrokes: false } })
      }
      surface.pointer("pointerdown")
      surface.pointer("pointerup", { clientX: 104, clientY: tool === "arrow" ? 120 : 124 })
      expect(await execute("state")).toMatchObject({ result: { hasStrokes: true } })
    },
  )

  test.each(["pointercancel", "lostpointercapture"])(
    "discards only the unfinished shape on %s",
    async (event) => {
      await start()
      stroke()
      await execute("tool", { ...settings, tool: "rectangle" })
      surface.pointer("pointerdown")
      surface.pointer("pointermove", { clientX: 300, clientY: 300 })
      surface.pointer(event)
      expect(await execute("state")).toMatchObject({ result: { hasStrokes: true, drawing: false } })
      await execute("undo")
      expect(await execute("state")).toMatchObject({ result: { hasStrokes: false } })
    },
  )

  test("keeps two endpoints per shape, clamps edges, and frees the whole mark budget on undo", async () => {
    const bounded = { ...limits, maxTotalPoints: 5, maxStrokes: 3 } as unknown as typeof limits
    const pending = executePageAnnotation("start", "surface", context, settings, bounded)
    surface.advanceFrames()
    await pending
    surface.pointer("pointerdown")
    surface.pointer("pointerup") // One pen point.
    await execute("tool", { ...settings, tool: "rectangle" })
    for (let mark = 0; mark < 2; mark++) {
      surface.pointer("pointerdown", { clientX: -100, clientY: -100 })
      for (let index = 1; index <= 20; index++)
        surface.pointer("pointermove", { clientX: index * 100, clientY: index * 100 })
      surface.pointer("pointerup", { clientX: 99999, clientY: 99999 })
      expect(surface.paint.rect).toHaveBeenLastCalledWith(0, 0, innerWidth, innerHeight)
    }
    surface.pointer("pointerdown")
    expect(surface.capture).toHaveBeenCalledTimes(3)
    await execute("undo")
    surface.pointer("pointerdown")
    surface.pointer("pointerup", { clientX: 200, clientY: 220 })
    expect(surface.capture).toHaveBeenCalledTimes(4)
    await execute("clear")
    expect(await execute("state")).toMatchObject({ result: { hasStrokes: false } })
  })

  test("reserves two points before a shape starts and ignores non-finite endpoints", async () => {
    const bounded = { ...limits, maxTotalPoints: 2 } as unknown as typeof limits
    const pending = executePageAnnotation(
      "start",
      "surface",
      context,
      { ...settings, tool: "arrow" },
      bounded,
    )
    surface.advanceFrames()
    await pending
    surface.pointer("pointerdown")
    surface.pointer("pointermove", { clientX: NaN, clientY: Infinity })
    surface.pointer("pointerup", { clientX: 200, clientY: 120 })
    expect(surface.paint.moveTo).toHaveBeenCalledWith(100, 120)
    expect(surface.paint.lineTo).toHaveBeenCalledWith(200, 120)
    surface.pointer("pointerdown")
    expect(surface.capture).toHaveBeenCalledTimes(1)
    await execute("clear")
    await execute("tool", settings)
    surface.pointer("pointerdown")
    surface.pointer("pointerup")
    await execute("tool", { ...settings, tool: "arrow" })
    surface.pointer("pointerdown")
    expect(surface.capture).toHaveBeenCalledTimes(2)
  })

  test("serializes arrow painting and freezes mixed history without changing the active mark", async () => {
    const injected = new Function(
      `return (${executePageAnnotation.toString()})`,
    )() as typeof executePageAnnotation
    const pending = injected("start", "surface", context, settings, limits)
    surface.advanceFrames()
    await pending
    stroke()
    await execute("tool", { ...settings, tool: "arrow" })
    surface.pointer("pointerdown")
    await execute("tool", { ...settings, tool: "rectangle" })
    await execute("color", { color: "blue", width: 32, tool: "rectangle" })
    surface.pointer("pointermove", { clientX: 250, clientY: 120 })
    surface.paint.lineTo.mockClear()
    surface.pointer("pointerup", { clientX: 300, clientY: 120 })
    expect(surface.paint.lineTo).toHaveBeenCalledWith(300, 120)
    expect(surface.paint.strokeStyle).toBe(PAGE_ANNOTATION_COLORS.red)
    expect(surface.paint.lineWidth).toBe(8)
    expect(surface.paint.rect).not.toHaveBeenCalled()
    const freeze = execute("freeze")
    surface.advanceFrames()
    expect(await freeze).toMatchObject({ result: { frozen: true, hasStrokes: true } })
    await expect(execute("tool", { ...settings, tool: "rectangle" })).rejects.toThrow("not applied")
    await expect(execute("color", { ...settings, color: "green" })).rejects.toThrow("not applied")
    await expect(execute("width", { ...settings, width: 24 })).rejects.toThrow("not applied")
    await execute("resume")
    await execute("undo")
    expect(await execute("state")).toMatchObject({ result: { hasStrokes: true } })
    await execute("undo")
    expect(await execute("state")).toMatchObject({ result: { hasStrokes: false } })
  })

  test.each([
    { action: "tool", tool: "arrow" },
    { action: "color", color: "blue" },
    { action: "width", width: 24 },
  ] as const)(
    "applies delayed %j to the NEXT mark without changing the current gesture",
    async (update) => {
      const clientId = "12345678-1234-1234-1234-123456789abc"
      let release = (): void => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const validate = vi.fn(async (): Promise<void> => undefined)
      const worker = new PageAnnotationWorker({
        beforeStart: async () => undefined,
        context: async () => context,
        windowId: async () => 1,
        validate,
        execute: async (operation, session) => {
          const pending = executePageAnnotation(
            operation,
            session.token,
            context,
            session.settings,
            limits,
          )
          surface.advanceFrames()
          return pending
        },
        cleanup: async (_context, token) => {
          stopPageAnnotationInjection(token)
        },
        emit: () => undefined,
        capturePermission: async () => undefined,
        capture: async () => ({}),
      })
      await worker.start({
        kind: "request",
        requestId: "start",
        method: "pageAnnotation.start",
        params: { clientId, ...settings },
        tabContext: context,
      })
      validate.mockImplementationOnce(() => gate)
      const pending = worker.update({
        kind: "request",
        requestId: "update",
        method: "pageAnnotation.update",
        params: { clientId, ...update },
        tabContext: context,
      })
      await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(3))
      surface.pointer("pointerdown") // The accepted idle setting has not reached the surface yet.
      release()
      await pending
      surface.pointer("pointerup", { clientX: 200, clientY: 120 })
      expect(surface.paint.lineWidth).toBe(8)
      expect(surface.paint.strokeStyle).toBe(PAGE_ANNOTATION_COLORS.red)
      expect(surface.paint.lineTo.mock.calls.at(-1)).toEqual([200, 120])
      surface.paint.lineTo.mockClear()
      surface.pointer("pointerdown", { clientX: 100, clientY: 220 })
      surface.paint.lineTo.mockClear() // Exclude the completed first mark from this redraw.
      surface.pointer("pointerup", { clientX: 200, clientY: 220 })
      expect(surface.paint.lineWidth).toBe(update.action === "width" ? 24 : 8)
      expect(surface.paint.strokeStyle).toBe(
        update.action === "color" ? PAGE_ANNOTATION_COLORS.blue : PAGE_ANNOTATION_COLORS.red,
      )
      // Two redraws: the current preview and then its committed history item.
      expect(surface.paint.lineTo).toHaveBeenCalledTimes(update.action === "tool" ? 8 : 4)
      if (update.action === "tool")
        expect(surface.paint.lineTo.mock.calls.at(-1)).not.toEqual([200, 220])
      await worker.stop({
        kind: "request",
        requestId: "stop",
        method: "pageAnnotation.stop",
        params: { clientId },
        tabContext: context,
      })
    },
  )

  test("uses pointer capture and discards cancelled partial strokes", async () => {
    await start()
    surface.pointer("pointerdown")
    expect(surface.capture).toHaveBeenCalledWith(1)
    expect(await execute("state")).toMatchObject({ result: { drawing: true, hasStrokes: false } })
    surface.pointer("pointermove")
    surface.pointer("pointercancel")
    expect(surface.release).toHaveBeenCalledWith(1)
    expect(await execute("state")).toMatchObject({
      result: { drawing: false, hasStrokes: false, revision: 2 },
    })
    stroke()
    surface.pointer("pointerdown")
    surface.pointer("lostpointercapture")
    expect(await execute("state")).toMatchObject({ result: { hasStrokes: true, revision: 6 } })
  })
  test("does not freeze empty marks or an active pointer; freeze retains input shield", async () => {
    await start()
    expect(await execute("freeze")).toMatchObject({ result: { frozen: false } })
    surface.pointer("pointerdown")
    expect(await execute("freeze")).toMatchObject({ result: { drawing: true, frozen: false } })
    surface.pointer("pointerup")
    const pending = execute("freeze")
    surface.advanceFrames()
    expect(await pending).toMatchObject({ result: { frozen: true, hasStrokes: true, revision: 3 } })
    expect(host()?.style.pointerEvents).toBe("auto")
    stroke()
    await execute("clear")
    expect(await execute("state")).toMatchObject({ result: { frozen: true, revision: 3 } })
    await execute("resume")
    stroke()
    expect(await execute("state")).toMatchObject({ result: { frozen: false, revision: 6 } })
  })
  test("ignores synthetic drawing but blocks keyboard activation, clicks, dragging, touch and scrolling", async () => {
    await start()
    surface.pointer("pointerdown", { isTrusted: false })
    expect(surface.capture).not.toHaveBeenCalled()
    const activated = vi.fn()
    const target = document.createElement("button")
    target.addEventListener("click", activated)
    document.body.append(target)
    for (const name of [
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
    ]) {
      const event = new Event(name, { bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      expect(event.defaultPrevented, name).toBe(true)
    }
    expect(activated).not.toHaveBeenCalled()
    expect(host()).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))
    expect(host()).toBeNull()
    expect(sent.at(-1)).toMatchObject({ state: { active: false }, reason: "user" })
  })
  test.each(["scroll", "resize"])("cancels on %s and emits no page data", async (name) => {
    await start()
    window.dispatchEvent(new Event(name))
    expect(host()).toBeNull()
    expect(sent).toEqual([
      {
        kind: "page-annotation-state",
        token: "surface",
        tabContext: context,
        state: { active: false },
        reason: "viewport-changed",
      },
    ])
  })
  test.each(["zoom", "dpr", "geometry"])("validates %s before state or capture", async (change) => {
    await start()
    if (change === "zoom") document.documentElement.style.zoom = "1.25"
    if (change === "dpr") vi.stubGlobal("devicePixelRatio", 2)
    if (change === "geometry") vi.stubGlobal("innerWidth", innerWidth + 1)
    expect(await execute("state")).toMatchObject({
      result: { active: false, reason: "viewport-changed" },
    })
    document.documentElement.style.zoom = ""
  })
  test.each(["pointer-events", "background-color", "opacity", "filter", "mask-image"])(
    "cancels on protection loss: %s",
    async (property) => {
      await start()
      host()?.style.setProperty(
        property,
        property === "pointer-events"
          ? "none"
          : property === "opacity"
            ? "0"
            : property === "filter"
              ? "opacity(0)"
              : property === "mask-image"
                ? "linear-gradient(transparent,transparent)"
                : "transparent",
        "important",
      )
      expect(await execute("state")).toMatchObject({
        result: { active: false, reason: "protection-lost" },
      })
    },
  )
  test("cancels on child focus and new top-layer surfaces", async () => {
    await start()
    const frame = document.createElement("iframe")
    document.body.append(frame)
    frame.focus()
    surface.advanceFrames(1)
    expect(host()).toBeNull()
    await start()
    const event = new Event("beforetoggle", { bubbles: true })
    Object.defineProperty(event, "newState", { value: "open" })
    frame.dispatchEvent(event)
    expect(host()).toBeNull()
  })
  test("releases startup and freeze paint waits during independent idempotent cleanup", async () => {
    const pending = execute("start")
    stopPageAnnotationInjection("surface")
    expect(await pending).toMatchObject({ result: { active: false } })
    await start()
    stroke()
    const freeze = execute("freeze")
    stopPageAnnotationInjection("surface")
    expect(await freeze).toMatchObject({ result: { active: false } })
    expect(stopPageAnnotationInjection()).toEqual({ ok: true, result: { active: false } })
    expect(surface.frames.size).toBe(0)
  })
  test("old token cleanup and controls cannot delete or change a replacement", async () => {
    await start("old")
    const oldHost = host()
    await start("new")
    expect(oldHost?.isConnected).toBe(false)
    const replacement = host()
    stopPageAnnotationInjection("old")
    await execute("stop", settings, "old")
    expect(await execute("clear", settings, "old")).toMatchObject({ result: { active: false } })
    expect(host()).toBe(replacement)
  })
  test("preserves page-owned nodes, styles, modal state, and prior focus", async () => {
    document.body.innerHTML =
      '<button id="prior">Prior focus</button><div data-pi-browser-agent-page-annotation>Page node</div>'
    const pageNode = host()
    const prior = document.querySelector<HTMLElement>("#prior")
    prior?.focus()
    const before = document.body.innerHTML
    await start()
    stopPageAnnotationInjection()
    expect(pageNode?.isConnected).toBe(true)
    expect(document.body.innerHTML).toBe(before)
    expect(document.activeElement).toBe(prior)
  })
  test("fails setup safely when the top layer or canvas is unavailable", async () => {
    vi.spyOn(HTMLElement.prototype, "showPopover").mockImplementation(() => {
      throw new Error("page data must not escape")
    })
    expect(await execute("start")).toEqual({
      ok: true,
      result: { active: false, reason: "overlay-unavailable" },
    })
    expect(host()).toBeNull()
    expect(surface.frames.size).toBe(0)
  })
  test.each(["missing-canvas", "throwing-canvas", "observer"])(
    "cleans up setup failure: %s",
    async (failure) => {
      if (failure === "missing-canvas")
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
      if (failure === "throwing-canvas")
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
          throw new Error("private page error")
        })
      if (failure === "observer")
        vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(() => {
          throw new Error("private page error")
        })
      expect(await execute("start")).toEqual({
        ok: true,
        result: { active: false, reason: "overlay-unavailable" },
      })
      expect(host()).toBeNull()
      expect(surface.frames.size).toBe(0)
    },
  )
  test("expires after five minutes and removes listeners and frames", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    await start()
    vi.advanceTimersByTime(limits.lifetimeMs - 1)
    expect(host()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(host()).toBeNull()
    expect(sent.at(-1)).toMatchObject({ state: { active: false }, reason: "timeout" })
    expect(surface.frames.size).toBe(0)
  })
  test("rejects oversized canvas setup without changing page styles", async () => {
    vi.stubGlobal("devicePixelRatio", 10)
    expect(await execute("start")).toMatchObject({
      result: { active: false, reason: "overlay-unavailable" },
    })
    expect(host()).toBeNull()
  })
  test("retains fixed vector budgets and accepts only finite points and valid pen settings", async () => {
    const bounded = {
      ...limits,
      maxPointsPerStroke: 4,
      maxTotalPoints: 6,
      maxStrokes: 2,
    } as unknown as typeof limits
    const pending = executePageAnnotation("start", "surface", context, settings, bounded)
    surface.advanceFrames()
    await pending
    await expect(execute("width", { color: "red", width: 33 })).rejects.toThrow("not applied")
    surface.pointer("pointerdown", { clientX: Number.NaN })
    expect(surface.capture).not.toHaveBeenCalled()
    surface.pointer("pointerdown")
    for (let index = 0; index < bounded.maxPointsPerStroke + 10; index += 1)
      surface.pointer("pointermove", { clientX: index % 500, clientY: 50 })
    const lines = surface.paint.lineTo.mock.calls.length
    surface.pointer("pointermove", { clientX: 700 })
    expect(surface.paint.lineTo.mock.calls.length).toBe(lines)
    surface.pointer("pointerup")
    expect(surface.paint.lineWidth).toBe(8)
    expect(await execute("state")).toMatchObject({ result: { hasStrokes: true, revision: 2 } })
    surface.pointer("pointerdown")
    surface.pointer("pointermove", { clientX: 300 })
    const limited = surface.paint.lineTo.mock.calls.length
    surface.pointer("pointermove", { clientX: 400 })
    expect(surface.paint.lineTo.mock.calls.length).toBe(limited)
    surface.pointer("pointerup")
    surface.pointer("pointerdown")
    expect(surface.capture).toHaveBeenCalledTimes(2)
    expect(await execute("state")).toMatchObject({ result: { revision: 4, drawing: false } })
    await execute("undo")
    stroke()
    expect(surface.capture).toHaveBeenCalledTimes(3)
    expect(await execute("state")).toMatchObject({ result: { revision: 7 } })
  })
})
