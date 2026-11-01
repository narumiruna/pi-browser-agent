import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { SelectedElementContext } from "../../src/browser/runtime/element-context.js"
import type { RuntimeEvent, sendRuntimeRequest } from "../../src/browser/runtime/messages.js"
import type { JsonValue } from "../../src/browser/runtime/types.js"
import { PointCommentsController } from "../../src/browser/sidepanel/point-comments.js"
import { deferred, pinContext, pointContext, pointPin } from "../helpers/point-comments.js"

let dom: JSDOM
afterEach(() => {
  dom?.window.close()
  vi.unstubAllGlobals()
})
function setup() {
  dom = new JSDOM('<button id="point-comments"></button><div id="point-comment-cards"></div>')
  vi.stubGlobal("document", dom.window.document)
  let clientId = ""
  let sequence = 0
  const request = vi.fn<typeof sendRuntimeRequest>(
    async (method, params = {}): Promise<JsonValue> => {
      if (method === "pointComments.start") {
        clientId = String(params.clientId)
        sequence = 0
        return { active: true, clientId, generation: 1 }
      }
      if (method === "pointComments.stop" && params.submit)
        return {
          active: false,
          targets: controller.snapshot().map(({ note: _note, ...target }) => target),
        }
      return { active: false }
    },
  )
  const options = {
    getContext: vi.fn(async () => pinContext),
    getElements: vi.fn((): SelectedElementContext[] => []),
    requestSiteAccess: vi.fn(async () => true),
    canStart: vi.fn(() => true),
    onChange: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
    appendText: vi.fn(),
    request,
  }
  const controller = new PointCommentsController(options)
  const selected = (number = 1, id = pointPin(number).id): RuntimeEvent => {
    const { note: _note, ...target } = pointPin(number, { id })
    return {
      kind: "event",
      name: "pointComments.selected",
      tabContext: pinContext,
      payload: { clientId, sequence: ++sequence, generation: 1, target },
    }
  }
  const select = (number = 1, id = pointPin(number).id) => controller.onEvent(selected(number, id))
  function input(value: string, index = 0) {
    const note = dom.window.document.querySelectorAll("textarea")[index]
    if (!note) throw new Error("Missing note")
    note.value = value
    note.dispatchEvent(new dom.window.Event("input"))
    return note
  }
  return { controller, options, request, selected, select, input, client: () => clientId }
}

