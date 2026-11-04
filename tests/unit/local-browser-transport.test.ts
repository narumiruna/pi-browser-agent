import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { TaskConnection } from "../../.pi/extensions/browser-tasks/chrome-connection.js"
import {
  type LocalConnection,
  type LocalRequest,
  parseLocalRequest,
  REQUEST_FAILURE,
  TASK_LIMITS,
  type Task,
} from "../../src/browser/coding-agent/protocol.js"

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), release: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: mocks.execFile }))
vi.mock("node:os", () => ({ release: mocks.release }))

const EXTENSION_ID = "a".repeat(32)
const identity: LocalConnection = {
  clientId: "550e8400-e29b-41d4-a716-446655440000",
  generation: "650e8400-e29b-41d4-a716-446655440000",
  windowId: 1,
  state: "approved",
}
const outgoing: Task = {
  id: "task-1",
  from: "coding",
  to: "browser",
  task: "Read selected page",
  status: "queued",
}
const incoming: Task = { ...outgoing, id: "incoming-1", from: "browser", to: "coding" }

async function clientFixture() {
  const { LocalBrowserClient } = await import("../../.pi/extensions/browser-tasks/transport.js")
  const stopped = new AbortController()
  const tasks = new Map<string, Task>([
    [incoming.id, incoming],
    [outgoing.id, outgoing],
  ])
  const requests: LocalRequest[] = []
  let current = { ...identity }
  let transform = (value: unknown): unknown => value
  const channel: TaskConnection = {
    signal: stopped.signal,
    close: vi.fn(async () => {
      stopped.abort()
    }),
    evaluate: vi.fn(async (input: LocalRequest) => {
      const request = parseLocalRequest(input)
      requests.push(request)
      if (request.method === "status") return { ok: true, value: current }
      let value: unknown
      const task = tasks.get(request.id ?? "")
      if (request.method === "send") value = { ...outgoing, id: request.id, task: request.task }
      else if (request.method === "inbox")
        value = [...tasks.values()].filter(
          (item) => item.from === "browser" && item.status === "queued",
        )
      else if (!task) throw new Error("Missing task")
      else if (request.method === "get") value = task
      else if (request.method === "accept") value = { ...task, status: "running" }
      else if (request.method === "reply")
        value = { ...task, status: "completed", answer: "[REDACTED]" }
      else value = { ...task, status: "cancelled" }
      if (request.id && request.method !== "get") tasks.set(request.id, value as Task)
      return transform({ ok: true, value })
    }),
  }
  return {
    client: new LocalBrowserClient(channel, identity),
    channel,
    stopped,
    tasks,
    requests,
    replaceIdentity: (update: Partial<LocalConnection>) => {
      current = { ...current, ...update }
    },
    transform: (callback: typeof transform) => {
      transform = callback
    },
  }
}

type WireCommand = {
  type: string
  id: number
  extensionId?: string
  clientId?: string
  request?: LocalRequest
}

