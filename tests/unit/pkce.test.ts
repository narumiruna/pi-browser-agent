import { describe, expect, test } from "vitest"
import { createPkce } from "../../src/browser/auth/pkce.js"

describe("browser PKCE", () => {
  test("creates URL-safe verifier and SHA-256 challenge", async () => {
    const { verifier, challenge } = await createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).not.toBe(verifier)
  })
})
