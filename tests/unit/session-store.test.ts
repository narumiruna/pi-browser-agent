import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { IDBObjectStore as FakeObjectStore, IDBFactory } from "fake-indexeddb"
import { describe, expect, test, vi } from "vitest"
import {
  compactSession,
  createSession as createSessionRecord,
  MAX_SESSION_BYTES,
  type SessionRecord,
  SessionSizeLimitError,
  SessionStore,
  sessionByteLength,
} from "../../src/browser/sessions/session-store.js"
import {
  createSessionTree,
  getTreePath,
  selectTreeNode,
  syncSessionTree,
} from "../../src/browser/sessions/session-tree.js"

function createSession(modelId: string) {
  return createSessionRecord(modelId, "openai-codex")
}

async function rawRecord(indexedDb: IDBFactory, id: string, value?: unknown): Promise<unknown> {
  const request = indexedDb.open("pi-browser-agent-sessions", 1)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction(
      "sessions",
      value === undefined ? "readonly" : "readwrite",
    )
    const store = transaction.objectStore("sessions")
    const operation = value === undefined ? store.get(id) : store.put(value)
    return await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(operation.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

function treeSession(): SessionRecord {
  const session = createSession("gpt-5.4")
  session.messages = [
    { role: "system", content: "current baseline", timestamp: 0 },
    {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "First request" },
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ],
    },
    {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      timestamp: 2,
      stopReason: "stop",
      responseId: "response-id",
      providerThinkingLevel: "high",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        { type: "thinking", thinking: "reasoning", thinkingSignature: "opaque" },
        { type: "text", text: "First answer", textSignature: "signed" },
      ],
    },
  ]
  session.tree = createSessionTree(session.messages)
  return session
}