async function processFixture(
  options: { ready?: unknown; noReady?: boolean; noConnect?: boolean; noClose?: boolean } = {},
) {
  mocks.release.mockReturnValue("6.6.0-microsoft-standard-WSL2")
  const discovery: { file: string; args: string[]; options: Record<string, unknown> }[] = []
  mocks.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      settings: Record<string, unknown>,
      callback: (error: unknown, value: string) => void,
    ) => {
      discovery.push({ file, args, options: settings })
      const output =
        file === "powershell.exe"
          ? "C:\\Tools\\bun.exe\r\n"
          : args[0] === "-u"
            ? "/mnt/c/Tools/bun.exe\n"
            : "\\\\wsl.localhost\\Ubuntu\\project\\windows-helper.ts\n"
      queueMicrotask(() => callback(null, output))
    },
  )
  const commands: WireCommand[] = []
  let approved = { ...identity }
  let drop = ""
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: Writable
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const emit = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`)
  const answer = (id: number, value: unknown) => emit({ type: "response", id, ok: true, value })
  child.kill = vi.fn(() => {
    child.emit("exit", null)
    return true
  })
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const command = JSON.parse(chunk.toString()) as WireCommand
      commands.push(command)
      if (command.type === "connect") {
        approved = { ...identity, clientId: command.clientId ?? identity.clientId }
        if (!options.noConnect) queueMicrotask(() => answer(command.id, approved))
      } else if (command.type === "close") {
        if (!options.noClose)
          queueMicrotask(() => {
            answer(command.id, null)
            child.emit("exit", 0)
          })
      } else if (command.request?.method !== drop) {
        queueMicrotask(() =>
          answer(command.id, {
            ok: true,
            value: command.request?.method === "status" ? approved : outgoing,
          }),
        )
      }
      done()
    },
  })
  mocks.spawn.mockImplementation(() => {
    if (!options.noReady) queueMicrotask(() => emit(options.ready ?? { type: "ready", version: 1 }))
    return child
  })
  const { connectExistingBrowser } = await import("../../.pi/extensions/browser-tasks/transport.js")
  return {
    child,
    commands,
    discovery,
    emit,
    answer,
    connect: (extra: Partial<Parameters<typeof connectExistingBrowser>[0]> = {}) =>
      connectExistingBrowser({ projectRoot: "/project", extensionId: EXTENSION_ID, ...extra }),
    drop: (method: string) => {
      drop = method
    },
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("existing Windows Chrome transport", () => {
  test("native processes receive only required OS metadata, not parent provider secrets or preload flags", async () => {
    vi.stubEnv("OPENAI_API_KEY", "private-parent-key")
    vi.stubEnv("NODE_OPTIONS", "--require private-preload")
    vi.stubEnv("BUN_OPTIONS", "private-preload")
    vi.stubEnv("LD_PRELOAD", "private-library")
    vi.stubEnv("WSLENV", "OPENAI_API_KEY/u:NODE_OPTIONS:BUN_OPTIONS")
    const env = await processFixture()
    const client = await env.connect()
    for (const item of env.discovery) {
      const childEnv = item.options.env as Record<string, string>
      expect(childEnv.WSLENV).toBe("")
      expect(
        Object.keys(childEnv).every((key) =>
          ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME", "WSLENV"].includes(key),
        ),
      ).toBe(true)
    }
    const childEnv = mocks.spawn.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(childEnv.WSLENV).toBe("")
    expect(JSON.stringify(childEnv)).not.toContain("private-")
    expect(
      Object.keys(childEnv).every((key) =>
        ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME", "WSLENV"].includes(key),
      ),
    ).toBe(true)
    await client.close()
  })
  test("discovers Windows Bun with fixed commands, passes paths without a shell, and owns only the helper", async () => {
    const env = await processFixture()
    const client = await env.connect()
    expect(client.endpoint).toBe("Windows Chrome (existing profile)")
    expect(env.discovery.map((item) => [item.file, item.args.slice(0, 4)])).toEqual([
      ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]],
      ["wslpath", ["-u", "C:\\Tools\\bun.exe"]],
      [
        "wslpath",
        [
          "-w",
          new URL("../../.pi/extensions/browser-tasks/windows-helper.ts", import.meta.url).pathname,
        ],
      ],
    ])
    expect(env.discovery[0]?.args[4]).toContain("Get-Command bun.exe -CommandType Application")
    for (const item of env.discovery)
      expect(item.options).toMatchObject({ shell: false, timeout: 15_000, maxBuffer: 16 * 1024 })
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/mnt/c/Tools/bun.exe",
      ["\\\\wsl.localhost\\Ubuntu\\project\\windows-helper.ts"],
      {
        shell: false,
        windowsHide: true,
        cwd: "/project",
        stdio: "pipe",
        env: expect.objectContaining({ WSLENV: "" }),
      },
    )
    expect(env.commands[0]).toMatchObject({ type: "connect", id: 1, extensionId: EXTENSION_ID })
    expect(
      JSON.stringify([
        ...env.discovery.map(({ file, args }) => ({ file, args })),
        ...mocks.spawn.mock.calls.map(([file, args]) => ({ file, args })),
      ]),
    ).not.toMatch(
      /chrome\.exe|chromium|browser-profile|user-data-dir|remote-debugging|forward|relay|install|download/i,
    )
    expect(env.discovery[0]?.args[4]).not.toContain(EXTENSION_ID)
    await client.close()
    await client.close()
    expect(env.commands.map((item) => item.type)).toEqual(["connect", "close"])
    expect(env.child.kill).not.toHaveBeenCalled()
  })

  test("rejects non-WSL, invalid target IDs and missing runtimes without native error output", async () => {
    const env = await processFixture()
    vi.stubEnv("WSL_DISTRO_NAME", "")
    vi.stubEnv("WSL_INTEROP", "")
    mocks.release.mockReturnValue("6.6.0-linux")
    await expect(env.connect()).rejects.toThrow("requires Pi in WSL")
    expect(mocks.execFile).not.toHaveBeenCalled()
    mocks.release.mockReturnValue("microsoft")
    await expect(env.connect({ extensionId: "a; Start-Process chrome" })).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(mocks.execFile).not.toHaveBeenCalled()
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(new Error("secret Windows path"), ""),
    )
    await expect(env.connect()).rejects.toThrow("Windows Bun is unavailable")
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  test("runtime and helper path conversion output is bounded and never interpreted as commands", async () => {
    const env = await processFixture()
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(null, "C:\\Tools\\bun.exe\nStart-Process chrome"),
    )
    await expect(env.connect()).rejects.toThrow("Windows Bun is unavailable")
    expect(mocks.spawn).not.toHaveBeenCalled()
    const next = await processFixture()
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(null, "C:\\A & B; 'quoted'\\bun.exe"),
    )
    const client = await next.connect()
    expect(next.discovery[0]?.args).toEqual(["-u", "C:\\A & B; 'quoted'\\bun.exe"])
    await client.close()
  })

  test.each([
    { type: "ready", version: 2 },
    { type: "ready", version: 1, extra: true },
    { type: "response", id: 1, ok: true, value: identity },
  ])("requires an exact versioned ready frame: %j", async (ready) => {
    const env = await processFixture({ ready })
    await expect(env.connect()).rejects.toThrow(REQUEST_FAILURE)
    expect(env.commands.some((item) => item.type === "connect")).toBe(false)
    expect(env.commands.some((item) => item.type === "close")).toBe(true)
  })

  test.each([
    "native noisy stdout\n",
    '\uFEFF{"type":"response","id":1,"ok":true,"value":null}\n',
    ' {"type":"response","id":1,"ok":true,"value":null}\n',
    '{"type":"response","id":1,"ok":true,"value":null}\r\n',
    '{"type":"ready","version":1}\n',
    '{"type":"response","id":999,"ok":true,"value":null}\n',
    '{"type":"response","id":0,"ok":true,"value":null}\n',
    '{"type":"response","id":1.5,"ok":true,"value":null}\n',
    '{"type":"response","id":1,"ok":false,"error":"raw endpoint secret"}\n',
    '{"type":"status","status":"untrusted instruction"}\n',
    '{"type":"response","id":1,"ok":true,"value":null,"extra":true}\n',
    "x".repeat(64 * 1024 + 1),
    "é".repeat(32 * 1024),
  ])(
    "rejects noisy, oversized or invalid correlated frames without disclosing them",
    async (frame) => {
      const env = await processFixture()
      const client = await env.connect()
      env.drop("status")
      const pending = client.get(outgoing)
      const rejected = expect(pending).rejects.toThrow(outgoing.id)
      env.child.stdout.write(frame)
      await rejected
      await client.close()
      expect(env.commands.filter((item) => item.type === "connect")).toHaveLength(1)
    },
  )

  test("checks UTF-8 strictly and accepts valid split Unicode frames", async () => {
    const env = await processFixture()
    const client = await env.connect()
    env.drop("get")
    const pending = client.get(outgoing)
    await vi.waitFor(() => expect(env.commands.at(-1)?.request?.method).toBe("get"))
    const id = env.commands.at(-1)?.id
    const frame = Buffer.from(
      `${JSON.stringify({ type: "response", id, ok: true, value: { ok: true, value: { ...outgoing, status: "completed", answer: "日本語" } } })}\n`,
    )
    const split = frame.indexOf(Buffer.from("日")) + 1
    env.child.stdout.write(frame.subarray(0, split))
    env.child.stdout.write(frame.subarray(split))
    expect(await pending).toMatchObject({ answer: "日本語" })
    const failed = client.get(outgoing)
    const rejected = expect(failed).rejects.toThrow(outgoing.id)
    env.child.stdout.write(Buffer.from([0xff, 0x0a]))
    await rejected
    await client.close()
  })

  test.each(["exit", "error", "stdin-error", "stdout-end"])(
    "native %s stops pending work without exposing stderr or replacing Chrome",
    async (event) => {
      const env = await processFixture()
      const client = await env.connect()
      env.drop("status")
      const pending = client.get(outgoing)
      const rejected = expect(pending).rejects.toThrow(outgoing.id)
      env.child.stderr.write("secret endpoint and Windows profile path")
      if (event === "stdin-error") env.child.stdin.emit("error", new Error("secret endpoint"))
      else if (event === "stdout-end") env.child.stdout.end()
      else env.child.emit(event, event === "error" ? new Error("secret endpoint") : 1)
      await rejected
      await expect(client.get(outgoing)).rejects.toThrow(outgoing.id)
      await client.close()
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
      expect(env.commands.filter((item) => item.type === "connect")).toHaveLength(1)
    },
  )

  test("maps only fixed approval status instructions while connection is pending", async () => {
    const env = await processFixture({ noConnect: true })
    const status = vi.fn()
    const pending = env.connect({ onStatus: status })
    await vi.waitFor(() => expect(env.commands[0]?.type).toBe("connect"))
    env.emit({ type: "status", status: "chrome-approval" })
    env.emit({ type: "status", status: "browser-approval" })
    expect(status.mock.calls[0]?.[0]).toContain("native remote debugging permission")
    expect(status.mock.calls[1]?.[0]).toContain("Allow local connection")
    const connect = env.commands[0]
    env.answer(connect?.id ?? 1, { ...identity, clientId: connect?.clientId })
    const client = await pending
    await client.close()
  })

  test("caps inflight messages at eight and uses strictly increasing IDs", async () => {
    const env = await processFixture()
    const client = await env.connect()
    env.drop("status")
    const calls = Array.from({ length: 9 }, () => client.get(outgoing))
    const settled = Promise.allSettled(calls)
    await vi.waitFor(() =>
      expect(env.commands.filter((item) => item.type === "request")).toHaveLength(8),
    )
    env.child.emit("exit", 1)
    expect((await settled).every((item) => item.status === "rejected")).toBe(true)
    const ids = env.commands.map((item) => item.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    await client.close()
    expect(env.child.kill).not.toHaveBeenCalled()
  })

  test("abort interrupts pending connect and sends close before stopping only an unresponsive helper", async () => {
    const env = await processFixture({ noConnect: true, noClose: true })
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms <= 3_000 ? 5 : ms))
    const controller = new AbortController()
    const pending = env.connect({ signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow(REQUEST_FAILURE)
    await vi.waitFor(() => expect(env.commands[0]?.type).toBe("connect"))
    controller.abort()
    await rejected
    expect(env.commands.map((item) => item.type)).toEqual(["connect", "close"])
    expect(env.child.kill).toHaveBeenCalledTimes(1)
  })

  test.each(["ready", "connect", "request"])(
    "bounds %s deadline and ignores late issued responses",
    async (phase) => {
      const env = await processFixture({
        noReady: phase === "ready",
        noConnect: phase === "connect",
      })
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      if (phase !== "request") {
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
          timeout(ms === (phase === "ready" ? 15_000 : TASK_LIMITS.waitMs) ? 5 : ms),
        )
        await expect(env.connect()).rejects.toThrow(REQUEST_FAILURE)
      } else {
        const client = await env.connect()
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 15_000 ? 5 : ms))
        env.drop("get")
        await expect(client.get(outgoing)).rejects.toThrow(outgoing.id)
        const id = env.commands.at(-1)?.id ?? 1
        env.answer(id, {
          ok: true,
          value: { ...outgoing, status: "completed", answer: "Late answer" },
        })
        env.drop("")
        expect(await client.get(outgoing)).toEqual(outgoing)
        await client.close()
      }
      expect(env.commands.filter((item) => item.type === "connect").length).toBeLessThanOrEqual(1)
    },
  )
})

describe("typed LocalBrowserClient channel seam", () => {
  test("checks identity before each bounded exact task request; close delegates only once", async () => {
    const env = await clientFixture()
    const text = 'Read "quoted" page; $' + "{globalThis.secret}; </script>"
    const sent = await env.client.send(outgoing.id, text)
    expect(sent.task).toBe(text)
    expect(env.requests).toEqual([
      { method: "status", clientId: identity.clientId },
      {
        method: "send",
        clientId: identity.clientId,
        generation: identity.generation,
        id: outgoing.id,
        task: text,
      },
    ])
    await env.client.close()
    await env.client.close()
    expect(env.channel.close).toHaveBeenCalledTimes(1)
    expect(env.requests.some((item) => item.method === "disconnect")).toBe(false)
    await expect(env.client.get(sent)).rejects.toThrow(sent.id)
  })

  test.each([
    { state: "pending" as const },
    { generation: "750e8400-e29b-41d4-a716-446655440000" },
    { windowId: 2 },
    { clientId: "different" },
  ])("rejects changed approval identity: %j", async (update) => {
    const env = await clientFixture()
    env.replaceIdentity(update)
    await expect(env.client.send(outgoing.id, outgoing.task)).rejects.toThrow(outgoing.id)
    expect(env.requests.some((item) => item.method === "send")).toBe(false)
    await env.client.close()
  })

  test.each([
    null,
    { ok: false, error: "credential secret" },
    { ok: true, value: { ...outgoing, secret: "hidden" } },
    { ok: true, value: { ...outgoing, task: "x".repeat(TASK_LIMITS.responseBytes) } },
    { ok: true, value: outgoing, extra: true },
  ])("rejects malformed envelopes without exposing raw data", async (value) => {
    const env = await clientFixture()
    env.transform(() => value)
    await expect(env.client.get(outgoing)).rejects.toThrow(REQUEST_FAILURE)
    await env.client.close()
  })

  test("keeps immutable task identity, terminal state, direction, inbox and byte guards", async () => {
    const env = await clientFixture()
    expect(await env.client.inbox()).toEqual([incoming])
    await expect(env.client.accept(outgoing)).rejects.toThrow()
    await expect(env.client.reply(outgoing, "wrong direction")).rejects.toThrow()
    await expect(env.client.send("large", "é".repeat(TASK_LIMITS.taskBytes))).rejects.toThrow()
    const completed: Task = { ...outgoing, status: "completed", answer: "original" }
    env.tasks.set(outgoing.id, { ...completed, answer: "changed" })
    await expect(env.client.get(completed)).rejects.toThrow(outgoing.id)
    env.transform(() => ({ ok: true, value: [incoming, incoming] }))
    await expect(env.client.inbox()).rejects.toThrow()
    await env.client.close()
  })

  test("accepts Browser-redacted reply receipts; mutations are never replayed", async () => {
    const env = await clientFixture()
    const accepted = await env.client.accept(incoming)
    expect(await env.client.reply(accepted, "Selected private value")).toMatchObject({
      status: "completed",
      answer: "[REDACTED]",
    })
    const sent = await env.client.send(outgoing.id, outgoing.task)
    expect((await env.client.cancel(sent)).status).toBe("cancelled")
    await expect(env.client.accept(incoming)).rejects.toThrow(incoming.id)
    await expect(env.client.reply(accepted, "Selected private value")).rejects.toThrow(incoming.id)
    await expect(env.client.cancel(sent)).rejects.toThrow(sent.id)
    for (const method of ["accept", "reply", "cancel"])
      expect(env.requests.filter((item) => item.method === method)).toHaveLength(1)
    await env.client.close()
  })

  test("retains uncertain mutation ID on abort and never retries even if the channel ignores cancellation", async () => {
    const env = await clientFixture()
    const controller = new AbortController()
    vi.mocked(env.channel.evaluate).mockImplementation(async (request) => {
      env.requests.push(request)
      if (request.method === "status") return { ok: true, value: identity }
      return new Promise(() => {})
    })
    const pending = env.client.send(outgoing.id, outgoing.task, controller.signal)
    await vi.waitFor(() => expect(env.requests.some((item) => item.method === "send")).toBe(true))
    controller.abort()
    await expect(pending).rejects.toThrow(outgoing.id)
    await expect(env.client.send(outgoing.id, outgoing.task)).rejects.toThrow(outgoing.id)
    expect(env.requests.filter((item) => item.method === "send")).toHaveLength(1)
    await env.client.close()
  })

  test("observes a rejected channel promise even when the same dispatch aborts its signal synchronously", async () => {
    const env = await clientFixture()
    vi.mocked(env.channel.evaluate).mockImplementationOnce(async () => {
      env.stopped.abort()
      throw new Error("native secret")
    })
    await expect(env.client.get(outgoing)).rejects.toThrow(outgoing.id)
    await env.client.close()
  })

  test("channel failure aborts task waiting; waiting uses read-only get without resubmission", async () => {
    const env = await clientFixture()
    const sent = await env.client.send(outgoing.id, outgoing.task)
    const pending = env.client.wait(sent)
    await vi.waitFor(() => expect(env.requests.some((item) => item.method === "get")).toBe(true))
    env.stopped.abort()
    await expect(pending).rejects.toThrow(sent.id)
    expect(env.requests.filter((item) => item.method === "send")).toHaveLength(1)
    await env.client.close()
  })
})
