import { describe, expect, test, vi } from "vitest"
import {
  type DeviceAuthorization,
  exchangeDeviceCode,
  extractAccountId,
  pollDeviceAuthorization,
  refreshCodexCredential,
  requestDeviceAuthorization,
} from "../../src/browser/auth/codex-oauth.js"

function jwt(accountId = "acct-123"): string {
  const payload = btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
  return `header.${payload}.signature`
}

const device: DeviceAuthorization = {
  deviceAuthId: "device-1",
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth.openai.com/codex/device",
  intervalSeconds: 1,
  expiresInSeconds: 900,
}

describe("browser Codex OAuth", () => {
  test("parses device authorization and exchanges a completed code", async () => {
    const access = jwt()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "1" }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorization_code: "code", code_verifier: "verifier" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: access, refresh_token: "refresh", expires_in: 3600 }),
          {
            status: 200,
          },
        ),
      )
    let now = 1000
    const dependencies = {
      fetch: fetchMock,
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }
    const controller = new AbortController()

    const authorization = await requestDeviceAuthorization(controller.signal, dependencies)
    const code = await pollDeviceAuthorization(authorization, controller.signal, dependencies)
    const credential = await exchangeDeviceCode(code, controller.signal, dependencies)

    expect(authorization).toMatchObject(device)
    expect(credential).toMatchObject({
      type: "oauth",
      accountId: "acct-123",
      access,
      refresh: "refresh",
      expires: now + 3_600_000,
    })
    expect(fetchMock.mock.calls[2]?.[1]?.body?.toString()).toContain("code_verifier=verifier")
  })

  test("handles pending and slowdown responses before completion", async () => {
    let now = 0
    const sleeps: number[] = []
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow_down" }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorization_code: "code", code_verifier: "verifier" }), {
          status: 200,
        }),
      )
    const result = await pollDeviceAuthorization(device, new AbortController().signal, {
      fetch: fetchMock,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
    })
    expect(result).toEqual({ authorizationCode: "code", codeVerifier: "verifier" })
    expect(sleeps).toEqual([1000, 1000, 6000])
  })

  test.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ])("reports terminal %s state", async (code, message) => {
    await expect(
      pollDeviceAuthorization(device, new AbortController().signal, {
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify({ error: code }), { status: 400 })),
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(message)
  })

  test("expires locally and cancels without another request", async () => {
    let now = 0
    const fetchMock = vi.fn<typeof fetch>()
    await expect(
      pollDeviceAuthorization({ ...device, expiresInSeconds: 1 }, new AbortController().signal, {
        fetch: fetchMock,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      }),
    ).rejects.toThrow("expired")
    expect(fetchMock).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    await expect(
      pollDeviceAuthorization(device, controller.signal, {
        fetch: fetchMock,
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("cancelled")
  })

  test("validates account claims and atomically accepts a rotated refresh token", async () => {
    expect(extractAccountId(jwt("account-x"))).toBe("account-x")
    expect(() => extractAccountId("not-a-jwt")).toThrow("account ID")
    const credential = await refreshCodexCredential(
      { type: "oauth", access: jwt(), refresh: "old", expires: 0 },
      new AbortController().signal,
      {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: jwt("account-x"),
              refresh_token: "rotated",
              expires_in: 60,
            }),
            { status: 200 },
          ),
        ),
        now: () => 500,
      },
    )
    expect(credential).toMatchObject({
      refresh: "rotated",
      expires: 60_500,
      accountId: "account-x",
    })
  })
})
