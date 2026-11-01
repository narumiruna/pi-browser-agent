import { describe, expect, test } from "vitest"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  PAGE_ANNOTATION_COLORS,
  PAGE_ANNOTATION_LIMITS,
  parsePageAnnotationMarks,
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
      minShapeSize: 4,
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

  test("accepts allowlisted tools while preserving legacy pen starts", () => {
    for (const tool of ["pen", "arrow", "rectangle"]) {
      expect(
        parseRuntimeRequest(
          request("pageAnnotation.start", { clientId, color: "red", width: 8, tool }),
        ).params,
      ).toMatchObject({ tool })
      expect(
        parseRuntimeRequest(request("pageAnnotation.update", { clientId, action: "tool", tool }))
          .params,
      ).toEqual({ clientId, action: "tool", tool })
    }
    expect(
      parseRuntimeRequest(request("pageAnnotation.start", { clientId, color: "red", width: 8 }))
        .method,
    ).toBe("pageAnnotation.start")
  })

  test.each([
    { color: "#ef4444" },
    { color: "constructor" },
    { color: "RED" },
    { tool: "line" },
    { tool: "constructor" },
    { tool: null },
    { tool: 1 },
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
    { action: "tool" },
    { action: "tool", tool: "Arrow" },
    { action: "tool", tool: "constructor" },
    { action: "tool", tool: "arrow", width: 8 },
    { action: "color", color: "red", tool: "pen" },
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

  test("validates mixed marks, two-endpoint geometry and shared point budgets", () => {
    const arrow = {
      ...stroke,
      tool: "arrow",
      points: [
        { x: 2, y: 3 },
        { x: 22, y: 23 },
      ],
    }
    const rectangle = { ...arrow, tool: "rectangle", points: [...arrow.points].reverse() }
    const pen = { ...stroke, tool: "pen" }
    expect(parsePageAnnotationMarks([pen, arrow, rectangle], 800, 600)).toEqual([
      pen,
      arrow,
      rectangle,
    ])
    for (const mark of [
      { ...arrow, tool: "constructor" },
      { ...arrow, extra: true },
      { ...arrow, width: 33 },
      { ...arrow, color: "pink" },
      { ...arrow, points: [] },
      { ...arrow, points: [arrow.points[0]] },
      { ...arrow, points: [...arrow.points, arrow.points[1]] },
      {
        ...arrow,
        points: [
          { x: 0, y: 0 },
          { x: 3.99, y: 0 },
        ],
      },
      {
        ...rectangle,
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 3.99 },
        ],
      },
      {
        ...arrow,
        points: [
          { x: NaN, y: 1 },
          { x: 20, y: 20 },
        ],
      },
      {
        ...arrow,
        points: [
          { x: 1, y: Infinity },
          { x: 20, y: 20 },
        ],
      },
      {
        ...arrow,
        points: [
          { x: -1, y: 0 },
          { x: 20, y: 20 },
        ],
      },
      {
        ...arrow,
        points: [
          { x: 801, y: 0 },
          { x: 20, y: 20 },
        ],
      },
      {
        ...arrow,
        points: [
          { x: 0, y: 601 },
          { x: 20, y: 20 },
        ],
      },
      {
        ...arrow,
        points: [
          { x: 0, y: 0, pressure: 1 },
          { x: 20, y: 20 },
        ],
      },
    ])
      expect(() => parsePageAnnotationMarks([mark], 800, 600)).toThrow()
    expect(
      parsePageAnnotationMarks(
        [
          {
            ...arrow,
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 0 },
            ],
          },
        ],
        800,
        600,
      ),
    ).toHaveLength(1)
    expect(
      parsePageAnnotationMarks(
        [
          {
            ...rectangle,
            points: [
              { x: 4, y: 4 },
              { x: 0, y: 0 },
            ],
          },
        ],
        800,
        600,
      ),
    ).toHaveLength(1)
    expect(() => parsePageAnnotationMarks(Array(257).fill(arrow), 800, 600)).toThrow()
    const fullPen = { ...pen, points: Array(4096).fill({ x: 1, y: 1 }) }
    const nearFullPen = { ...pen, points: Array(4094).fill({ x: 1, y: 1 }) }
    expect(parsePageAnnotationMarks([fullPen, nearFullPen, arrow], 800, 600)).toHaveLength(3)
    expect(() =>
      parsePageAnnotationMarks([fullPen, nearFullPen, arrow, rectangle], 800, 600),
    ).toThrow()
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
