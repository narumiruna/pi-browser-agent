import { describe, expect, test } from "vitest"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"

describe("internal runtime messages", () => {
  test("accepts a known, JSON-safe request", () => {
    expect(
      parseRuntimeRequest({
        kind: "request",
        requestId: "request-1",
        method: "page.type",
        params: { selector: "#title", text: "hello" },
        tabContext: { tabId: 1, url: "https://example.test", epoch: 2 },
      }),
    ).toMatchObject({ method: "page.type" })
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
    { kind: "event", name: "tab.changed", payload: {} },
  ])("rejects malformed or unknown message %#", (message) => {
    expect(() => parseRuntimeRequest(message)).toThrow("Malformed or unknown")
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
