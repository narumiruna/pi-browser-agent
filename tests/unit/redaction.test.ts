import { describe, expect, test } from "vitest"
import { redactSecrets, safeErrorMessage } from "../../src/browser/auth/redaction.js"

describe("credential redaction", () => {
  test("removes credentials recursively from diagnostics", () => {
    const value = redactSecrets({
      access_token: "access-secret",
      nested: { refresh: "refresh-secret", harmless: "ok" },
      authorization: "Bearer secret-token",
    })
    expect(value).toEqual({
      access_token: "[REDACTED]",
      nested: { refresh: "[REDACTED]", harmless: "ok" },
      authorization: "[REDACTED]",
    })
    expect(JSON.stringify(value)).not.toContain("secret")
  })

  test("redacts bearer values and JWTs from error strings", () => {
    const message = safeErrorMessage(
      new Error("failed Bearer abc.def-123 token eyJheader.eyJpayload.signature"),
    )
    expect(message).not.toContain("abc.def")
    expect(message).not.toContain("eyJpayload")
    expect(message).toContain("[REDACTED]")
  })
})
