import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { release } from "node:os"
import { fileURLToPath } from "node:url"
import {
  type LocalConnection,
  type LocalRequest,
  parseLocalConnection,
  parseLocalRequest,
  parseTask,
  REQUEST_FAILURE,
  TASK_LIMITS,
  type Task,
  TaskError,
  taskId,
  taskText,
  terminal,
} from "../../../src/browser/coding-agent/protocol.js"
import {
  HELPER_FRAME_BYTES,
  HELPER_PROTOCOL_VERSION,
  type HelperCommand,
  type TaskConnection,
} from "./chrome-connection.js"

function failure(id?: string): TaskError {
  return new TaskError(`${REQUEST_FAILURE}${id ? ` Task ID: ${id}` : ""}`)
}

function helperFailure(reason: unknown): TaskError {
  if (reason === "chrome-unavailable")
    return new TaskError(
      "Cannot connect to existing Windows Chrome or Browser Agent. Keep Chrome 144 or newer running, enable remote debugging yourself at chrome://inspect/#remote-debugging, and reload the intended Browser Agent extension. No browser was started.",
    )
  if (reason === "browser-unavailable")
    return new TaskError(
      "Browser Agent is unavailable or its local approval changed. Verify the public extension ID, reload the extension if needed, and inspect Settings → Tools before connecting again. No operation was retried.",
    )
  return failure()
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(failure())
    }
    signal.addEventListener("abort", abort, { once: true })
    work
      .then(resolve, () => reject(failure()))
      .finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

async function pause(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(failure())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, 250)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure()
  return value as Record<string, unknown>
}

function connection(value: unknown, clientId: string): LocalConnection {
  const identity = parseLocalConnection(value)
  if (identity.clientId !== clientId) throw failure()
  return identity
}

function response(value: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > TASK_LIMITS.responseBytes)
    throw failure()
  const record = object(value)
  if (record.ok !== true || Object.keys(record).sort().join() !== "ok,value") throw failure()
  return record.value
}

// Do not forward Pi credentials or runtime preload flags through WSL interoperability.
function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { WSLENV: "" }
  for (const key of ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  // Generated extension typings require browser-only fields; native children omit them.
  return env as NodeJS.ProcessEnv
}

// Discovery commands are fixed. Neither task text nor extension IDs enter a shell command.
function command(file: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: TASK_LIMITS.timeoutMs,
        maxBuffer: 16 * 1024,
        env: nativeEnvironment(),
        signal,
      },
      (error, stdout) => {
        if (error || signal.aborted) return reject(failure())
        const text = stdout.trim()
        if (!text || /[\r\n\0]/.test(text)) return reject(failure())
        resolve(text)
      },
    )
  })
}

