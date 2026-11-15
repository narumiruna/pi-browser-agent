import { expect, test } from "vitest"
import { isTranslationContentMessage } from "../../../src/browser/runtime/translation.js"
import { batchPageTranslationItems } from "../../../src/browser/translation/shared/messages.js"

const item = (index, text = "Public source text") => ({
  id: `source-${index}`,
  kind: "paragraph",
  text,
})
const unpack = (messages) => messages.flatMap((message) => message.payload.items)
function check(messages) {
  for (const message of messages) {
    expect(isTranslationContentMessage(message)).toBe(true)
    expect(message.payload.items.length).toBeGreaterThan(0)
    expect(message.payload.items.length).toBeLessThanOrEqual(64)
    expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(131072)
    expect(message.payload.sessionId).toBe("owned-session")
  }
}
test.each([
  [65, [64, 1]],
  [128, [64, 64]],
  [129, [64, 64, 1]],
])("%i visible items keep order across bounded packets", (count, lengths) => {
  const items = Array.from({ length: count }, (_, index) => item(index))
  const { messages, rejectedItems } = batchPageTranslationItems("owned-session", items)
  check(messages)
  expect(messages.map((message) => message.payload.items.length)).toEqual(lengths)
  expect(unpack(messages)).toEqual(items)
  expect(rejectedItems).toEqual([])
})
test.each(["漢".repeat(19000), '\n"\\'.repeat(6000)])(
  "packets count UTF-8 bytes and JSON escaping",
  (text) => {
    const items = Array.from({ length: 5 }, (_, index) => item(index, text))
    const { messages, rejectedItems } = batchPageTranslationItems("owned-session", items)
    expect(messages.length).toBeGreaterThan(1)
    check(messages)
    expect(unpack(messages)).toEqual(items)
    expect(rejectedItems).toEqual([])
  },
)
test("an oversized protected fragment or invalid item does not discard valid neighbors", () => {
  const rejected = [
    item("long", "x".repeat(20001)),
    { ...item("math"), protectedFragments: [{ value: "漢".repeat(50000) }] },
    { ...item("extra"), arbitraryCode: "not allowed" },
  ]
  const good = [item(1), item(2)]
  const { messages, rejectedItems } = batchPageTranslationItems("owned-session", [
    good[0],
    ...rejected,
    good[1],
  ])
  check(messages)
  expect(unpack(messages)).toEqual(good)
  expect(rejectedItems).toEqual(rejected)
})
test("an empty window sends no packet", () => {
  expect(batchPageTranslationItems("owned-session", [])).toEqual({
    messages: [],
    rejectedItems: [],
  })
})
