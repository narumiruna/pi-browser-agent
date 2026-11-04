import { open } from "node:fs/promises"
import { win32 } from "node:path"
import {
  LOCAL_API_VERSION,
  type LocalConnection,
  type LocalRequest,
  type LocalResponse,
  localId,
  parseLocalConnection,
  parseLocalRequest,
  REQUEST_FAILURE,
  TASK_LIMITS,
  TaskError,
} from "../../../src/browser/coding-agent/protocol.js"

export const HELPER_FRAME_BYTES = 64 * 1024
export const HELPER_PROTOCOL_VERSION = 1
export type HelperStatus = "chrome-approval" | "browser-approval"
export type HelperFailure =
  | "invalid-request"
  | "chrome-unavailable"
  | "browser-unavailable"
  | "connection-stopped"
export type HelperCommand =
  | { type: "connect"; id: number; extensionId: string; clientId: string }
  | { type: "request"; id: number; request: LocalRequest }
  | { type: "close"; id: number }
export type HelperEvent =
  | { type: "ready"; version: 1 }
  | { type: "status"; status: HelperStatus }
  | { type: "response"; id: number; ok: true; value: unknown }
  | { type: "response"; id: number; ok: false; error: HelperFailure }

export interface TaskConnection {
  readonly signal: AbortSignal
  evaluate(request: LocalRequest, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const ENDPOINT = new RegExp(`^ws://127\\.0\\.0\\.1:([1-9][0-9]{0,4})/devtools/browser/${UUID}$`)
const CDP_FRAME_BYTES = TASK_LIMITS.responseBytes * 8
const fail = () => new TaskError(REQUEST_FAILURE)

function endpoint(value: string): string {
  const match = ENDPOINT.exec(value)
  if (!match || match[0] !== value || Number(match[1]) > 65535) throw fail()
  return value
}

// This fixed metadata file is the only browser-profile file read by the adapter.
export async function readChromeEndpoint(): Promise<string> {
  try {
    const root = process.env.LOCALAPPDATA
    if (!root || !win32.isAbsolute(root) || root.startsWith("\\\\")) throw fail()
    const file = await open(
      win32.join(root, "Google", "Chrome", "User Data", "DevToolsActivePort"),
      "r",
    )
    try {
      const buffer = Buffer.alloc(1024)
      let length = 0
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      // The exact two-line format is shorter than this buffer. A full buffer is invalid.
      if (length === buffer.length) throw fail()
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, length),
      )
      const match = new RegExp(
        `^([1-9][0-9]{0,4})\\r?\\n(/devtools/browser/${UUID})(?:\\r?\\n)?$`,
      ).exec(text)
      if (!match || match[0] !== text) throw fail()
      return endpoint(`ws://127.0.0.1:${match[1]}${match[2]}`)
    } finally {
      await file.close()
    }
  } catch {
    throw fail()
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail()
  return value as Record<string, unknown>
}

function response(value: unknown): LocalResponse {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > TASK_LIMITS.responseBytes) throw fail()
  const record = object(value)
  if (record.ok === true && Object.keys(record).sort().join() === "ok,value")
    return record as LocalResponse
  // Browser error text is not exported across this boundary.
  if (
    record.ok === false &&
    Object.keys(record).sort().join() === "error,ok" &&
    typeof record.error === "string"
  )
    return { ok: false, error: REQUEST_FAILURE }
  throw fail()
}

function identity(value: unknown, clientId: string): LocalConnection {
  const result = response(value)
  if (!result.ok) throw fail()
  const current = parseLocalConnection(result.value)
  if (current.clientId !== clientId) throw fail()
  return current
}

function same(a: LocalConnection, b: LocalConnection): boolean {
  return (
    a.clientId === b.clientId &&
    a.generation === b.generation &&
    a.windowId === b.windowId &&
    a.state === b.state
  )
}

async function pause(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(fail())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, 250)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

type Attachment = {
  targetId: string
  sessionId: string
  url: string
  role: "settings" | "conversation"
}
type Target = { targetId: string; url: string; type: string }
type CdpMethod =
  | "Browser.getVersion"
  | "Target.getTargets"
  | "Target.setDiscoverTargets"
  | "Target.createTarget"
  | "Target.attachToTarget"
  | "Target.detachFromTarget"
  | "Runtime.evaluate"

