import { describe, expect, test } from "vitest"
import { reconnectDelay } from "../../src/browser/bridge/reconnect.js"

describe("reconnect backoff", () => {
  test("uses bounded exponential backoff with jitter", () => {
    expect(reconnectDelay(0, () => 0)).toBe(375)
    expect(reconnectDelay(1, () => 0.5)).toBe(1_000)
    expect(reconnectDelay(20, () => 1)).toBe(30_000)
  })
})
