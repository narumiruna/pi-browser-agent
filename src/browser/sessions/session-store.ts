import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core"

const DATABASE_NAME = "pi-chrome-sessions"
const DATABASE_VERSION = 1
const STORE_NAME = "sessions"
export const MAX_SESSIONS = 50
export const MAX_SESSION_BYTES = 5 * 1024 * 1024

export type SessionStatus = "idle" | "interrupted" | "running"

export interface SessionRecord {
  schemaVersion: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: SessionStatus
  model: { provider: string; id: string; thinkingLevel: ThinkingLevel }
  messages: AgentMessage[]
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: SessionStatus
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
  })
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<SessionRecord>
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    ["idle", "interrupted", "running"].includes(record.status ?? "") &&
    Array.isArray(record.messages) &&
    typeof record.model === "object" &&
    record.model !== null &&
    typeof record.model.provider === "string" &&
    typeof record.model.id === "string"
  )
}

export class SessionSizeLimitError extends Error {
  constructor() {
    super(`Session exceeds the ${MAX_SESSION_BYTES / 1024 / 1024} MB storage limit`)
    this.name = "SessionSizeLimitError"
  }
}

export function sessionByteLength(record: SessionRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength
}

function assertWithinLimit(record: SessionRecord): void {
  if (sessionByteLength(record) > MAX_SESSION_BYTES) throw new SessionSizeLimitError()
}

export function compactSession(record: SessionRecord): {
  record: SessionRecord
  removedImages: number
  removedMessages: number
} {
  const compacted = structuredClone(record)
  let removedImages = 0
  for (const message of compacted.messages) {
    const value = message as unknown as { content?: unknown }
    if (!Array.isArray(value.content)) continue
    for (let index = value.content.length - 1; index >= 0; index -= 1) {
      const item = value.content[index]
      if (typeof item === "object" && item !== null && "type" in item && item.type === "image") {
        value.content.splice(index, 1, {
          type: "text",
          text: "[image omitted because the saved session reached its size limit]",
        })
        removedImages += 1
      }
    }
  }

  let removedMessages = 0
  while (sessionByteLength(compacted) > MAX_SESSION_BYTES && compacted.messages.length > 0) {
    const nextTurn = compacted.messages.findIndex(
      (message, index) => index > 0 && message.role === "user",
    )
    const turnLength = nextTurn === -1 ? compacted.messages.length : nextTurn
    compacted.messages.splice(0, turnLength)
    removedMessages += turnLength
  }
  if (sessionByteLength(compacted) > MAX_SESSION_BYTES) throw new SessionSizeLimitError()
  return { record: compacted, removedImages, removedMessages }
}

export class SessionStore {
  private database?: Promise<IDBDatabase>

  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    this.database = new Promise((resolve, reject) => {
      const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" })
          store.createIndex("updatedAt", "updatedAt")
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error("Unable to open session storage"))
    })
    return this.database
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readonly")
    const value: unknown = await requestResult(transaction.objectStore(STORE_NAME).get(id))
    await transactionDone(transaction)
    return isSessionRecord(value) ? value : undefined
  }

  async list(): Promise<SessionSummary[]> {
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readonly")
    const values: unknown[] = await requestResult(transaction.objectStore(STORE_NAME).getAll())
    await transactionDone(transaction)
    return values
      .filter(isSessionRecord)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ id, title, createdAt, updatedAt, status }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        status,
      }))
  }

  async put(
    record: SessionRecord,
    protectedSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (!isSessionRecord(record)) throw new Error("Refusing to persist an invalid session")
    assertWithinLimit(record)
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).put(structuredClone(record))
    await transactionDone(transaction)
    await this.enforceRetention(protectedSessionIds)
  }

  async rename(
    id: string,
    title: string,
    protectedSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const record = await this.get(id)
    if (!record) throw new Error("Session not found")
    const normalized = title.trim().slice(0, 120)
    if (!normalized) throw new Error("Session title cannot be empty")
    await this.put({ ...record, title: normalized, updatedAt: Date.now() }, protectedSessionIds)
  }

  async delete(id: string): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).delete(id)
    await transactionDone(transaction)
  }

  async clear(): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).clear()
    await transactionDone(transaction)
  }

  async markSessionInterrupted(id: string): Promise<void> {
    const record = await this.get(id)
    if (record?.status !== "running") return
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).put({ ...record, status: "interrupted" })
    await transactionDone(transaction)
  }

  private async enforceRetention(protectedSessionIds: ReadonlySet<string>): Promise<void> {
    const summaries = await this.list()
    const excess = summaries.length - MAX_SESSIONS
    if (excess <= 0) return
    const toDelete = [...summaries]
      .reverse()
      .filter((session) => !protectedSessionIds.has(session.id))
      .slice(0, excess)
    const database = await this.open()
    const transaction = database.transaction(STORE_NAME, "readwrite")
    const store = transaction.objectStore(STORE_NAME)
    for (const session of toDelete) store.delete(session.id)
    await transactionDone(transaction)
  }
}

export function createSession(modelId: string, provider: string): SessionRecord {
  const now = Date.now()
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title: "New session",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    model: { provider, id: modelId, thinkingLevel: "medium" },
    messages: [],
  }
}
