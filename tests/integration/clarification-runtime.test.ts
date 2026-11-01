import type { AgentTool } from "@earendil-works/pi-agent-core"
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type JsonObject,
} from "@earendil-works/pi-ai"
import { IDBFactory } from "fake-indexeddb"
import { Type } from "typebox"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { PendingClarification } from "../../src/browser/agent/clarification.js"
import { BrowserAgentRuntime } from "../../src/browser/agent/runtime.js"
import { McpManager } from "../../src/browser/mcp/manager.js"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"
import { required, selectedTarget } from "../support/target-context.js"

class Locks {
  private held = new Set<string>()
  async request(
    name: string,
    _options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>,
  ) {
    if (this.held.has(name)) return callback(null)
    this.held.add(name)
    try {
      await callback({ name, mode: "exclusive" } as Lock)
    } finally {
      this.held.delete(name)
    }
  }
  async query() {
    return {
      held: [...this.held].map((name) => ({ name, mode: "exclusive", clientId: "test" })),
      pending: [],
    }
  }
}
let locks: LockManager
const runtimes = new Set<BrowserAgentRuntime>()
const request = { question: "Which target?", options: [{ label: "First" }, { label: "Second" }] }
const call = (name: string, id = name, args: JsonObject = {}) => ({
  type: "toolCall" as const,
  name,
  id,
  arguments: args,
})

async function setup(batches: AssistantMessage["content"][]) {
  let card: PendingClarification | undefined
  const events: string[] = []
  const warnings: string[] = []
  const confirm = vi.fn(async () => false)
  const runtime = new BrowserAgentRuntime(
    {
      confirm,
      onAuthEvent: vi.fn(),
      onAgentEvent: (event) => events.push(event.type),
      onClarification: (value) => {
        card = value
      },
      onPersistenceError: (error) => warnings.push(error),
    },
    new SessionLease(locks),
  )
  runtimes.add(runtime)
  await runtime.initialize()
  let streams = 0
  const contexts: string[] = []
  runtime.agent.streamFunction = (_model, context) => {
    contexts.push(JSON.stringify(context))
    const stream = createAssistantMessageEventStream()
    const content = batches[streams++] ?? [{ type: "text" as const, text: "Answered" }]
    const toolUse = content.some((part) => part.type === "toolCall")
    const message: AssistantMessage = {
      role: "assistant",
      api: runtime.model.api,
      provider: runtime.model.provider,
      model: runtime.model.id,
      content,
      stopReason: toolUse ? "toolUse" : "stop",
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
    stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message })
    stream.end()
    return stream
  }
  return {
    runtime,
    confirm,
    events,
    warnings,
    contexts,
    card: () => card,
    streams: () => streams,
    async waiting() {
      await vi.waitFor(() => expect(card).toBeDefined())
      return required(card)
    },
  }
}

