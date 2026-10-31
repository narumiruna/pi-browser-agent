import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { setLanguagePreference } from "../../src/browser/i18n/index.js"
import type { RuntimeEvent, sendRuntimeRequest } from "../../src/browser/runtime/messages.js"
import { type JsonValue, RuntimeError } from "../../src/browser/runtime/types.js"
import { PageAnnotationController } from "../../src/browser/sidepanel/page-annotation.js"
import { element } from "../../src/browser/sidepanel/ui.js"

const context = { tabId: 7, url: "https://example.test/", epoch: 2 }
const blank = {
  active: true as const,
  hasStrokes: false,
  drawing: false,
  frozen: false,
  revision: 0,
  width: 900,
  height: 700,
}
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
let dom: JSDOM

afterEach(() => {
  dom?.window.close()
  setLanguagePreference("en")
  vi.unstubAllGlobals()
})

function setup() {
  dom = new JSDOM(`<button id="page-pen"></button>
    <select id="page-pen-color">${["red", "yellow", "green", "blue", "white", "black"].map((color) => `<option value="${color}">${color}</option>`).join("")}</select>
    <div id="page-pen-controls"><input id="page-pen-width" type="range" min="2" max="32">
    <button id="page-pen-undo"></button><button id="page-pen-clear"></button><button id="page-pen-cancel"></button></div>`)
  vi.stubGlobal("document", dom.window.document)
  let clientId = ""
  const request = vi.fn<typeof sendRuntimeRequest>(async (method, params): Promise<JsonValue> => {
    if (method === "pageAnnotation.start") {
      clientId = String(params?.clientId)
      return { clientId, state: blank }
    }
    if (method === "pageAnnotation.update")
      return { clientId, state: { ...blank, hasStrokes: true, revision: 3 } }
    if (method === "pageAnnotation.capture")
      return {
        clientId,
        dataUrl: `data:image/png;base64,${png}`,
        mimeType: "image/png",
        tabContext: context,
      }
    return { active: false }
  })
  const options = {
    getContext: vi.fn(async () => context),
    requestSiteAccess: vi.fn(async () => true),
    canStart: vi.fn(() => true),
    onChange: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
    request,
  }
  const controller = new PageAnnotationController(options)
  const event = (state = { ...blank, hasStrokes: true, revision: 2 }): RuntimeEvent => ({
    kind: "event",
    name: "pageAnnotation.changed",
    tabContext: context,
    payload: { clientId, state },
  })
  const marks = () => controller.onEvent(event())
  return {
    controller,
    options,
    request,
    event,
    marks,
    clientId: () => clientId,
    document: dom.window.document,
  }
}

