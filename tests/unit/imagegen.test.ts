import type { AuthResult, Credential } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { CREDENTIALS_KEY } from "../../src/browser/auth/credential-store.js"
import type { BrowserConfiguration } from "../../src/browser/configuration.js"
import {
  generateImageRequest,
  IMAGE_ENDPOINT,
  IMAGE_REQUEST_TIMEOUT_MS,
  imagegenWait,
  MAX_IMAGE_RESPONSE_BYTES,
} from "../../src/browser/imagegen/client.js"
import { createImagegenTools } from "../../src/browser/imagegen/tool.js"

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOfoAAAAASUVORK5CYII="
function token(account = "account-test", alg = "RS256", signature = "c2ln") {
  return `${btoa(JSON.stringify({ alg })).replace(/=/g, "")}.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).replace(/=/g, "")}.${signature}`
}
let credential: Credential | undefined
let allowed: boolean
let changed: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>
let revoked: Set<() => void>
let auth: ReturnType<typeof vi.fn>
let fetcher: ReturnType<typeof vi.fn>
let configuration: Pick<BrowserConfiguration, "credentials" | "models">

function response(value: unknown = { data: [{ b64_json: PNG }] }, headers = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  })
}
async function tool(confirm = vi.fn(async () => true)) {
  const [result] = await createImagegenTools(configuration, confirm)
  if (!result) throw new Error("Missing tool")
  return result
}
async function execute(confirm = vi.fn(async () => true), signal?: AbortSignal) {
  return (await tool(confirm)).execute("image-test", { prompt: "A small icon" }, signal)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  credential = {
    type: "oauth",
    access: token(),
    refresh: "private-refresh",
    expires: Date.now() + 3600000,
  }
  allowed = true
  changed = new Set()
  revoked = new Set()
  auth = vi.fn(async (): Promise<AuthResult> => ({ auth: { apiKey: token() } }))
  configuration = {
    credentials: { read: vi.fn(async () => credential) },
    models: { getAuth: auth },
  } as unknown as Pick<BrowserConfiguration, "credentials" | "models">
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({
          piBrowserAgentApprovedHostPermissions: allowed
            ? ["https://chatgpt.com/*", "https://auth.openai.com/*"]
            : [],
        })),
      },
      onChanged: {
        addListener: (listener: never) => changed.add(listener),
        removeListener: (listener: never) => changed.delete(listener),
      },
    },
    permissions: {
      contains: vi.fn(async () => true),
      onRemoved: {
        addListener: (listener: never) => revoked.add(listener),
        removeListener: (listener: never) => revoked.delete(listener),
      },
    },
  })
  fetcher = vi.fn(async () => response())
  vi.stubGlobal("fetch", fetcher)
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Codex image JSON protocol", () => {
  test("sends one fixed request with OAuth headers, no cookies, redirects, history, or filesystem path", async () => {
    fetcher.mockResolvedValue(
      response(undefined, { "x-codex-imagegen-request-id": "image_test-1" }),
    )
    const confirm = vi.fn(async () => true)
    const result = await (await tool(confirm)).execute("one", {
      prompt: "  An icon  ",
      transparentBackground: true,
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("account quota"),
        {
          targetUrl: IMAGE_ENDPOINT,
          prompt: "  An icon  ",
          transparentBackground: true,
          size: "auto",
        },
      ]),
    )
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(IMAGE_ENDPOINT)
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    })
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
      "ChatGPT-Account-ID": "account-test",
      originator: "pi-browser-agent",
    })
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "  An icon  ",
      background: "transparent",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    })
    expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" })
    expect(result.details).toEqual({
      mimeType: "image/png",
      width: 1,
      height: 1,
      requestId: "image_test-1",
    })
    expect(JSON.stringify(result)).not.toContain(token())
    expect(JSON.stringify(result)).not.toContain("private-refresh")
    expect(JSON.stringify(result)).not.toContain("account-test")
    expect(changed.size).toBe(0)
    expect(revoked.size).toBe(0)
  })

  test.each([
    undefined,
    "auto",
    "256x256",
    "256x768",
    "768x256",
    "512x512",
    "768x512",
    "1024x1536",
    "1536x864",
    "3840x2160",
    "2160x3840",
  ])("confirms and sends output size %s", async (size) => {
    const confirm = vi.fn(async () => true)
    await (await tool(confirm)).execute("sized", { prompt: "A small icon", size })
    expect(confirm.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ size: size ?? "auto" })]),
    )
    expect(fetcher).toHaveBeenCalledOnce()
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ size: size ?? "auto" })
  })

  test("reads chunked UTF-8 JSON and ignores arbitrary response metadata and headers", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ignored: "圖片", data: [{ b64_json: PNG }] }),
    )
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
            controller.close()
          },
        }),
        {
          headers: {
            "Content-Type": "Application/JSON; charset=utf-8",
            "x-request-id": "secret",
            "x-codex-imagegen-request-id": "unsafe id",
          },
        },
      ),
    )
    const result = await execute()
    expect(result.details).not.toHaveProperty("requestId")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test.each([401, 403, 429, 500, 302])(
    "rejects HTTP %s without exposing the body or retrying",
    async (status) => {
      fetcher.mockResolvedValue(new Response(`private ${token()}`, { status }))
      await expect(execute()).rejects.toThrow(/rejected|denied|quota|rate limit/)
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )

  test.each([
    { data: [] },
    { data: [{ b64_json: PNG }, { b64_json: PNG }] },
    { data: [{ url: "https://elsewhere.test/private.png" }] },
    { data: [{ b64_json: "<svg onload='bad'/>" }] },
  ])("rejects invalid image results without fetching links", async (value) => {
    fetcher.mockResolvedValue(response(value))
    await expect(execute()).rejects.toThrow(/invalid|Invalid/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  test.each(["text/event-stream", "text/html"])("rejects content type %s", async (type) => {
    fetcher.mockResolvedValue(
      new Response("private response", { headers: { "content-type": type } }),
    )
    await expect(execute()).rejects.toThrow("invalid image JSON")
  })

  test("rejects redirected responses and malformed UTF-8", async () => {
    const redirected = response()
    Object.defineProperty(redirected, "redirected", { value: true })
    fetcher.mockResolvedValueOnce(redirected)
    await expect(execute()).rejects.toThrow("redirects are not allowed")
    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    )
    await expect(execute()).rejects.toThrow("invalid image JSON")
  })

  test("bounds declared and streamed bytes even without Content-Length", async () => {
    fetcher.mockResolvedValueOnce(
      response(undefined, { "content-length": String(MAX_IMAGE_RESPONSE_BYTES + 1) }),
    )
    await expect(execute()).rejects.toThrow("size limit")
    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array(MAX_IMAGE_RESPONSE_BYTES + 1), {
        headers: { "content-type": "application/json" },
      }),
    )
    await expect(execute()).rejects.toThrow("size limit")
  })

  test.each([token("unsafe account"), token("account", "none"), "private-key"])(
    "rejects incompatible token %s before HTTP",
    async (value) => {
      await expect(
        generateImageRequest(
          value,
          { prompt: "icon", transparentBackground: false, size: "auto" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("valid OpenAI Codex")
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
})

describe("Codex image authorization and lifecycle", () => {
  test.each([undefined, { type: "api_key", key: "private-key" }])(
    "omits the tool without Codex OAuth",
    async (value) => {
      credential = value as Credential | undefined
      expect(await createImagegenTools(configuration, vi.fn())).toEqual([])
      expect(auth).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  test.each([
    { prompt: " " },
    { prompt: "a".repeat(32001) },
    { prompt: "icon", path: "/tmp/icon.png" },
    { prompt: "icon", transparentBackground: "yes" },
  ])("validates direct arguments before confirmation", async (args) => {
    const confirm = vi.fn(async () => true)
    await expect((await tool(confirm)).execute("invalid", args)).rejects.toThrow(
      "nonblank image prompt",
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test.each([
    null,
    "",
    512,
    {},
    "AUTO",
    "512X512",
    "0512x512",
    "512.0x512",
    "512x512 ",
    "512x512\n",
    "512x512\r",
    "16x16",
    "240x512",
    "512x240",
    "513x512",
    "512x513",
    "4096x2160",
    "2160x4096",
    "3840x2176",
    "2176x3840",
    "256x784",
    "784x256",
    "9999999999x512",
  ])("rejects invalid output size %j before confirmation or authentication", async (size) => {
    const confirm = vi.fn(async () => true)
    await expect(
      (await tool(confirm)).execute("invalid-size", { prompt: "A small icon", size }),
    ).rejects.toThrow("image size")
    expect(confirm).not.toHaveBeenCalled()
    expect(auth).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("decline does not resolve auth or generate", async () => {
    await expect(execute(vi.fn(async () => false))).rejects.toThrow("declined")
    expect(auth).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("always confirms again without a reusable approval scope", async () => {
    const confirm = vi.fn(async () => true)
    await execute(confirm)
    await execute(confirm)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect((confirm.mock.calls as unknown[][]).every((call) => call[3] === undefined)).toBe(true)
  })

  test("broad Chrome access without exact app approval cannot authorize generation or refresh", async () => {
    allowed = false
    await expect(execute()).rejects.toThrow("origin access is missing")
    expect(auth).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("rechecks credential removal during confirmation", async () => {
    const confirm = vi.fn(async () => {
      credential = undefined
      return true
    })
    await expect(execute(confirm)).rejects.toThrow("Sign in to OpenAI Codex")
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("rejects account replacement during confirmation even without a storage event", async () => {
    const confirm = vi.fn(async () => {
      credential = {
        type: "oauth",
        access: token("replacement-account"),
        refresh: "replacement-refresh",
        expires: Date.now() + 3600000,
        accountId: "replacement-account",
      }
      return true
    })
    await expect(execute(confirm)).rejects.toThrow("Sign in to OpenAI Codex")
    expect(auth).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(changed.size).toBe(0)
  })

  test.each(["replacement", "removal", "remove and restore"])(
    "cancels pending confirmation on credential %s without waiting for the dialog",
    async (kind) => {
      const pending = deferred<boolean>()
      const confirm = vi.fn(async () => pending.promise)
      const original = credential
      const running = execute(confirm)
      const failure = expect(running).rejects.toThrow("cancelled before confirmation")
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
      credential =
        kind === "replacement"
          ? {
              type: "oauth",
              access: token("replacement-account"),
              refresh: "replacement-refresh",
              expires: Date.now() + 3600000,
            }
          : undefined
      for (const listener of changed)
        listener({ [CREDENTIALS_KEY]: { newValue: { "openai-codex": credential } } }, "local")
      if (kind === "remove and restore") {
        credential = original
        for (const listener of changed)
          listener({ [CREDENTIALS_KEY]: { newValue: { "openai-codex": credential } } }, "local")
      }
      await failure
      expect((confirm.mock.calls as unknown[][])[0]?.[2]).toMatchObject({ aborted: true })
      pending.resolve(true)
      await Promise.resolve()
      expect(auth).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
      expect(changed.size).toBe(0)
      expect(revoked.size).toBe(0)
    },
  )

  test("permits same-account refresh while confirmation is open", async () => {
    const rotated = token("account-test", "RS256", "cm90YXRlZA")
    const confirm = vi.fn(async () => {
      credential = {
        type: "oauth",
        access: rotated,
        refresh: "rotated-refresh",
        expires: Date.now() + 3600000,
        accountId: "account-test",
      }
      for (const listener of changed)
        listener({ [CREDENTIALS_KEY]: { newValue: { "openai-codex": credential } } }, "local")
      return true
    })
    auth.mockResolvedValue({ auth: { apiKey: rotated } })
    await execute(confirm)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${rotated}`)
  })

  test("cancels account replacement during authentication and discards its late result", async () => {
    const late = deferred<AuthResult>()
    auth.mockReturnValue(late.promise)
    const running = execute()
    const failure = expect(running).rejects.toThrow("cancelled")
    await vi.waitFor(() => expect(auth).toHaveBeenCalledOnce())
    credential = {
      type: "oauth",
      access: token("replacement-account"),
      refresh: "replacement-refresh",
      expires: Date.now() + 3600000,
      accountId: "replacement-account",
    }
    for (const listener of changed)
      listener({ [CREDENTIALS_KEY]: { newValue: { "openai-codex": credential } } }, "local")
    await failure
    late.resolve({ auth: { apiKey: credential.access } })
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(changed.size).toBe(0)
    expect(revoked.size).toBe(0)
  })

  test("rejects authentication that resolves another account without a storage event", async () => {
    auth.mockImplementation(async () => {
      credential = {
        type: "oauth",
        access: token("replacement-account"),
        refresh: "replacement-refresh",
        expires: Date.now() + 3600000,
      }
      return { auth: { apiKey: credential.access } }
    })
    await expect(execute()).rejects.toThrow("Sign in to OpenAI Codex")
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("rejects stored account metadata that conflicts with the access-token claim", async () => {
    credential = {
      type: "oauth",
      access: token("replacement-account"),
      refresh: "private-refresh",
      expires: Date.now() + 3600000,
      accountId: "account-test",
    }
    const confirm = vi.fn(async () => true)
    await expect(execute(confirm)).rejects.toThrow("Sign in to OpenAI Codex")
    expect(confirm).not.toHaveBeenCalled()
    expect(auth).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("rejects custom resolved auth endpoints instead of forwarding credential or headers", async () => {
    auth.mockResolvedValue({
      auth: { apiKey: token(), baseUrl: "https://other.test", headers: { "x-secret": "private" } },
    })
    await expect(execute()).rejects.toThrow("Sign in to OpenAI Codex")
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("redacts unknown authentication and transport failures", async () => {
    auth.mockRejectedValueOnce(new Error(`private-refresh ${token()}`))
    await expect(execute()).rejects.toThrow(/^Image generation failed\./)
    fetcher.mockRejectedValueOnce(new Error(`private-refresh ${token()}`))
    await expect(execute()).rejects.toThrow(/^Image generation failed\./)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  test("observes already-started rejections when the signal is already aborted", async () => {
    const abort = new AbortController()
    abort.abort(new Error("Cancelled test"))
    await expect(
      imagegenWait(Promise.reject(new Error("private upstream failure")), abort.signal),
    ).rejects.toThrow("Cancelled test")
    const late = deferred<void>()
    await expect(
      imagegenWait(
        late.promise.then(() => {
          throw new Error("private late failure")
        }),
        abort.signal,
      ),
    ).rejects.toThrow("Cancelled test")
    late.resolve()
    await Promise.resolve()
  })

  test.each(["before confirmation", "after confirmation"])(
    "cancels a stalled credential read %s",
    async (phase) => {
      const imageTool = await tool()
      const ready = deferred<void>()
      let reads = 0
      vi.mocked(configuration.credentials.read).mockImplementation(async () => {
        reads++
        if (phase === "after confirmation" && reads === 1) return credential
        ready.resolve()
        return new Promise(() => {})
      })
      const abort = new AbortController()
      const running = imageTool.execute("stalled-read", { prompt: "icon" }, abort.signal)
      const failure = expect(running).rejects.toThrow(/cancelled|Cancelled/)
      await ready.promise
      abort.abort(new Error("Cancelled test"))
      await failure
      expect(fetcher).not.toHaveBeenCalled()
      expect(changed.size).toBe(0)
      expect(revoked.size).toBe(0)
    },
  )

  test.each(["caller", "deadline"])(
    "ends a stalled permission read on %s cancellation",
    async (kind) => {
      vi.useFakeTimers()
      const ready = deferred<void>()
      vi.mocked(chrome.permissions.contains).mockImplementation(async () => {
        ready.resolve()
        return new Promise(() => {})
      })
      const abort = new AbortController()
      const running = execute(undefined, abort.signal)
      const failure = expect(running).rejects.toThrow("cancelled or timed out")
      await ready.promise
      if (kind === "caller") abort.abort()
      else await vi.advanceTimersByTimeAsync(IMAGE_REQUEST_TIMEOUT_MS + 1)
      await failure
      expect(auth).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
      expect(changed.size).toBe(0)
      expect(revoked.size).toBe(0)
    },
  )

  test("drops a late decoded image after cancellation and still closes its bitmap", async () => {
    const late = deferred<{ width: number; height: number; close: ReturnType<typeof vi.fn> }>()
    vi.mocked(createImageBitmap).mockReturnValue(late.promise as Promise<ImageBitmap>)
    const abort = new AbortController()
    const running = execute(undefined, abort.signal)
    const failure = expect(running).rejects.toThrow("cancelled")
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce())
    abort.abort()
    await failure
    const bitmap = { width: 1, height: 1, close: vi.fn() }
    late.resolve(bitmap)
    await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
    expect(fetcher).toHaveBeenCalledOnce()
    expect(changed.size).toBe(0)
  })

  test("times out a stalled response body without replay", async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const reading = deferred<void>()
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            reading.resolve()
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    )
    const running = execute()
    const failure = expect(running).rejects.toThrow("timed out")
    await reading.promise
    await vi.advanceTimersByTimeAsync(IMAGE_REQUEST_TIMEOUT_MS + 1)
    await failure
    expect(cancelled).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  test("accepts the existing serialized OAuth refresh and ignores unrelated credential changes", async () => {
    const rotated = token("account-test", "RS256", "cm90YXRlZA")
    auth.mockImplementation(async () => {
      credential = {
        type: "oauth",
        access: rotated,
        refresh: "rotated-refresh",
        expires: Date.now() + 3600000,
        accountId: "account-test",
      }
      for (const listener of changed)
        listener({ [CREDENTIALS_KEY]: { newValue: { "openai-codex": credential } } }, "local")
      return { auth: { apiKey: rotated } }
    })
    fetcher.mockImplementation(async () => {
      for (const listener of changed)
        listener(
          {
            [CREDENTIALS_KEY]: {
              newValue: {
                "openai-codex": credential,
                another: { type: "api_key", key: "private-other" },
              },
            },
          },
          "local",
        )
      return response()
    })
    await execute()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1].headers["ChatGPT-Account-ID"]).toBe("account-test")
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${rotated}`)
  })

  test("cancels a late authentication resolution without dispatch", async () => {
    const late = deferred<AuthResult>()
    auth.mockReturnValue(late.promise)
    const abort = new AbortController()
    const running = execute(undefined, abort.signal)
    await vi.waitFor(() => expect(auth).toHaveBeenCalledOnce())
    abort.abort()
    await expect(running).rejects.toThrow("server may still consume account quota")
    late.resolve({ auth: { apiKey: token() } })
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(changed.size).toBe(0)
  })

  test("bounds a stalled authentication wait", async () => {
    vi.useFakeTimers()
    auth.mockReturnValue(new Promise(() => {}))
    const running = execute()
    const failure = expect(running).rejects.toThrow("No automatic retry")
    await vi.advanceTimersByTimeAsync(30001)
    await failure
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("bounds stalled headers and cancels late response bodies", async () => {
    vi.useFakeTimers()
    const late = deferred<Response>()
    fetcher.mockReturnValue(late.promise)
    const running = execute()
    const failure = expect(running).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(IMAGE_REQUEST_TIMEOUT_MS + 1)
    await failure
    const body = response()
    const cancel = vi.spyOn(body.body as ReadableStream, "cancel")
    late.resolve(body)
    await Promise.resolve()
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(changed.size).toBe(0)
  })

  test.each(["credential", "permission", "caller"])(
    "cancels active work after %s revocation",
    async (kind) => {
      const abort = new AbortController()
      fetcher.mockImplementation(
        async (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new Error("private transport error")),
              { once: true },
            )
          }),
      )
      const running = execute(undefined, abort.signal)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
      if (kind === "credential")
        for (const listener of changed) listener({ [CREDENTIALS_KEY]: { newValue: {} } }, "local")
      if (kind === "permission") {
        allowed = false
        for (const listener of revoked) listener()
      }
      if (kind === "caller") abort.abort()
      await expect(running).rejects.toThrow("cancelled")
      expect(changed.size).toBe(0)
      expect(revoked.size).toBe(0)
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )
})
