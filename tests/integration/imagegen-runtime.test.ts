import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { IMAGE_ENDPOINT } from "../../src/browser/imagegen/client.js"
import { createImagegenTools } from "../../src/browser/imagegen/tool.js"
import type { SessionLease } from "../../src/browser/sessions/session-lease.js"

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
const TOKEN = `${btoa(JSON.stringify({ alg: "RS256" }))}.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).replace(/=/g, "")}.c2ln`
const runtimes: BrowserAgentRuntime[] = []
let stored: Record<string, unknown>

function runtime() {
  const confirm = vi.fn(async () => true)
  const agent = new BrowserAgentRuntime(
    {
      confirm,
      onAuthEvent: vi.fn(),
      onAgentEvent: vi.fn(),
    },
    {
      claim: vi.fn(async (_id: string, prepare?: () => Promise<boolean>) =>
        prepare ? prepare() : true,
      ),
      release: vi.fn(async () => {}),
      protectedSessionIds: vi.fn(async () => new Set<string>()),
    } as unknown as SessionLease,
  )
  runtimes.push(agent)
  return { agent, confirm }
}

function streams(agent: BrowserAgentRuntime, useTool: boolean) {
  const contexts: string[] = []
  agent.agent.streamFunction = (_model, context) => {
    contexts.push(JSON.stringify(context))
    const call = useTool && contexts.length === 1
    const message: AssistantMessage = {
      role: "assistant",
      api: agent.model.api,
      provider: agent.model.provider,
      model: agent.model.id,
      content: call
        ? [
            {
              type: "toolCall",
              id: "generate-test",
              name: "codex_imagegen",
              arguments: { prompt: "A red square" },
            },
          ]
        : [{ type: "text", text: "Done" }],
      stopReason: call ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    const stream = createAssistantMessageEventStream()
    stream.push(
      call
        ? { type: "done", reason: "toolUse", message }
        : { type: "done", reason: "stop", message },
    )
    stream.end()
    return stream
  }
  return contexts
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  stored = {
    piBrowserAgentApprovedHostPermissions: ["https://chatgpt.com/*", "https://auth.openai.com/*"],
    piBrowserAgentCredentialsV1: {
      "openai-codex": {
        type: "oauth",
        access: TOKEN,
        refresh: "private-refresh",
        expires: Date.now() + 3600000,
      },
    },
  }
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => structuredClone({ [key]: stored[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(value))
        }),
        remove: vi.fn(async (key: string) => {
          delete stored[key]
        }),
        setAccessLevel: vi.fn(async () => {}),
      },
      onChanged: event(),
    },
    permissions: { contains: vi.fn(async () => true), onRemoved: event() },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), {
          headers: { "content-type": "application/json" },
        }),
    ),
  )
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
  )
})

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((agent) => agent.shutdown()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test("generates with a different chat provider and no page; saves the raster without persisting auth or replaying on restore", async () => {
  const { agent, confirm } = runtime()
  await agent.initialize()
  const chat = agent.configuration.getModels("anthropic").find((model) => model.imageInput)
  if (!chat) throw new Error("Missing test chat model")
  await agent.configuration.updateSettings({
    modelProvider: chat.provider,
    modelId: chat.id,
    enabledTools: [],
  })
  await agent.syncSettings({ applyModelToActiveSession: true })
  vi.spyOn(agent.configuration.models, "getAuth").mockResolvedValue({ auth: { apiKey: TOKEN } })
  const contexts = streams(agent, true)
  await agent.submit("Generate an image", "steer", [], [], false)
  expect(agent.model.provider).toBe("anthropic")
  expect(agent.usesPageContext).toBe(false)
  expect(agent.agent.state.tools.map((tool) => tool.name)).toEqual(["codex_imagegen"])
  expect(confirm).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(IMAGE_ENDPOINT)
  expect(contexts).toHaveLength(2)
  expect(contexts[1]).toContain(PNG)
  const id = agent.activeSession.id
  const saved = await agent.sessions.get(id)
  expect(saved?.messages).toContainEqual(
    expect.objectContaining({
      role: "toolResult",
      toolName: "codex_imagegen",
      isError: false,
      content: expect.arrayContaining([{ type: "image", data: PNG, mimeType: "image/png" }]),
    }),
  )
  expect(JSON.stringify(saved)).not.toContain(TOKEN)
  expect(JSON.stringify(saved)).not.toContain("private-refresh")
  await agent.shutdown()
  runtimes.splice(runtimes.indexOf(agent), 1)
  const restored = runtime().agent
  await restored.initialize(id)
  expect(restored.activeSession.messages).toEqual(saved?.messages)
  expect(fetch).toHaveBeenCalledOnce()
  expect(restored.agent.state.isStreaming).toBe(false)
})

test("image authentication permits the real serialized same-account OAuth refresh", async () => {
  const { agent } = runtime()
  await agent.initialize()
  const original = await agent.configuration.credentials.read("openai-codex")
  if (original?.type !== "oauth") throw new Error("Missing test credential")
  await agent.configuration.credentials.modify("openai-codex", async () => ({
    ...original,
    accountId: "test-account",
    expires: Date.now() - 1,
  }))
  const rotated = TOKEN.replace(/\.c2ln$/, ".cm90YXRlZA")
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === "https://auth.openai.com/oauth/token")
      return new Response(
        JSON.stringify({
          access_token: rotated,
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
        { headers: { "content-type": "application/json" } },
      )
    if (url !== IMAGE_ENDPOINT) throw new Error("Unexpected test endpoint")
    return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), {
      headers: { "content-type": "application/json" },
    })
  })
  const [tool] = await createImagegenTools(
    agent.configuration,
    vi.fn(async () => true),
  )
  if (!tool) throw new Error("Missing image tool")
  const result = await tool.execute("refresh-image", { prompt: "A red square" })
  expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fetch).mock.calls[1]).toEqual([
    IMAGE_ENDPOINT,
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: `Bearer ${rotated}`,
        "ChatGPT-Account-ID": "test-account",
      }),
    }),
  ])
  expect(await agent.configuration.credentials.read("openai-codex")).toMatchObject({
    access: rotated,
    refresh: "rotated-refresh",
    accountId: "test-account",
  })
})

test("a later explicit run drops image generation after Codex credential removal", async () => {
  const { agent } = runtime()
  await agent.initialize()
  streams(agent, false)
  await agent.submit("Hello", "steer", [], [], false)
  expect(agent.agent.state.tools.map((tool) => tool.name)).toContain("codex_imagegen")
  await agent.configuration.credentials.delete("openai-codex")
  await agent.submit("Hello again", "steer", [], [], false)
  expect(agent.agent.state.tools.map((tool) => tool.name)).not.toContain("codex_imagegen")
  expect(fetch).not.toHaveBeenCalled()
})
