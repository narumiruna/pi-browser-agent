// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  executeRegionCapture,
  stopRegionCaptureInjection,
} from "../../src/browser/content/region-capture.js"
import {
  REGION_CAPTURE_LIMITS,
  type RegionCaptureOperation,
} from "../../src/browser/runtime/region-capture.js"
import { mockPageAnnotationSurface } from "../helpers/page-annotation-surface.js"

const context = { tabId: 1, url: location.href, epoch: 0 }
const rectangle = { x: 100, y: 80, width: 100, height: 120 }
let surface: ReturnType<typeof mockPageAnnotationSurface>
let shadow: ShadowRoot
let sent: Record<string, unknown>[]
const host = () => document.querySelector<HTMLElement>("[data-pi-browser-agent-region-capture]")
const execute = (action: RegionCaptureOperation, token = "surface") =>
  executeRegionCapture(action, token, context, REGION_CAPTURE_LIMITS)
const keyDown = (key: string, values: Partial<KeyboardEvent> = {}) =>
  surface.pointer("keydown", { key, repeat: false, ...values } as Partial<PointerEvent>)
const keyUp = (key: string, values: Partial<KeyboardEvent> = {}) =>
  surface.pointer("keyup", { key, ...values } as Partial<PointerEvent>)
function key(key: string, values: Partial<KeyboardEvent> = {}) {
  keyDown(key, values)
  if (!values.repeat) keyUp(key, values)
}
async function start(token = "surface") {
  const pending = execute("start", token)
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
      result: {
        active: true,
        rectangle: null,
        frozen: false,
        dragging: false,
        committedRevision: null,
      },
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
    const pending = injected("start", "surface", context, REGION_CAPTURE_LIMITS)
    surface.advanceFrames()
    expect(await pending).toMatchObject({ result: { active: true } })
  })
  test("selects by reverse drag, allows reselection, clamps to viewport, and ignores untrusted pointers", async () => {
    await start()
    surface.pointer("pointerdown", { isTrusted: false })
    expect(surface.capture).not.toHaveBeenCalled()
    drag()
    const completed = (await execute("state")).result
    expect(completed).toMatchObject({ rectangle, dragging: false })
    if (!completed.active) throw new Error("Selection is inactive")
    expect(completed.committedRevision).toBe(completed.revision)
    expect(surface.capture).toHaveBeenCalledWith(1)
    expect(surface.release).toHaveBeenCalledWith(1)
    surface.pointer("pointerdown", { clientX: 0, clientY: 0 })
    expect(await execute("state")).toMatchObject({
      result: { dragging: true, committedRevision: null },
    })
    surface.pointer("pointerup", { clientX: 99999, clientY: 99999 })
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 0, y: 0, width: innerWidth, height: innerHeight } },
    })
    expect(
      sent.every(
        (m) =>
          m.kind === "region-capture-state" &&
          Object.keys(m).every((name) => ["kind", "token", "tabContext", "state"].includes(name)),
      ),
    ).toBe(true)
  })
  test("rejects tiny/empty drags and discards cancelled pointers", async () => {
    await start()
    surface.pointer("pointerdown")
    surface.pointer("pointerup", { clientX: 101, clientY: 121 })
    expect(await execute("state")).toMatchObject({
      result: { rectangle: null, committedRevision: null },
    })
    surface.pointer("pointerdown")
    surface.pointer("pointercancel")
    expect(await execute("state")).toMatchObject({
      result: { rectangle: null, dragging: false, committedRevision: null },
    })
  })
  test.each([
    { width: 7, height: 24 },
    { width: 32, height: 7 },
  ])("does not create an undersized keyboard rectangle in %j", async (viewport) => {
    vi.stubGlobal("innerWidth", viewport.width)
    vi.stubGlobal("innerHeight", viewport.height)
    await start()
    key("ArrowRight")
    key("Enter")
    expect(await execute("state")).toMatchObject({
      result: { rectangle: null, committedRevision: null, revision: 0 },
    })
  })
  test("lost pointer capture discards an unfinished rectangle without a commit", async () => {
    await start()
    surface.pointer("pointerdown", { clientX: 0, clientY: 0 })
    surface.pointer("pointermove", { clientX: 120, clientY: 160 })
    surface.pointer("lostpointercapture")
    expect(await execute("state")).toMatchObject({
      result: { rectangle: null, dragging: false, committedRevision: null },
    })
  })
  test("does not change or commit geometry from synthetic pointers or keys", async () => {
    await start()
    key("ArrowRight", { isTrusted: false })
    key("Enter", { isTrusted: false })
    key("Escape", { isTrusted: false })
    expect(await execute("state")).toMatchObject({
      result: { active: true, rectangle: null, revision: 0, committedRevision: null },
    })
    surface.pointer("pointerdown", { clientX: 0, clientY: 0 })
    surface.pointer("pointermove", { clientX: 120, clientY: 160 })
    const dragging = await execute("state")
    key("ArrowRight")
    key("Enter")
    expect(await execute("state")).toEqual(dragging)
    surface.pointer("pointermove", { isTrusted: false, clientX: 300, clientY: 300 })
    surface.pointer("pointerup", { isTrusted: false, clientX: 300, clientY: 300 })
    surface.pointer("pointercancel", { isTrusted: false })
    surface.pointer("lostpointercapture", { isTrusted: false })
    expect(await execute("state")).toEqual(dragging)
    expect(dragging).toMatchObject({
      result: {
        rectangle: { x: 0, y: 0, width: 120, height: 160 },
        dragging: true,
        committedRevision: null,
      },
    })
    surface.pointer("pointerup", { clientX: 120, clientY: 160 })
    const committed = await execute("state")
    surface.pointer("pointerdown", { isTrusted: false })
    key("ArrowRight", { isTrusted: false })
    key("Enter", { isTrusted: false })
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(await execute("state")).toEqual(committed)
  })
  test("moves and resizes with keyboard precision, then commits only once on non-repeat Enter", async () => {
    await start()
    key("Enter")
    expect(sent).toEqual([])
    key("ArrowRight")
    key("ArrowDown", { altKey: true })
    key("ArrowRight", { shiftKey: true, altKey: true })
    key("ArrowDown", { shiftKey: true })
    expect(await execute("state")).toMatchObject({
      result: {
        rectangle: { x: 10, y: 1, width: 201, height: 160 },
        revision: 4,
        committedRevision: null,
      },
    })
    expect(shadow.querySelector("div")?.style.left).toBe("10px")
    key("Enter", { repeat: true })
    expect(await execute("state")).toMatchObject({ result: { committedRevision: null } })
    key("Enter", { isTrusted: false })
    expect(await execute("state")).toMatchObject({ result: { committedRevision: null } })
    key("Enter")
    const committed = await execute("state")
    expect(committed).toMatchObject({ result: { revision: 5, committedRevision: 5 } })
    const count = sent.length
    key("Enter", { repeat: true })
    key("Enter")
    expect(sent).toHaveLength(count)
    expect(await execute("state")).toEqual(committed)
    key("ArrowLeft", { altKey: true })
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 9 }, committedRevision: null, revision: 6 },
    })
  })
  test("a held confirmation key cannot commit until trusted release", async () => {
    await start()
    key("ArrowRight")
    keyDown("Enter")
    keyDown("Enter", { repeat: true })
    keyUp("Enter", { isTrusted: false })
    expect(await execute("state")).toMatchObject({ result: { committedRevision: null } })
    expect(await execute("freeze")).toMatchObject({ result: { frozen: false } })
    keyUp("Enter")
    const state = (await execute("state")).result
    if (!state.active) throw new Error("Selection is inactive")
    expect(state.committedRevision).toBe(state.revision)
    const count = sent.length
    keyUp("Enter")
    expect(sent).toHaveLength(count)
  })
  test("editing while Enter is held discards that pending confirmation", async () => {
    await start()
    key("ArrowRight")
    keyDown("Enter")
    key("ArrowDown")
    keyUp("Enter")
    expect(await execute("state")).toMatchObject({ result: { committedRevision: null } })
    key("Enter")
    expect((await execute("state")).result).toMatchObject({ committedRevision: 3 })
  })
  test("a completed drag waits for an already-held Enter to be released", async () => {
    await start()
    keyDown("Enter")
    drag()
    expect(await execute("state")).toMatchObject({ result: { committedRevision: null } })
    keyUp("Enter")
    const state = (await execute("state")).result
    if (!state.active) throw new Error("Selection is inactive")
    expect(state.committedRevision).toBe(state.revision)
  })
  test("cleanup does not restore a page button while ignored Enter is still held", async () => {
    const previous = document.createElement("button")
    document.body.append(previous)
    previous.focus()
    await start()
    keyDown("Enter")
    stopRegionCaptureInjection()
    expect(host()).toBeNull()
    expect(document.activeElement).not.toBe(previous)
  })
  test("validation loss on the first held Enter does not restore a page button", async () => {
    const previous = document.createElement("button")
    document.body.append(previous)
    previous.focus()
    await start()
    vi.stubGlobal("devicePixelRatio", devicePixelRatio + 1)
    keyDown("Enter")
    expect(host()).toBeNull()
    expect(document.activeElement).not.toBe(previous)
  })
  test("clamps keyboard movement and resizing to the viewport and minimum side", async () => {
    vi.stubGlobal("innerWidth", 32)
    vi.stubGlobal("innerHeight", 24)
    await start()
    key("ArrowLeft")
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 0, y: 0, width: 32, height: 24 }, committedRevision: null },
    })
    for (let i = 0; i < 4; i += 1) {
      key("ArrowLeft", { shiftKey: true })
      key("ArrowUp", { shiftKey: true })
    }
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 0, y: 0, width: 8, height: 8 } },
    })
    for (let i = 0; i < 4; i += 1) {
      key("ArrowRight")
      key("ArrowDown")
    }
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 24, y: 16, width: 8, height: 8 } },
    })
    key("ArrowRight", { shiftKey: true })
    key("ArrowDown", { shiftKey: true })
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 24, y: 16, width: 8, height: 8 } },
    })
    for (let i = 0; i < 4; i += 1) {
      key("ArrowLeft")
      key("ArrowUp")
      key("ArrowRight", { shiftKey: true })
      key("ArrowDown", { shiftKey: true })
    }
    expect(await execute("state")).toMatchObject({
      result: { rectangle: { x: 0, y: 0, width: 32, height: 24 } },
    })
  })
  test("freezes only a completed rectangle, hides only outline, waits two paints, resumes", async () => {
    await start()
    expect(await execute("freeze")).toMatchObject({ result: { frozen: false } })
    surface.pointer("pointerdown")
    expect(await execute("freeze")).toMatchObject({ result: { dragging: true, frozen: false } })
    surface.pointer("pointercancel")
    key("ArrowRight")
    expect(await execute("freeze")).toMatchObject({
      result: { frozen: false, committedRevision: null },
    })
    drag()
    const completed = (await execute("state")).result
    if (!completed.active) throw new Error("Selection is inactive")
    let resolved = false
    const freezing = execute("freeze").then((value) => {
      resolved = true
      return value
    })
    surface.advanceFrames(1)
    await Promise.resolve()
    expect(resolved).toBe(false)
    surface.advanceFrames(1)
    expect(await freezing).toMatchObject({
      result: {
        frozen: true,
        rectangle,
        revision: completed.revision + 1,
        committedRevision: completed.committedRevision,
      },
    })
    expect(shadow.querySelector("div")?.style.display).toBe("none")
    expect(host()?.style.pointerEvents).toBe("auto")
    expect(host()?.style.backgroundColor).toBe("rgba(0, 0, 0, 0.01)")
    const frozen = await execute("state")
    drag()
    key("ArrowRight")
    key("Enter")
    expect(await execute("freeze")).toEqual(frozen)
    expect(await execute("state")).toEqual(frozen)
    expect(await execute("resume")).toMatchObject({
      result: { frozen: false, rectangle, committedRevision: null },
    })
    expect(shadow.querySelector("div")?.style.display).toBe("block")
    key("Enter", { isTrusted: false })
    key("Enter", { repeat: true })
    expect(await execute("state")).toMatchObject({ result: { committedRevision: null } })
    key("Enter")
    const recommitted = (await execute("state")).result
    if (!recommitted.active) throw new Error("Selection is inactive")
    expect(recommitted.committedRevision).toBe(recommitted.revision)
    expect(recommitted.revision).toBeGreaterThan(completed.revision)
  })
  test("trusted Escape cancels without adding page controls", async () => {
    await start()
    expect(shadow.querySelectorAll("button,input,dialog")).toHaveLength(0)
    key("Escape")
    expect(host()).toBeNull()
    expect(sent.at(-1)).toMatchObject({ state: { active: false }, reason: "user" })
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