// Requests are parsed again here. JSON data never becomes executable source.
function expression(api: Attachment, request?: LocalRequest): string {
  const guard = `location.href === ${JSON.stringify(api.url)} && globalThis.__piBrowserLocal?.version === ${LOCAL_API_VERSION} && globalThis.__piBrowserLocal?.role === ${JSON.stringify(api.role)}`
  // An ordinary extension tab has a current tab. A SidePanel does not.
  const panel =
    api.role === "conversation"
      ? ' && (await chrome.tabs.getCurrent()) === undefined && document.body?.dataset.conversationReady === "true"'
      : ""
  const check = `(${guard})${panel}`
  if (!request) return `(async () => Boolean(${check}))()`
  return `(async () => { if (!(${check})) return null; const result = await globalThis.__piBrowserLocal.dispatch(${JSON.stringify(parseLocalRequest(request))}); return new TextEncoder().encode(JSON.stringify(result)).byteLength <= ${TASK_LIMITS.responseBytes} ? result : null; })()`
}

export class ExistingChromeConnection implements TaskConnection {
  private readonly lifetime = new AbortController()
  private readonly socketLost = new AbortController()
  readonly signal = this.lifetime.signal
  private socket?: WebSocket
  private sequence = 0
  private started = false
  private closing?: Promise<void>
  private clientId?: string
  private settings?: Attachment
  private panel?: Attachment
  private current?: LocalConnection
  private registration?: Promise<unknown>
  private readonly attachments = new Map<string, Attachment>()
  private readonly attempts = new Set<string>()
  private readonly pending = new Map<
    number,
    { sessionId?: string; resolve: (value: unknown) => void; reject: () => void }
  >()

  constructor(
    private readonly address: string,
    private readonly WebSocketCtor: typeof WebSocket = WebSocket,
  ) {
    endpoint(address)
  }

  private stop(): void {
    this.lifetime.abort()
    for (const pending of this.pending.values()) pending.reject()
    this.pending.clear()
  }