describe("session storage", () => {
  test("rolls back an updated record when retention lookup fails after its queued put", async () => {
    const store = new SessionStore(new IDBFactory())
    const original = createSession("gpt-5.4")
    await store.put(original)
    const lookup = vi.spyOn(FakeObjectStore.prototype, "getAll").mockImplementationOnce(() => {
      throw new Error("Retention lookup failed")
    })
    try {
      await expect(store.put({ ...original, title: "New branch" })).rejects.toThrow(
        "Retention lookup failed",
      )
    } finally {
      lookup.mockRestore()
    }
    await expect(store.get(original.id)).resolves.toEqual(original)
  })

  test("rolls back a new tree and all retention deletes when cleanup fails", async () => {
    const store = new SessionStore(new IDBFactory())
    for (let index = 0; index < 50; index += 1) {
      const record = createSession("gpt-5.4")
      record.updatedAt = index
      await store.put(record)
    }
    const record = createSession("gpt-5.4")
    record.messages = [{ role: "user", content: "New branch", timestamp: 1 }]
    record.tree = createSessionTree(record.messages)
    const deletion = vi.spyOn(FakeObjectStore.prototype, "delete").mockImplementationOnce(() => {
      throw new Error("Retention delete failed")
    })
    try {
      await expect(store.put(record)).rejects.toThrow("Retention delete failed")
    } finally {
      deletion.mockRestore()
    }
    await expect(store.get(record.id)).resolves.toBeUndefined()
    await expect(store.list()).resolves.toHaveLength(50)
  })

  test("persists legacy Azure model migration without rewriting message metadata", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const session = createSessionRecord("gpt-5", "azure-openai-responses", "high")
    session.messages = [
      {
        role: "assistant",
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        model: "gpt-5",
        timestamp: 1,
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "text", text: "Saved answer" }],
      },
    ]
    await store.put(session)
    const migrated = { ...session, model: { ...session.model, provider: "azure" } }
    await expect(store.get(session.id)).resolves.toEqual(migrated)
    await expect(store.get(session.id)).resolves.toEqual(migrated)
    const request = indexedDb.open("pi-browser-agent-sessions")
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = database
      .transaction("sessions", "readonly")
      .objectStore("sessions")
      .get(session.id)
    const persisted = await new Promise<unknown>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })
    expect(persisted).toEqual(migrated)
    database.close()
  })

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

  test("does not create an index that session queries do not use", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    await store.put(createSession("gpt-5.4"))
    const request = indexedDb.open("pi-browser-agent-sessions")
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    const indexes = [
      ...database.transaction("sessions", "readonly").objectStore("sessions").indexNames,
    ]

    expect(indexes).toEqual([])
    database.close()
  })

  test("marks sessions interrupted instead of treating partial work as complete", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = { ...createSession("gpt-5.4"), status: "running" as const }
    await store.put(session)
    const other = { ...createSession("gpt-5.4"), status: "running" as const }
    await store.put(other)
    await store.markSessionInterrupted(session.id)
    await expect(store.get(session.id)).resolves.toMatchObject({ status: "interrupted" })
    await expect(store.get(other.id)).resolves.toMatchObject({ status: "running" })
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

  test("compacts oversized images and messages into a persistable record", () => {
    const session = createSession("gpt-5.4")
    session.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "capture" },
          { type: "image", data: "x".repeat(MAX_SESSION_BYTES), mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ]

    const compacted = compactSession(session)

    expect(compacted.removedImages).toBe(1)
    expect(compacted.record.messages).toHaveLength(1)
    expect(sessionByteLength(compacted.record)).toBeLessThanOrEqual(MAX_SESSION_BYTES)
  })

  test("preserves the leading system message when removing an oversized turn", () => {
    const session = createSession("gpt-5.4")
    const baseline = {
      role: "system" as const,
      content: "Follow browser safety rules",
      timestamp: 0,
    }
    session.messages = [
      baseline,
      { role: "user", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 1 },
    ]

    const compacted = compactSession(session)

    expect(compacted.removedMessages).toBe(1)
    expect(compacted.record.messages).toEqual([baseline])
    expect(sessionByteLength(compacted.record)).toBeLessThanOrEqual(MAX_SESSION_BYTES)
  })

  test("rejects compaction if the system baseline alone exceeds the limit", () => {
    const session = createSession("gpt-5.4")
    session.messages = [
      { role: "system", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 0 },
      { role: "user", content: "recent turn", timestamp: 1 },
    ]

    expect(() => compactSession(session)).toThrow("storage limit")
  })

  test("compacts complete turns without orphaning tool calls or results", () => {
    const session = createSession("gpt-5.4")
    session.messages = [
      { role: "user", content: "first turn", timestamp: 1 },
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
          { type: "text", text: "x".repeat(MAX_SESSION_BYTES) },
          { type: "toolCall", id: "call-1", name: "browser_get_visible_text", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "browser_get_visible_text",
        timestamp: 3,
        isError: false,
        content: [{ type: "text", text: "result" }],
      },
      { role: "user", content: "second turn", timestamp: 4 },
    ]

    const compacted = compactSession(session)

    expect(compacted.removedMessages).toBe(3)
    expect(compacted.record.messages).toEqual([
      { role: "user", content: "second turn", timestamp: 4 },
    ])
  })
})

