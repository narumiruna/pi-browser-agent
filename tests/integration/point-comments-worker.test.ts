import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { PointCommentsWorker } from "../../src/browser/point-comments-worker.js"
import type { RuntimeRequest } from "../../src/browser/runtime/messages.js"
import type {
  PointCommentsNotification,
  PointCommentTarget,
} from "../../src/browser/runtime/point-comments.js"
import { deferred, pinClientId, pinContext, pointPin } from "../helpers/point-comments.js"

const sender = {
  id: "extension",
  frameId: 0,
  tab: { id: pinContext.tabId },
} as chrome.runtime.MessageSender
const startRequest = (): RuntimeRequest<"pointComments.start"> => ({
  kind: "request",
  requestId: "start",
  method: "pointComments.start",
  params: { clientId: pinClientId, capacity: 5, nextNumber: 1 },
  tabContext: pinContext,
})
const stopRequest = (submit?: true): RuntimeRequest<"pointComments.stop"> => ({
  kind: "request",
  requestId: "stop",
  method: "pointComments.stop",
  params: { clientId: pinClientId, ...(submit ? { submit } : {}) },
  tabContext: pinContext,
})
function fixture() {
  let session: Parameters<ConstructorParameters<typeof PointCommentsWorker>[0]["start"]>[0]
  let targets: PointCommentTarget[] = []
  let sequence = 0
  const deps = {
    beforeStart: vi.fn(async () => undefined),
    context: vi.fn(async () => ({ ...pinContext })),
    windowId: vi.fn(async () => 3),
    validate: vi.fn(async () => undefined),
    start: vi.fn(async (value: typeof session) => {
      session = value
      return { ok: true, result: { started: true } }
    }),
    control: vi.fn(async (_session: typeof session, operation: string, id?: string) => {
      if (operation === "remove" || operation === "reselect")
        targets = targets.filter((target) => target.id !== id)
      if (operation === "clear") targets = []
      return { active: operation !== "submit", sequence, targets }
    }),
    cleanup: vi.fn(
      async (_context: typeof pinContext, _token?: string): Promise<void> => undefined,
    ),
    emit: vi.fn(),
  }
  const worker = new PointCommentsWorker(deps)
  const notification = (number = 1): PointCommentsNotification => {
    const { note: _note, ...target } = pointPin(number)
    return {
      kind: "point-comments-result",
      token: session.token,
      tabContext: pinContext,
      generation: session.mode.generation,
      sequence: sequence + 1,
      status: "selected",
      target,
    }
  }
  const select = async (number = 1) => {
    const message = notification(number)
    await worker.notification(message, sender)
    if (message.status === "selected") targets.push(message.target)
    sequence++
    return message
  }
  return {
    worker,
    deps,
    notification,
    select,
    session: () => session,
    setState: (value: PointCommentTarget[]) => {
      targets = value
    },
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("chrome", { runtime: { id: "extension" } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("point comments worker ownership", () => {
  test("accepts repeated acknowledged selections, shared capacity, and cleanup before submit", async () => {
    const { worker, deps, select } = fixture()
    await worker.start(startRequest())
    for (let n = 1; n <= 5; n++) await select(n)
    expect(
      deps.emit.mock.calls.filter(([event]) => event.name === "pointComments.selected"),
    ).toHaveLength(5)
    const stop = await worker.stop(stopRequest(true))
    expect(stop).toMatchObject({
      active: false,
      targets: expect.arrayContaining([expect.objectContaining({ number: 5 })]),
    })
    expect(deps.control).toHaveBeenLastCalledWith(expect.anything(), "submit")
    expect(deps.validate).toHaveBeenCalled()
  })
  test("rejects wrong sender, frame, token, generation, context and replay", async () => {
    const { worker, notification, select } = fixture()
    await worker.start(startRequest())
    for (const source of [
      { ...sender, id: "page" },
      { ...sender, frameId: 1 },
      { ...sender, tab: { id: 9 } },
    ])
      await expect(
        worker.notification(notification(), source as chrome.runtime.MessageSender),
      ).rejects.toThrow()
    for (const changed of [
      { token: crypto.randomUUID() },
      { generation: 99 },
      { sequence: 2 },
      { tabContext: { ...pinContext, epoch: 9 } },
    ])
      await expect(worker.notification({ ...notification(), ...changed }, sender)).rejects.toThrow()
    const message = await select()
    await expect(worker.notification(message, sender)).rejects.toThrow("Out-of-order")
  })
  test("rejects duplicate IDs, wrong display numbers, excess targets and foreign page URLs", async () => {
    for (const transform of [
      (message: PointCommentsNotification) =>
        message.status === "selected"
          ? { ...message, target: { ...message.target, number: 3 } }
          : message,
      (message: PointCommentsNotification) =>
        message.status === "selected"
          ? {
              ...message,
              target: {
                ...message.target,
                context: { ...message.target.context, pageUrl: "https://other.test/" },
              },
            }
          : message,
    ]) {
      const f = fixture()
      await f.worker.start(startRequest())
      await expect(f.worker.notification(transform(f.notification()), sender)).rejects.toThrow()
      await f.worker.stop(stopRequest())
    }
    const f = fixture()
    await f.worker.start(startRequest())
    await f.select()
    const duplicate = f.notification(1)
    await expect(f.worker.notification(duplicate, sender)).rejects.toThrow()
    await f.worker.stop(stopRequest())
  })
  test("remove, clear and reselect retain numbering and only explicit replacement UUIDs", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await f.select()
    await f.worker.control({
      kind: "request",
      requestId: "reselect",
      method: "pointComments.reselect",
      params: { clientId: pinClientId, id: pointPin().id, number: 1 },
      tabContext: pinContext,
    })
    f.setState([])
    await f.select(1)
    await f.worker.control({
      kind: "request",
      requestId: "remove",
      method: "pointComments.remove",
      params: { clientId: pinClientId, id: pointPin().id },
      tabContext: pinContext,
    })
    await f.worker.control({
      kind: "request",
      requestId: "clear",
      method: "pointComments.clear",
      params: { clientId: pinClientId },
      tabContext: pinContext,
    })
    await expect(f.worker.stop(stopRequest(true))).resolves.toEqual({ active: false, targets: [] })
  })
  test("early selection is accepted before a delayed startup response", async () => {
    const f = fixture()
    const implementation = f.deps.start.getMockImplementation()
    f.deps.start.mockImplementation(async (session) => {
      await implementation?.(session)
      await f.select()
      return { ok: true, result: { started: true } }
    })
    await f.worker.start(startRequest())
    expect(f.deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pointComments.selected" }),
    )
    await f.worker.stop(stopRequest())
  })
  test("stop waits for late setup and cleans again by original token", async () => {
    const f = fixture()
    const gate = deferred<void>()
    const implementation = f.deps.start.getMockImplementation()
    f.deps.start.mockImplementation(async (session) => {
      await implementation?.(session)
      await gate.promise
      return { ok: true, result: { started: true } }
    })
    const started = f.worker.start(startRequest()).catch((error) => error)
    await vi.waitFor(() => expect(f.deps.start).toHaveBeenCalled())
    const stopped = f.worker.stop(stopRequest())
    gate.resolve()
    expect(await started).toBeInstanceOf(Error)
    await stopped
    expect(
      f.deps.cleanup.mock.calls.filter(([, token]) => token === f.session().token),
    ).toHaveLength(2)
  })
  test("a rejected cleanup cannot be treated as a prepared submission", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await f.select()
    f.deps.control.mockRejectedValueOnce(new Error("Unconfirmed removal"))
    await expect(f.worker.stop(stopRequest(true))).rejects.toThrow("Unconfirmed")
    await expect(f.worker.stop(stopRequest())).resolves.toEqual({ active: false })
  })
  test("tab change while submission cleanup is pending prevents a late success", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await f.select()
    const gate = deferred<void>()
    const control = f.deps.control.getMockImplementation()
    if (!control) throw new Error("Missing control implementation")
    f.deps.control.mockImplementationOnce(async (session, operation) => {
      await gate.promise
      return control(session, operation)
    })
    const submitting = f.worker.stop(stopRequest(true))
    await vi.waitFor(() => expect(f.deps.control).toHaveBeenCalledWith(expect.anything(), "submit"))
    f.deps.validate.mockRejectedValue(new Error("Stale context"))
    f.worker.contextChanged("tab-activated")
    gate.resolve()
    await expect(submitting).rejects.toThrow()
  })
  test.each(["navigation", "focus", "disconnect", "access", "expiry"])(
    "%s invalidates ownership and late results",
    async (reason) => {
      const f = fixture()
      await f.worker.start(startRequest())
      const message = f.notification()
      if (reason === "navigation") f.worker.navigation(pinContext.tabId)
      if (reason === "focus") f.worker.contextChanged("window-focus-changed")
      if (reason === "disconnect") f.worker.disconnect(3)
      if (reason === "access") {
        f.deps.validate.mockRejectedValue(new Error("revoked"))
        await f.worker.accessChanged()
      }
      if (reason === "expiry") await vi.advanceTimersByTimeAsync(300_000)
      await expect(f.worker.notification(message, sender)).rejects.toThrow()
      await f.worker.stop(stopRequest()).catch(() => undefined)
      expect(f.deps.cleanup).toHaveBeenCalledWith(pinContext, expect.any(String))
    },
  )
  test("background navigation does not cancel startup; target disconnect before window lookup does", async () => {
    const f = fixture()
    const gate = deferred<number>()
    f.deps.windowId.mockImplementationOnce(() => gate.promise)
    const start = f.worker.start(startRequest())
    await vi.waitFor(() => expect(f.deps.windowId).toHaveBeenCalled())
    f.worker.navigation(99)
    f.worker.disconnect(3)
    gate.resolve(3)
    await expect(start).rejects.toThrow()
    expect(f.deps.start).not.toHaveBeenCalled()
  })
  test("wrong client cannot stop or change another session", async () => {
    const f = fixture()
    await f.worker.start(startRequest())
    await expect(
      f.worker.stop({ ...stopRequest(), params: { clientId: crypto.randomUUID() } }),
    ).rejects.toThrow()
    await expect(
      f.worker.control({
        kind: "request",
        requestId: "clear",
        method: "pointComments.clear",
        params: { clientId: crypto.randomUUID() },
        tabContext: pinContext,
      }),
    ).rejects.toThrow()
    await f.worker.stop(stopRequest())
  })
})