const BUN_QUERY =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; (Get-Command bun.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source"
const RUNTIME_FAILURE =
  "Windows Bun is unavailable. Install Bun on Windows or make bun.exe available on the Windows PATH, then use /browser-connect again. No runtime was installed."

class WindowsTaskConnection implements TaskConnection {
  private readonly stopped = new AbortController()
  readonly signal = this.stopped.signal
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private readySeen = false
  private exited = false
  private closing?: Promise<void>
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error?: TaskError) => void
    }
  >()
  private readyResolve!: () => void
  private readyReject!: () => void
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = () => reject(failure())
  })
  private exitResolve!: () => void
  private readonly exit = new Promise<void>((resolve) => {
    this.exitResolve = resolve
  })
  private connecting = false

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onStatus?: (text: string) => void,
  ) {
    // Observe rejection before any process event can arrive.
    void this.ready.catch(() => {})
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk))
    child.stdout.on("end", () => {
      if (!this.closing) this.fail()
    })
    child.stderr.resume() // Never retain or expose native diagnostics.
    child.stdin.on("error", () => this.fail())
    child.on("error", () => this.fail())
    child.on("exit", () => {
      this.exited = true
      this.exitResolve()
      this.fail()
    })
  }

  private rejectPending(): void {
    this.readyReject()
    for (const item of this.pending.values()) item.reject()
    this.pending.clear()
  }

  private fail(): void {
    this.stopped.abort()
    this.rejectPending()
    void this.close()
  }

  private receive(chunk: Buffer): void {
    try {
      // Split before concatenation so a large multi-frame chunk cannot bypass the frame limit.
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        if (this.buffer.length + end - offset + 1 > HELPER_FRAME_BYTES) throw failure()
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)])
        if (newline < 0) return
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.buffer)
        if (!text || text.trim() !== text) throw failure()
        const value = JSON.parse(text)
        this.buffer = Buffer.alloc(0)
        this.event(value)
        offset = newline + 1
      }
    } catch {
      this.fail()
    }
  }

  private event(value: unknown): void {
    const event = object(value)
    const keys = Object.keys(event).sort().join()
    if (event.type === "ready") {
      if (keys !== "type,version" || event.version !== HELPER_PROTOCOL_VERSION || this.readySeen)
        throw failure()
      this.readySeen = true
      this.readyResolve()
      return
    }
    if (!this.readySeen) throw failure()
    if (event.type === "status") {
      if (keys !== "status,type" || !this.connecting || this.closing) throw failure()
      if (event.status === "chrome-approval")
        this.onStatus?.(
          "In existing Windows Chrome, approve its native remote debugging permission yourself. Pi does not approve it.",
        )
      else if (event.status === "browser-approval")
        this.onStatus?.(
          "In Browser Settings → Tools, select Allow local connection and confirm. Keep the conversation Side Panel open. Approved Pi tasks start automatically when it is ready and idle with an empty composer; required access and browser-action confirmations remain.",
        )
      else throw failure()
      return
    }
    if (
      event.type !== "response" ||
      !Number.isSafeInteger(event.id) ||
      (event.id as number) < 1 ||
      (event.id as number) > this.sequence ||
      (event.ok === true
        ? keys !== "id,ok,type,value"
        : event.ok !== false ||
          keys !== "error,id,ok,type" ||
          typeof event.error !== "string" ||
          ![
            "invalid-request",
            "chrome-unavailable",
            "browser-unavailable",
            "connection-stopped",
          ].includes(event.error))
    )
      throw failure()
    const pending = this.pending.get(event.id as number)
    if (!pending) return // Issued requests can finish after cancellation. Never replay them.
    if (event.ok) pending.resolve(event.value)
    else pending.reject(helperFailure(event.error))
  }

  private async send(
    command:
      | Omit<Extract<HelperCommand, { type: "connect" }>, "id">
      | Omit<Extract<HelperCommand, { type: "request" }>, "id">
      | { type: "close" },
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (this.pending.size >= 8 || this.sequence >= Number.MAX_SAFE_INTEGER || this.exited)
      throw failure()
    const id = ++this.sequence
    const frame = `${JSON.stringify({ ...command, id })}\n`
    if (Buffer.byteLength(frame) > HELPER_FRAME_BYTES) throw failure()
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject: (error) => reject(error ?? failure()) })
    })
    try {
      this.child.stdin.write(frame, (error) => {
        if (error) this.fail()
      })
      return await bounded(result, signal)
    } finally {
      this.pending.delete(id)
    }
  }

  async connect(
    extensionId: string,
    clientId: string,
    signal: AbortSignal,
  ): Promise<LocalConnection> {
    await bounded(this.ready, AbortSignal.any([signal, this.signal, AbortSignal.timeout(15_000)]))
    this.connecting = true
    try {
      const identity = connection(
        await this.send({ type: "connect", extensionId, clientId }, signal),
        clientId,
      )
      if (identity.state !== "approved") throw failure()
      return identity
    } finally {
      this.connecting = false
    }
  }

  evaluate(request: LocalRequest, signal: AbortSignal): Promise<unknown> {
    return this.send(
      { type: "request", request: parseLocalRequest(request) },
      AbortSignal.any([signal, this.signal, AbortSignal.timeout(TASK_LIMITS.timeoutMs)]),
    )
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stopped.abort()
      this.rejectPending()
      // Defer until closing is assigned: process failures can occur during the close write.
      this.closing = Promise.resolve().then(async () => {
        if (this.exited) return
        try {
          await this.send({ type: "close" }, AbortSignal.timeout(3_000))
        } catch {
          /* Detach is best effort. */
        }
        this.child.stdin.end()
        try {
          await bounded(this.exit, AbortSignal.timeout(500))
        } catch {
          /* Stop only the owned helper. */
        }
        if (!this.exited) this.child.kill()
      })
    }
    return this.closing
  }
}

