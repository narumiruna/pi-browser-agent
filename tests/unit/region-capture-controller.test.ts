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
  committedRevision: null,
  width: 900,
  height: 700,
} satisfies RegionCaptureState
const rectangle = { x: 100.2, y: 120.4, width: 200, height: 160 }
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
let dom: JSDOM
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function setup() {
  dom = new JSDOM(
    readFileSync(new URL("../../src/browser/sidepanel/index.html", import.meta.url), "utf8"),
  )
  vi.stubGlobal("document", dom.window.document)
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unused")
  let owner = { clientId: "", operationId: "" }
  let session = "session-one"
  const imageResult = (overrides: Record<string, JsonValue> = {}) => ({
    ...owner,
    dataUrl: `data:image/png;base64,${png}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    ...overrides,
  })
  const request = vi.fn<typeof sendRuntimeRequest>(async (method, params): Promise<JsonValue> => {
    if (method === "regionCapture.start") {
      owner = params as typeof owner
      return { ...owner, state: { ...blank } }
    }
    if (method === "regionCapture.capture") return imageResult()
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
  const event = (value: RegionCaptureState, extra: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
    kind: "event",
    name: "regionCapture.changed",
    payload: { ...owner, state: value },
    tabContext: context,
    ...extra,
  })
  const commit = (revision = 3) => {
    controller.onEvent(event({ ...blank, rectangle, revision, committedRevision: revision }))
  }
  return {
    controller,
    options,
    request,
    event,
    commit,
    imageResult,
    session: (id: string) => {
      session = id
    },
    captures: () => request.mock.calls.filter(([method]) => method === "regionCapture.capture"),
    stops: () => request.mock.calls.filter(([method]) => method === "regionCapture.stop"),
  }
}
afterEach(() => {
  dom?.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const button = () =>
  dom.window.document.querySelector<HTMLButtonElement>("#region-capture") as HTMLButtonElement

async function attached(f: ReturnType<typeof setup>) {
  await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
  expect(f.options.onAttach).toHaveBeenCalledOnce()
}

describe("compact region capture controller", () => {
  test("uses only the existing icon and accessible help, with no panel or crop dialog", async () => {
    const f = setup()
    for (const id of [
      "region-selection",
      "region-x",
      "region-y",
      "region-width",
      "region-height",
      "region-preview-action",
      "region-cancel",
      "region-preview-dialog",
      "region-attach",
      "region-retake",
    ])
      expect(dom.window.document.getElementById(id)).toBeNull()
    expect(button().getAttribute("aria-describedby")).toBe("region-capture-help")
    expect(button().title).toContain("Shift+Arrow")
    await f.controller.start()
    expect(button().ariaLabel).toBe("Cancel region capture")
    expect(f.controller.sendBlocked).toBe(true)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["regionCapture.start"])
    expect(f.options.preflight).not.toHaveBeenCalled()
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.options.focusComposer).not.toHaveBeenCalled()
  })
  test("held or synthetic Enter on the icon cannot start another operation", () => {
    const f = setup()
    const down = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    })
    button().dispatchEvent(down)
    button().dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Enter" }))
    expect(down.defaultPrevented).toBe(true)
    expect(f.request).not.toHaveBeenCalled()
    expect(f.options.requestSiteAccess).not.toHaveBeenCalled()
  })
  test("editing, dragging, frozen state, and incomplete rectangles do not auto-capture", async () => {
    const f = setup()
    await f.controller.start()
    for (const state of [
      { ...blank, rectangle, revision: 1 },
      { ...blank, rectangle, dragging: true, revision: 2 },
      { ...blank, rectangle, frozen: true, revision: 4, committedRevision: 3 },
      { ...blank, revision: 5 },
    ])
      f.controller.onEvent(f.event(state))
    expect(f.captures()).toHaveLength(0)
    expect(f.options.preflight).not.toHaveBeenCalled()
    expect(f.options.confirm).not.toHaveBeenCalled()
  })
  test("a completed selection auto-attaches one crop only after cleanup and never submits", async () => {
    const f = setup()
    await f.controller.start()
    const original = f.request.getMockImplementation() as typeof sendRuntimeRequest
    const gate = deferred<JsonValue>()
    f.request.mockImplementation(async (method, params, options) => {
      if (method === "regionCapture.stop") return gate.promise
      return original(method, params, options)
    })
    f.commit()
    await vi.waitFor(() => expect(f.stops()).toHaveLength(1))
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.controller.sendBlocked).toBe(true)
    expect(f.captures()[0]?.[1]).toMatchObject({ selectionRevision: 3, maxBytes: 3_000_000 })
    gate.resolve({ active: false })
    await attached(f)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "regionCapture.start",
      "regionCapture.capture",
      "regionCapture.stop",
    ])
    expect(f.options.onAttach.mock.calls[0]?.[0].type).toBe("image/png")
    expect(f.options.focusComposer).toHaveBeenCalledOnce()
    expect(f.controller.sendBlocked).toBe(false)
    expect(button().ariaLabel).toBe("Capture region")
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  test("duplicate completion notifications cannot capture or attach twice", async () => {
    const f = setup()
    await f.controller.start()
    f.commit()
    f.commit()
    f.commit()
    await attached(f)
    f.commit()
    expect(f.captures()).toHaveLength(1)
    expect(f.options.onAttach).toHaveBeenCalledOnce()
  })
  test("a completed drag before the start reply waits for startup and keeps its revision", async () => {
    const f = setup()
    const original = f.request.getMockImplementation() as typeof sendRuntimeRequest
    const gate = deferred<void>()
    f.request.mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      await gate.promise
      return result
    })
    const starting = f.controller.start()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
    f.commit(5)
    expect(f.captures()).toHaveLength(0)
    gate.resolve()
    await starting
    await attached(f)
    expect(f.captures()).toHaveLength(1)
    expect(f.captures()[0]?.[1]?.selectionRevision).toBe(5)
  })
  test("old owners, contexts, and revisions cannot initiate capture", async () => {
    const f = setup()
    await f.controller.start()
    f.controller.onEvent(f.event({ ...blank, rectangle, revision: 5 }))
    f.commit(4)
    f.controller.onEvent(
      f.event(
        { ...blank, rectangle, revision: 6, committedRevision: 6 },
        {
          payload: { clientId: "other", operationId: "other", state: blank },
        },
      ),
    )
    f.controller.onEvent(
      f.event(
        { ...blank, rectangle, revision: 6, committedRevision: 6 },
        {
          tabContext: { ...context, epoch: 99 },
        },
      ),
    )
    expect(f.captures()).toHaveLength(0)
    f.commit(6)
    await attached(f)
    expect(f.captures()).toHaveLength(1)
  })
  test("malformed completion data cancels without capture", async () => {
    const f = setup()
    await f.controller.start()
    f.controller.onEvent(f.event({ ...blank, rectangle, revision: 1, committedRevision: 2 }))
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.captures()).toHaveLength(0)
    expect(f.options.onAttach).not.toHaveBeenCalled()
  })
  test("site denial sends no start or stop and leaves ordinary chat unblocked", async () => {
    const f = setup()
    f.options.requestSiteAccess.mockResolvedValue(false)
    await expect(f.controller.start()).rejects.toThrow("unavailable")
    expect(f.request).not.toHaveBeenCalled()
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.options.preflight).not.toHaveBeenCalled()
    expect(f.controller.sendBlocked).toBe(false)
  })
  test("cancel during pending permission ignores late approval without dispatch", async () => {
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
  })
  test("a lost dispatched start reply requires confirmed cleanup", async () => {
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
  test("cancel a dispatched start cleans once and ignores its late reply", async () => {
    const f = setup()
    const gate = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => gate.promise)
    const starting = f.controller.start()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
    await f.controller.cancel()
    gate.resolve({ clientId: "old", operationId: "old", state: blank })
    await starting
    expect(f.controller.occupied).toBe(false)
    expect(f.stops()).toHaveLength(1)
  })
  test("a page change before dispatch needs no cleanup", async () => {
    const f = setup()
    f.options.getContext.mockResolvedValueOnce(context).mockResolvedValue({ ...context, tabId: 99 })
    await expect(f.controller.start()).rejects.toThrow("page changed")
    expect(f.request).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(false)
  })
  test("preflight failure keeps selection but never replays the same completion", async () => {
    const f = setup()
    await f.controller.start()
    f.options.preflight.mockImplementationOnce(() => {
      throw new Error("text-only model")
    })
    f.commit()
    await vi.waitFor(() => expect(f.options.onError).toHaveBeenCalledOnce())
    expect(f.captures()).toHaveLength(0)
    expect(f.options.confirm).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(true)
    f.commit()
    f.controller.refresh()
    expect(f.options.preflight).toHaveBeenCalledOnce()
    f.commit(4)
    await attached(f)
    expect(f.captures()).toHaveLength(1)
  })
  test("capture failure needs a fresh trusted completion, not a state refresh", async () => {
    const f = setup()
    await f.controller.start()
    f.request.mockRejectedValueOnce(new Error("native capture failed"))
    f.commit()
    await vi.waitFor(() => expect(f.options.onError).toHaveBeenCalledOnce())
    f.commit()
    f.controller.refresh()
    expect(f.captures()).toHaveLength(1)
    expect(f.options.onAttach).not.toHaveBeenCalled()
    f.commit(4)
    await attached(f)
    expect(f.captures()).toHaveLength(2)
  })
  test("existing screenshot confirmation retries only after its explicit approval", async () => {
    const f = setup()
    await f.controller.start()
    f.request.mockRejectedValueOnce(new RuntimeError("CONFIRMATION_REQUIRED", "confirm"))
    const gate = deferred<boolean>()
    f.options.confirm.mockReturnValue(gate.promise)
    f.commit()
    await vi.waitFor(() => expect(f.options.confirm).toHaveBeenCalledOnce())
    expect(f.captures()).toHaveLength(1)
    expect(f.options.onAttach).not.toHaveBeenCalled()
    gate.resolve(true)
    await attached(f)
    expect(f.captures()).toHaveLength(2)
    expect(f.captures()[1]?.[1]?.selectionRevision).toBe(3)
    expect(f.captures()[1]?.[2]?.confirmed).toBe(true)
  })
  test("denied screenshot consent neither retries nor attaches", async () => {
    const f = setup()
    await f.controller.start()
    f.request.mockRejectedValueOnce(new RuntimeError("CONFIRMATION_REQUIRED", "confirm"))
    f.options.confirm.mockResolvedValue(false)
    f.commit()
    await vi.waitFor(() => expect(f.options.onError).toHaveBeenCalledOnce())
    expect(f.captures()).toHaveLength(1)
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(true)
  })
  test("late screenshot consent after cancellation cannot retry capture", async () => {
    const f = setup()
    await f.controller.start()
    f.request.mockRejectedValueOnce(new RuntimeError("CONFIRMATION_REQUIRED", "confirm"))
    const gate = deferred<boolean>()
    f.options.confirm.mockReturnValue(gate.promise)
    f.commit()
    await vi.waitFor(() => expect(f.options.confirm).toHaveBeenCalledOnce())
    await f.controller.cancel()
    gate.resolve(true)
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.captures()).toHaveLength(1)
    expect(f.options.onAttach).not.toHaveBeenCalled()
  })
  test.each<Record<string, JsonValue>>([
    { dataUrl: "data:image/png;base64," },
    { dataUrl: "data:image/png;base64,invalid!" },
    { mimeType: "image/jpeg" },
    { width: 2 },
    { clientId: "other" },
  ])("rejects malformed crop without attachment: %j", async (overrides) => {
    const f = setup()
    await f.controller.start()
    f.request.mockResolvedValueOnce(f.imageResult(overrides))
    f.commit()
    await vi.waitFor(() => expect(f.options.onError).toHaveBeenCalledOnce())
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.controller.sendBlocked).toBe(true)
  })
  test("rejects a crop beyond the preflight budget", async () => {
    const f = setup()
    await f.controller.start()
    f.options.preflight.mockReturnValue(1)
    f.commit()
    await vi.waitFor(() => expect(f.options.onError).toHaveBeenCalledOnce())
    expect(f.options.onAttach).not.toHaveBeenCalled()
  })
  test("unconfirmed cleanup blocks attachment/Send and retries from the same icon without recapture", async () => {
    const f = setup()
    await f.controller.start()
    const original = f.request.getMockImplementation() as typeof sendRuntimeRequest
    let failed = false
    f.request.mockImplementation(async (method, params, options) => {
      if (method === "regionCapture.stop" && !failed) {
        failed = true
        throw new Error("cleanup")
      }
      return original(method, params, options)
    })
    f.commit()
    await vi.waitFor(() => expect(button().ariaLabel).toBe("Retry region cleanup"))
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.controller.sendBlocked).toBe(true)
    f.commit()
    button().click()
    await attached(f)
    expect(f.captures()).toHaveLength(1)
    expect(f.stops()).toHaveLength(2)
  })
  test("clicking the active icon during cleanup cancels rather than attaching", async () => {
    const f = setup()
    await f.controller.start()
    const original = f.request.getMockImplementation() as typeof sendRuntimeRequest
    const gate = deferred<JsonValue>()
    f.request.mockImplementation(async (method, params, options) => {
      if (method === "regionCapture.stop") return gate.promise
      return original(method, params, options)
    })
    f.commit()
    await vi.waitFor(() => expect(f.stops()).toHaveLength(1))
    expect(button().ariaLabel).toBe("Cancel region capture")
    button().click()
    gate.resolve({ active: false })
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.options.onAttach).not.toHaveBeenCalled()
    expect(f.stops()).toHaveLength(1)
  })
  test("attachment failure retains the static crop for explicit icon retry after a tab change", async () => {
    const f = setup()
    await f.controller.start()
    f.options.onAttach.mockRejectedValueOnce(new Error("capacity changed"))
    f.commit()
    await vi.waitFor(() => expect(button().ariaLabel).toBe("Retry region attachment"))
    f.controller.onEvent({
      kind: "event",
      name: "tab.changed",
      payload: {},
      tabContext: { ...context, tabId: 8 },
    })
    expect(f.controller.sendBlocked).toBe(true)
    button().click()
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.options.onAttach).toHaveBeenCalledTimes(2)
    expect(f.captures()).toHaveLength(1)
    expect(f.stops()).toHaveLength(1)
  })
  test("session replacement discards a retained crop without retry", async () => {
    const f = setup()
    await f.controller.start()
    f.options.onAttach.mockRejectedValueOnce(new Error("capacity changed"))
    f.commit()
    await vi.waitFor(() => expect(button().ariaLabel).toBe("Retry region attachment"))
    f.session("replacement")
    f.controller.onEvent({ kind: "event", name: "tab.changed", payload: {} })
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.options.onAttach).toHaveBeenCalledOnce()
    expect(f.captures()).toHaveLength(1)
  })
  test("cancelled asynchronous attachment cannot pass its acceptance guard", async () => {
    const f = setup()
    await f.controller.start()
    const gate = deferred<void>()
    const accepted = vi.fn()
    f.options.onAttach.mockImplementation(async (_image, accept) => {
      await gate.promise
      accept()
      accepted()
    })
    f.commit()
    await vi.waitFor(() => expect(f.options.onAttach).toHaveBeenCalledOnce())
    button().click()
    gate.resolve()
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(accepted).not.toHaveBeenCalled()
    expect(f.options.onError).not.toHaveBeenCalled()
    expect(f.captures()).toHaveLength(1)
  })
  test("late capture cannot revive a cancelled or replacement operation", async () => {
    const f = setup()
    await f.controller.start()
    const gate = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => gate.promise)
    f.commit()
    await f.controller.cancel()
    await f.controller.start()
    gate.resolve({ invalid: "late" })
    f.commit(4)
    await attached(f)
    expect(f.captures()).toHaveLength(2)
    expect(f.options.onError).not.toHaveBeenCalled()
  })
  test("active icon cancels selection without capture and disposal does not restore focus", async () => {
    const f = setup()
    await f.controller.start()
    button().click()
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.captures()).toHaveLength(0)
    expect(dom.window.document.activeElement).toBe(button())
    await f.controller.start()
    f.controller.dispose()
    await vi.waitFor(() => expect(f.controller.occupied).toBe(false))
    expect(f.options.onAttach).not.toHaveBeenCalled()
  })
})
