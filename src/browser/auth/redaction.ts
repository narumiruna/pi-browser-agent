const SECRET_KEYS = new Set([
  "access",
  "access_token",
  "authorization",
  "code_verifier",
  "id_token",
  "refresh",
  "refresh_token",
  "token",
])
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+/gi
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(BEARER_PATTERN, "Bearer [REDACTED]").replace(JWT_PATTERN, "[REDACTED]")
  }
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactSecrets(item),
    ]),
  )
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecrets(message) as string
}