export class LocalBrowserClient {
  readonly endpoint = "Windows Chrome (existing profile)"
  private readonly attempts = new Set<string>()
  private readonly lifetime = new AbortController()
  private closing?: Promise<void>
  private readonly identity: LocalConnection

  constructor(
    private readonly channel: TaskConnection,
    identity: LocalConnection,
  ) {
    this.identity = parseLocalConnection(identity)
    if (this.identity.state !== "approved") throw failure()
  }

  private async request(
    method: LocalRequest["method"],
    fields: Partial<LocalRequest>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const active = AbortSignal.any([
      this.lifetime.signal,
      this.channel.signal,
      AbortSignal.timeout(TASK_LIMITS.timeoutMs),
      ...(signal ? [signal] : []),
    ])
    try {
      active.throwIfAborted()
      const current = connection(
        response(
          await bounded(
            this.channel.evaluate({ method: "status", clientId: this.identity.clientId }, active),
            active,
          ),
        ),
        this.identity.clientId,
      )
      if (
        current.state !== "approved" ||
        current.generation !== this.identity.generation ||
        current.windowId !== this.identity.windowId
      )
        throw failure()
      active.throwIfAborted()
      return response(
        await bounded(
          this.channel.evaluate(
            parseLocalRequest({
              method,
              clientId: this.identity.clientId,
              generation: this.identity.generation,
              ...fields,
            }),
            active,
          ),
          active,
        ),
      )
    } catch {
      throw failure(fields.id)
    }
  }

  private mutation(method: string, id: string): void {
    const key = `${method}:${taskId(id)}`
    if (this.attempts.has(key) || this.attempts.size >= TASK_LIMITS.tracked * 4) throw failure(id)
    this.attempts.add(key)
  }

  private matching(value: unknown, expected: Task): Task {
    try {
      const task = parseTask(value)
      if (
        task.id !== expected.id ||
        task.task !== expected.task ||
        task.from !== expected.from ||
        task.to !== expected.to ||
        (terminal(expected) && JSON.stringify(task) !== JSON.stringify(parseTask(expected))) ||
        (expected.status === "running" && task.status === "queued")
      )
        throw failure()
      return task
    } catch {
      throw failure(expected.id)
    }
  }

  async send(id: string, task: string, signal?: AbortSignal): Promise<Task> {
    const expected: Task = {
      id: taskId(id),
      task: taskText(task, TASK_LIMITS.taskBytes),
      from: "coding",
      to: "browser",
      status: "queued",
    }
    this.mutation("send", id)
    return this.matching(await this.request("send", { id, task }, signal), expected)
  }

  async get(expected: Task, signal?: AbortSignal): Promise<Task> {
    return this.matching(await this.request("get", { id: taskId(expected.id) }, signal), expected)
  }

  async inbox(signal?: AbortSignal): Promise<Task[]> {
    const value = await this.request("inbox", {}, signal)
    if (!Array.isArray(value) || value.length > TASK_LIMITS.inbox) throw failure()
    const tasks = value.map((item) => parseTask(item))
    if (
      new Set(tasks.map((task) => task.id)).size !== tasks.length ||
      tasks.some(
        (task) => task.from !== "browser" || task.to !== "coding" || task.status !== "queued",
      )
    )
      throw failure()
    return tasks
  }

