import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { RegionCaptureWorker } from "../../src/browser/region-capture-worker.js"
import { cropRegionPng } from "../../src/browser/region-crop.js"
import type { RuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  REGION_CAPTURE_LIMITS,
  type RegionCaptureOperation,
  type RegionCaptureState,
} from "../../src/browser/runtime/region-capture.js"
import { RuntimeError } from "../../src/browser/runtime/types.js"

vi.mock("../../src/browser/region-crop.js", () => ({ cropRegionPng: vi.fn() }))
const clientId = "12345678-1234-1234-1234-123456789abc"
const operationId = "12345678-1234-1234-1234-123456789abd"
const owner = { clientId, operationId }
const context = { tabId: 1, url: "https://example.test/", epoch: 1 }
const active = {
  active: true as const,
  rectangle: { x: 100, y: 120, width: 200, height: 160 },
  dragging: false,
  frozen: false,
  revision: 1,
  committedRevision: 1,
  width: 800,
  height: 600,
}
const source = "data:image/png;base64,ORIGINAL_WORKER_ONLY"
const cropped = {
  dataUrl: "data:image/png;base64,CROP_ONLY",
  mimeType: "image/png" as const,
  width: 200,
  height: 160,
}
const sender = {
  id: "extension",
  frameId: 0,
  tab: { id: 1, windowId: 3 },
} as chrome.runtime.MessageSender
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const startRequest = (): RuntimeRequest<"regionCapture.start"> => ({
  kind: "request",
  requestId: "start",
  method: "regionCapture.start",
  params: owner,
  tabContext: context,
})
const stopRequest = (): RuntimeRequest<"regionCapture.stop"> => ({
  ...startRequest(),
  method: "regionCapture.stop",
})
const captureRequest = (): RuntimeRequest<"regionCapture.capture"> => ({
  ...startRequest(),
  method: "regionCapture.capture",
  params: { ...owner, maxBytes: 3_000_000, selectionRevision: active.committedRevision },
})
function fixture() {
  let token = ""
  let state: RegionCaptureState = { ...active }
  const deps = {
    beforeStart: vi.fn(async (): Promise<void> => undefined),
    context: vi.fn(async () => context),
    windowId: vi.fn(async () => 3),
    validate: vi.fn(async (): Promise<void> => undefined),
    execute: vi.fn(async (operation: RegionCaptureOperation, session: { token: string }) => {
      token = session.token
      if (state.active) {
        if (
          operation === "freeze" &&
          !state.frozen &&
          !state.dragging &&
          state.rectangle &&
          state.committedRevision === state.revision
        )
          state = { ...state, frozen: true, revision: state.revision + 1 }
        if (operation === "resume")
          state = {
            ...state,
            frozen: false,
            committedRevision: null,
            revision: state.revision + 1,
          }
      }
      return { ok: true, result: state }
    }),
    cleanup: vi.fn(async (_context: typeof context, _token?: string): Promise<void> => undefined),
    emit: vi.fn(),
    capturePermission: vi.fn(async (_confirmed?: boolean): Promise<void> => undefined),
    capture: vi.fn(async () => ({ dataUrl: source })),
  }
  const worker = new RegionCaptureWorker(deps)
  return {
    deps,
    worker,
    token: () => token,
    state: (value: RegionCaptureState) => {
      state = value
    },
    notification: (value: RegionCaptureState = state) => ({
      kind: "region-capture-state" as const,
      token,
      tabContext: context,
      state: value,
    }),
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("chrome", { runtime: { id: "extension" } })
  vi.mocked(cropRegionPng)
    .mockReset()
    .mockImplementation(async (_source, _rectangle, _viewport, _maxBytes, guard) => {
      await guard()
      return cropped
    })
})
afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe("region capture worker ownership and failure paths", () => {
  test("start and notifications never capture; requested capture returns only the crop", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await f.worker.notification(f.notification(), sender)
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(cropRegionPng).not.toHaveBeenCalled()
    const result = await f.worker.capture(captureRequest())
    expect(result).toEqual({ ...owner, ...cropped })
    expect(JSON.stringify(result)).not.toContain("ORIGINAL_WORKER_ONLY")
    expect(cropRegionPng).toHaveBeenCalledWith(
      source,
      active.rectangle,
      expect.objectContaining({ frozen: true, committedRevision: 1, revision: 2 }),
      3_000_000,
      expect.any(Function),
    )
    expect(f.deps.capture).toHaveBeenCalledOnce()
  })
  test.each(["client", "operation", "context"])(
    "rejects a forged %s without capture",
    async (field) => {
      const f = fixture()
      await f.worker.start(startRequest())
      const request = captureRequest()
      if (field === "context") request.tabContext = { ...context, epoch: 99 }
      else request.params[field === "client" ? "clientId" : "operationId"] = crypto.randomUUID()
      await expect(f.worker.capture(request)).rejects.toThrow()
      expect(f.deps.capture).not.toHaveBeenCalled()
    },
  )
  test.each([
    { ...active, dragging: true, committedRevision: null },
    { ...active, rectangle: null, committedRevision: null },
    { ...active, committedRevision: null },
    { ...active, frozen: true },
  ])("never freezes or captures incomplete selection %j", async (state) => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.state(state)
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(f.deps.capturePermission).not.toHaveBeenCalled()
    expect(f.deps.execute.mock.calls.some(([action]) => action === "freeze")).toBe(false)
  })
  test.each([null, 99])(
    "a forged high-revision hint (commit=%s) cannot authorize capture or poison later selection",
    async (committedRevision) => {
      const f = fixture()
      await f.worker.start(startRequest())
      f.deps.emit.mockClear()
      f.state({ ...active, revision: 5, committedRevision: null })
      await f.worker.notification(
        f.notification({ ...active, revision: 99, committedRevision }),
        sender,
      )
      expect(f.deps.emit).not.toHaveBeenCalled()
      expect(f.deps.capture).not.toHaveBeenCalled()
      expect(f.deps.capturePermission).not.toHaveBeenCalled()
      const request = captureRequest()
      request.params.selectionRevision = 99
      await expect(f.worker.capture(request)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
      expect(f.deps.capturePermission).not.toHaveBeenCalled()
      expect(f.deps.capture).not.toHaveBeenCalled()
      f.state({ ...active, revision: 6, committedRevision: 6 })
      await f.worker.notification(f.notification(), sender)
      expect(f.deps.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ state: expect.objectContaining({ revision: 6 }) }),
        }),
      )
      request.params.selectionRevision = 6
      await expect(f.worker.capture(request)).resolves.toMatchObject(cropped)
      expect(f.deps.capture).toHaveBeenCalledOnce()
    },
  )
  test("a completed hint with forged geometry is not forwarded", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.emit.mockClear()
    await f.worker.notification(
      f.notification({ ...active, rectangle: { ...active.rectangle, x: 50 } }),
      sender,
    )
    expect(f.deps.emit).not.toHaveBeenCalled()
    expect(f.deps.capturePermission).not.toHaveBeenCalled()
    await f.worker.notification(f.notification(), sender)
    expect(f.deps.emit).toHaveBeenCalledOnce()
    expect(f.deps.capture).not.toHaveBeenCalled()
  })
  test("completed geometry compares scalar values across transport property orders", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.emit.mockClear()
    f.state({
      ...active,
      rectangle: { height: 160, width: 200, y: 120, x: 100 },
    })
    await f.worker.notification(f.notification(active), sender)
    expect(f.deps.emit).toHaveBeenCalledOnce()
    await expect(f.worker.capture(captureRequest())).resolves.toMatchObject(cropped)
    expect(f.deps.capture).toHaveBeenCalledOnce()
  })
  test.each([0, 1, 4])(
    "rejects stale or future selection revision %s before consent",
    async (revision) => {
      const f = fixture()
      await f.worker.start(startRequest())
      f.state({ ...active, revision: 3, committedRevision: 3 })
      const request = captureRequest()
      request.params.selectionRevision = revision
      await expect(f.worker.capture(request)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
      expect(f.deps.capturePermission).not.toHaveBeenCalled()
      expect(f.deps.capture).not.toHaveBeenCalled()
    },
  )
  test.each([
    { ...active, revision: 2, committedRevision: 2 },
    { ...active, committedRevision: null },
    { ...active, rectangle: { ...active.rectangle, x: 101 } },
    { ...active, width: 801 },
  ])("rechecks commit and geometry after consent %j", async (changed) => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capturePermission.mockImplementationOnce(async () => {
      expect(f.deps.execute).toHaveBeenLastCalledWith("state", expect.anything())
      f.state(changed)
    })
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "STALE_CONTEXT",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(f.deps.execute.mock.calls.some(([action]) => action === "freeze")).toBe(false)
  })
  test.each([
    { committedRevision: 0 },
    { revision: 3 },
    { rectangle: { ...active.rectangle, x: 101 } },
    { width: 801 },
  ])("binds freeze to the requested commit, rectangle and viewport %j", async (changed) => {
    const f = fixture()
    await f.worker.start(startRequest())
    const execute = f.deps.execute.getMockImplementation()
    if (!execute) throw new Error("Missing fixture execute")
    f.deps.execute.mockImplementation(async (...args) => {
      const value = await execute(...args)
      return args[0] === "freeze" && value.result.active
        ? { ...value, result: { ...value.result, ...changed } }
        : value
    })
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("freeze")
    expect(f.deps.capture).not.toHaveBeenCalled()
  })
  test("requires a frozen painted selection before the native capture", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.execute.mockImplementation(async () => ({ ok: true, result: active }))
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("freeze")
    expect(f.deps.capture).not.toHaveBeenCalled()
  })
  test("permission denial preserves selection and never automatically retries", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capturePermission.mockRejectedValueOnce(
      new RuntimeError("CONFIRMATION_REQUIRED", "confirm"),
    )
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(f.deps.execute.mock.calls.some(([action]) => action === "freeze")).toBe(false)
    expect(f.deps.execute.mock.calls.some(([action]) => action === "resume")).toBe(false)
    await expect(f.worker.capture({ ...captureRequest(), confirmed: true })).resolves.toMatchObject(
      cropped,
    )
    expect(f.deps.capture).toHaveBeenCalledOnce()
  })
  test.each(["native", "crop"])(
    "%s failure clears completion without source fallback or replay",
    async (step) => {
      const f = fixture()
      await f.worker.start(startRequest())
      if (step === "native") f.deps.capture.mockRejectedValueOnce(new Error("capture failed"))
      else vi.mocked(cropRegionPng).mockRejectedValueOnce(new Error("crop failed"))
      await expect(f.worker.capture(captureRequest())).rejects.toThrow("failed")
      expect(f.deps.execute).toHaveBeenLastCalledWith("resume", expect.anything())
      expect(f.deps.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: expect.objectContaining({ frozen: false, committedRevision: null }),
          }),
        }),
      )
      expect(f.deps.capture).toHaveBeenCalledOnce()
      // Even a replayed committed-state hint cannot restore a consumed capture attempt.
      f.state({ ...active })
      await f.worker.notification(f.notification(), sender)
      await expect(f.worker.capture(captureRequest())).rejects.toThrow("already captured")
      expect(f.deps.capture).toHaveBeenCalledOnce()
    },
  )
  test("rechecks the protected commit after freeze and before native capture", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    let checks = 0
    f.deps.capturePermission.mockImplementation(async () => {
      if (++checks === 2) f.state({ ...active, frozen: true, revision: 2, committedRevision: 0 })
    })
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "STALE_CONTEXT",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(cropRegionPng).not.toHaveBeenCalled()
  })
  test("does not replay a consumed attempt if the capture dependency denies its final checks", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockRejectedValueOnce(new RuntimeError("CONFIRMATION_REQUIRED", "confirm"))
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    })
    await expect(f.worker.capture({ ...captureRequest(), confirmed: true })).rejects.toThrow(
      "already captured",
    )
    expect(f.deps.capture).toHaveBeenCalledOnce()
    expect(cropRegionPng).not.toHaveBeenCalled()
  })
  test.each([
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "missing URL", value: {} },
    { label: "non-string URL", value: { dataUrl: 1 } },
  ])("rejects malformed source $label without fallback or replay", async ({ value }) => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockResolvedValueOnce(value as unknown as { dataUrl: string })
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("Invalid region source image")
    expect(cropRegionPng).not.toHaveBeenCalled()
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("already captured")
    expect(f.deps.capture).toHaveBeenCalledOnce()
  })
  test("consumes a revision once before capture, including concurrent or later duplicates", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<{ dataUrl: string }>()
    f.deps.capture.mockReturnValueOnce(gate.promise)
    const pending = f.worker.capture(captureRequest())
    await vi.waitFor(() => expect(f.deps.capture).toHaveBeenCalledOnce())
    const permissionCalls = f.deps.capturePermission.mock.calls.length
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("already captured")
    gate.resolve({ dataUrl: source })
    await pending
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("already captured")
    const stale = captureRequest()
    stale.params.selectionRevision = 0
    await expect(f.worker.capture(stale)).rejects.toThrow("already captured")
    expect(f.deps.capture).toHaveBeenCalledOnce()
    // The crop guards recheck permission, but duplicate requests do not.
    const completedCalls = f.deps.capturePermission.mock.calls.length
    expect(completedCalls).toBeGreaterThanOrEqual(permissionCalls)
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("already captured")
    expect(f.deps.capturePermission).toHaveBeenCalledTimes(completedCalls)
  })
  test("allows only a newer genuine commit after a failed native capture", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockRejectedValueOnce(new Error("capture failed"))
    await expect(f.worker.capture(captureRequest())).rejects.toThrow("capture failed")
    f.state({ ...active, revision: 5, committedRevision: 5 })
    const next = captureRequest()
    next.params.selectionRevision = 5
    await expect(f.worker.capture(next)).resolves.toMatchObject(cropped)
    expect(f.deps.capture).toHaveBeenCalledTimes(2)
    f.state({ ...active, revision: 3, committedRevision: 3 })
    next.params.selectionRevision = 3
    await expect(f.worker.capture(next)).rejects.toThrow("already captured")
    expect(f.deps.capture).toHaveBeenCalledTimes(2)
  })
  test.each([false, true])(
    "screenshot revocation invalidates frozen ownership (pending crop %s)",
    async (pendingCrop) => {
      const f = fixture()
      await f.worker.start(startRequest())
      const gate = deferred<void>()
      if (pendingCrop)
        vi.mocked(cropRegionPng).mockImplementationOnce(async () => {
          await gate.promise
          return cropped
        })
      const pending = f.worker.capture(captureRequest())
      const rejection = pendingCrop
        ? expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
        : undefined
      if (pendingCrop) await vi.waitFor(() => expect(cropRegionPng).toHaveBeenCalled())
      else await pending
      f.deps.capturePermission.mockRejectedValueOnce(
        new RuntimeError("PERMISSION_DENIED", "screenshot revoked"),
      )
      await f.worker.accessChanged()
      gate.resolve()
      await rejection
      expect(f.worker.occupied).toBe(false)
      await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      })
    },
  )
  test("geometry/revision change after capture rejects source before decode", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.capture.mockImplementationOnce(async () => {
      f.state({ ...active, frozen: true, width: 900 })
      return { dataUrl: source }
    })
    await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
      code: "STALE_CONTEXT",
    })
    expect(cropRegionPng).not.toHaveBeenCalled()
    expect(f.deps.cleanup).toHaveBeenLastCalledWith(context, f.token())
  })
  test("cancellation during crop rejects the late crop and cannot resume a replacement", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<void>()
    vi.mocked(cropRegionPng).mockImplementationOnce(async () => {
      await gate.promise
      return cropped
    })
    const pending = f.worker.capture(captureRequest())
    const rejection = expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(cropRegionPng).toHaveBeenCalled())
    await f.worker.stop(stopRequest())
    await f.worker.start({
      ...startRequest(),
      params: { ...owner, operationId: crypto.randomUUID() },
    })
    gate.resolve()
    await rejection
    expect(f.deps.execute.mock.calls.some(([operation]) => operation === "resume")).toBe(false)
  })
  test("stop accepts confirmed removal for the same owner without a second orphan injection", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await f.worker.cancel("access-revoked")
    f.deps.cleanup.mockClear()
    f.deps.cleanup.mockRejectedValue(new Error("Original receiver is gone after confirmed removal"))
    await expect(f.worker.stop(stopRequest())).resolves.toEqual({ active: false })
    expect(f.deps.cleanup).not.toHaveBeenCalled()
  })
  test.each(["client", "operation", "tab", "url", "epoch"])(
    "confirmed removal cannot acknowledge a different %s binding",
    async (field) => {
      const f = fixture()
      await f.worker.start(startRequest())
      await f.worker.cancel("access-revoked")
      f.deps.cleanup.mockRejectedValue(new Error("No new removal confirmation"))
      const request = stopRequest()
      if (field === "tab") request.tabContext = { ...context, tabId: context.tabId + 1 }
      else if (field === "url") request.tabContext = { ...context, url: `${context.url}changed` }
      else if (field === "epoch") request.tabContext = { ...context, epoch: context.epoch + 1 }
      else request.params[field === "client" ? "clientId" : "operationId"] = crypto.randomUUID()
      await expect(f.worker.stop(request)).rejects.toThrow()
    },
  )
  test("stop waits for in-flight removal confirmation and does not clean twice", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.cleanup.mockClear()
    const gate = deferred<void>()
    f.deps.cleanup.mockReturnValueOnce(gate.promise)
    const cancelling = f.worker.cancel("access-revoked")
    let finished = false
    const stopping = f.worker.stop(stopRequest()).then((value) => {
      finished = true
      return value
    })
    await vi.waitFor(() => expect(f.deps.cleanup).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
    gate.resolve()
    await cancelling
    await expect(stopping).resolves.toEqual({ active: false })
    expect(f.deps.cleanup).toHaveBeenCalledOnce()
  })
  test("confirmed removal cannot acknowledge a pending replacement", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await f.worker.cancel("access-revoked")
    const gate = deferred<void>()
    f.deps.beforeStart.mockReturnValueOnce(gate.promise)
    const stopping = f.worker.stop(stopRequest())
    const starting = f.worker.start({
      ...startRequest(),
      params: { ...owner, operationId: crypto.randomUUID() },
    })
    await expect(stopping).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.beforeStart).toHaveBeenCalledTimes(2))
    gate.resolve()
    await starting
  })
  test("reusing owner IDs still requires removal of the new surface", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const previous = f.token()
    await f.worker.cancel("access-revoked")
    await f.worker.start(startRequest())
    expect(f.token()).not.toBe(previous)
    f.deps.cleanup.mockClear()
    await expect(f.worker.stop(stopRequest())).resolves.toEqual({ active: false })
    expect(f.deps.cleanup).toHaveBeenCalledOnce()
    expect(f.deps.cleanup).toHaveBeenCalledWith(context, f.token())
  })
  test("stop during a pending capture discards its late full-viewport result", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<{ dataUrl: string }>()
    f.deps.capture.mockReturnValueOnce(gate.promise)
    const pending = f.worker.capture(captureRequest())
    const rejection = expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.capture).toHaveBeenCalled())
    await f.worker.stop(stopRequest())
    gate.resolve({ dataUrl: source })
    await rejection
    expect(cropRegionPng).not.toHaveBeenCalled()
  })
  test("late permission approval cannot revive a cancelled capture", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<void>()
    f.deps.capturePermission.mockReturnValueOnce(gate.promise)
    const pending = f.worker.capture(captureRequest())
    const rejection = expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.capturePermission).toHaveBeenCalled())
    await f.worker.stop(stopRequest())
    gate.resolve()
    await rejection
    expect(f.deps.capture).not.toHaveBeenCalled()
  })
  test.each(["tab-activated", "window-focus-changed", "access-revoked"] as const)(
    "%s invalidates ownership and cleans original target",
    async (reason) => {
      const f = fixture()
      await f.worker.start(startRequest())
      if (reason === "access-revoked") {
        f.deps.validate.mockRejectedValueOnce(new RuntimeError("PERMISSION_DENIED", "revoked"))
        await f.worker.accessChanged()
      } else f.worker.contextChanged(reason)
      await expect(f.worker.capture(captureRequest())).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      })
      await vi.waitFor(() => expect(f.deps.cleanup).toHaveBeenLastCalledWith(context, f.token()))
    },
  )
  test("target reload and expiry cancel; unrelated navigation does not", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.worker.navigation(99)
    await expect(f.worker.notification(f.notification(), sender)).resolves.toEqual({
      accepted: true,
    })
    f.worker.navigation(1)
    await expect(f.worker.capture(captureRequest())).rejects.toThrow()
    await f.worker.start(startRequest())
    await vi.advanceTimersByTimeAsync(REGION_CAPTURE_LIMITS.lifetimeMs)
    await expect(f.worker.capture(captureRequest())).rejects.toThrow()
    expect(f.deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ reason: "timeout" }) }),
    )
  })
  test("disconnect while window lookup is pending prevents injection", async () => {
    const f = fixture()
    const gate = deferred<number>()
    f.deps.windowId.mockReturnValueOnce(gate.promise)
    const starting = f.worker.start(startRequest())
    const rejection = expect(starting).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.windowId).toHaveBeenCalled())
    f.worker.disconnect(3)
    gate.resolve(3)
    await rejection
    expect(f.deps.execute).not.toHaveBeenCalled()
  })
  test("late setup is cleaned after cancellation before a replacement starts", async () => {
    const f = fixture()
    const gate = deferred<{ ok: boolean; result: typeof active }>()
    f.deps.execute.mockReturnValueOnce(gate.promise)
    const starting = f.worker.start(startRequest())
    const rejection = expect(starting).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.waitFor(() => expect(f.deps.execute).toHaveBeenCalled())
    const stop = f.worker.stop(stopRequest())
    gate.resolve({ ok: true, result: active })
    await rejection
    await stop
    expect(f.deps.cleanup.mock.calls.filter(([, token]) => !!token).length).toBeGreaterThanOrEqual(
      2,
    )
  })
  test("failed cleanup remains occupied and must be confirmed before replacement", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    f.deps.cleanup.mockRejectedValueOnce(new Error("cleanup failed"))
    await expect(f.worker.stop(stopRequest())).rejects.toThrow("cleanup failed")
    expect(f.worker.occupied).toBe(true)
    f.deps.cleanup.mockRejectedValueOnce(new Error("cleanup still failed"))
    await expect(f.worker.stop(stopRequest())).rejects.toThrow("cleanup still failed")
    expect(f.worker.occupied).toBe(true)
    await f.worker.stop(stopRequest())
    expect(f.worker.occupied).toBe(false)
  })
  test("restart cleanup uses original context even if another window is current", async () => {
    const f = fixture()
    f.deps.context.mockResolvedValue({ ...context, tabId: 99 })
    await f.worker.stop(stopRequest())
    expect(f.deps.cleanup).toHaveBeenCalledWith(context)
    expect(f.deps.context).not.toHaveBeenCalled()
  })
  test.each([
    { ...sender, frameId: 1 },
    { ...sender, id: "page" },
    { ...sender, tab: { id: 99 } },
  ])("rejects forged notification sender %j", async (source) => {
    const f = fixture()
    await f.worker.start(startRequest())
    await expect(
      f.worker.notification(f.notification(), source as chrome.runtime.MessageSender),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    expect(f.deps.capture).not.toHaveBeenCalled()
  })
  test.each(["token", "context"])("rejects a notification with stale %s binding", async (field) => {
    const f = fixture()
    await f.worker.start(startRequest())
    const message = f.notification()
    if (field === "token") message.token = crypto.randomUUID()
    else message.tabContext = { ...context, epoch: context.epoch + 1 }
    await expect(f.worker.notification(message, sender)).rejects.toMatchObject({
      code: field === "token" ? "PERMISSION_DENIED" : "STALE_CONTEXT",
    })
    expect(f.deps.capture).not.toHaveBeenCalled()
    expect(f.deps.capturePermission).not.toHaveBeenCalled()
  })
  test("out-of-order notification validation never restores an old rectangle revision", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    const gate = deferred<void>()
    f.deps.validate.mockReturnValueOnce(gate.promise)
    f.state({ ...active, revision: 2, committedRevision: 2 })
    const pending = f.worker.notification(f.notification(), sender)
    f.state({ ...active, revision: 3, committedRevision: 3 })
    await f.worker.notification(f.notification(), sender)
    gate.resolve()
    await pending
    expect(f.deps.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          state: expect.objectContaining({ revision: 3, dragging: false }),
        }),
      }),
    )
  })
})

