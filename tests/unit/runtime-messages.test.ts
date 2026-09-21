import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest"
import { parseRuntimeRequest, sendRuntimeRequest } from "../../src/browser/runtime/messages.js"
import type { ElementTarget } from "../../src/browser/runtime/types.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("internal runtime messages", () => {
  test("carries the parsed method through parameter narrowing", () => {
    const request = parseRuntimeRequest({
      kind: "request",
      requestId: "1",
      method: "page.type",
      params: { selector: "#x", text: "" },
    })
    if (request.method === "page.type") {
      expectTypeOf(request.params).toEqualTypeOf<ElementTarget & { text: string }>()
    } else if (request.method === "bookmarks.search") {
      expectTypeOf(request.params).toEqualTypeOf<{ query: string; limit: number }>()
    } else if (request.method === "requests.cancel") {
      expectTypeOf(request.params).toEqualTypeOf<{ requestId: string }>()
    }
  })

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
    expect(
      parseRuntimeRequest({
        kind: "request",
        requestId: "request-3",
        method: "bookmarks.search",
        params: { query: "docs", limit: 20 },
      }),
    ).toMatchObject({ method: "bookmarks.search", params: { query: "docs", limit: 20 } })
    expect(
      parseRuntimeRequest({
        kind: "request",
        requestId: "request-4",
        method: "bookmarks.getRecent",
        params: { limit: 5 },
      }),
    ).toMatchObject({ method: "bookmarks.getRecent", params: { limit: 5 } })
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
    {
      kind: "request",
      requestId: "1",
      method: "bookmarks.search",
      params: { query: "   ", limit: 10 },
    },
    {
      kind: "request",
      requestId: "1",
      method: "bookmarks.search",
      params: { query: "docs", limit: 51 },
    },
    {
      kind: "request",
      requestId: "1",
      method: "bookmarks.getRecent",
      params: { limit: 10, extra: true },
    },
    {
      kind: "request",
      requestId: "1",
      method: "bookmarks.getRecent",
      params: { limit: 10 },
      tabContext: { tabId: 1, url: "https://example.test", epoch: 1 },
    },
    { kind: "event", name: "tab.changed", payload: {} },
  ])("rejects malformed or unknown message %#", (message) => {
    expect(() => parseRuntimeRequest(message)).toThrow("Malformed or unknown")
  })

  test.each([
    ["page.click", "selector", 2048, {}],
    ["page.type", "selector", 2048, { text: "" }],
    ["page.type", "text", 50_000, { selector: "#x" }],
    ["tabs.navigate", "url", 16_384, {}],
    ["bookmarks.search", "query", 500, { limit: 1 }],
    ["webmcp.callTool", "name", 256, { arguments: {} }],
    ["requests.cancel", "requestId", 256, {}],
  ] as const)("preserves %s %s string bounds", (method, key, limit, rest) => {
    const request = (length: number) => ({
      kind: "request",
      requestId: "1",
      method,
      params: { ...rest, [key]: "x".repeat(length) },
    })
    expect(() => parseRuntimeRequest(request(limit))).not.toThrow()
    expect(() => parseRuntimeRequest(request(limit + 1))).toThrow("Malformed or unknown")
    if (key === "text") expect(() => parseRuntimeRequest(request(0))).not.toThrow()
    else expect(() => parseRuntimeRequest(request(0))).toThrow("Malformed or unknown")
    expect(() =>
      parseRuntimeRequest({ ...request(1), params: { ...request(1).params, extra: true } }),
    ).toThrow("Malformed or unknown")
  })

  test.each(["bookmarks.search", "bookmarks.getRecent"])(
    "preserves %s limits and context rejection",
    (method) => {
      const request = (limit: unknown) => ({
        kind: "request",
        requestId: "1",
        method,
        params: method === "bookmarks.search" ? { query: " docs ", limit } : { limit },
      })
      for (const limit of [1, 50]) expect(() => parseRuntimeRequest(request(limit))).not.toThrow()
      for (const limit of [0, 51, 1.5, Number.NaN, Infinity, "1", undefined])
        expect(() => parseRuntimeRequest(request(limit))).toThrow("Malformed or unknown")
      expect(() =>
        parseRuntimeRequest({ ...request(1), tabContext: { tabId: 0, url: "x", epoch: 0 } }),
      ).toThrow("Malformed or unknown")
      expect(() => parseRuntimeRequest({ ...request(1), tabContext: null })).toThrow(
        "Malformed or unknown",
      )
    },
  )

  test("preserves envelope extras, context bounds, and raw bookmark-query length", () => {
    const message = {
      kind: "request",
      requestId: "x".repeat(256),
      method: "app.getState",
      params: {},
      extra: true,
      tabContext: {
        tabId: 0,
        epoch: Number.MAX_SAFE_INTEGER,
        url: "x".repeat(16_384),
        extra: true,
      },
      confirmed: false,
    }
    expect(parseRuntimeRequest(message)).toBe(message)
    expect(() => parseRuntimeRequest({ ...message, requestId: "x".repeat(257) })).toThrow(
      "Malformed or unknown",
    )
    expect(() => parseRuntimeRequest({ ...message, params: { extra: true } })).toThrow(
      "Malformed or unknown",
    )
    for (const extra of [
      { url: "" },
      { url: "x".repeat(16_385) },
      { tabId: -1 },
      { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { tabId: 0.5 },
    ]) {
      expect(() =>
        parseRuntimeRequest({ ...message, tabContext: { ...message.tabContext, ...extra } }),
      ).toThrow("Malformed or unknown")
    }
    for (const query of [" ".repeat(500), ` ${"x".repeat(500)}`]) {
      expect(() =>
        parseRuntimeRequest({
          kind: "request",
          requestId: "1",
          method: "bookmarks.search",
          params: { query, limit: 1 },
        }),
      ).toThrow("Malformed or unknown")
    }
  })

  test("retains JSON depth, collection-size, finite-number, and reserved-key restrictions", () => {
    const request = (args: unknown) => ({
      kind: "request",
      requestId: "1",
      method: "webmcp.callTool",
      params: { name: "read", arguments: args },
    })
    const nested = (depth: number): unknown => {
      let value: unknown = null
      for (let i = 0; i < depth; i++) value = { child: value }
      return value
    }
    for (const args of [
      { values: Array(10_000).fill(null) },
      Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key${i}`, i])),
      nested(19),
    ]) {
      expect(() => parseRuntimeRequest(request(args))).not.toThrow()
    }
    for (const args of [
      null,
      [],
      { value: Infinity },
      { value: undefined },
      { value: () => undefined },
      { values: Array(10_001).fill(null) },
      Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`key${i}`, i])),
      nested(20),
    ]) {
      expect(() => parseRuntimeRequest(request(args))).toThrow("Malformed or unknown")
    }
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => parseRuntimeRequest(request(JSON.parse(`{"${key}":null}`)))).toThrow(
        "Malformed or unknown",
      )
    }
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

  test("validates exclusive reference targets without changing selectors", () => {
    const target = { snapshotId: "11111111-1111-1111-1111-111111111111", ref: "e1" }
    for (const method of ["page.click", "page.type"]) {
      const request = (params: Record<string, unknown>) => ({
        kind: "request",
        requestId: "1",
        method,
        params: { ...params, ...(method === "page.type" ? { text: "value" } : {}) },
      })
      expect(() => parseRuntimeRequest(request(target))).not.toThrow()
      for (const invalid of [
        {},
        { ref: "e1" },
        { snapshotId: target.snapshotId },
        { ...target, selector: "#x" },
        { ...target, extra: 1 },
        { ...target, ref: "e0" },
        { ...target, ref: "e12345678" },
        { ...target, snapshotId: "x".repeat(37) },
      ]) {
        expect(() => parseRuntimeRequest(request(invalid))).toThrow("Malformed")
      }
    }
    expect(() =>
      parseRuntimeRequest({
        kind: "request",
        requestId: "1",
        method: "page.listElements",
        params: {},
      }),
    ).not.toThrow()
    expect(() =>
      parseRuntimeRequest({
        kind: "request",
        requestId: "1",
        method: "page.listElements",
        params: { limit: 100 },
      }),
    ).toThrow("Malformed")
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