beforeEach(() => {
  locks = new Locks() as unknown as LockManager
  vi.stubGlobal("indexedDB", new IDBFactory())
  const area = () => {
    const values: Record<string, unknown> = {}
    return {
      get: vi.fn(async (key: string) => structuredClone({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) =>
        Object.assign(values, structuredClone(items)),
      ),
      remove: vi.fn(async (key: string) => {
        delete values[key]
      }),
    }
  }
  vi.stubGlobal("chrome", {
    storage: {
      local: { ...area(), setAccessLevel: vi.fn(async () => undefined) },
      session: area(),
    },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request")
    }),
  )
})
afterEach(async () => {
  for (const runtime of runtimes) runtime.abort()
  await Promise.all([...runtimes].map((runtime) => runtime.shutdown()))
  runtimes.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("run-scoped clarification integration", () => {
  test.each([false, true])(
    "suppresses all browser/MCP sibling dispatch (question first=%s) and continues once",
    async (first) => {
      const dispatch = vi.fn(async () => ({ content: [], details: {} }))
      const tools: AgentTool[] = ["browser_side_effect", "mcp_remote"].map((name) => ({
        name,
        description: name,
        label: name,
        parameters: Type.Object({}),
        executionMode: "sequential",
        replay: "never",
        execute: dispatch,
      }))
      vi.spyOn(McpManager.prototype, "prepare").mockResolvedValue(tools)
      const question = call("request_user_input", "question", request)
      const siblings = tools.map((tool) => call(tool.name))
      const s = await setup([first ? [question, ...siblings] : [...siblings, question]])
      const session = s.runtime.activeSession.id
      const prompt = vi.spyOn(s.runtime.agent, "prompt")
      const run = s.runtime.submit("Ambiguous request")
      const card = await s.waiting()
      expect(s.runtime.isAwaitingClarification).toBe(true)
      expect(dispatch).not.toHaveBeenCalled()
      expect(s.confirm).not.toHaveBeenCalled()
      for (const operation of [
        () => s.runtime.submit("replace"),
        () => s.runtime.newSession(),
        () => s.runtime.resumeSession(session),
        () => s.runtime.clearSessions(),
      ])
        await expect(operation()).rejects.toThrow(/question/)
      expect(() => s.runtime.queueFollowUp("queued")).toThrow(/question/)
      expect(s.runtime.answerClarification(card, { optionId: "option-2" })).toBe(true)
      expect(s.runtime.answerClarification(card, { other: "late" })).toBe(false)
      await run
      expect(prompt).toHaveBeenCalledOnce()
      expect(s.events.filter((event) => event === "agent_start")).toHaveLength(1)
      expect(s.streams()).toBe(2)
      expect(s.runtime.activeSession.id).toBe(session)
      expect(s.contexts[1]).toContain("Second")
      expect(dispatch).not.toHaveBeenCalled()
      expect(s.confirm).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      const saved = await s.runtime.sessions.get(session)
      expect(saved?.messages.filter((message) => message.role === "toolResult")).toHaveLength(3)
      await vi.waitFor(() => expect(s.runtime.isBusy).toBe(false))
      const tree = s.runtime.getSessionTree()
      expect(tree.nodes.some((node) => node.message.role === "toolResult")).toBe(true)
      await s.runtime.shutdown()
      runtimes.delete(s.runtime)
      const restored = await setup([])
      await restored.runtime.resumeSession(session)
      expect(restored.runtime.isAwaitingClarification).toBe(false)
      expect(restored.card()).toBeUndefined()
      expect(restored.streams()).toBe(0)
    },
  )

  test.each(["abort", "shutdown", "credential"])(
    "%s cancels without deadlock or provider continuation",
    async (action) => {
      const s = await setup([[call("request_user_input", "question", request)]])
      const run = s.runtime.submit("Ask")
      const card = await s.waiting()
      if (action === "abort") s.runtime.abort()
      if (action === "shutdown") await s.runtime.shutdown()
      if (action === "credential") await s.runtime.configuration.logout(s.runtime.model.provider)
      await run
      expect(s.runtime.answerClarification(card, { optionId: "option-1" })).toBe(false)
      expect(s.card()).toBeUndefined()
      expect(s.streams()).toBe(1)
      expect(s.runtime.agent.state.isStreaming).toBe(false)
      expect(
        s.runtime.agent.state.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toBe(true)
      if (action === "shutdown") runtimes.delete(s.runtime)
    },
  )

  test("enforces the three-call run limit, including invalid calls", async () => {
    const s = await setup(
      Array.from({ length: 4 }, (_, index) => [
        call("request_user_input", `question-${index}`, index === 0 ? {} : request),
      ]),
    )
    const run = s.runtime.submit("Ask")
    for (let i = 1; i <= 2; i++) {
      await vi.waitFor(() => expect(s.card()?.toolCallId).toBe(`question-${i}`))
      s.runtime.answerClarification(required(s.card()), { other: `Answer ${i}` })
    }
    await run
    expect(s.card()).toBeUndefined()
    const errors = s.runtime.agent.state.messages.filter(
      (message) => message.role === "toolResult" && message.isError,
    )
    expect(errors).toHaveLength(2)
    expect(JSON.stringify(errors)).toContain("at most three")
  })

  test.each([false, true])(
    "target-context changes invalidate only element-linked questions (element=%s)",
    async (element) => {
      const args: JsonObject = {
        ...request,
        options: [
          { label: "Submitted target", attachmentId: "known" },
          { label: "Different result" },
        ],
      }
      const s = await setup([[call("request_user_input", "question", args)]])
      const images = element
        ? []
        : [{ type: "image" as const, mimeType: "image/png", data: "YQ==" }]
      const elements = element ? [selectedTarget()] : []
      const run = s.runtime.submit(
        "Review the target",
        "steer",
        images,
        elements,
        true,
        undefined,
        [],
        { imageIds: element ? [] : ["known"], elementIds: element ? ["known"] : [] },
      )
      const card = await s.waiting()
      s.runtime.invalidateClarificationTargets()
      if (element) expect(s.runtime.answerClarification(card, { optionId: "option-1" })).toBe(false)
      else expect(s.runtime.answerClarification(card, { optionId: "option-1" })).toBe(true)
      await run
      expect(s.streams()).toBe(element ? 1 : 2)
      expect(s.card()).toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  test("unknown attachment IDs cannot open a card or fetch their content", async () => {
    const s = await setup([
      [
        call("request_user_input", "question", {
          ...request,
          options: [
            { label: "Remote target", attachmentId: "https://evil.test/image" },
            { label: "Other" },
          ],
        }),
      ],
    ])
    await s.runtime.submit("Review")
    expect(s.card()).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(
      s.runtime.agent.state.messages.some(
        (message) => message.role === "toolResult" && message.isError,
      ),
    ).toBe(true)
  })

  test("paired preparation freezes IDs, image positions, and page context without putting data in system instructions", async () => {
    let release!: (tools: AgentTool[]) => void
    vi.spyOn(McpManager.prototype, "prepare").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const s = await setup([])
    const images = [{ type: "image" as const, mimeType: "image/png", data: "YQ==" }]
    const elements = [selectedTarget()]
    const submitted = {
      imageIds: ["image"],
      elementIds: ["element"],
      pair: { targetId: "element", referenceId: "image" },
    }
    const run = s.runtime.submit(
      "Match target style",
      "steer",
      images,
      elements,
      true,
      undefined,
      [],
      submitted,
    )
    await vi.waitFor(() => expect(release).toBeDefined())
    images[0] = { ...required(images[0]), data: "Yg==" }
    required(elements[0]).text = "Changed after submit"
    submitted.pair.targetId = "new-draft"
    release([])
    await run
    const user = s.runtime.agent.state.messages.find((message) => message.role === "user")
    expect(JSON.stringify(user)).toContain('"data":"YQ=="')
    expect(JSON.stringify(user)).not.toContain("Changed after submit")
    expect(JSON.stringify(user)).toContain('targetId\\":\\"element')
    expect(JSON.stringify(user)).toContain('imagePosition\\":1')
    expect(s.runtime.agent.state.systemPrompt).not.toContain("Match target style")
    expect(s.runtime.agent.state.systemPrompt).not.toContain("untrustedPageContext")
    expect(fetch).not.toHaveBeenCalled()
  })

  test("ordinary tool batches keep baseline persistence-failure behavior", async () => {
    const dispatch = vi.fn(async () => ({ content: [], details: {} }))
    vi.spyOn(McpManager.prototype, "prepare").mockResolvedValue([
      {
        name: "ordinary_read",
        label: "Read",
        description: "Read",
        parameters: Type.Object({}),
        execute: dispatch,
      },
    ])
    const s = await setup([[call("ordinary_read")]])
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(s.runtime.sessions, "put").mockRejectedValue(new Error("Disk unavailable"))
    await s.runtime.submit("Ordinary request")
    expect(dispatch).toHaveBeenCalledOnce()
    expect(s.streams()).toBe(2)
    expect(s.card()).toBeUndefined()
  })

  test("persistence failure before dispatch cannot open a question or deadlock", async () => {
    const s = await setup([[call("request_user_input", "question", request)]])
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(s.runtime.sessions, "put").mockRejectedValue(new Error("Disk unavailable"))
    await s.runtime.submit("Ask")
    expect(s.card()).toBeUndefined()
    expect(s.streams()).toBe(1)
    expect(s.warnings.some((warning) => warning.includes("Disk unavailable"))).toBe(true)
    expect(error).toHaveBeenCalled()
    expect(s.runtime.agent.state.isStreaming).toBe(false)
  })
})
