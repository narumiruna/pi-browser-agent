import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { RuntimeEvent, sendRuntimeRequest } from "../../src/browser/runtime/messages.js"
import type { RegionCaptureState } from "../../src/browser/runtime/region-capture.js"
import { type JsonValue, RuntimeError } from "../../src/browser/runtime/types.js"
import { RegionCaptureController } from "../../src/browser/sidepanel/region-capture.js"

const context = { tabId: 7, url: "https://example.test/", epoch: 2 }
const blank = {
  active: true as const,
  rectangle: null,
  dragging: false,
  frozen: false,
  revision: 0,
  width: 900,
  height: 700,
} satisfies RegionCaptureState
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
let dom: JSDOM
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup() {
  dom = new JSDOM(
    readFileSync(new URL("../../src/browser/sidepanel/index.html", import.meta.url), "utf8"),
  )
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement)
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:crop")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
  let owner = { clientId: "", operationId: "" }
  let state = { ...blank }
  let session = "session-one"
  const request = vi.fn<typeof sendRuntimeRequest>(async (method, params): Promise<JsonValue> => {
    if (method === "regionCapture.start") {
      owner = params as typeof owner
      return { ...owner, state }
    }
    if (method === "regionCapture.update") {
      state = {
        ...state,
        rectangle: params?.rectangle as JsonValue,
        revision: state.revision + 1,
      } as typeof state
      return { ...owner, state }
    }
    if (method === "regionCapture.capture")
      return {
        ...owner,
        dataUrl: `data:image/png;base64,${png}`,
        mimeType: "image/png",
        width: 1,
        height: 1,
      }
    return { active: false }
  })
  const options = {
    getContext: vi.fn(async () => context),
    getSessionId: () => session,
    requestSiteAccess: vi.fn(async () => true),
    canStart: vi.fn(() => true),
    preflight: vi.fn(() => 3_000_000),
    confirm: vi.fn(async (_error: RuntimeError, _signal: AbortSignal) => true),
    onAttach: vi.fn(async (_blob: Blob, accept: () => void) => {
      accept()
    }),
    focusComposer: vi.fn(),
    onChange: vi.fn(),
    onError: vi.fn(),
    request,
  }
  const controller = new RegionCaptureController(options)
  const input = (key: string) =>
    dom.window.document.querySelector<HTMLInputElement>(`#region-${key}`) as HTMLInputElement
  const event = (value: RegionCaptureState, extra: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
    kind: "event",
    name: "regionCapture.changed",
    payload: { ...owner, state: value },
    tabContext: context,
    ...extra,
  })
  const selecting = async () => {
    await controller.start()
    await controller.updateRectangle()
  }
  return {
    controller,
    options,
    request,
    input,
    event,
    selecting,
    session: (id: string) => {
      session = id
    },
  }
}
afterEach(() => {
  dom?.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const button = (id: string) =>
  dom.window.document.querySelector<HTMLButtonElement>(`#${id}`) as HTMLButtonElement

describe("region capture panel controller", () => {
  test("starts without capture and supports keyboard numeric selection with focus", async () => {
    const f = setup()
    await f.controller.start()
    expect(f.input("x")).toBe(dom.window.document.activeElement)
    expect(button("region-preview-action").disabled).toBe(true)
    f.input("x").value = "100.2"
    f.input("y").value = "120.4"
    await f.controller.updateRectangle()
    expect(f.request).toHaveBeenLastCalledWith(
      "regionCapture.update",
      expect.objectContaining({ rectangle: { x: 100.2, y: 120.4, width: 200, height: 150 } }),
      expect.anything(),
    )
    expect(button("region-preview-action").disabled).toBe(false)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "regionCapture.start",
      "regionCapture.update",
    ])
    expect(f.controller.sendBlocked).toBe(true)
  })
  test("site denial with no grants sends no start or stop and leaves ordinary chat unblocked", async () => {
    const f = setup()
    f.options.requestSiteAccess.mockResolvedValue(false)
    f.request.mockRejectedValue(
      new RuntimeError("PERMISSION_DENIED", "no listener or injection access"),
    )
    await expect(f.controller.start()).rejects.toThrow("unavailable")
    expect(f.request).not.toHaveBeenCalled()
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.options.preflight).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(false)
    expect(f.controller.sendBlocked).toBe(false)
  })
  test("cancel during pending permission sends no requests even after late approval", async () => {
    const f = setup()
    const permission = deferred<boolean>()
    f.options.requestSiteAccess.mockReturnValue(permission.promise)
    const starting = f.controller.start()
    await vi.waitFor(() => expect(f.options.requestSiteAccess).toHaveBeenCalled())
    await f.controller.cancel()
    permission.resolve(true)
    await starting
    expect(f.request).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(false)
    expect(f.controller.sendBlocked).toBe(false)
    expect(f.options.onAttach).not.toHaveBeenCalled()
  })
  test("a lost dispatched start reply requires confirmed cleanup and retains a real blocker", async () => {
    const f = setup()
    f.request.mockRejectedValue(new Error("lost response"))
    await expect(f.controller.start()).rejects.toThrow("lost response")
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "regionCapture.start",
      "regionCapture.stop",
    ])
    expect(f.controller.sendBlocked).toBe(true)
    f.request.mockResolvedValue({ active: false })
    await f.controller.cancel()
    expect(f.controller.occupied).toBe(false)
  })
  test("cancels a pending dispatched start, cleans once, and ignores its late reply", async () => {
    const f = setup()
    const gate = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => gate.promise)
    const starting = f.controller.start()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
    await f.controller.cancel()
    gate.resolve({ clientId: "old", operationId: "old", state: blank })
    await starting
    expect(f.controller.occupied).toBe(false)
    expect(f.request.mock.calls.filter(([method]) => method === "regionCapture.stop")).toHaveLength(
      1,
    )
  })
  test("changed page before dispatch needs no cleanup", async () => {
    const f = setup()
    f.options.getContext.mockResolvedValueOnce(context).mockResolvedValue({ ...context, tabId: 99 })
    await expect(f.controller.start()).rejects.toThrow("page changed")
    expect(f.request).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(false)
  })
  test.each(["", "NaN", "-1", "899"])(
    "invalid numeric x=%s preserves selection without capture",
    async (value) => {
      const f = setup()
      await f.selecting()
      f.input("x").value = value
      await expect(f.controller.updateRectangle()).rejects.toThrow("8 CSS")
      expect(button("region-preview-action").disabled).toBe(true)
      expect(
        f.request.mock.calls.filter(([method]) => method === "regionCapture.capture"),
      ).toHaveLength(0)
    },
  )
  test("preflights image support and capacity before capture, retaining selection", async () => {
    const f = setup()
    await f.selecting()
    f.options.preflight.mockImplementationOnce(() => {
      throw new Error("text-only model")
    })
    await expect(f.controller.preview()).rejects.toThrow("text-only")
    expect(button("region-preview-action").disabled).toBe(false)
    expect(f.request.mock.calls.some(([method]) => method === "regionCapture.capture")).toBe(false)
    expect(f.options.confirm).not.toHaveBeenCalled()
  })
  test("preview cleans before opening, attaches once, releases URL, and never submits", async () => {
    const f = setup()
    await f.selecting()
    await f.controller.preview()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "regionCapture.start",
      "regionCapture.update",
      "regionCapture.capture",
      "regionCapture.stop",
    ])
    expect(button("region-attach")).toBe(dom.window.document.activeElement)
    expect(f.options.onAttach).not.toHaveBeenCalled()
    await Promise.all([f.controller.attach(), f.controller.attach()])
    expect(f.options.onAttach).toHaveBeenCalledOnce()
    expect(f.options.onAttach.mock.calls[0]?.[0].type).toBe("image/png")
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:crop")
    expect(f.controller.sendBlocked).toBe(false)
    expect(f.options.focusComposer).toHaveBeenCalledOnce()
  })
  test("unconfirmed cleanup blocks attach/send until manual retry without recapture", async () => {
    const f = setup()
    await f.selecting()
    const original = f.request.getMockImplementation() as typeof sendRuntimeRequest
    let failed = false
    f.request.mockImplementation(async (method, params, options) => {
      if (method === "regionCapture.stop" && !failed) {
        failed = true
        throw new Error("cleanup")
      }
      return original(method, params, options)
    })
    await expect(f.controller.preview()).rejects.toThrow("confirm region cleanup")
    await f.controller.attach()
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.controller.sendBlocked).toBe(true)
    await f.controller.preview()
    await f.controller.attach()
    expect(
      f.request.mock.calls.filter(([method]) => method === "regionCapture.capture"),
    ).toHaveLength(1)
    expect(f.options.onAttach).toHaveBeenCalledOnce()
  })
  test("cancel preview adds nothing; static preview survives a later tab change", async () => {
    const f = setup()
    await f.selecting()
    await f.controller.preview()
    f.controller.onEvent({
      kind: "event",
      name: "tab.changed",
      payload: {},
      tabContext: { ...context, tabId: 8 },
    })
    expect(button("region-attach").disabled).toBe(false)
    await f.controller.cancel()
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.request.mock.calls.filter(([method]) => method === "regionCapture.stop")).toHaveLength(
      1,
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })
  test("session replacement discards a finished preview", async () => {
    const f = setup()
    await f.selecting()
    await f.controller.preview()
    f.session("replacement")
    f.controller.onEvent({ kind: "event", name: "tab.changed", payload: {} })
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.options.onAttach).not.toHaveBeenCalled()
  })
  test("attachment failure retains only the cropped preview for retry", async () => {
    const f = setup()
    await f.selecting()
    await f.controller.preview()
    f.options.onAttach.mockRejectedValueOnce(new Error("capacity changed"))
    await expect(f.controller.attach()).rejects.toThrow("capacity changed")
    expect(button("region-attach").disabled).toBe(false)
    await f.controller.attach()
    expect(
      f.request.mock.calls.filter(([method]) => method === "regionCapture.capture"),
    ).toHaveLength(1)
    expect(f.controller.occupied).toBe(false)
  })
  test("late capture after cancellation cannot create a preview or attach", async () => {
    const f = setup()
    await f.selecting()
    const gate = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => gate.promise)
    const pending = f.controller.preview()
    await f.controller.cancel()
    gate.resolve({ invalid: "late" })
    await pending
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(false)
  })
  test("late screenshot consent cannot trigger capture after cancellation", async () => {
    const f = setup()
    await f.selecting()
    f.request.mockRejectedValueOnce(new RuntimeError("CONFIRMATION_REQUIRED", "confirm"))
    const gate = deferred<boolean>()
    f.options.confirm.mockReturnValue(gate.promise)
    const pending = f.controller.preview()
    await vi.waitFor(() => expect(f.options.confirm).toHaveBeenCalled())
    await f.controller.cancel()
    gate.resolve(true)
    await pending
    expect(
      f.request.mock.calls.filter(([method]) => method === "regionCapture.capture"),
    ).toHaveLength(1)
    expect(f.controller.occupied).toBe(false)
  })
  test("a cancelled update cannot lock or enable a replacement operation", async () => {
    const f = setup()
    await f.selecting()
    const older = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => older.promise)
    const updating = f.controller.updateRectangle()
    await f.controller.cancel()
    await f.controller.start()
    expect(f.input("x").disabled).toBe(false)
    const newer = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => newer.promise)
    const replacement = f.controller.updateRectangle()
    expect(f.input("x").disabled).toBe(true)
    older.resolve({ invalid: "old update" })
    await updating
    expect(f.input("x").disabled).toBe(true)
    await f.controller.cancel()
    newer.resolve({ invalid: "cancelled replacement" })
    await replacement
    expect(f.controller.occupied).toBe(false)
  })
  test("new selection clears cancelled invalid field feedback", async () => {
    const f = setup()
    await f.selecting()
    f.input("x").value = "-1"
    await expect(f.controller.updateRectangle()).rejects.toThrow()
    await f.controller.cancel()
    await f.controller.start()
    await f.controller.updateRectangle()
    expect(button("region-preview-action").disabled).toBe(false)
  })
  test("old owners and revisions cannot overwrite numeric selection", async () => {
    const f = setup()
    await f.selecting()
    f.controller.onEvent(
      f.event({ ...blank, rectangle: { x: 10, y: 20, width: 100, height: 120 }, revision: 5 }),
    )
    f.controller.onEvent(
      f.event({ ...blank, rectangle: { x: 80, y: 20, width: 100, height: 120 }, revision: 4 }),
    )
    f.controller.onEvent(
      f.event(blank, { payload: { clientId: "other", operationId: "other", state: blank } }),
    )
    expect(f.input("x").value).toBe("10")
  })
})
