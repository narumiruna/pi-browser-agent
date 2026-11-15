import { expect, test, vi } from "vitest"
import { createBrowserAnthropicOAuth } from "../../../src/browser/auth/anthropic-oauth.js"
import { createBrowserGitHubCopilotOAuth } from "../../../src/browser/auth/github-copilot-oauth.js"
import { createBrowserKimiOAuth } from "../../../src/browser/auth/kimi-oauth.js"
import { pollDeviceAuthorization, readJsonResponse } from "../../../src/browser/auth/oauth-utils.js"
import { createBrowserOpenRouterOAuth } from "../../../src/browser/auth/openrouter-oauth.js"
import { createBrowserRadiusOAuth } from "../../../src/browser/auth/radius-oauth.js"
import { createBrowserXaiOAuth } from "../../../src/browser/auth/xai-oauth.js"

const deviceProviders = [
  ["Kimi", createBrowserKimiOAuth],
  ["Radius", createBrowserRadiusOAuth],
  ["xAI", createBrowserXaiOAuth],
]
const allProviders = [
  ["Anthropic", createBrowserAnthropicOAuth],
  ["GitHub Copilot", createBrowserGitHubCopilotOAuth],
  ["OpenRouter", createBrowserOpenRouterOAuth],
  ...deviceProviders,
]
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const token = (suffix = "initial") => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 3600,
})
const device = {
  device_code: "owned-device-code",
  user_code: "OWNED-CODE",
  verification_uri: "https://login.example/device",
  expires_in: 900,
  interval: 1,
}
const interaction = (controller = new AbortController()) => ({
  signal: controller.signal,
  notify: vi.fn(),
  prompt: vi.fn(async () => "authorization-code"),
})

test.each(deviceProviders)(
  "%s device login handles pending, slowdown, rotation, and private auth conversion",
  async (_name, create) => {
    let now = 1000000
    const waits = []
    const replies = [
      json(device),
      json({ error: "authorization_pending" }, 400),
      json({ error: "slow_down" }, 400),
      json(token()),
      json(token("rotated")),
    ]
    const requests = []
    const oauth = create({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms)
        now += ms
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: String(init.body) })
        const response = replies.shift()
        if (!response) throw Error("Unexpected request")
        return response
      },
    })
    const io = interaction()
    const credential = await oauth.login(io)
    expect(credential).toMatchObject({
      type: "oauth",
      access: "access-initial",
      refresh: "refresh-initial",
    })
    expect(io.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "device_code", userCode: "OWNED-CODE" }),
    )
    expect(waits).toEqual([1000, 1000, 6000])
    const rotated = await oauth.refresh(credential, new AbortController().signal)
    expect(rotated).toMatchObject({ access: "access-rotated", refresh: "refresh-rotated" })
    expect(requests.at(-1).body).toContain("refresh_token=refresh-initial")
    expect(JSON.stringify(await oauth.toAuth(rotated))).toContain("access-rotated")
    expect(JSON.stringify(io.notify.mock.calls)).not.toContain("access-initial")
  },
)
test.each(allProviders)(
  "%s cancellation before login emits no URL, prompt, or network",
  async (_name, create) => {
    const fetch = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const io = interaction(controller)
    await expect(create({ fetch }).login(io)).rejects.toMatchObject({ name: "AbortError" })
    expect(fetch).not.toHaveBeenCalled()
    expect(io.notify).not.toHaveBeenCalled()
    expect(io.prompt).not.toHaveBeenCalled()
  },
)
test("GitHub Copilot derives its account-specific endpoint without authorizing or probing it", async () => {
  const replies = [
    json(device),
    json({ access_token: "github-refresh-token" }),
    json({
      token: "tid=initial;proxy-ep=proxy.business.githubcopilot.com;exp=9999999",
      expires_at: 9999999,
    }),
    json({
      token: "tid=rotated;proxy-ep=proxy.business.githubcopilot.com;exp=9999999",
      expires_at: 9999999,
    }),
  ]
  const urls = []
  const oauth = createBrowserGitHubCopilotOAuth({
    sleep: async () => {},
    fetch: async (url) => {
      urls.push(String(url))
      return replies.shift()
    },
  })
  const credential = await oauth.login(interaction())
  expect(credential.refresh).toBe("github-refresh-token")
  expect((await oauth.toAuth(credential)).baseUrl).toBe("https://api.business.githubcopilot.com")
  const rotated = await oauth.refresh(credential, new AbortController().signal)
  expect(rotated.access).toContain("tid=rotated")
  expect(
    urls.every(
      (url) => new URL(url).hostname === "github.com" || new URL(url).hostname === "api.github.com",
    ),
  ).toBe(true)
})
test.each([
  ["Anthropic", createBrowserAnthropicOAuth],
  ["OpenRouter", createBrowserOpenRouterOAuth],
])(
  "%s PKCE exchange uses an independent S256 verifier without a loopback fetch",
  async (name, create) => {
    const calls = []
    const events = []
    const oauth = create({
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) })
        return json(name === "OpenRouter" ? { key: "openrouter-private-key" } : token())
      },
    })
    const io = interaction()
    io.notify = (event) => events.push(event)
    io.prompt = async () => {
      const auth = new URL(events.find((event) => event.type === "auth_url").url)
      return name === "Anthropic"
        ? `${auth.searchParams.get("redirect_uri")}?code=owned-code&state=${auth.searchParams.get("state")}`
        : "owned-code"
    }
    const credential = await oauth.login(io)
    const auth = new URL(events.find((event) => event.type === "auth_url").url)
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256")
    const verifier = calls[0].body.code_verifier
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    expect(Buffer.from(digest).toString("base64url")).toBe(auth.searchParams.get("code_challenge"))
    expect(
      calls.every(
        (call) =>
          new URL(call.url).protocol === "https:" && new URL(call.url).hostname !== "localhost",
      ),
    ).toBe(true)
    expect(JSON.stringify(events)).not.toContain(credential.access)
    const refreshed = await oauth.refresh(credential, new AbortController().signal)
    expect(refreshed.type).toBe("oauth")
  },
)
test("malformed OAuth JSON cannot expose a response body that happens to name the provider", async () => {
  await expect(
    readJsonResponse(
      new Response("Kimi Code OAuth private-fixture-refresh-token"),
      "Kimi Code OAuth",
    ),
  ).rejects.toThrow(/^Kimi Code OAuth returned an invalid response\.$/)
})
test("device deadlines, denial, malformed intervals, and cancellation are finite", async () => {
  let now = 0
  const waits = []
  await expect(
    pollDeviceAuthorization({
      expiresInSeconds: 2,
      intervalSeconds: NaN,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms)
        now += ms
      },
      poll: async () => ({ status: "pending" }),
    }),
  ).rejects.toThrow("expired")
  expect(waits).toEqual([2000])
  await expect(
    pollDeviceAuthorization({
      waitBeforeFirstPoll: false,
      expiresInSeconds: 900,
      poll: async () => ({ status: "failed", message: "User denied login" }),
    }),
  ).rejects.toThrow("denied")
  const controller = new AbortController()
  await expect(
    pollDeviceAuthorization({
      expiresInSeconds: 900,
      signal: controller.signal,
      sleep: async () => controller.abort(),
      poll: vi.fn(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" })
})
