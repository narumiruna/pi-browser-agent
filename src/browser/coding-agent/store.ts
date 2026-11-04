import { withExclusiveStorageWrite } from "../storage-lock.js"
import { type LocalConnection, localId, parseLocalConnection, TaskError } from "./protocol.js"

// V1 approved draft exchange only, not automatic task execution. Require fresh consent.
export const CODING_CONNECTION_KEY = "piBrowserAgentLocalCodingSessionV2"
const LOCK = "pi-browser-agent-local-coding-session"

function parse(value: unknown): LocalConnection | undefined {
  if (value === undefined) return undefined
  return parseLocalConnection(value)
}

export async function getLocalConnection(): Promise<LocalConnection | undefined> {
  const value = (await chrome.storage.session.get(CODING_CONNECTION_KEY))[CODING_CONNECTION_KEY]
  return parse(value)
}

function matches(left: LocalConnection | undefined, right: LocalConnection): boolean {
  return Boolean(
    left &&
      left.clientId === right.clientId &&
      left.generation === right.generation &&
      left.windowId === right.windowId &&
      left.state === right.state,
  )
}

async function write(connection: LocalConnection): Promise<LocalConnection> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  await chrome.storage.session.set({ [CODING_CONNECTION_KEY]: connection })
  return { ...connection }
}

export async function requestLocalConnection(
  clientId: string,
  windowId: number,
): Promise<LocalConnection> {
  localId(clientId)
  if (!Number.isSafeInteger(windowId) || windowId < 0) throw new TaskError("Invalid local window")
  return withExclusiveStorageWrite(LOCK, async () => {
    const current = await getLocalConnection()
    if (current && current.state !== "rejected") {
      if (current.clientId === clientId && current.windowId === windowId) return current
      throw new TaskError("Another local connection must be disconnected first")
    }
    return write({ clientId, generation: crypto.randomUUID(), windowId, state: "pending" })
  })
}

export async function approveLocalConnection(
  expected: LocalConnection,
  signal?: AbortSignal,
): Promise<LocalConnection> {
  const snapshot = parse(expected)
  if (snapshot?.state !== "pending") throw new TaskError("No pending local connection")
  return withExclusiveStorageWrite(LOCK, async () => {
    if (!matches(await getLocalConnection(), snapshot))
      throw new TaskError("Local connection changed")
    signal?.throwIfAborted()
    const approved = await write({
      ...snapshot,
      generation: crypto.randomUUID(),
      state: "approved",
    })
    if (signal?.aborted) {
      if (matches(await getLocalConnection(), approved))
        await write({ ...approved, generation: crypto.randomUUID(), state: "rejected" })
      signal.throwIfAborted()
    }
    return approved
  })
}

export async function disconnectLocalConnection(
  expected: LocalConnection,
): Promise<LocalConnection> {
  const snapshot = parse(expected)
  if (!snapshot) throw new TaskError("No local connection")
  return withExclusiveStorageWrite(LOCK, async () => {
    if (!matches(await getLocalConnection(), snapshot))
      throw new TaskError("Local connection changed")
    return write({ ...snapshot, generation: crypto.randomUUID(), state: "rejected" })
  })
}

export async function assertLocalConnection(
  clientId: string,
  generation: string,
  windowId: number,
): Promise<LocalConnection> {
  localId(clientId)
  localId(generation)
  const current = await getLocalConnection()
  if (
    current?.state !== "approved" ||
    current.clientId !== clientId ||
    current.generation !== generation ||
    current.windowId !== windowId
  ) {
    throw new TaskError("Local connection is not approved")
  }
  return current
}