async function serviceFixture() {
  let listener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (response: unknown) => void,
  ) => boolean
  let revoked: () => void = () => undefined
  let allowed = true
  let state: Extract<RegionCaptureState, { active: true }> = { ...active }
  const tab = { id: 1, url: context.url, windowId: 3, active: true, title: "Fixture" }
  const emit = vi.fn(async () => undefined)
  const script = vi.fn(async (options: { func: { name: string }; args?: unknown[] }) => {
    if (options.func.name === "readDocumentContentType") return [{ result: "text/html" }]
    if (["stopRegionCaptureInjection", "stopPageAnnotationInjection"].includes(options.func.name))
      return [{ result: { ok: true, result: { active: false } } }]
    if (options.func.name === "executeRegionCapture") {
      if (options.args?.[0] === "freeze")
        state = { ...state, frozen: true, revision: state.revision + 1 }
      if (options.args?.[0] === "resume")
        state = { ...state, frozen: false, committedRevision: null, revision: state.revision + 1 }
      return [{ result: { ok: true, result: state } }]
    }
    return []
  })
  const capture = vi.fn(async () => source)
  const panel = {
    id: "extension",
    url: "chrome-extension://extension/src/browser/sidepanel/index.html",
  }
  vi.stubGlobal("chrome", {
    commands: { onCommand: { addListener: vi.fn() } },
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async () => ({
          piBrowserAgentApprovedHostPermissions: ["https://example.test/*"],
        })),
      },
      onChanged: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(async () => allowed),
      getAll: vi.fn(async () => ({ origins: allowed ? ["https://example.test/*"] : [] })),
      onRemoved: {
        addListener: vi.fn((callback) => {
          revoked = callback
        }),
      },
    },
    runtime: {
      id: "extension",
      getURL: (path: string) => `chrome-extension://extension/${path}`,
      getManifest: () => ({ side_panel: { default_path: "src/browser/sidepanel/index.html" } }),
      onConnect: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((callback) => {
          listener = callback
        }),
      },
      sendMessage: emit,
    },
    contextMenus: { onClicked: { addListener: vi.fn() } },
    scripting: { executeScript: script },
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
      sendMessage: vi.fn(async () => undefined),
      captureVisibleTab: capture,
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: vi.fn(async () => ({ focused: true })),
      onFocusChanged: { addListener: vi.fn() },
    },
  })
  await import("../../src/browser/service-worker.js")
  const request = (
    method: string,
    params = owner,
    sender: chrome.runtime.MessageSender = panel,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> =>
    new Promise((resolve) => {
      listener(
        { kind: "request", requestId: crypto.randomUUID(), method, params },
        sender,
        resolve as (response: unknown) => void,
      )
    })
  await request("app.getState", {} as typeof owner)
  return {
    request,
    script,
    capture,
    emit,
    revoke: () => {
      allowed = false
      revoked()
    },
  }
}

