import { describe, expect, test, vi } from "vitest"
import { ChromeCredentialStore, CREDENTIALS_KEY } from "../../src/browser/auth/credential-store.js"

function environment(credentials: unknown = {}) {
  const values: Record<string, unknown> = { [CREDENTIALS_KEY]: credentials }
  const area = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items))
    }),
    remove: vi.fn(async (_key: string | string[]) => undefined),
  }
  const store = new ChromeCredentialStore(area as unknown as chrome.storage.StorageArea)
  return { area, values, store }
}

const escaped = (value: string) => JSON.stringify(value).slice(1, -1)

describe("selected local task output redaction", () => {
  test("reads known credentials privately and returns only redacted text without writes", async () => {
    const key = "provider-key-0123456789"
    const access = "oauth-access-0123456789"
    const refresh = "oauth-refresh-0123456789"
    const nested = "nested-provider-secret-0123456789"
    const env = environment({
      openai: { type: "api_key", key, options: { headers: { authorization: nested } } },
      oauthProvider: { type: "oauth", access, refresh, expires: 12345 },
    })
    const read = vi.spyOn(env.store, "read")
    const list = vi.spyOn(env.store, "list")
    const before = structuredClone(env.values)
    const result = await env.store.redact(`Answer: ${key}; ${access}; ${refresh}; ${nested}.`)
    expect(result).toBe("Answer: [REDACTED]; [REDACTED]; [REDACTED]; [REDACTED].")
    expect(typeof result).toBe("string")
    expect(env.area.get).toHaveBeenCalledExactlyOnceWith(CREDENTIALS_KEY)
    expect(read).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(env.area.set).not.toHaveBeenCalled()
    expect(env.area.remove).not.toHaveBeenCalled()
    expect(env.values).toEqual(before)
  })

  test("removes raw and JSON-escaped API key and nested OAuth values", async () => {
    const key = 'api-key-"quoted"\\path\nnext'
    const access = 'access-"quoted"\\path\tnext'
    const refresh = 'refresh-"quoted"\\path\rnext'
    const nested = 'nested-"quoted"\\path\nnext'
    const { store } = environment({
      provider: { type: "api_key", key },
      oauthProvider: {
        type: "oauth",
        access,
        refresh,
        expires: 12345,
        extra: [{ secret: nested }],
      },
    })
    const secrets = [key, access, refresh, nested]
    const text = secrets.map((value) => `${value} | ${escaped(value)} | ${value}`).join("\n")
    const result = await store.redact(text)
    expect(result).toBe(secrets.map(() => "[REDACTED] | [REDACTED] | [REDACTED]").join("\n"))
    for (const value of secrets) {
      expect(result).not.toContain(value)
      expect(result).not.toContain(escaped(value))
    }
  })

  test("redacts longer overlapping secrets before their shorter prefixes", async () => {
    const { store } = environment({
      first: { type: "api_key", key: "shared-secret" },
      second: { type: "api_key", key: "shared-secret-longer" },
    })
    expect(await store.redact("shared-secret-longer shared-secret shared-secret-longer")).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    )
  })

  test("does not export a known secret merely because it is short", async () => {
    const { store } = environment({
      provider: { type: "api_key", key: "sk-test" },
      oauthProvider: { type: "oauth", access: "tok-123", refresh: "ref-123", expires: 12345 },
    })
    expect(await store.redact("sk-test tok-123 ref-123")).toBe("[REDACTED] [REDACTED] [REDACTED]")
  })

  test("preserves normal selected output and does not redact credential type names", async () => {
    const { store, area } = environment({
      provider: { type: "api_key", key: "private-provider-key" },
      oauthProvider: {
        type: "oauth",
        access: "private-access-token",
        refresh: "private-refresh-token",
        expires: 12345,
      },
    })
    const text =
      "Reviewed api_key and oauth configuration.\nUnicode: 日本語 😀. No credential appears."
    expect(await store.redact(text)).toBe(text)
    expect(await store.redact("")).toBe("")
    expect(area.set).not.toHaveBeenCalled()
    expect(area.remove).not.toHaveBeenCalled()
  })

  test.each([
    undefined,
    null,
    [],
    {},
    { invalid: { type: "unknown", secret: "not-a-credential" } },
  ])("preserves normal text when no valid credentials exist: %j", async (credentials) => {
    const { store } = environment(credentials)
    expect(await store.redact("Selected normal output")).toBe("Selected normal output")
  })

  test("fails closed if private credential storage cannot be read", async () => {
    const { store, area } = environment({
      provider: { type: "api_key", key: "private-provider-key" },
    })
    area.get.mockRejectedValueOnce(new Error("Credential storage unavailable"))
    await expect(store.redact("Selected output private-provider-key")).rejects.toThrow(
      "Credential storage unavailable",
    )
    expect(area.set).not.toHaveBeenCalled()
    expect(area.remove).not.toHaveBeenCalled()
  })
})
