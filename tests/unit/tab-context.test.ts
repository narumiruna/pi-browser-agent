import { describe, expect, test } from "vitest"
import { assertTabContext } from "../../src/browser/content/tab-context.js"

describe("tab context", () => {
  const current = { tabId: 7, url: "https://example.test/page", epoch: 3 }

  test("accepts the current navigation epoch", () => {
    expect(() => assertTabContext(current, current)).not.toThrow()
    expect(() => assertTabContext(undefined, current)).not.toThrow()
  })

  test.each([
    { ...current, tabId: 8 },
    { ...current, url: "https://example.test/other" },
    { ...current, epoch: 4 },
  ])("rejects stale context %#", (expected) => {
    expect(() => assertTabContext(expected, current)).toThrow(/navigated/)
  })
})