  async accept(expected: Task, signal?: AbortSignal): Promise<Task> {
    parseTask(expected)
    if (expected.from !== "browser" || expected.status !== "queued") throw failure(expected.id)
    this.mutation("accept", expected.id)
    const task = this.matching(
      await this.request("accept", { id: expected.id, task: expected.task }, signal),
      expected,
    )
    if (task.status !== "running") throw failure(expected.id)
    return task
  }

  async reply(expected: Task, answer: string, signal?: AbortSignal): Promise<Task> {
    parseTask(expected)
    taskText(answer, TASK_LIMITS.answerBytes)
    if (expected.from !== "browser" || expected.status !== "running") throw failure(expected.id)
    this.mutation("reply", expected.id)
    const task = this.matching(
      await this.request("reply", { id: expected.id, answer }, signal),
      expected,
    )
    if (task.status !== "completed") throw failure(expected.id)
    return task
  }

  async cancel(expected: Task, signal?: AbortSignal): Promise<Task> {
    parseTask(expected)
    this.mutation("cancel", expected.id)
    const task = this.matching(await this.request("cancel", { id: expected.id }, signal), expected)
    if (!terminal(task)) throw failure(expected.id)
    return task
  }

  async wait(expected: Task, signal?: AbortSignal): Promise<Task> {
    const active = AbortSignal.any([
      this.lifetime.signal,
      this.channel.signal,
      AbortSignal.timeout(TASK_LIMITS.waitMs),
      ...(signal ? [signal] : []),
    ])
    let task = parseTask(expected)
    try {
      while (!terminal(task)) {
        await pause(active)
        task = await this.get(task, active)
      }
      return task
    } catch {
      throw failure(expected.id)
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort()
      this.closing = this.channel.close()
    }
    return this.closing
  }
}

export async function connectExistingBrowser(options: {
  projectRoot: string
  extensionId: string
  signal?: AbortSignal
  onStatus?: (text: string) => void
}): Promise<LocalBrowserClient> {
  if (options.extensionId.length !== 32 || !/^[a-p]{32}$/.test(options.extensionId)) throw failure()
  if (
    process.platform !== "linux" ||
    !(/microsoft/i.test(release()) || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  )
    throw new TaskError(
      "This connection requires Pi in WSL and existing Windows Chrome 144 or newer.",
    )
  const active = AbortSignal.any([
    AbortSignal.timeout(TASK_LIMITS.waitMs),
    ...(options.signal ? [options.signal] : []),
  ])
  let channel: WindowsTaskConnection | undefined
  let abort: (() => void) | undefined
  try {
    active.throwIfAborted()
    let runtime: string
    try {
      const windowsRuntime = await command(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BUN_QUERY],
        active,
      )
      if (!/^[a-z]:\\[^\r\n\0]*\\bun\.exe$/i.test(windowsRuntime)) throw failure()
      runtime = await command("wslpath", ["-u", windowsRuntime], active)
      if (!runtime.startsWith("/") || !runtime.endsWith("/bun.exe")) throw failure()
    } catch {
      throw new TaskError(RUNTIME_FAILURE)
    }
    const helper = await command(
      "wslpath",
      ["-w", fileURLToPath(new URL("./windows-helper.ts", import.meta.url))],
      active,
    )
    active.throwIfAborted()
    channel = new WindowsTaskConnection(
      spawn(runtime, [helper], {
        shell: false,
        windowsHide: true,
        cwd: options.projectRoot,
        env: nativeEnvironment(),
        stdio: "pipe",
      }),
      options.onStatus,
    )
    const owned = channel
    abort = () => {
      void owned.close()
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    const identity = await channel.connect(
      options.extensionId,
      randomUUID(),
      AbortSignal.any([active, channel.signal]),
    )
    active.throwIfAborted()
    return new LocalBrowserClient(
      {
        signal: channel.signal,
        evaluate: (request, signal) => owned.evaluate(request, signal),
        close: async () => {
          if (abort) options.signal?.removeEventListener("abort", abort)
          await owned.close()
        },
      },
      identity,
    )
  } catch (error) {
    if (abort) options.signal?.removeEventListener("abort", abort)
    await channel?.close()
    throw error instanceof TaskError ? error : failure()
  }
}
