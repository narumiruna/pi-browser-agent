export const BRIDGE_ERROR_CODES = [
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "CONFIRMATION_REQUIRED",
  "CONNECTION_CLOSED",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "MESSAGE_TOO_LARGE",
  "METHOD_NOT_FOUND",
  "NOT_CONNECTED",
  "NOT_SUPPORTED",
  "PERMISSION_DENIED",
  "REQUEST_CANCELLED",
  "REQUEST_TIMEOUT",
  "STALE_CONTEXT",
  "TAB_NOT_BOUND",
  "UNSUPPORTED_PROTOCOL",
] as const

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number]

export interface BridgeErrorData {
  code: BridgeErrorCode
  message: string
  details?: Record<string, unknown>
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: BridgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "BridgeError"
    this.code = code
    this.details = details
  }

  toData(): BridgeErrorData {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === "string" && BRIDGE_ERROR_CODES.includes(value as BridgeErrorCode)
}

export function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  return new BridgeError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unknown bridge error",
  )
}