describe("service worker region routing", () => {
  test("routes trusted panel requests only, without capture on start", async () => {
    const f = await serviceFixture()
    await expect(f.request("regionCapture.start")).resolves.toMatchObject({ ok: true })
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.script).toHaveBeenCalledWith(
      expect.objectContaining({
        func: expect.objectContaining({ name: "executeRegionCapture" }),
        args: ["start", expect.any(String), expect.any(Object), REGION_CAPTURE_LIMITS],
      }),
    )
    await expect(
      f.request("regionCapture.update", { ...owner, rectangle: active.rectangle } as typeof owner),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    await expect(
      f.request("regionCapture.capture", { ...owner, maxBytes: 3_000_000 } as typeof owner),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    expect(f.capture).not.toHaveBeenCalled()
    await expect(
      f.request("regionCapture.stop", owner, {
        id: "extension",
        url: "chrome-extension://extension/src/browser/sidepanel/index.html?view=settings",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    await expect(f.request("regionCapture.stop")).resolves.toMatchObject({
      ok: true,
      result: { active: false },
    })
    expect(
      f.script.mock.calls
        .filter(([options]) => options.func.name === "stopRegionCaptureInjection")
        .every(([options]) => !options.args?.includes(undefined)),
    ).toBe(true)
  })
  test.each(["selecting", "frozen", "pending-capture", "pending-crop"])(
    "onRemoved invalidates %s and rejects late results",
    async (phase) => {
      const f = await serviceFixture()
      await f.request("regionCapture.start")
      const gate = deferred<void>()
      let pending: ReturnType<typeof f.request> | undefined
      if (phase !== "selecting") {
        if (phase === "pending-capture")
          f.capture.mockImplementationOnce(async () => {
            await gate.promise
            return source
          })
        else
          vi.mocked(cropRegionPng).mockImplementationOnce(async () => {
            await gate.promise
            return cropped
          })
        pending = f.request("regionCapture.capture", {
          ...owner,
          maxBytes: 3_000_000,
          selectionRevision: 1,
        } as typeof owner)
        await vi.waitFor(() =>
          expect(
            phase === "pending-capture" ? f.capture : vi.mocked(cropRegionPng),
          ).toHaveBeenCalled(),
        )
      }
      f.revoke()
      await vi.waitFor(() =>
        expect(f.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "regionCapture.cancelled",
            payload: expect.objectContaining({ reason: "access-revoked" }),
          }),
        ),
      )
      gate.resolve()
      if (pending) await expect(pending).resolves.toMatchObject({ ok: false })
      await vi.waitFor(() =>
        expect(f.script).toHaveBeenCalledWith(
          expect.objectContaining({
            func: expect.objectContaining({ name: "stopRegionCaptureInjection" }),
          }),
        ),
      )
      await expect(
        f.request("regionCapture.capture", {
          ...owner,
          maxBytes: 3_000_000,
          selectionRevision: 1,
        } as typeof owner),
      ).resolves.toMatchObject({ ok: false })
    },
  )
})
