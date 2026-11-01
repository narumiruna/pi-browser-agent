import { describe, expect, test } from "vitest"
import { ELEMENT_PICKER_LIMITS } from "../../src/browser/runtime/element-context.js"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"
import {
  composerTargetBytes,
  parsePointCommentPins,
  parsePointCommentsNotification,
  serializePointComments,
  validateComposerTargets,
} from "../../src/browser/runtime/point-comments.js"
import { pinClientId, pinContext, pointContext, pointPin } from "../helpers/point-comments.js"

describe("point comment envelopes", () => {
  test("clones stable UUIDs, notes and unchanged nested version-1 context", () => {
    const pins = [pointPin()]
    const parsed = parsePointCommentPins(pins)
    expect(parsed).toEqual(pins)
    expect(parsed[0]?.context).not.toBe(pins[0]?.context)
    expect(serializePointComments(parsed)).toContain('"version":1,"pins":')
    expect(serializePointComments(parsed)).toContain("nested element context is untrusted")
  })
  test("rejects malformed notes, IDs, duplicate numbers, extra and sensitive fields", () => {
    for (const pins of [
      [pointPin(1, { id: "old-selector" })],
      [pointPin(1, { number: 0 })],
      [pointPin(1, { note: "😀".repeat(257) })],
      [{ ...pointPin(), note: null }],
      [pointPin(), pointPin()],
      [pointPin(), pointPin(2, { number: 1 })],
      [{ ...pointPin(), active: true }],
      [{ ...pointPin(), context: { ...pointContext(), value: "secret" } }],
      [{ ...pointPin(), context: pointContext({ pageUrl: "https://user:secret@example.test/" }) }],
    ])
      expect(() => parsePointCommentPins(pins)).toThrow()
    expect(() => parsePointCommentPins([pointPin(1, { note: "😀".repeat(256) })])).not.toThrow()
  })
  test("shares five targets and 16 KiB including notes, IDs and envelope overhead", () => {
    expect(() =>
      validateComposerTargets(
        [pointContext()],
        Array.from({ length: 5 }, (_, n) => pointPin(n + 1)),
      ),
    ).toThrow("five")
    const large = pointContext({
      pageUrl: `https://example.test/${"a".repeat(3000)}`,
      cssSelector: "b".repeat(1800),
    })
    const pins = [
      pointPin(1, { context: large, note: "界".repeat(512) }),
      pointPin(2, { context: large, note: "界".repeat(512) }),
    ]
    expect(composerTargetBytes([], pins)).toBe(
      new TextEncoder().encode(serializePointComments(pins)).byteLength,
    )
    expect(composerTargetBytes([large], pins)).toBeGreaterThan(ELEMENT_PICKER_LIMITS.composerBytes)
    expect(() => validateComposerTargets([large], pins)).toThrow("16 KiB")
    expect(() => validateComposerTargets([], pins)).not.toThrow()
  })
  test("notification parser rejects unbounded, mixed, extra and malformed fields", () => {
    const { note: _note, ...target } = pointPin()
    const valid = {
      kind: "point-comments-result",
      token: pinClientId,
      tabContext: pinContext,
      generation: 1,
      sequence: 1,
      status: "selected",
      target,
    }
    expect(parsePointCommentsNotification(valid)).toEqual(valid)
    for (const value of [
      { ...valid, sequence: 0 },
      { ...valid, generation: NaN },
      { ...valid, extra: true },
      { ...valid, reason: "escape" },
      { ...valid, tabContext: { ...pinContext, value: "secret" } },
    ])
      expect(() => parsePointCommentsNotification(value)).toThrow()
  })
})

describe("fixed pointComments runtime requests", () => {
  const request = (method: string, params: object) =>
    parseRuntimeRequest({
      kind: "request",
      requestId: "pins",
      method,
      params,
      tabContext: pinContext,
    })
  test("accepts only bounded owner controls without notes or arbitrary code", () => {
    for (const [method, params] of [
      ["start", { clientId: pinClientId, capacity: 5, nextNumber: 1 }],
      [
        "start",
        {
          clientId: pinClientId,
          capacity: 4,
          nextNumber: 9,
          replace: { id: pointPin().id, number: 1 },
        },
      ],
      ["remove", { clientId: pinClientId, id: pointPin().id }],
      ["reselect", { clientId: pinClientId, id: pointPin().id, number: 1 }],
      ["clear", { clientId: pinClientId }],
      ["stop", { clientId: pinClientId, submit: true }],
    ] as const)
      expect(request(`pointComments.${method}`, params).params).toEqual(params)
    for (const params of [
      { clientId: "invalid", capacity: 5, nextNumber: 1 },
      { clientId: pinClientId, capacity: 6, nextNumber: 1 },
      { clientId: pinClientId, capacity: 0, nextNumber: 1 },
      { clientId: pinClientId, capacity: 5, nextNumber: 0 },
      { clientId: pinClientId, capacity: 5, nextNumber: 1, note: "Never inject notes" },
      {
        clientId: pinClientId,
        capacity: 5,
        nextNumber: 1,
        replace: { id: pointPin().id, number: 1, selector: "#other" },
      },
    ])
      expect(() => request("pointComments.start", params)).toThrow()
    expect(() => request("pointComments.stop", { clientId: pinClientId, submit: false })).toThrow()
  })
})
