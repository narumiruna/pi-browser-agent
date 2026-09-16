import { IDBFactory } from "fake-indexeddb"
import { describe, expect, test } from "vitest"
import {
  createSession,
  MAX_SESSION_BYTES,
  SessionStore,
} from "../../src/browser/sessions/session-store.js"

describe("session storage", () => {
  test("round-trips complete text, reasoning, tool, and image messages", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = createSession("gpt-5.4")
    session.messages = [
      { role: "user", content: "inspect", timestamp: 1 },
      {
        role: "assistant",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.4",
        timestamp: 2,
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [
          { type: "thinking", thinking: "inspect safely", thinkingSignature: "encrypted" },
          { type: "toolCall", id: "call-1", name: "browser_capture_visible", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "browser_capture_visible",
        timestamp: 3,
        isError: false,
        content: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
      },
    ]
    await store.put(session)

    await expect(store.get(session.id)).resolves.toEqual(session)
    await store.rename(session.id, "Captured page")
    await expect(store.list()).resolves.toMatchObject([{ title: "Captured page" }])
    await store.delete(session.id)
    await expect(store.get(session.id)).resolves.toBeUndefined()
  })

  test("marks sessions interrupted instead of treating partial work as complete", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = { ...createSession("gpt-5.4"), status: "running" as const }
    await store.put(session)
    await store.markRunningSessionsInterrupted()
    await expect(store.get(session.id)).resolves.toMatchObject({ status: "interrupted" })
  })

  test("enforces retention and clears records with embedded images", async () => {
    const store = new SessionStore(new IDBFactory())
    let oldestId = ""
    for (let index = 0; index <= 50; index += 1) {
      const session = createSession("gpt-5.4")
      session.createdAt = index
      session.updatedAt = index
      session.messages = [
        {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "browser_capture_visible",
          timestamp: index,
          isError: false,
          content: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
        },
      ]
      if (index === 0) oldestId = session.id
      await store.put(session)
    }

    await expect(store.list()).resolves.toHaveLength(50)
    await expect(store.get(oldestId)).resolves.toBeUndefined()
    await store.clear()
    await expect(store.list()).resolves.toEqual([])
  })

  test("rejects transcripts over the configured storage limit", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = createSession("gpt-5.4")
    session.messages = [{ role: "user", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 1 }]
    await expect(store.put(session)).rejects.toThrow("storage limit")
  })
})
