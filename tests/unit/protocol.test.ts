import { describe, expect, test } from "vitest"
import {
  BridgeError,
  isJsonValue,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseProtocolFrame,
  serializeProtocolFrame,
  truncateUtf8,
} from "../../src/protocol/index.js"

describe("protocol schemas", () => {
  test("round-trips a valid hello frame", () => {
    const frame = {
      type: "hello" as const,
      protocolVersion: PROTOCOL_VERSION,
      clientId: "client-1",
      extensionVersion: "0.1.0",
      capabilities: ["page.read" as const],
    }

    expect(parseProtocolFrame(serializeProtocolFrame(frame))).toEqual(frame)
  })

  test.each([
    "not json",
    "null",
    "[]",
    '{"type":"request","id":"x"}',
    '{"type":"unknown"}',
    '{"type":"response","id":"x"}',
  ])("rejects malformed frame %s", (raw) => {
    expect(() => parseProtocolFrame(raw)).toThrow(BridgeError)
  })

  test("rejects oversized input before parsing", () => {
    const raw = JSON.stringify({ type: "ping", timestamp: 1, padding: "x".repeat(MAX_FRAME_BYTES) })
    expect(() => parseProtocolFrame(raw)).toThrow(/exceeds/)
  })

  test("rejects deeply nested and prototype-sensitive JSON values", () => {
    let deeplyNested: unknown = null
    for (let index = 0; index < 25; index += 1) deeplyNested = [deeplyNested]

    expect(isJsonValue(deeplyNested)).toBe(false)
    expect(isJsonValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false)
    expect(() =>
      parseProtocolFrame('{"type":"ping","timestamp":1,"__proto__":{"polluted":true}}'),
    ).toThrow(BridgeError)
  })

  test("rejects a sample of arbitrary malformed objects", () => {
    for (let index = 0; index < 100; index += 1) {
      const raw = JSON.stringify({
        type: `unknown-${index}`,
        id: Math.random(),
        nested: Array.from({ length: index % 7 }, () => Math.random()),
      })
      expect(() => parseProtocolFrame(raw)).toThrow(BridgeError)
    }
  })
})

describe("UTF-8 truncation", () => {
  test("preserves complete multi-byte characters within the byte limit", () => {
    const result = truncateUtf8("前端內容".repeat(100), 64)
    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(64)
    expect(result.text).toMatch(/\[truncated\]$/)
  })

  test("does not split UTF-16 surrogate pairs", () => {
    const result = truncateUtf8("😀".repeat(20), 23)
    expect(result.text).not.toContain("�")
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(23)
  })

  test("does not alter small text", () => {
    expect(truncateUtf8("hello", 10)).toEqual({ text: "hello", truncated: false })
  })
})
