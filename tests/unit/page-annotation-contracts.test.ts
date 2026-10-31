import { describe, expect, test } from "vitest"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  PAGE_ANNOTATION_COLORS,
  PAGE_ANNOTATION_LIMITS,
  parsePageAnnotationNotification,
  parsePageAnnotationState,
  parsePageAnnotationStrokes,
} from "../../src/browser/runtime/page-annotation.js"

const clientId = "12345678-1234-1234-1234-123456789abc"
const context = { tabId: 1, url: "https://example.test/", epoch: 1 }
const state = {
  active: true,
  hasStrokes: true,
  drawing: false,
  frozen: false,
  revision: 1,
  width: 800,
  height: 600,
}
const request = (method: string, params: unknown) => ({
  kind: "request",
  requestId: "annotation",
  method,
  params,
})
const stroke = { color: "red", width: 8, points: [{ x: 2, y: 3 }] }

describe("page annotation contracts", () => {
  test("uses fixed colors and bounded budgets", () => {
    expect(Object.keys(PAGE_ANNOTATION_COLORS)).toEqual([
      "red",
      "yellow",
      "green",
      "blue",
      "white",
      "black",
    ])
    expect(PAGE_ANNOTATION_LIMITS).toEqual({
      minPenWidth: 2,
      maxPenWidth: 32,
      defaultPenWidth: 8,
      maxStrokes: 256,
      maxPointsPerStroke: 4096,
      maxTotalPoints: 8192,
      maxCanvasDimension: 4096,
      maxCanvasPixels: 16_000_000,
      lifetimeMs: 300_000,
    })
  })

  test("accepts exact start, controls, capture and stop shapes", () => {
    for (const [method, params] of [
      ["pageAnnotation.start", { clientId, color: "blue", width: 2 }],
      ["pageAnnotation.start", { clientId, color: "white", width: 32 }],
      ["pageAnnotation.update", { clientId, action: "color", color: "green" }],
      ["pageAnnotation.update", { clientId, action: "width", width: 8 }],
      ...["undo", "clear", "resume"].map((action) => [
        "pageAnnotation.update",
        { clientId, action },
      ]),
      ["pageAnnotation.capture", { clientId }],
      ["pageAnnotation.stop", { clientId }],
    ] as [string, unknown][])
      expect(parseRuntimeRequest(request(method, params)).method).toBe(method)
  })

  test.each([
    { color: "#ef4444" },
    { color: "constructor" },
    { color: "RED" },
    { color: "url(https://example.test)" },
    { width: 1 },
    { width: 33 },
    { width: 2.5 },
    { width: Number.NaN },
    { width: Infinity },
    { clientId: "-".repeat(36) },
    { clientId: "bad" },
    { extra: true },
  ])("rejects malformed start settings %j", (change) => {
    expect(() =>
      parseRuntimeRequest(
        request("pageAnnotation.start", { clientId, color: "red", width: 8, ...change }),
      ),
    ).toThrow()
  })

  test.each([
    { action: "freeze" },
    { action: "state" },
    { action: "stop" },
    { action: "color" },
    { action: "color", color: "pink" },
    { action: "color", color: "blue", width: 8 },
    { action: "width" },
    { action: "width", width: 8, color: "blue" },
    { action: "undo", width: 8 },
    { action: "resume", extra: true },
  ])("rejects unsupported or inexact updates %j", (params) => {
    expect(() =>
      parseRuntimeRequest(request("pageAnnotation.update", { clientId, ...params })),
    ).toThrow()
  })

  test("rejects unknown envelope, context and capture keys", () => {
    expect(() =>
      parseRuntimeRequest({ ...request("pageAnnotation.capture", { clientId }), token: clientId }),
    ).toThrow()
    expect(() =>
      parseRuntimeRequest({
        ...request("pageAnnotation.stop", { clientId }),
        tabContext: { ...context, token: clientId },
      }),
    ).toThrow()
    expect(() =>
      parseRuntimeRequest(request("pageAnnotation.capture", { clientId, confirmed: true })),
    ).toThrow()
  })

  test.each([
    { active: true },
    { ...state, width: Infinity },
    { ...state, width: 4097 },
    { ...state, height: 0 },
    { ...state, width: 4096, height: 4096 },
    { ...state, revision: -1 },
    { ...state, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, drawing: true, frozen: true },
    { ...state, points: [] },
    { active: false, width: 800 },
  ])("rejects malformed state %j", (value) => {
    expect(() => parsePageAnnotationState(value)).toThrow()
  })

  test("validates exact bounded notifications and fixed cancellation reasons", () => {
    const notification = {
      kind: "page-annotation-state",
      token: clientId,
      tabContext: context,
      state,
    }
    expect(parsePageAnnotationNotification(notification).state).toEqual(state)
    expect(
      parsePageAnnotationNotification({
        ...notification,
        state: { active: false },
        reason: "protection-lost",
      }).reason,
    ).toBe("protection-lost")
    for (const change of [
      { token: "forged" },
      { tabContext: { ...context, frameId: 0 } },
      { tabContext: { ...context, epoch: Infinity } },
      { state: { active: false }, reason: "page supplied exception" },
      { reason: "timeout" },
      { extra: true },
    ])
      expect(() => parsePageAnnotationNotification({ ...notification, ...change })).toThrow()
  })

  test("validates bounded stroke coordinates and exact palette IDs", () => {
    expect(parsePageAnnotationStrokes([stroke], 800, 600)).toEqual([stroke])
    for (const item of [
      { ...stroke, color: "pink" },
      { ...stroke, width: 99 },
      { ...stroke, extra: true },
      { ...stroke, points: [] },
      { ...stroke, points: [{ x: NaN, y: 1 }] },
      { ...stroke, points: [{ x: 1, y: Infinity }] },
      { ...stroke, points: [{ x: -1, y: 1 }] },
      { ...stroke, points: [{ x: 801, y: 1 }] },
      { ...stroke, points: [{ x: 1, y: 601 }] },
      { ...stroke, points: [{ x: 1, y: 1, pressure: 1 }] },
    ])
      expect(() => parsePageAnnotationStrokes([item], 800, 600)).toThrow()
    expect(() => parsePageAnnotationStrokes(Array(257).fill(stroke), 800, 600)).toThrow()
    expect(() =>
      parsePageAnnotationStrokes(
        [{ ...stroke, points: Array(4097).fill({ x: 1, y: 1 }) }],
        800,
        600,
      ),
    ).toThrow()
    expect(() =>
      parsePageAnnotationStrokes(
        Array(3).fill({ ...stroke, points: Array(3000).fill({ x: 1, y: 1 }) }),
        800,
        600,
      ),
    ).toThrow()
    expect(() => parsePageAnnotationStrokes([], Infinity, 600)).toThrow()
  })
})
