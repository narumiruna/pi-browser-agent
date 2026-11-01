import { Agent, type AgentTool } from "@earendil-works/pi-agent-core"
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type JsonObject,
} from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { Type } from "typebox"
import { describe, expect, test, vi } from "vitest"
import { required } from "../support/target-context.js"

const model = required(openaiCodexProvider().getModels()[0])
const name = "request_user_input"
const question = { question: "Which target?", options: ["First", "Second"] }
const call = (tool: string, id = tool, args: unknown = {}) => ({
  type: "toolCall" as const,
  name: tool,
  id,
  arguments: args as JsonObject,
})

function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: content.length ? "toolUse" : "stop",
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
}

function proof(batch: AssistantMessage["content"], sequential = false) {
  const dispatch = vi.fn(async () => ({ content: [], details: {} }))
  let release: (() => void) | undefined
  const waiting = vi.fn(
    (_id: string, _args: unknown, signal?: AbortSignal) =>
      new Promise<{ content: []; details: object }>((resolve) => {
        const finish = () => resolve({ content: [], details: {} })
        release = finish
        signal?.addEventListener("abort", finish, { once: true })
        if (signal?.aborted) finish()
      }),
  )
  const tools: AgentTool[] = [
    {
      name,
      label: name,
      description: name,
      parameters: Type.Object(
        { question: Type.String(), options: Type.Array(Type.String()) },
        { additionalProperties: false },
      ),
      execute: waiting,
    },
    ...["browser_click", "mcp_call"].map((tool) => ({
      name: tool,
      label: tool,
      description: tool,
      parameters: Type.Object({}),
      ...(sequential ? { executionMode: "sequential" as const } : {}),
      execute: dispatch,
    })),
  ]
  const hook = vi.fn(async ({ assistantMessage, toolCall }) => {
    // Inspect the raw complete batch, even when the clarification schema is invalid.
    const requests = assistantMessage.content.filter(
      (part: { type: string; name?: string }) => part.type === "toolCall" && part.name === name,
    )
    if (requests.length > 1 || (requests.length === 1 && toolCall.name !== name)) {
      return { block: true, reason: "Clarification batch: sibling discarded" }
    }
    return undefined
  })
  let streams = 0
  const agent = new Agent({
    initialState: { model, tools },
    toolExecution: "parallel",
    beforeToolCall: hook,
    // The locked loop otherwise starts an aborted stream after tool settlement.
    finishTurn: async (_turn, signal) => (signal?.aborted ? { action: "end" } : undefined),
    streamFn: () => {
      const stream = createAssistantMessageEventStream()
      const reply = message(streams++ === 0 ? batch : [])
      stream.push({
        type: "done",
        reason: reply.stopReason === "toolUse" ? "toolUse" : "stop",
        message: reply,
      })
      stream.end()
      return stream
    },
  })
  return { agent, dispatch, waiting, hook, release: () => release?.(), streams: () => streams }
}

describe("locked SDK clarification scheduling proof", () => {
  test.each([false, true])(
    "blocks browser and MCP siblings in either order (sequential=%s)",
    async (sequential) => {
      for (const first of [true, false]) {
        const request = call(name, "question", question)
        const siblings = [call("browser_click"), call("mcp_call")]
        const p = proof(first ? [request, ...siblings] : [...siblings, request], sequential)
        const run = p.agent.prompt("Ambiguous request")
        await vi.waitFor(() => expect(p.waiting).toHaveBeenCalledOnce())
        expect(p.dispatch).not.toHaveBeenCalled()
        expect(p.streams()).toBe(1)
        p.release()
        await run
        expect(p.dispatch).not.toHaveBeenCalled()
        expect(p.streams()).toBe(2)
        expect(p.agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(3)
      }
    },
  )

  test("invalid and duplicate clarification calls still suppress every sibling", async () => {
    for (const requests of [
      [call(name, "invalid", {})],
      [call(name, "a", question), call(name, "b", question)],
    ]) {
      const p = proof([call("browser_click"), ...requests, call("mcp_call")])
      await p.agent.prompt("Ambiguous request")
      expect(p.dispatch).not.toHaveBeenCalled()
      expect(p.waiting).not.toHaveBeenCalled()
      expect(p.agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(
        requests.length + 2,
      )
    }
  })

  test("aborts a delayed local tool without deadlock, dispatch, or automatic replay", async () => {
    const p = proof([call("mcp_call"), call(name, "question", question), call("browser_click")])
    const run = p.agent.prompt("Ambiguous request")
    await vi.waitFor(() => expect(p.waiting).toHaveBeenCalledOnce())
    p.agent.abort()
    await Promise.all([run, p.agent.waitForIdle()])
    p.release()
    expect(p.dispatch).not.toHaveBeenCalled()
    expect(p.agent.state.isStreaming).toBe(false)
    expect(p.streams()).toBe(1)
  })
})
