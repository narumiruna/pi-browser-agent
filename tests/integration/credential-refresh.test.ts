import type { OAuthCredential } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, test, vi } from "vitest"
import { OPENAI_PROVIDER_ID } from "../../src/browser/auth/codex-oauth.js"
import { CREDENTIALS_KEY } from "../../src/browser/auth/credential-store.js"
import { BrowserConfiguration } from "../../src/browser/configuration.js"

const TOKEN_URL = "https://auth.openai.com/oauth/token"
const TOKEN_PAYLOAD = btoa(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).replace(/=/g, "")
const ORIGINAL_ACCESS = `e30.${TOKEN_PAYLOAD}.b3JpZ2luYWw`
const ROTATED_ACCESS = `e30.${TOKEN_PAYLOAD}.cm90YXRlZA`

function tokenResponse(): Response {
  return Response.json({
    access_token: ROTATED_ACCESS,
    refresh_token: "rotated-refresh",
    expires_in: 3600,
  })
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function setup() {
  const original: OAuthCredential = {
    type: "oauth",
    access: ORIGINAL_ACCESS,
    refresh: "original-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "test-account",
  }
  const otherCredential = { type: "api_key", key: "other-key" }
  const stored: Record<string, unknown> = {
    [CREDENTIALS_KEY]: { [OPENAI_PROVIDER_ID]: original, anthropic: otherCredential },
  }
  const lockState = { held: false }
  const requestLock = vi.fn(
    async (_name: string, _options: LockOptions, operation: () => Promise<unknown>) => {
      expect(lockState.held).toBe(false)
      lockState.held = true
      try {
        return await operation()
      } finally {
        lockState.held = false
      }
    },
  )
  const storage = {
    get: vi.fn(async (key: string) => structuredClone({ [key]: stored[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      expect(lockState.held).toBe(true)
      Object.assign(stored, structuredClone(items))
    }),
    remove: vi.fn(async (key: string) => {
      expect(lockState.held).toBe(true)
      delete stored[key]
    }),
  }
  vi.stubGlobal("navigator", { locks: { request: requestLock } })
  vi.stubGlobal("chrome", { storage: { local: storage } })
  const fetchToken = vi.fn<typeof fetch>(async () => tokenResponse())
  vi.stubGlobal("fetch", fetchToken)
  const configuration = new BrowserConfiguration(vi.fn())
  return {
    configuration,
    original,
    otherCredential,
    stored,
    storage,
    fetchToken,
    lockState,
    requestLock,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("manual credential refresh with the real Models implementation", () => {
  test("refreshes a valid finite Codex token and resolves without an impossible validity check", async () => {
    const ui = setup()

    await expect(ui.configuration.refreshCredential(OPENAI_PROVIDER_ID)).resolves.toBeUndefined()

    expect(ui.fetchToken).toHaveBeenCalledOnce()
    expect(ui.fetchToken).toHaveBeenCalledWith(
      TOKEN_URL,
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    )
    const body = ui.fetchToken.mock.calls[0]?.[1]?.body
    expect(body).toBeInstanceOf(URLSearchParams)
    expect((body as URLSearchParams).get("grant_type")).toBe("refresh_token")
    expect((body as URLSearchParams).get("refresh_token")).toBe("original-refresh")
    await expect(ui.configuration.credentials.read(OPENAI_PROVIDER_ID)).resolves.toMatchObject({
      type: "oauth",
      access: ROTATED_ACCESS,
      refresh: "rotated-refresh",
      expires: expect.any(Number),
      accountId: "test-account",
    })
    await expect(ui.configuration.models.getAuth(OPENAI_PROVIDER_ID)).resolves.toEqual({
      auth: { apiKey: ROTATED_ACCESS },
      source: "OAuth",
    })
    await expect(ui.configuration.credentials.read("anthropic")).resolves.toEqual(
      ui.otherCredential,
    )
    expect(ui.storage.set).toHaveBeenCalledOnce()
    expect(ui.fetchToken).toHaveBeenCalledOnce()
    expect(ui.requestLock).toHaveBeenCalledWith(
      "pi-browser-agent-credentials-write",
      { mode: "exclusive" },
      expect.any(Function),
    )
    expect(ui.configuration.isChangingAuth).toBe(false)
  })

  test("shares the refresh lock with Models requests and other credential writes across configurations", async () => {
    const ui = setup()
    ui.stored[CREDENTIALS_KEY] = {
      [OPENAI_PROVIDER_ID]: { ...ui.original, expires: 0 },
      anthropic: ui.otherCredential,
    }
    const entered = deferred<void>()
    const reply = deferred<Response>()
    ui.fetchToken.mockImplementationOnce(async () => {
      expect(ui.lockState.held).toBe(true)
      entered.resolve()
      return reply.promise
    })
    const other = new BrowserConfiguration(vi.fn())
    const manual = ui.configuration.refreshCredential(OPENAI_PROVIDER_ID)
    await entered.promise
    expect(ui.configuration.isChangingAuth).toBe(true)
    const automatic = other.models.getAuth(OPENAI_PROVIDER_ID)
    await vi.waitFor(() => expect(ui.storage.get).toHaveBeenCalledTimes(2))
    const changeOther = other.credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "updated-other-key",
    }))
    expect(ui.storage.set).not.toHaveBeenCalled()
    reply.resolve(tokenResponse())

    const [, auth] = await Promise.all([manual, automatic, changeOther])

    expect(auth).toEqual({ auth: { apiKey: ROTATED_ACCESS }, source: "OAuth" })
    expect(ui.fetchToken).toHaveBeenCalledOnce()
    expect(ui.storage.set).toHaveBeenCalledTimes(2)
    await expect(other.credentials.read(OPENAI_PROVIDER_ID)).resolves.toMatchObject({
      access: ROTATED_ACCESS,
      refresh: "rotated-refresh",
    })
    await expect(other.credentials.read("anthropic")).resolves.toEqual({
      type: "api_key",
      key: "updated-other-key",
    })
    expect(ui.requestLock).toHaveBeenCalledTimes(3)
    expect(ui.lockState.held).toBe(false)
    expect(ui.configuration.isChangingAuth).toBe(false)
  })

  test("preserves the prior credential and releases busy state on failure, then permits retry", async () => {
    const ui = setup()
    ui.fetchToken.mockResolvedValueOnce(new Response("private-error-response", { status: 503 }))

    await expect(ui.configuration.refreshCredential(OPENAI_PROVIDER_ID)).rejects.toThrow(
      "OpenAI token request failed (503)",
    )

    await expect(ui.configuration.credentials.read(OPENAI_PROVIDER_ID)).resolves.toEqual(
      ui.original,
    )
    expect(ui.storage.set).not.toHaveBeenCalled()
    expect(ui.configuration.isChangingAuth).toBe(false)
    await expect(ui.configuration.refreshCredential(OPENAI_PROVIDER_ID)).resolves.toBeUndefined()
    await expect(ui.configuration.models.getAuth(OPENAI_PROVIDER_ID)).resolves.toMatchObject({
      auth: { apiKey: ROTATED_ACCESS },
    })
    expect(ui.fetchToken).toHaveBeenCalledTimes(2)
  })

  test("bounds an in-lock refresh to 15 seconds and preserves credentials after timeout", async () => {
    const ui = setup()
    const timeout = new AbortController()
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal)
    const entered = deferred<void>()
    ui.fetchToken.mockImplementationOnce(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          expect(ui.lockState.held).toBe(true)
          const signal = init?.signal
          if (!signal) throw new Error("Missing refresh signal")
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          entered.resolve()
        }),
    )
    const refresh = ui.configuration.refreshCredential(OPENAI_PROVIDER_ID)
    const rejected = expect(refresh).rejects.toMatchObject({ name: "TimeoutError" })
    await entered.promise
    expect(timeoutSignal).toHaveBeenCalledExactlyOnceWith(15_000)
    timeout.abort(new DOMException("Refresh timed out", "TimeoutError"))

    await rejected

    await expect(ui.configuration.credentials.read(OPENAI_PROVIDER_ID)).resolves.toEqual(
      ui.original,
    )
    expect(ui.storage.set).not.toHaveBeenCalled()
    expect(ui.lockState.held).toBe(false)
    expect(ui.configuration.isChangingAuth).toBe(false)
  })

  test.each(["missing", "api_key", "unsupported"] as const)(
    "rejects %s credentials without a request or storage write",
    async (state) => {
      const ui = setup()
      if (state === "missing") ui.stored[CREDENTIALS_KEY] = {}
      if (state === "api_key") {
        ui.stored[CREDENTIALS_KEY] = { [OPENAI_PROVIDER_ID]: ui.otherCredential }
      }

      await expect(
        ui.configuration.refreshCredential(
          state === "unsupported" ? "anthropic" : OPENAI_PROVIDER_ID,
        ),
      ).rejects.toThrow("Configure this provider before refreshing its credential")

      expect(ui.fetchToken).not.toHaveBeenCalled()
      expect(ui.storage.set).not.toHaveBeenCalled()
      expect(ui.configuration.isChangingAuth).toBe(false)
    },
  )
})