describe("point comments panel cards", () => {
  test("notes retain DOM identity, keyboard focus, UUID and number across other edits and removal", async () => {
    const f = setup()
    await f.controller.start()
    f.select(1)
    f.select(2)
    f.select(3)
    const note = f.input("First note")
    note.focus()
    f.controller.refresh()
    expect(document.activeElement).toBe(note)
    expect(document.querySelector("textarea")).toBe(note)
    await f.controller.remove(pointPin(2).id)
    expect(f.controller.pins.map((pin) => pin.number)).toEqual([1, 3])
    expect(f.controller.pins[0]?.note).toBe("First note")
    expect(document.activeElement?.id).toBe("point-comments")
  })
  test("shared capacity includes ordinary contexts, and notes have a UTF-16 limit", async () => {
    const f = setup()
    f.options.getElements.mockReturnValue([pointContext()])
    await f.controller.start()
    expect(f.request).toHaveBeenCalledWith(
      "pointComments.start",
      expect.objectContaining({ capacity: 4 }),
      { tabContext: pinContext },
    )
    f.select()
    f.input("😀".repeat(257))
    expect(f.controller.pins[0]?.note.length).toBe(512)
    expect(document.querySelector("textarea")?.maxLength).toBe(512)
  })
  test("cancel strips metadata, retains notes and blocks snapshot until remove/reselect/conversion", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.input("Only this user note")
    await f.controller.stop()
    expect(f.controller.pins[0]).toMatchObject({
      note: "Only this user note",
      active: false,
      context: undefined,
    })
    expect(f.controller.sendBlocked).toBe(true)
    expect(() => f.controller.snapshot()).toThrow("inactive")
    await f.controller.convert(pointPin().id)
    expect(f.options.appendText).toHaveBeenCalledWith("Only this user note")
    expect(f.controller.pins).toHaveLength(0)
  })
  test("explicit reselect retains the stable UUID, number and note", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.input("Keep note")
    await f.controller.reselect(pointPin().id)
    expect(f.controller.pins[0]?.active).toBe(false)
    f.select(1)
    expect(f.controller.pins[0]).toMatchObject({
      id: pointPin().id,
      number: 1,
      note: "Keep note",
      active: true,
    })
    expect(f.request).toHaveBeenCalledWith(
      "pointComments.reselect",
      { clientId: f.client(), id: pointPin().id, number: 1 },
      { tabContext: pinContext },
    )
  })
  test("inactive-card reselect starts a fresh session with explicit replacement identity", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    await f.controller.stop()
    await f.controller.reselect(pointPin().id)
    expect(f.request).toHaveBeenLastCalledWith(
      "pointComments.start",
      expect.objectContaining({ replace: { id: pointPin().id, number: 1 }, nextNumber: 2 }),
      { tabContext: pinContext },
    )
    f.select()
    expect(f.controller.pins).toHaveLength(1)
  })
  test("site denial and a cancelled delayed permission reply cannot install a surface", async () => {
    const f = setup()
    const gate = deferred<boolean>()
    f.options.requestSiteAccess.mockImplementationOnce(() => gate.promise)
    const start = f.controller.start()
    await vi.waitFor(() => expect(f.options.requestSiteAccess).toHaveBeenCalled())
    await f.controller.stop()
    gate.resolve(true)
    await start
    expect(f.request.mock.calls.some(([method]) => method === "pointComments.start")).toBe(false)
    f.options.requestSiteAccess.mockResolvedValue(false)
    await expect(f.controller.start()).rejects.toThrow("Site access")
  })
  test("malformed runtime events cannot break the card controller", () => {
    const f = setup()
    for (const event of [
      { kind: "event" },
      { kind: "event", name: "pointComments.selected", payload: null },
    ])
      expect(() => f.controller.onEvent(event as unknown as RuntimeEvent)).not.toThrow()
    expect(f.controller.pins).toHaveLength(0)
    expect(f.options.onError).not.toHaveBeenCalled()
  })
  test("access denial before dispatch never requires inaccessible orphan cleanup", async () => {
    const f = setup()
    f.options.requestSiteAccess.mockResolvedValue(false)
    f.request.mockRejectedValue(new Error("No script permission"))
    await expect(f.controller.start()).rejects.toThrow("Site access")
    expect(f.request).not.toHaveBeenCalled()
    expect(f.controller.occupied).toBe(false)
    expect(f.controller.sendBlocked).toBe(false)
    expect(f.controller.pins).toHaveLength(0)
  })
  test("malformed, stale, duplicate and out-of-order events cannot revive cards", async () => {
    const f = setup()
    await f.controller.start()
    const old = f.selected()
    f.controller.onEvent({ ...old, payload: { ...old.payload, clientId: crypto.randomUUID() } })
    expect(f.controller.pins).toHaveLength(0)
    f.controller.onEvent(old)
    f.controller.onEvent(old)
    await vi.waitFor(() => expect(f.controller.active).toBe(false))
    expect(f.controller.pins[0]?.active).toBe(false)
    expect(f.options.onError).toHaveBeenCalled()
  })
  test("unconfirmed cleanup blocks Send even after all cards are removed", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.request.mockRejectedValueOnce(new Error("Cannot remove"))
    await expect(f.controller.stop()).rejects.toThrow("cleanup")
    await f.controller.remove(pointPin().id)
    expect(f.controller.sendBlocked).toBe(true)
    await f.controller.stop()
    expect(f.controller.sendBlocked).toBe(false)
  })
  test("submission snapshot is immutable; accepted IDs do not clear newer notes", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.input("Original note")
    const snapshot = f.controller.snapshot()
    f.request.mockResolvedValueOnce({
      active: false,
      targets: snapshot.map(({ note: _note, ...target }) => target),
    })
    const prepared = await f.controller.prepareSubmission(new AbortController().signal)
    expect(prepared[0]?.note).toBe("Original note")
    expect(f.controller.pins[0]?.active).toBe(false)
    f.input("Newer note")
    f.controller.accept(new Set([pointPin().id]))
    expect(f.controller.pins[0]?.note).toBe("Newer note")
  })
  test("only submitted accepted IDs clear, and preparation failure keeps notes", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.input("Retain me")
    f.request.mockRejectedValueOnce(new Error("Stale target"))
    await expect(f.controller.prepareSubmission(new AbortController().signal)).rejects.toThrow(
      "Stale target",
    )
    expect(f.controller.pins[0]?.note).toBe("Retain me")
    expect(f.controller.pins[0]?.active).toBe(false)
  })
  test("Escape/abort during cleanup rejects late preparation and leaves notes inactive", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.input("Retained")
    const snapshot = f.controller.snapshot()
    const gate = deferred<JsonValue>()
    f.request.mockImplementationOnce(async () => gate.promise)
    const abort = new AbortController()
    const preparing = f.controller.prepareSubmission(abort.signal)
    abort.abort()
    gate.resolve({ active: false, targets: snapshot.map(({ note: _note, ...target }) => target) })
    await expect(preparing).rejects.toThrow("cancelled")
    expect(f.controller.pins[0]?.note).toBe("Retained")
    expect(f.controller.sendBlocked).toBe(true)
  })
  test("disconnect and context change request original-target cleanup without automatic restart", async () => {
    const f = setup()
    await f.controller.start()
    f.select()
    f.controller.disconnected()
    await vi.waitFor(() => expect(f.controller.active).toBe(false))
    expect(f.request).toHaveBeenLastCalledWith(
      "pointComments.stop",
      { clientId: f.client() },
      { tabContext: pinContext },
    )
    expect(f.controller.pins[0]?.context).toBeUndefined()
  })
})