function getRequestImplementation(request: {
  getMockImplementation: () => typeof sendRuntimeRequest | undefined
}) {
  const implementation = request.getMockImplementation()
  if (!implementation) throw new Error("Missing request mock")
  return implementation
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("page annotation panel controller", () => {
  test("renders native named palette and starts with fixed settings", async () => {
    const { controller, request, document, marks } = setup()
    expect(document.querySelector("#page-pen")?.getAttribute("aria-label")).toBe("Draw on page")
    expect(document.querySelector("#page-pen-color")?.getAttribute("aria-label")).toBe("Pen color")
    expect([...document.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Red",
      "Yellow",
      "Green",
      "Blue",
      "White",
      "Black",
    ])
    await controller.toggle()
    expect(request).toHaveBeenCalledWith(
      "pageAnnotation.start",
      expect.objectContaining({ color: "red", width: 8 }),
      { tabContext: context },
    )
    expect(controller.active).toBe(true)
    expect(controller.hasMarks).toBe(false)
    marks()
    expect(controller.hasMarks).toBe(true)
    expect(controller.sendBlocked).toBe(false)
  })

  test("does not request permissions or inject while unavailable", async () => {
    const { controller, options, request } = setup()
    options.canStart.mockReturnValue(false)
    controller.refresh()
    expect(dom.window.document.querySelector<HTMLButtonElement>("#page-pen")?.disabled).toBe(true)
    await expect(controller.toggle()).rejects.toThrow("Wait for the current operation")
    expect(options.requestSiteAccess).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  test("site denial cleans up without installing a surface", async () => {
    const { controller, options, request } = setup()
    options.requestSiteAccess.mockResolvedValue(false)
    await expect(controller.toggle()).rejects.toThrow("Site access is required")
    expect(request.mock.calls.some(([method]) => method === "pageAnnotation.start")).toBe(false)
    expect(controller.occupied).toBe(false)
  })

  test("late site approval cannot restart cancelled drawing", async () => {
    const { controller, options, request } = setup()
    const gate = deferred<boolean>()
    options.requestSiteAccess.mockReturnValue(gate.promise)
    const starting = controller.toggle()
    await vi.waitFor(() => expect(options.requestSiteAccess).toHaveBeenCalled())
    await controller.stop()
    gate.resolve(true)
    await starting
    expect(request.mock.calls.some(([method]) => method === "pageAnnotation.start")).toBe(false)
    expect(controller.occupied).toBe(false)
  })

  test("a changed page cannot receive a pending start", async () => {
    const { controller, options, request } = setup()
    options.getContext
      .mockResolvedValueOnce(context)
      .mockResolvedValue({ ...context, url: "https://other.test/" })
    await expect(controller.toggle()).rejects.toThrow("page changed before drawing")
    expect(request.mock.calls.some(([method]) => method === "pageAnnotation.start")).toBe(false)
  })

  test("ignores other owners, contexts, and older revisions", async () => {
    const { controller, event } = setup()
    await controller.toggle()
    controller.onEvent({
      ...event(),
      payload: { ...event().payload, clientId: crypto.randomUUID() },
    })
    controller.onEvent({ ...event(), tabContext: { ...context, epoch: 9 } })
    expect(controller.hasMarks).toBe(false)
    controller.onEvent(event({ ...blank, hasStrokes: true, drawing: true, revision: 4 }))
    controller.onEvent(event({ ...blank, revision: 1 }))
    expect(controller.hasMarks).toBe(true)
    expect(controller.sendBlocked).toBe(true)
  })

  test("updates color and width through validated control actions", async () => {
    const { controller, request } = setup()
    await controller.toggle()
    const colors = element<HTMLSelectElement>("page-pen-color")
    colors.value = "blue"
    colors.dispatchEvent(new dom.window.Event("change"))
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pageAnnotation.update",
        expect.objectContaining({ action: "color", color: "blue" }),
        expect.anything(),
      ),
    )
    await vi.waitFor(() => expect(controller.sendBlocked).toBe(false))
    const width = element<HTMLInputElement>("page-pen-width")
    width.value = "12"
    width.dispatchEvent(new dom.window.Event("input"))
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pageAnnotation.update",
        expect.objectContaining({ action: "width", width: 12 }),
        expect.anything(),
      ),
    )
  })

  test("restores palette focus after an update without stealing newer focus", async () => {
    const { controller, request } = setup()
    await controller.toggle()
    const original = getRequestImplementation(request)
    const colors = element<HTMLSelectElement>("page-pen-color")
    for (const moveFocus of [false, true]) {
      const gate = deferred<undefined>()
      request.mockImplementationOnce(async (...args): Promise<JsonValue> => {
        await gate.promise
        return original(...args)
      })
      colors.focus()
      colors.value = moveFocus ? "green" : "blue"
      colors.dispatchEvent(new dom.window.Event("change"))
      colors.blur()
      const cancel = element<HTMLButtonElement>("page-pen-cancel")
      if (moveFocus) cancel.focus()
      gate.resolve(undefined)
      await vi.waitFor(() => expect(controller.sendBlocked).toBe(false))
      expect(dom.window.document.activeElement).toBe(moveFocus ? cancel : colors)
    }
  })

  test("empty drawing does not capture", async () => {
    const { controller, request } = setup()
    await controller.toggle()
    await expect(
      controller.capture(new AbortController().signal, async () => true),
    ).rejects.toThrow("Add a mark")
    expect(request.mock.calls.some(([method]) => method === "pageAnnotation.capture")).toBe(false)
  })

  test("returns only a locally decoded PNG for the captured owner", async () => {
    const { controller, marks } = setup()
    await controller.toggle()
    marks()
    const blob = await controller.capture(new AbortController().signal, async () => true)
    expect(blob.type).toBe("image/png")
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.from(atob(png), (value) => value.charCodeAt(0)),
    )
  })

  test("requests screenshot confirmation explicitly and retries capture only after grant", async () => {
    const { controller, marks, request } = setup()
    await controller.toggle()
    marks()
    const original = getRequestImplementation(request)
    let captures = 0
    request.mockImplementation(async (...args): Promise<JsonValue> => {
      if (args[0] === "pageAnnotation.capture" && captures++ === 0) {
        throw new RuntimeError("CONFIRMATION_REQUIRED", "Allow screenshot", {
          requiredPermission: "<all_urls>",
        })
      }
      return original(...args)
    })
    const confirm = vi.fn(async () => true)
    await controller.capture(new AbortController().signal, confirm)
    expect(confirm).toHaveBeenCalledOnce()
    expect(captures).toBe(2)
    expect(request).toHaveBeenLastCalledWith(
      "pageAnnotation.capture",
      expect.anything(),
      expect.objectContaining({ confirmed: true, tabContext: context }),
    )
  })

  test("capture failure resumes safe editable marks and reports a fixed local error", async () => {
    const { controller, marks, request } = setup()
    await controller.toggle()
    marks()
    const original = getRequestImplementation(request)
    request.mockImplementation(async (...args): Promise<JsonValue> => {
      if (args[0] === "pageAnnotation.capture") throw new Error("untrusted page diagnostic")
      return original(...args)
    })
    await expect(
      controller.capture(new AbortController().signal, async () => true),
    ).rejects.toThrow("Could not capture page drawing")
    expect(request).toHaveBeenLastCalledWith(
      "pageAnnotation.update",
      expect.objectContaining({ action: "resume" }),
      { tabContext: context },
    )
    expect(controller.hasMarks).toBe(true)
    expect(controller.sendBlocked).toBe(false)
  })

  test("permission cancellation does not capture again", async () => {
    const { controller, marks, request } = setup()
    await controller.toggle()
    marks()
    const original = getRequestImplementation(request)
    request.mockImplementation(async (...args): Promise<JsonValue> => {
      if (args[0] === "pageAnnotation.capture")
        throw new RuntimeError("CONFIRMATION_REQUIRED", "Allow screenshot")
      return original(...args)
    })
    await expect(
      controller.capture(new AbortController().signal, async () => false),
    ).rejects.toThrow("Could not capture")
    expect(
      request.mock.calls.filter(([method]) => method === "pageAnnotation.capture"),
    ).toHaveLength(1)
  })

  test("late capture cannot deliver a cancelled image", async () => {
    const { controller, marks, request } = setup()
    await controller.toggle()
    marks()
    const gate = deferred<Awaited<ReturnType<typeof sendRuntimeRequest>>>()
    const original = getRequestImplementation(request)
    request.mockImplementation(
      async (...args): Promise<JsonValue> =>
        args[0] === "pageAnnotation.capture" ? gate.promise : original(...args),
    )
    const result = controller.capture(new AbortController().signal, async () => true)
    const rejection = expect(result).rejects.toThrow()
    await controller.stop()
    gate.resolve({
      clientId: "old",
      dataUrl: `data:image/png;base64,${png}`,
      mimeType: "image/png",
      tabContext: context,
    })
    await rejection
    expect(controller.occupied).toBe(false)
  })

  test.each([
    "https://page.test/image.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,%%%%",
  ])("rejects invalid capture data %s without fetching", async (dataUrl) => {
    const { controller, marks, request, clientId } = setup()
    await controller.toggle()
    marks()
    const original = getRequestImplementation(request)
    request.mockImplementation(
      async (...args): Promise<JsonValue> =>
        args[0] === "pageAnnotation.capture"
          ? { clientId: clientId(), dataUrl, mimeType: "image/png", tabContext: context }
          : original(...args),
    )
    await expect(
      controller.capture(new AbortController().signal, async () => true),
    ).rejects.toThrow("Could not capture")
  })

  test("cleanup retains the original document even after another window becomes visible", async () => {
    const { controller, request, options } = setup()
    await controller.toggle()
    options.getContext.mockResolvedValue({ tabId: 99, url: "https://other.test/", epoch: 6 })
    await controller.stop(false)
    expect(request).toHaveBeenLastCalledWith("pageAnnotation.stop", expect.anything(), {
      tabContext: context,
    })
  })

  test("cleanup failure blocks Send until a confirmed retry", async () => {
    const { controller, request, marks } = setup()
    await controller.toggle()
    marks()
    request.mockRejectedValueOnce(new Error("worker unavailable"))
    await expect(controller.stop(false)).rejects.toThrow("Could not confirm drawing cleanup")
    expect(controller.occupied).toBe(true)
    expect(controller.sendBlocked).toBe(true)
    await controller.stop(false)
    expect(controller.occupied).toBe(false)
  })

  test("intentional cleanup before submission does not cancel the submission guard", async () => {
    const { controller, request, options, clientId } = setup()
    await controller.toggle()
    const original = getRequestImplementation(request)
    request.mockImplementation(async (...args): Promise<JsonValue> => {
      if (args[0] === "pageAnnotation.stop")
        controller.onEvent({
          kind: "event",
          name: "pageAnnotation.cancelled",
          tabContext: context,
          payload: { clientId: clientId(), state: { active: false }, reason: "user" },
        })
      return original(...args)
    })
    await controller.stop(false)
    expect(options.onCancel).not.toHaveBeenCalled()
  })

  test("protection loss invalidates submission and stale notifications cannot revive it", async () => {
    const { controller, options, event, clientId } = setup()
    await controller.toggle()
    controller.onEvent({
      kind: "event",
      name: "pageAnnotation.cancelled",
      tabContext: context,
      payload: { clientId: clientId(), reason: "protection-lost", state: { active: false } },
    })
    controller.onEvent(event())
    expect(options.onCancel).toHaveBeenCalledOnce()
    expect(options.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("protection changed") }),
    )
    await vi.waitFor(() => expect(controller.occupied).toBe(false))
  })

  test("a cancellation notification is not cleanup confirmation", async () => {
    const { controller, request, clientId } = setup()
    await controller.toggle()
    request.mockRejectedValueOnce(new Error("cleanup failed"))
    controller.onEvent({
      kind: "event",
      name: "pageAnnotation.cancelled",
      tabContext: context,
      payload: { clientId: clientId(), reason: "user", state: { active: false } },
    })
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pageAnnotation.stop",
        expect.anything(),
        expect.anything(),
      ),
    )
    expect(controller.occupied).toBe(true)
    expect(controller.sendBlocked).toBe(true)
    await controller.stop(false)
    expect(controller.occupied).toBe(false)
  })
})
