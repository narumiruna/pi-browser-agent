import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { localId, parseLocalRequest } from "../../../src/browser/coding-agent/protocol.js"
import {
  ExistingChromeConnection,
  HELPER_FRAME_BYTES,
  HELPER_PROTOCOL_VERSION,
  type HelperCommand,
  type HelperEvent,
  type HelperFailure,
  type HelperStatus,
  readChromeEndpoint,
  type TaskConnection,
} from "./chrome-connection.js"

type Connection = TaskConnection & {
  connect(
    target: { extensionId: string; clientId: string },
    signal: AbortSignal,
    onStatus?: (status: HelperStatus) => void,
  ): Promise<unknown>
}

function command(value: unknown, previous: number): HelperCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.id) || (record.id as number) <= previous) throw new Error()
  const fields =
    record.type === "connect"
      ? "clientId,extensionId,id,type"
      : record.type === "request"
        ? "id,request,type"
        : record.type === "close"
          ? "id,type"
          : ""
  if (!fields || Object.keys(record).sort().join() !== fields) throw new Error()
  const id = record.id as number
  if (record.type === "connect") {
    if (
      typeof record.extensionId !== "string" ||
      record.extensionId.length !== 32 ||
      !/^[a-p]{32}$/.test(record.extensionId) ||
      localId(record.clientId).length !== 36
    )
      throw new Error()
    return {
      type: "connect",
      id,
      extensionId: record.extensionId,
      clientId: localId(record.clientId),
    }
  }
  if (record.type === "request")
    return { type: "request", id, request: parseLocalRequest(record.request) }
  return { type: "close", id }
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error()), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function boundedClose(connection?: Connection): Promise<void> {
  if (connection) await bounded(connection.close(), 2000).catch(() => {})
}

// Stream and driver injection are for isolated tests. No endpoint is accepted on stdin.
export async function runWindowsHelper(
  input: AsyncIterable<Uint8Array>,
  output: (line: string) => Promise<void>,
  dependencies: {
    createConnection?: () => Promise<Connection>
    signal?: AbortSignal
    stopInput?: () => void
  } = {},
): Promise<void> {
  const controller = new AbortController()
  let connection: Connection | undefined
  let connected = false
  let attempted = false
  let closing = false
  let previous = 0
  let writeQueue = Promise.resolve()
  let outputFailed = false
  const handlers = new Set<Promise<void>>()
  const emit = (event: HelperEvent): Promise<void> => {
    if (outputFailed) return Promise.resolve()
    let line = `${JSON.stringify(event)}\n`
    if (Buffer.byteLength(line) > HELPER_FRAME_BYTES) {
      if (event.type !== "response") {
        outputFailed = true
        controller.abort()
        return Promise.resolve()
      }
      line = `${JSON.stringify({ type: "response", id: event.id, ok: false, error: "browser-unavailable" })}\n`
    }
    writeQueue = writeQueue
      .then(async () => {
        if (!outputFailed) await bounded(output(line), 2000)
      })
      .catch(() => {
        outputFailed = true
        controller.abort()
        dependencies.stopInput?.()
      })
    return writeQueue
  }
  const stop = () => {
    closing = true
    controller.abort()
    dependencies.stopInput?.()
  }
  dependencies.signal?.addEventListener("abort", stop, { once: true })
  if (dependencies.signal?.aborted) stop()
  const handle = async (message: HelperCommand): Promise<void> => {
    let failure: HelperFailure = "connection-stopped"
    try {
      let value: unknown
      if (message.type === "close") {
        stop()
        await boundedClose(connection)
        value = null
      } else if (message.type === "connect") {
        if (attempted || closing) {
          failure = "invalid-request"
          throw new Error()
        }
        attempted = true
        failure = "chrome-unavailable"
        connection = await (dependencies.createConnection?.() ??
          (async () => new ExistingChromeConnection(await readChromeEndpoint()))())
        if (controller.signal.aborted) {
          await boundedClose(connection)
          throw new Error()
        }
        value = await connection.connect(
          { extensionId: message.extensionId, clientId: message.clientId },
          controller.signal,
          (status) => {
            if (status === "browser-approval") failure = "browser-unavailable"
            if (!closing) void emit({ type: "status", status })
          },
        )
        if (closing || connection.signal.aborted) throw new Error()
        connected = true
        connection.signal.addEventListener("abort", stop, { once: true })
      } else {
        if (!connected || !connection || closing || connection.signal.aborted) throw new Error()
        failure = "browser-unavailable"
        value = await connection.evaluate(message.request, controller.signal)
        if (closing || connection.signal.aborted) throw new Error()
      }
      await emit({ type: "response", id: message.id, ok: true, value })
    } catch {
      await emit({
        type: "response",
        id: message.id,
        ok: false,
        error: closing ? "connection-stopped" : failure,
      })
    }
  }
  await emit({ type: "ready", version: HELPER_PROTOCOL_VERSION })
  let buffer = Buffer.alloc(0)
  try {
    for await (const chunk of input) {
      if (closing || controller.signal.aborted) break
      // Consume a chunk in slices so even a large supplied chunk cannot grow a frame buffer.
      let offset = 0
      while (offset < chunk.byteLength && !closing) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.byteLength : newline
        if (buffer.byteLength + end - offset + 1 > HELPER_FRAME_BYTES) throw new Error()
        buffer = Buffer.concat([buffer, chunk.subarray(offset, end)])
        offset = end + 1
        if (newline < 0) break
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer)
        if (!text || text.trim() !== text) throw new Error()
        const message = command(JSON.parse(text), previous)
        if (handlers.size >= 8 && message.type !== "close") throw new Error()
        previous = message.id
        buffer = Buffer.alloc(0)
        const work = handle(message)
        handlers.add(work)
        void work.finally(() => handlers.delete(work))
      }
    }
    if (buffer.byteLength && !closing) throw new Error()
  } catch {
    if (!closing) await emit({ type: "response", id: 0, ok: false, error: "invalid-request" })
  } finally {
    stop()
    dependencies.signal?.removeEventListener("abort", stop)
    connection?.signal.removeEventListener("abort", stop)
    await boundedClose(connection)
    // Pending connect/request handlers are cancelled, never replayed.
    await bounded(Promise.allSettled([...handlers]), 2100).catch(() => {})
    await writeQueue
  }
}

async function main(): Promise<void> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    await runWindowsHelper(
      process.stdin,
      (line) =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(line, (error) => (error ? reject(new Error()) : resolve()))
        }),
      { signal: controller.signal, stopInput: () => process.stdin.destroy() },
    )
  } finally {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
}

// Importing this file cannot open a socket or start a helper.
if (
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
) {
  void main().then(
    () => process.exit(0),
    () => process.exit(1),
  )
}
