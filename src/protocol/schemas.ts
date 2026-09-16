import { isBridgeCapability } from "./capabilities.js"
import { BridgeError, type BridgeErrorData, isBridgeErrorCode } from "./errors.js"
import type { JsonObject, JsonValue, ProtocolFrame, TabContext } from "./messages.js"
import { MAX_FRAME_BYTES, MAX_TEXT_RESULT_BYTES } from "./version.js"

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function isNonEmptyString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

export function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) return false
    if (current.depth > 20) return false

    const candidate = current.value
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      continue
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return false
      continue
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 10_000) return false
      for (const item of candidate) stack.push({ depth: current.depth + 1, value: item })
      continue
    }
    if (!isRecord(candidate)) return false

    const entries = Object.entries(candidate)
    if (entries.length > 1_000) return false
    for (const [key, item] of entries) {
      if (FORBIDDEN_KEYS.has(key)) return false
      stack.push({ depth: current.depth + 1, value: item })
    }
  }

  return true
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value)
}

export function isTabContext(value: unknown): value is TabContext {
  return (
    isRecord(value) &&
    isFiniteInteger(value.tabId) &&
    value.tabId >= 0 &&
    isNonEmptyString(value.url, 16_384) &&
    isFiniteInteger(value.epoch) &&
    value.epoch >= 0
  )
}

function isBridgeErrorData(value: unknown): value is BridgeErrorData {
  return (
    isRecord(value) &&
    isBridgeErrorCode(value.code) &&
    isNonEmptyString(value.message) &&
    (value.details === undefined || isJsonObject(value.details))
  )
}

export function isProtocolFrame(value: unknown): value is ProtocolFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false

  switch (value.type) {
    case "hello":
      return (
        isFiniteInteger(value.protocolVersion) &&
        isNonEmptyString(value.clientId, 256) &&
        isNonEmptyString(value.extensionVersion, 128) &&
        Array.isArray(value.capabilities) &&
        value.capabilities.length <= 32 &&
        value.capabilities.every(isBridgeCapability)
      )
    case "auth.challenge":
      return (
        isNonEmptyString(value.challengeId, 256) &&
        isNonEmptyString(value.nonce, 256) &&
        isFiniteInteger(value.expiresAt)
      )
    case "auth.response":
      return isNonEmptyString(value.challengeId, 256) && isNonEmptyString(value.proof, 256)
    case "auth.result":
      return (
        typeof value.success === "boolean" &&
        (value.error === undefined || isBridgeErrorData(value.error))
      )
    case "request":
      return (
        isNonEmptyString(value.id, 256) &&
        isNonEmptyString(value.method, 256) &&
        isJsonObject(value.params) &&
        isFiniteInteger(value.timeoutMs) &&
        value.timeoutMs > 0 &&
        (value.tabContext === undefined || isTabContext(value.tabContext)) &&
        (value.confirmed === undefined || typeof value.confirmed === "boolean")
      )
    case "response":
      return (
        isNonEmptyString(value.id, 256) &&
        (value.result === undefined || isJsonValue(value.result)) &&
        (value.error === undefined || isBridgeErrorData(value.error)) &&
        (value.result !== undefined || value.error !== undefined) &&
        !(value.result !== undefined && value.error !== undefined)
      )
    case "event":
      return (
        isNonEmptyString(value.name, 256) &&
        isJsonObject(value.payload) &&
        (value.tabContext === undefined || isTabContext(value.tabContext))
      )
    case "cancel":
      return isNonEmptyString(value.id, 256)
    case "ping":
    case "pong":
      return isFiniteInteger(value.timestamp)
    default:
      return false
  }
}

export function parseProtocolFrame(raw: string, maxBytes = MAX_FRAME_BYTES): ProtocolFrame {
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new BridgeError("MESSAGE_TOO_LARGE", `Bridge frame exceeds ${maxBytes} bytes`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BridgeError("INVALID_REQUEST", "Bridge frame is not valid JSON")
  }

  if (!isJsonValue(parsed) || !isProtocolFrame(parsed)) {
    throw new BridgeError("INVALID_REQUEST", "Bridge frame does not match the protocol schema")
  }
  return parsed
}

export function serializeProtocolFrame(frame: ProtocolFrame, maxBytes = MAX_FRAME_BYTES): string {
  if (!isJsonValue(frame) || !isProtocolFrame(frame)) {
    throw new BridgeError("INVALID_REQUEST", "Cannot serialize an invalid bridge frame")
  }
  const serialized = JSON.stringify(frame)
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new BridgeError("MESSAGE_TOO_LARGE", `Bridge frame exceeds ${maxBytes} bytes`)
  }
  return serialized
}

export function truncateUtf8(
  text: string,
  maxBytes = MAX_TEXT_RESULT_BYTES,
): {
  text: string
  truncated: boolean
} {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return { text, truncated: false }

  const suffix = "\n[truncated]"
  const suffixBytes = encoder.encode(suffix).byteLength
  if (maxBytes <= suffixBytes) {
    return { text: suffix.slice(0, Math.max(0, maxBytes)), truncated: true }
  }

  const contentLimit = maxBytes - suffixBytes
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(text.slice(0, middle)).byteLength <= contentLimit) low = middle
    else high = middle - 1
  }

  let prefix = text.slice(0, low)
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1)

  return { text: `${prefix}${suffix}`, truncated: true }
}
