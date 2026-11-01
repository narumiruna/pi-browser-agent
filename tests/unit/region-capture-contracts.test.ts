import { describe, expect, test } from "vitest"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  parseRegionCaptureNotification,
  parseRegionCaptureState,
  validRegionRectangle,
} from "../../src/browser/runtime/region-capture.js"

const owner = {
  clientId: "12345678-1234-1234-1234-123456789abc",
  operationId: "12345678-1234-1234-1234-123456789abd",
}
const rectangle = { x: 0, y: 0, width: 8, height: 8 }
const state = {
  active: true,
  rectangle,
  dragging: false,
  frozen: false,
  revision: 1,
  committedRevision: 1,
  width: 100,
  height: 80,
}
const context = { tabId: 1, url: "https://example.test/", epoch: 0 }
const request = (method: string, extra = {}) => ({
  kind: "request",
  requestId: "request",
  method,
  params: { ...owner, ...extra },
  tabContext: context,
})

describe("fixed region capture contracts", () => {
  test.each(["start", "stop"])("accepts bounded %s ownership only", (action) => {
    expect(parseRuntimeRequest(request(`regionCapture.${action}`)).method).toBe(
      `regionCapture.${action}`,
    )
    expect(() =>
      parseRuntimeRequest(request(`regionCapture.${action}`, { capture: true })),
    ).toThrow()
  })
  test("requires a selection revision and bounded capture byte budget without extra keys", () => {
    expect(
      parseRuntimeRequest(
        request("regionCapture.capture", { maxBytes: 3_000_000, selectionRevision: 1 }),
      ).method,
    ).toBe("regionCapture.capture")
    for (const extra of [
      {},
      { maxBytes: 8 },
      { selectionRevision: 1 },
      { maxBytes: 8, selectionRevision: 1, rectangle },
      { maxBytes: 8, selectionRevision: 1, confirmed: true },
    ])
      expect(() => parseRuntimeRequest(request("regionCapture.capture", extra))).toThrow()
    for (const maxBytes of [0, -1, 3_000_001, NaN, Infinity, 1.5, "8"])
      expect(() =>
        parseRuntimeRequest(request("regionCapture.capture", { maxBytes, selectionRevision: 1 })),
      ).toThrow()
    for (const selectionRevision of [-1, NaN, Infinity, 1.5, "1", null, undefined, 2 ** 53])
      expect(() =>
        parseRuntimeRequest(request("regionCapture.capture", { maxBytes: 8, selectionRevision })),
      ).toThrow()
    for (const selectionRevision of [0, Number.MAX_SAFE_INTEGER])
      expect(
        parseRuntimeRequest(request("regionCapture.capture", { maxBytes: 8, selectionRevision }))
          .params,
      ).toMatchObject({ selectionRevision })
  })
  test("rejects the removed numeric update request", () => {
    expect(() => parseRuntimeRequest(request("regionCapture.update", { rectangle }))).toThrow()
    expect(() => parseRuntimeRequest(request("regionCapture.update"))).toThrow()
  })
  test.each([NaN, Infinity, -Infinity, -1, "8", null, undefined])(
    "rejects non-finite or negative geometry %s",
    (x) => expect(validRegionRectangle({ ...rectangle, x })).toBe(false),
  )
  test.each([
    { ...rectangle, width: 0 },
    { ...rectangle, height: 7.99 },
    { ...rectangle, x: 4090 },
    { ...rectangle, width: 4097 },
    { ...rectangle, extra: 1 },
    { x: 0, y: 0, width: 8 },
  ])("rejects empty, tiny, extra, missing, or oversized rectangles", (value) =>
    expect(validRegionRectangle(value)).toBe(false),
  )
  test("accepts fractional geometry at the viewport boundary, not beyond it", () => {
    expect(validRegionRectangle({ x: 90.1, y: 70.1, width: 9.9, height: 9.9 }, 100, 80)).toBe(true)
    expect(validRegionRectangle({ ...rectangle, x: 93 }, 100, 80)).toBe(false)
  })
  test("accepts editing state and a completed revision retained by freeze", () => {
    expect(parseRegionCaptureState(state)).toEqual(state)
    expect(parseRegionCaptureState({ ...state, committedRevision: null }).active).toBe(true)
    expect(
      parseRegionCaptureState({ ...state, committedRevision: null, dragging: true }).active,
    ).toBe(true)
    expect(parseRegionCaptureState({ ...state, frozen: true, revision: 2 })).toEqual({
      ...state,
      frozen: true,
      revision: 2,
    })
    expect(parseRegionCaptureState({ active: false })).toEqual({ active: false })
  })
  test("requires committedRevision on every active state", () => {
    const { committedRevision: _committedRevision, ...missing } = state
    expect(() => parseRegionCaptureState(missing)).toThrow()
  })
  test.each([
    { ...state, extra: true },
    { ...state, revision: Infinity },
    { ...state, revision: -1 },
    { ...state, dragging: true, frozen: true },
    { ...state, rectangle: null, frozen: true },
    { ...state, width: 4097 },
    { ...state, width: 4096, height: 4096 },
    { ...state, rectangle: { ...rectangle, x: 99 } },
    { ...state, committedRevision: undefined },
    { ...state, committedRevision: NaN },
    { ...state, committedRevision: Infinity },
    { ...state, committedRevision: -1 },
    { ...state, committedRevision: 0.5 },
    { ...state, committedRevision: "1" },
    { ...state, committedRevision: 2 },
    { ...state, committedRevision: 0 },
    { ...state, frozen: true, committedRevision: 2 },
    { ...state, dragging: true },
    { ...state, rectangle: null },
    { active: false, rectangle: null },
    { active: false, committedRevision: null },
  ])("rejects invalid state %j", (value) => expect(() => parseRegionCaptureState(value)).toThrow())
  test("validates exact keys, IDs and notification reason without capture authority", () => {
    const message = {
      kind: "region-capture-state",
      token: owner.clientId,
      tabContext: context,
      state,
    }
    expect(parseRegionCaptureNotification(message).state).toEqual(state)
    for (const value of [
      { ...message, capture: true },
      { ...message, dataUrl: "data:image/png;base64,NO_IMAGE" },
      { ...message, token: "forged" },
      { ...message, reason: "user" },
      { ...message, tabContext: { ...context, extra: true } },
    ])
      expect(() => parseRegionCaptureNotification(value)).toThrow()
    expect(
      parseRegionCaptureNotification({ ...message, state: { active: false }, reason: "user" })
        .reason,
    ).toBe("user")
    for (const value of [
      { ...request("regionCapture.start"), extra: true },
      request("regionCapture.start", { clientId: "forged" }),
      { ...request("regionCapture.start"), tabContext: { ...context, extra: true } },
    ])
      expect(() => parseRuntimeRequest(value)).toThrow()
  })
})
