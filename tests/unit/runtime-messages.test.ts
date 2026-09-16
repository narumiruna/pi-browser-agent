import { afterEach, describe, expect, test, vi } from "vitest"
import { parseRuntimeRequest, sendRuntimeRequest } from "../../src/browser/runtime/messages.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("internal runtime messages", () => {
  test("accepts known, JSON-safe requests", () => {
    expect(
      parseRuntimeRequest({
        kind: "request",
        requestId: "request-1",
        method: "page.type",
        params: { selector: "#title", text: "hello" },
        tabContext: { tabId: 1, url: "https://example.test", epoch: 2 },
      }),
    ).toMatchObject({ method: "page.type" })
    expect(
      parseRuntimeRequest({
        kind: "request",
        requestId: "request-2",
        method: "selection.takePending",
        params: { windowId: 3 },
      }),
    ).toMatchObject({ method: "selection.takePending", params: { windowId: 3 } })
  })

  test.each([
    { kind: "request", requestId: "1", method: "unknown", params: {} },
    { kind: "request", requestId: "1", method: "page.type", params: { value: Number.NaN } },
    { kind: "request", requestId: "1", method: "page.type", params: { selector: "#x" } },
    {
      kind: "request",
      requestId: "1",
      method: "page.click",
      params: { selector: "#x", extra: true },
    },
    { kind: "request", requestId: "", method: "page.type", params: {} },
    { kind: "request", requestId: "1", method: "selection.takePending", params: {} },
    { kind: "event", name: "tab.changed", payload: {} },
  ])("rejects malformed or unknown message %#", (message) => {
    expect(() => parseRuntimeRequest(message)).toThrow("Malformed or unknown")
  })

  test("rejects a response that completes after cancellation", async () => {
    let complete: ((value: unknown) => void) | undefined
    const response = new Promise((resolve) => {
      complete = resolve
    })
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { method: string }) =>
          message.method === "requests.cancel"
            ? Promise.resolve({ ok: true, result: { cancelled: true } })
            : response,
        ),
      },
    })
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "request-id") })
    const controller = new AbortController()
    const pending = sendRuntimeRequest("app.getState", {}, { signal: controller.signal })

    controller.abort()
    complete?.({ ok: true, result: { tabContext: null } })

    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
  })

  test("rejects prototype-polluting keys", () => {
    const params = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}')
    expect(() =>
      parseRuntimeRequest({
        kind: "request",
        requestId: "1",
        method: "page.type",
        params,
      }),
    ).toThrow("Malformed or unknown")
  })
})