describe("persistent session tree storage", () => {
  test("round-trips inactive branches, images and metadata across store instances, rename and clear", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const original = treeSession()
    if (!original.tree?.nodes[0]) throw new Error("Missing fixture tree")
    const selection = selectTreeNode(original.tree, original.tree.nodes[0].id)
    const branchMessages: AgentMessage[] = [
      { role: "user", content: "Edited request", timestamp: 4 },
    ]
    const branched = {
      ...original,
      tree: syncSessionTree(selection.tree, branchMessages),
      messages: [original.messages[0] as AgentMessage, ...branchMessages],
    }
    await store.put(branched)
    const reopened = new SessionStore(indexedDb)
    await expect(reopened.get(branched.id)).resolves.toEqual(branched)
    const restored = await reopened.get(branched.id)
    expect(restored?.tree?.nodes.slice(0, 2)).toEqual(original.tree.nodes)
    expect(getTreePath(branched.tree).map((node) => node.message)).toEqual(branchMessages)
    await reopened.rename(branched.id, "  Branch session  ")
    const renamed = await reopened.get(branched.id)
    expect(renamed).toMatchObject({
      title: "Branch session",
      tree: branched.tree,
      messages: branched.messages,
      model: branched.model,
    })
    expect(renamed?.schemaVersion).toBe(1)
    await reopened.clear()
    await expect(store.get(branched.id)).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  test("preserves tool calls, image results, nested metadata and signed reasoning in tree records", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = treeSession()
    const assistant = session.messages[2]
    if (assistant?.role !== "assistant") throw new Error("Missing fixture assistant")
    assistant.stopReason = "toolUse"
    assistant.content.push({
      type: "toolCall",
      id: "capture-1",
      name: "capture",
      arguments: { target: "page" },
      thoughtSignature: "tool-signature",
    })
    session.messages.push({
      role: "toolResult",
      toolCallId: "capture-1",
      toolName: "capture",
      isError: false,
      timestamp: 3,
      content: [
        { type: "text", text: "Captured" },
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ],
      details: { sourceUrl: "https://example.test", count: 1 },
      nestedCalls: {
        complete: true,
        calls: [
          { id: "nested", name: "inspect", arguments: { limit: 1 }, status: "ok", durationMs: 10 },
        ],
      },
    })
    session.tree = createSessionTree(session.messages)
    await store.put(session)
    await expect(store.get(session.id)).resolves.toEqual(session)
    const reloaded = await store.get(session.id)
    if (!reloaded?.tree) throw new Error("Missing stored tree")
    const selected = selectTreeNode(reloaded.tree, reloaded.tree.activeLeafId)
    expect(selected.messages).toEqual(session.messages.slice(1))
    expect(compactSession(reloaded)).toEqual({
      record: session,
      removedImages: 0,
      removedMessages: 0,
    })
  })

  test("keeps tree metadata unchanged during Azure migration and interruption", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const session = treeSession()
    session.model.provider = "azure-openai-responses"
    session.status = "running"
    await store.put(session)
    const expected = { ...session, model: { ...session.model, provider: "azure" } }
    await expect(store.get(session.id)).resolves.toEqual(expected)
    await expect(rawRecord(indexedDb, session.id)).resolves.toEqual(expected)
    await store.markSessionInterrupted(session.id)
    await expect(store.get(session.id)).resolves.toEqual({ ...expected, status: "interrupted" })
  })

  test("permits root projection and a changed leading baseline but requires exact active metadata", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = treeSession()
    await store.put(session)
    session.messages[0] = { role: "system", content: "new configured baseline", timestamp: 99 }
    await store.put(session)
    const mismatch = structuredClone(session)
    const answer = mismatch.messages[2]
    if (answer?.role !== "assistant") throw new Error("Missing assistant")
    answer.content = [{ type: "text", text: "Same position, changed metadata" }]
    await expect(store.put(mismatch)).rejects.toThrow("active messages")
    await expect(store.get(session.id)).resolves.toEqual(session)
    if (!session.tree) throw new Error("Missing tree")
    const root = selectTreeNode(session.tree, null)
    const rootRecord = {
      ...session,
      tree: root.tree,
      messages: [session.messages[0] as AgentMessage],
    }
    await store.put(rootRecord)
    await expect(store.get(session.id)).resolves.toEqual(rootRecord)
    await store.put({ ...rootRecord, messages: [] })
    await expect(store.get(session.id)).resolves.toMatchObject({ messages: [], tree: root.tree })
  })

  test.each([
    "invalid graph",
    "missing tree",
    "wrong projection",
    "extra projection",
    "missing projection",
    "invalid messages",
    "bad record",
  ])("rejects raw %s tree records without deletion, migration or legacy fallback", async (kind) => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const session = treeSession()
    await store.put(session)
    const malformed: Record<string, unknown> = structuredClone(session) as unknown as Record<
      string,
      unknown
    >
    malformed.model = { ...session.model, provider: "azure-openai-responses" }
    if (kind === "invalid graph")
      malformed.tree = { version: 1, nodes: [], activeLeafId: "missing" }
    if (kind === "missing tree") malformed.tree = undefined
    if (kind === "wrong projection")
      malformed.messages = [{ role: "user", content: "different", timestamp: 1 }]
    if (kind === "extra projection")
      malformed.messages = [...session.messages, { role: "user", content: "extra", timestamp: 5 }]
    if (kind === "missing projection") malformed.messages = []
    if (kind === "invalid messages") malformed.messages = { 0: { role: "system" } }
    if (kind === "bad record") malformed.model = null
    await rawRecord(indexedDb, session.id, malformed)
    await expect(store.get(session.id)).rejects.toThrow(/session tree|active messages/)
    await expect(store.get(session.id)).rejects.toThrow(/session tree|active messages/)
    await expect(rawRecord(indexedDb, session.id)).resolves.toEqual(malformed)
    await expect(store.list()).resolves.toMatchObject([{ id: session.id, title: session.title }])
    await expect(store.rename(session.id, "Cannot normalize corruption")).rejects.toThrow()
    await expect(rawRecord(indexedDb, session.id)).resolves.toEqual(malformed)
    await store.delete(session.id)
    await expect(store.get(session.id)).resolves.toBeUndefined()
  })

  test("put rejects malformed trees and projection mismatch before any transaction or retention", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const session = treeSession()
    await store.put(session)
    const malformed = {
      ...session,
      tree: { version: 2, nodes: [], activeLeafId: null },
    } as unknown as SessionRecord
    await expect(store.put(malformed)).rejects.toThrow("Invalid session tree")
    await expect(store.put({ ...session, messages: [] })).rejects.toThrow("active messages")
    const different = {
      ...session,
      messages: [{ role: "user", content: "wrong", timestamp: 1 }],
    } as SessionRecord
    await expect(store.put(different)).rejects.toThrow("active messages")
    await expect(rawRecord(indexedDb, session.id)).resolves.toEqual(session)
    await expect(store.list()).resolves.toHaveLength(1)
  })

  test("persists only the validated immutable snapshot if the caller mutates during database open", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = treeSession()
    const snapshot = structuredClone(session)
    const save = store.put(session)
    session.tree = undefined
    session.messages = [{ role: "user", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 1 }]
    await save
    await expect(store.get(session.id)).resolves.toEqual(snapshot)
  })

  test("counts both the full tree and duplicated active messages for the existing 5 MB limit", async () => {
    const store = new SessionStore(new IDBFactory())
    const session = createSession("gpt-5.4")
    session.messages = [
      { role: "user", content: "x".repeat(Math.floor(MAX_SESSION_BYTES * 0.55)), timestamp: 1 },
    ]
    expect(sessionByteLength(session)).toBeLessThan(MAX_SESSION_BYTES)
    session.tree = createSessionTree(session.messages)
    expect(sessionByteLength(session)).toBeGreaterThan(MAX_SESSION_BYTES)
    await expect(store.put(session)).rejects.toBeInstanceOf(SessionSizeLimitError)
    await expect(store.get(session.id)).resolves.toBeUndefined()
  })

  test("oversized inactive-branch saves are atomic and compaction cannot destroy saved branches", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const session = treeSession()
    await store.put(session)
    if (!session.tree) throw new Error("Missing tree")
    const root = selectTreeNode(session.tree, null)
    const oversizedMessages: AgentMessage[] = [
      { role: "user", content: "x".repeat(MAX_SESSION_BYTES), timestamp: 9 },
    ]
    const hugeTree = syncSessionTree(root.tree, oversizedMessages)
    const oversized = { ...session, tree: { ...hugeTree, activeLeafId: session.tree.activeLeafId } }
    expect(sessionByteLength(oversized)).toBeGreaterThan(MAX_SESSION_BYTES)
    await expect(store.put(oversized)).rejects.toBeInstanceOf(SessionSizeLimitError)
    expect(() => compactSession(oversized)).toThrow(SessionSizeLimitError)
    await expect(rawRecord(indexedDb, session.id)).resolves.toEqual(session)
    await expect(store.get(session.id)).resolves.toEqual(session)
    const small = compactSession(session)
    expect(small).toEqual({ record: session, removedImages: 0, removedMessages: 0 })
    expect(small.record).not.toBe(session)
    expect(small.record.tree).not.toBe(session.tree)
    expect(small.record.messages).not.toBe(session.messages)
    expect(small.record.tree?.nodes).toEqual(session.tree.nodes)
  })

  test("retention does not silently delete malformed tree records", async () => {
    const indexedDb = new IDBFactory()
    const store = new SessionStore(indexedDb)
    const corrupt = { ...treeSession(), createdAt: -2, updatedAt: -2 }
    await store.put(corrupt)
    const malformed = { ...corrupt, tree: null }
    await rawRecord(indexedDb, corrupt.id, malformed)
    for (let index = 0; index < 50; index += 1) {
      await store.put({ ...createSession("gpt-5.4"), createdAt: index, updatedAt: index })
    }
    await expect(rawRecord(indexedDb, corrupt.id)).resolves.toEqual(malformed)
    await expect(store.list()).resolves.toHaveLength(50)
    await store.clear()
    await expect(store.list()).resolves.toEqual([])
  })
})