  private readonly receive = (event: MessageEvent) => {
    try {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > CDP_FRAME_BYTES)
        throw fail()
      const message = object(JSON.parse(event.data))
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id as number)
        if (!pending) return // A cancelled or expired operation cannot be revived.
        if (message.sessionId !== pending.sessionId) throw fail()
        if (message.error) pending.reject()
        else pending.resolve(message.result)
        return
      }
      if (typeof message.method !== "string") throw fail()
      const params = object(message.params ?? {})
      const bound = [this.settings, this.panel].filter((api): api is Attachment => Boolean(api))
      if (
        message.method === "Target.targetDestroyed" &&
        bound.some((api) => api.targetId === params.targetId)
      )
        this.stop()
      if (
        message.method === "Target.detachedFromTarget" &&
        bound.some((api) => api.sessionId === params.sessionId)
      )
        this.stop()
      if (message.method === "Target.targetInfoChanged") {
        const target = object(params.targetInfo)
        for (const api of bound) {
          if (
            target.targetId === api.targetId &&
            (target.url !== api.url || target.type !== "page")
          )
            this.stop()
        }
      }
    } catch {
      this.stop()
      this.socket?.close()
    }
  }

  private async open(signal: AbortSignal): Promise<void> {
    const socket = new this.WebSocketCtor(this.address)
    this.socket = socket
    socket.addEventListener("message", this.receive)
    const lost = () => {
      this.socketLost.abort()
      this.stop()
    }
    socket.addEventListener("close", lost)
    socket.addEventListener("error", lost)
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        socket.removeEventListener("open", ready)
        active.removeEventListener("abort", abort)
      }
      const ready = () => {
        done()
        resolve()
      }
      const abort = () => {
        done()
        socket.close()
        reject(fail())
      }
      const active = AbortSignal.any([
        signal,
        this.socketLost.signal,
        AbortSignal.timeout(TASK_LIMITS.waitMs),
      ])
      socket.addEventListener("open", ready, { once: true })
      active.addEventListener("abort", abort, { once: true })
      if (active.aborted) abort()
    })
  }

  private async call(
    method: CdpMethod,
    params: object,
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<unknown> {
    const active = AbortSignal.any([
      signal,
      this.socketLost.signal,
      AbortSignal.timeout(TASK_LIMITS.timeoutMs),
    ])
    if (active.aborted || this.socket?.readyState !== 1 || this.pending.size >= 16) throw fail()
    const id = ++this.sequence
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const abort = () => {
          this.pending.delete(id)
          reject(fail())
        }
        const finish = (value: unknown, failed: boolean) => {
          active.removeEventListener("abort", abort)
          this.pending.delete(id)
          if (failed || active.aborted) reject(fail())
          else resolve(value)
        }
        this.pending.set(id, {
          sessionId,
          resolve: (value) => finish(value, false),
          reject: () => finish(undefined, true),
        })
        active.addEventListener("abort", abort, { once: true })
        try {
          this.socket?.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
          )
        } catch {
          finish(undefined, true)
        }
      })
    } catch {
      throw fail()
    }
  }

  private async targets(signal: AbortSignal): Promise<Target[]> {
    const result = object(await this.call("Target.getTargets", {}, signal))
    if (!Array.isArray(result.targetInfos) || result.targetInfos.length > 4096) throw fail()
    return result.targetInfos.map((value) => {
      const target = object(value)
      if (
        typeof target.targetId !== "string" ||
        !target.targetId ||
        typeof target.type !== "string" ||
        typeof target.url !== "string"
      )
        throw fail()
      return { targetId: target.targetId, type: target.type, url: target.url }
    })
  }

  private async attach(
    target: Target,
    role: Attachment["role"],
    signal: AbortSignal,
  ): Promise<Attachment> {
    const result = object(
      await this.call(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
        signal,
      ),
    )
    if (typeof result.sessionId !== "string" || !result.sessionId) throw fail()
    const api = { targetId: target.targetId, sessionId: result.sessionId, url: target.url, role }
    this.attachments.set(api.sessionId, api)
    return api
  }

  private async dispatch(
    api: Attachment,
    request: LocalRequest | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = object(
      await this.call(
        "Runtime.evaluate",
        { expression: expression(api, request), returnByValue: true, awaitPromise: true },
        signal,
        api.sessionId,
      ),
    )
    if (result.exceptionDetails) throw fail()
    return object(result.result).value
  }

  private async panelCandidate(
    target: Target,
    approved: LocalConnection,
    signal: AbortSignal,
  ): Promise<Attachment | undefined> {
    let api: Attachment | undefined
    let selected = false
    try {
      api = await this.attach(target, "conversation", signal)
      if ((await this.dispatch(api, undefined, signal)) !== true) return undefined
      const current = identity(
        await this.dispatch(api, { method: "status", clientId: approved.clientId }, signal),
        approved.clientId,
      )
      if (!same(current, approved)) return undefined
      selected = true
      return api
    } catch {
      if (signal.aborted || this.socketLost.signal.aborted) throw fail()
      return undefined
    } finally {
      if (api && !selected) {
        this.attachments.delete(api.sessionId)
        try {
          await this.call("Target.detachFromTarget", { sessionId: api.sessionId }, signal)
        } catch {
          /* A candidate can close while it is probed. */
        }
      }
    }
  }

  async connect(
    target: { extensionId: string; clientId: string },
    signal: AbortSignal,
    onStatus?: (status: HelperStatus) => void,
  ): Promise<LocalConnection> {
    if (
      this.started ||
      this.signal.aborted ||
      target.extensionId.length !== 32 ||
      !/^[a-p]{32}$/.test(target.extensionId)
    )
      throw fail()
    if (localId(target.clientId).length !== 36) throw fail()
    this.started = true
    this.clientId = target.clientId
    const active = AbortSignal.any([signal, this.signal, AbortSignal.timeout(TASK_LIMITS.waitMs)])
    try {
      active.throwIfAborted()
      onStatus?.("chrome-approval")
      await this.open(active)
      const version = object(await this.call("Browser.getVersion", {}, active))
      const major =
        typeof version.product === "string"
          ? Number(/^Chrome\/(\d+)\./.exec(version.product)?.[1])
          : NaN
      if (!Number.isSafeInteger(major) || major < 144) throw fail()
      await this.call("Target.setDiscoverTargets", { discover: true }, active)
      const panelUrl = `chrome-extension://${target.extensionId}/sidebar/index.html`
      const settingsUrl = `${panelUrl}?view=settings`
      let targets = await this.targets(active)
      const existing = targets.filter((item) => item.url === settingsUrl && item.type === "page")
      if (existing.length > 1) throw fail()
      let settings = existing[0]
      const ready = AbortSignal.any([active, AbortSignal.timeout(TASK_LIMITS.timeoutMs)])
      if (!settings) {
        const created = object(await this.call("Target.createTarget", { url: settingsUrl }, active))
        if (typeof created.targetId !== "string") throw fail()
        // Only attach after Chrome reports the exact pinned packaged URL.
        for (;;) {
          targets = await this.targets(ready)
          settings = targets.find(
            (item) =>
              item.targetId === created.targetId &&
              item.url === settingsUrl &&
              item.type === "page",
          )
          if (settings) break
          await pause(ready)
        }
      }
      this.settings = await this.attach(settings, "settings", ready)
      while ((await this.dispatch(this.settings, undefined, ready)) !== true) await pause(ready)
      this.registration = this.dispatch(
        this.settings,
        { method: "connect", clientId: target.clientId },
        active,
      )
      const pending = identity(await this.registration, target.clientId)
      this.current = pending
      if (pending.state !== "pending") throw fail()
      onStatus?.("browser-approval")
      let approved: LocalConnection
      for (;;) {
        const current = identity(
          await this.dispatch(
            this.settings,
            { method: "status", clientId: target.clientId },
            active,
          ),
          target.clientId,
        )
        if (
          current.windowId !== pending.windowId ||
          current.state === "rejected" ||
          (current.state === "pending" && current.generation !== pending.generation)
        )
          throw fail()
        this.current = current
        if (current.state === "approved") {
          if (current.generation === pending.generation) throw fail()
          approved = current
          break
        }
        await pause(active)
      }
      while (!this.panel) {
        const current = identity(
          await this.dispatch(
            this.settings,
            { method: "status", clientId: target.clientId },
            active,
          ),
          target.clientId,
        )
        if (!same(current, approved)) throw fail()
        const candidates = (await this.targets(active)).filter(
          (item) => item.url === panelUrl && item.type === "page",
        )
        if (candidates.length > 32) throw fail()
        for (const candidate of candidates) {
          this.panel = await this.panelCandidate(candidate, approved, active)
          if (this.panel) break
        }
        if (!this.panel) await pause(active)
      }
      const current = identity(
        await this.dispatch(this.panel, { method: "status", clientId: target.clientId }, active),
        target.clientId,
      )
      if (!same(current, approved)) throw fail()
      active.throwIfAborted()
      // Settings is not part of the approved task lifetime. The user can close it.
      const settingsSession = this.settings
      this.settings = undefined
      this.attachments.delete(settingsSession.sessionId)
      await this.call("Target.detachFromTarget", { sessionId: settingsSession.sessionId }, active)
      active.throwIfAborted()
      void this.monitor()
      return current
    } catch {
      await this.close()
      throw fail()
    }
  }

  private async scope(signal: AbortSignal): Promise<void> {
    try {
      if (!this.panel || !this.current || this.current.state !== "approved" || !this.clientId)
        throw fail()
      const current = identity(
        await this.dispatch(this.panel, { method: "status", clientId: this.clientId }, signal),
        this.clientId,
      )
      if (!same(current, this.current)) throw fail()
    } catch {
      // A caller cancellation is not revocation. Invalid or missing metadata is.
      if (!signal.aborted) this.stop()
      throw fail()
    }
  }

  private async monitor(): Promise<void> {
    try {
      while (!this.signal.aborted) {
        await pause(this.signal)
        await this.scope(this.signal)
      }
    } catch {
      if (!this.signal.aborted) this.stop()
    }
  }

  async evaluate(value: LocalRequest, signal: AbortSignal): Promise<unknown> {
    const request = parseLocalRequest(value)
    const active = AbortSignal.any([
      signal,
      this.signal,
      AbortSignal.timeout(TASK_LIMITS.timeoutMs),
    ])
    if (
      active.aborted ||
      !this.current ||
      !this.panel ||
      request.clientId !== this.current.clientId ||
      request.method === "connect" ||
      request.method === "disconnect" ||
      (request.method !== "status" && request.generation !== this.current.generation)
    )
      throw fail()
    await this.scope(active)
    active.throwIfAborted()
    if (["send", "accept", "reply", "cancel"].includes(request.method)) {
      const key = `${request.method}:${request.id}`
      if (this.attempts.has(key) || this.attempts.size >= TASK_LIMITS.tracked * 4) throw fail()
      this.attempts.add(key)
    }
    const result = response(await this.dispatch(this.panel, request, active))
    // Revocation during an asynchronous operation cannot export a late result.
    await this.scope(active)
    active.throwIfAborted()
    return result
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stop()
    this.closing = (async () => {
      const cleanup = AbortSignal.timeout(TASK_LIMITS.timeoutMs)
      try {
        // Do not replay registration. A status read can recover a lost registration reply.
        await this.registration?.catch(() => {})
        const api = this.settings ?? this.panel
        if (api && this.clientId && this.registration && !this.socketLost.signal.aborted) {
          const current = identity(
            await this.dispatch(api, { method: "status", clientId: this.clientId }, cleanup),
            this.clientId,
          )
          const owned =
            !this.current ||
            same(current, this.current) ||
            (this.current.state === "pending" &&
              current.state === "approved" &&
              current.windowId === this.current.windowId &&
              current.generation !== this.current.generation)
          if (owned && (current.state === "pending" || current.state === "approved")) {
            await this.dispatch(
              api,
              { method: "disconnect", clientId: current.clientId, generation: current.generation },
              cleanup,
            )
          }
        }
      } catch {
        /* Best effort only. No registration or mutation is retried. */
      }
      await Promise.all(
        [...this.attachments.values()].map(async (api) => {
          try {
            await this.call("Target.detachFromTarget", { sessionId: api.sessionId }, cleanup)
          } catch {
            /* Already detached. */
          }
        }),
      )
      this.attachments.clear()
      this.socket?.removeEventListener("message", this.receive)
      this.socket?.close()
    })()
    return this.closing
  }
}
