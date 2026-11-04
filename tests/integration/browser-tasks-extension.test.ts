import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { type Task, TaskError } from "../../src/browser/coding-agent/protocol.js"

const mocks = vi.hoisted(() => ({ launch: vi.fn(), agentDir: "" }))
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => mocks.agentDir }))
const directories: string[] = []
vi.mock("../../.pi/extensions/browser-tasks/transport.js", () => ({
  connectExistingBrowser: mocks.launch,
}))

type Result = { content: { type: "text"; text: string }[]; details: unknown; isError: boolean }
type Context = {
  hasUI: boolean
  isIdle: () => boolean
  hasPendingMessages: () => boolean
  ui: {
    input: (
      title: string,
      placeholder: string,
      options?: { signal: AbortSignal },
    ) => Promise<string | undefined>
    confirm: (title: string, body: string, options?: { signal: AbortSignal }) => Promise<boolean>
    notify: (message: string, level: string) => void
  }
}
type Tool = {
  name: string
  defaultActive: boolean
  executionMode: string
  execute: (
    id: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    update: (result: Result) => void,
    ctx: Context,
  ) => Promise<Result>
}
const INCOMING: Task = {
  id: "incoming-1",
  from: "browser",
  to: "coding",
  task: "Explain repository validation. Do not change files.",
  status: "queued",
}

async function fixture(connected = true, directory?: string) {
  const agentDir = directory ?? (await mkdtemp(join(tmpdir(), "pi-browser-settings-")))
  if (!directory) directories.push(agentDir)
  mocks.agentDir = agentDir
  const settingsPath = join(agentDir, "pi-browser-agent.json")
  const tasks = new Map<string, Task>([[INCOMING.id, { ...INCOMING }]])
  const client = {
    endpoint: "Windows Chrome (existing profile)",
    close: vi.fn(async () => {}),
    send: vi.fn(async (id: string, task: string, _signal: AbortSignal) => {
      const value: Task = { id, task, from: "coding", to: "browser", status: "queued" }
      tasks.set(id, value)
      return value
    }),
    get: vi.fn(async (expected: Task, _signal: AbortSignal) => tasks.get(expected.id) ?? expected),
    wait: vi.fn(async (expected: Task, _signal: AbortSignal) => {
      const value: Task = { ...expected, status: "completed", answer: "Selected browser answer" }
      tasks.set(value.id, value)
      return value
    }),
    inbox: vi.fn(async () =>
      [...tasks.values()].filter((task) => task.from === "browser" && task.status === "queued"),
    ),
    accept: vi.fn(async (expected: Task, _signal: AbortSignal) => {
      if (tasks.get(expected.id)?.task !== expected.task) throw new TaskError("Changed task")
      const value: Task = { ...expected, status: "running" }
      tasks.set(value.id, value)
      return value
    }),
    reply: vi.fn(async (expected: Task, answer: string, _signal: AbortSignal) => {
      const value: Task = { ...expected, status: "completed", answer }
      tasks.set(value.id, value)
      return value
    }),
    cancel: vi.fn(async (expected: Task, _signal: AbortSignal) => {
      const value: Task = { ...expected, status: "cancelled" }
      tasks.set(value.id, value)
      return value
    }),
  }
  mocks.launch.mockImplementation(async (options: { onStatus: (text: string) => void }) => {
    options.onStatus("Select Allow local connection in existing Windows Chrome Browser Settings")
    return client
  })
  const tools = new Map<string, Tool>()
  const commands = new Map<string, { handler: (args: string, ctx: Context) => Promise<void> }>()
  const events = new Map<string, () => void | Promise<void>>()
  let activeTools = ["read", "bash", "unrelated_tool"]
  const api = {
    getActiveTools: () => [...activeTools],
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = [...names]
    }),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: Context) => Promise<void> },
    ) => commands.set(name, command),
    on: (name: string, handler: () => void | Promise<void>) => events.set(name, handler),
    sendMessage: vi.fn(
      (
        _message: { customType: string; content: string; display: boolean },
        _options?: { triggerTurn: boolean },
      ) => {},
    ),
    appendEntry: vi.fn(),
  }
  // Dynamic import keeps the Pi SDK's global message augmentation out of the browser typecheck.
  const entry = "../../.pi/extensions/browser-tasks/index.js"
  const loaded: { default: (host: typeof api) => void } = await import(entry)
  loaded.default(api)
  const ctx = {
    hasUI: true,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    ui: {
      input: vi.fn(
        async (
          _title: string,
          _placeholder: string,
          _options?: { signal: AbortSignal },
        ): Promise<string | undefined> => "a".repeat(32),
      ),
      confirm: vi.fn(
        async (_title: string, _body: string, _options?: { signal: AbortSignal }) => true,
      ),
      notify: vi.fn(),
    },
  }
  const update = vi.fn((_result: Result) => {})
  const invoke = (
    name: string,
    params: Record<string, string>,
    id = "call-1",
    signal?: AbortSignal,
  ) => {
    const tool = tools.get(name)
    if (!tool) throw new Error("Missing tool")
    return tool.execute(id, params, signal, update, ctx)
  }
  const command = async (name: string, args = "") => {
    const item = commands.get(name)
    if (!item) throw new Error("Missing command")
    await item.handler(args, ctx)
  }
  if (connected) await command("browser-connect")
  ctx.ui.confirm.mockClear()
  ctx.ui.notify.mockClear()
  return { client, tasks, tools, events, api, ctx, update, invoke, command, agentDir, settingsPath }
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("project-local Browser tasks extension", () => {
  test("registers inactive tools without launching a process or model request", async () => {
    const env = await fixture(false)
    expect([...env.tools.keys()]).toEqual([
      "browser_task",
      "browser_task_status",
      "browser_task_cancel",
      "browser_task_reply",
    ])
    expect(
      [...env.tools.values()].every(
        (tool) => !tool.defaultActive && tool.executionMode === "sequential",
      ),
    ).toBe(true)
    env.events.get("session_start")?.()
    expect(env.api.getActiveTools()).toEqual(["read", "bash", "unrelated_tool"])
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(env.api.sendMessage).not.toHaveBeenCalled()
    expect(env.api.appendEntry).not.toHaveBeenCalled()
    expect((await env.invoke("browser_task", { task: "Read a page" })).isError).toBe(true)
  })

  test("no-argument connect asks for public target ID, confirms broad CDP trust, and activates only after approval", async () => {
    const env = await fixture(false)
    await env.command("browser-connect", "https://untrusted.example/secret")
    expect(mocks.launch).not.toHaveBeenCalled()
    env.ctx.ui.confirm.mockResolvedValueOnce(false)
    await env.command("browser-connect")
    expect(mocks.launch).not.toHaveBeenCalled()
    await env.command("browser-connect")
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(mocks.launch.mock.calls[0]?.[0].projectRoot).toBe(
      new URL("../../", import.meta.url).pathname,
    )
    expect(mocks.launch.mock.calls[0]?.[0].extensionId).toBe("a".repeat(32))
    const trust = env.ctx.ui.confirm.mock.calls.at(-1)?.[1] ?? ""
    expect(trust).toContain("CDP grants broad access to the current profile")
    expect(trust).toContain("Chrome 144 or newer")
    expect(trust).toContain("chrome://inspect/#remote-debugging")
    expect(trust).toContain("existing loopback CDP endpoint")
    expect(trust).toContain("never launches or closes Chrome")
    expect(trust).toContain("copies credentials")
    expect(env.ctx.ui.input.mock.invocationCallOrder.at(-1)).toBeLessThan(
      env.ctx.ui.confirm.mock.invocationCallOrder.at(-1) ?? 0,
    )
    expect(env.ctx.ui.confirm.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0] ?? 0,
    )
    expect(env.api.getActiveTools()).toEqual([
      "read",
      "bash",
      "unrelated_tool",
      ...env.tools.keys(),
    ])
    expect(env.api.sendMessage).not.toHaveBeenCalled()
    await env.command("browser-connect")
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(env.ctx.ui.notify.mock.calls)).not.toContain("untrusted.example")
  })

  test("saves the public ID once and reuses it in a replacement plugin without caching consent", async () => {
    const env = await fixture()
    expect(JSON.parse(await readFile(env.settingsPath, "utf8"))).toEqual({
      extensionId: "a".repeat(32),
    })
    await env.command("browser-disconnect")
    const next = await fixture(false, env.agentDir)
    await next.command("browser-connect")
    expect(next.ctx.ui.input).not.toHaveBeenCalled()
    expect(next.ctx.ui.confirm).toHaveBeenCalledOnce()
    expect(next.ctx.ui.confirm.mock.calls[0]?.[1]).toContain("start automatically")
    expect(mocks.launch.mock.calls.at(-1)?.[0].extensionId).toBe("a".repeat(32))
  })

  test("invalid saved settings stop connection without an input prompt or overwrite", async () => {
    const env = await fixture(false)
    const invalid = '{"extensionId":"untrusted-url"}'
    await writeFile(env.settingsPath, invalid)
    await env.command("browser-connect")
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(env.ctx.ui.input).not.toHaveBeenCalled()
    expect(env.ctx.ui.confirm).not.toHaveBeenCalled()
    expect(await readFile(env.settingsPath, "utf8")).toBe(invalid)
    expect(env.ctx.ui.notify.mock.calls[0]?.[0]).toContain(env.settingsPath)
  })

  test("a declined trust warning does not save an extension ID", async () => {
    const env = await fixture(false)
    env.ctx.ui.confirm.mockResolvedValueOnce(false)
    await env.command("browser-connect")
    await expect(readFile(env.settingsPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("cancelled or invalid public extension ID opens no resources and asks no trust confirmation", async () => {
    const env = await fixture(false)
    for (const value of [
      undefined,
      "",
      "a".repeat(31),
      "A".repeat(32),
      `${"a".repeat(32)}\n`,
      "https://example.org/token",
      "a; run chrome",
    ]) {
      env.ctx.ui.input.mockResolvedValueOnce(value)
      await env.command("browser-connect")
    }
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(env.ctx.ui.confirm).not.toHaveBeenCalled()
    expect(env.api.getActiveTools()).toEqual(["read", "bash", "unrelated_tool"])
    expect(JSON.stringify(env.ctx.ui.notify.mock.calls)).not.toContain("example.org")
  })

  test("tools remain inactive during native and Browser approval; stale status is suppressed", async () => {
    const env = await fixture(false)
    let status!: (text: string) => void
    let finish!: (client: typeof env.client) => void
    mocks.launch.mockImplementationOnce((options: { onStatus: (text: string) => void }) => {
      status = options.onStatus
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = env.command("browser-connect")
    await vi.waitFor(() => expect(status).toBeDefined())
    status("Native Chrome approval")
    status("Browser Settings approval")
    expect(env.api.getActiveTools()).not.toContain("browser_task")
    expect(env.ctx.ui.notify).toHaveBeenCalledWith("Browser Settings approval", "info")
    await env.events.get("session_before_tree")?.()
    env.ctx.ui.notify.mockClear()
    status("Late status")
    expect(env.ctx.ui.notify).not.toHaveBeenCalled()
    finish(env.client)
    await pending
    expect(env.client.close).toHaveBeenCalled()
    expect(env.api.getActiveTools()).not.toContain("browser_task")
  })

  test("connection requires idle UI with no pending messages", async () => {
    const env = await fixture(false)
    env.ctx.hasUI = false
    await env.command("browser-connect")
    env.ctx.hasUI = true
    env.ctx.isIdle.mockReturnValue(false)
    await env.command("browser-connect")
    env.ctx.isIdle.mockReturnValue(true)
    env.ctx.hasPendingMessages.mockReturnValue(true)
    await env.command("browser-connect")
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(env.ctx.ui.confirm).not.toHaveBeenCalled()
    expect(env.ctx.ui.input).not.toHaveBeenCalled()
  })

  test.each([
    "session_shutdown",
    "session_before_tree",
    "session_before_switch",
    "session_before_fork",
  ])("%s prevents late connection activation and detaches the helper", async (event) => {
    const env = await fixture(false)
    let finish: ((client: typeof env.client) => void) | undefined
    let signal: AbortSignal | undefined
    mocks.launch.mockImplementationOnce((options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = env.command("browser-connect")
    await vi.waitFor(() => expect(finish).toBeDefined())
    await env.command("browser-connect")
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    await env.events.get(event)?.()
    expect(signal?.aborted).toBe(true)
    finish?.(env.client)
    await pending
    expect(env.client.close).toHaveBeenCalled()
    expect(env.api.getActiveTools()).not.toContain("browser_task")
  })

  test("disconnect confirms revocation and detachment, leaves Chrome intact, and preserves unrelated tools", async () => {
    const env = await fixture()
    env.api.setActiveTools([...env.api.getActiveTools(), "another_tool"])
    env.ctx.ui.confirm.mockResolvedValueOnce(false)
    await env.command("browser-disconnect")
    expect(env.client.close).not.toHaveBeenCalled()
    expect(env.api.getActiveTools()).toContain("browser_task")
    await env.command("browser-disconnect")
    expect(env.client.close).toHaveBeenCalled()
    expect(env.ctx.ui.confirm.mock.calls.at(-1)?.[1]).toContain("existing profile stay intact")
    expect(env.ctx.ui.confirm.mock.calls.at(-1)?.[1]).toContain("Revoke this local connection")
    expect(env.api.getActiveTools()).toEqual(["read", "bash", "unrelated_tool", "another_tool"])
    expect((await env.invoke("browser_task", { task: "Disconnected" })).isError).toBe(true)
  })

  test("submits once without another confirmation, reports automatic start, and blocks replayed call IDs", async () => {
    const env = await fixture()
    const result = await env.invoke("browser_task", { task: "Read selected page" }, "stable-call")
    expect(result.isError).toBe(false)
    const task = result.details as Task
    expect(task).toMatchObject({ status: "completed", answer: "Selected browser answer" })
    expect(task.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(env.update.mock.calls[0]?.[0].details).toMatchObject({
      id: task.id,
      status: "queued",
      waiting: "Starting in Browser Agent or awaiting access approval",
    })
    expect(env.client.send).toHaveBeenCalledTimes(1)
    expect(env.client.wait).toHaveBeenCalledTimes(1)
    expect(env.ctx.ui.confirm).not.toHaveBeenCalled()
    expect(
      (await env.invoke("browser_task", { task: "Read selected page" }, "stable-call")).isError,
    ).toBe(true)
    expect(env.client.send).toHaveBeenCalledTimes(1)
    expect((await env.invoke("browser_task_status", { taskId: task.id })).details).toEqual(task)
  })

  test("retains ID before uncertain submission and permits explicit status recovery only", async () => {
    const env = await fixture()
    env.client.send.mockRejectedValueOnce(new Error("untrusted credential error"))
    const failed = await env.invoke("browser_task", { task: "Read a page" })
    expect(failed.isError).toBe(true)
    const [id] = (failed.details as { taskIds: string[] }).taskIds
    expect(id).toBeTruthy()
    expect(JSON.stringify(failed)).not.toContain("credential error")
    expect((await env.invoke("browser_task", { task: "Replacement" }, "second-call")).isError).toBe(
      true,
    )
    expect(env.client.send).toHaveBeenCalledTimes(1)
    expect((await env.invoke("browser_task_status", { taskId: id ?? "" })).isError).toBe(false)
    expect(env.client.get).toHaveBeenCalledTimes(1)
    expect(env.client.wait).not.toHaveBeenCalled()
  })

  test("an interrupted wait retains its ID without resubmission", async () => {
    const env = await fixture()
    env.client.wait.mockImplementationOnce(
      async (_expected, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })
        }),
    )
    const controller = new AbortController()
    const pending = env.invoke(
      "browser_task",
      { task: "Wait for Browser answer" },
      "first",
      controller.signal,
    )
    await vi.waitFor(() => expect(env.client.wait).toHaveBeenCalled())
    expect((await env.invoke("browser_task", { task: "Concurrent" }, "second")).isError).toBe(true)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.details as { taskIds: string[] }).taskIds).toHaveLength(1)
    expect(env.client.send).toHaveBeenCalledTimes(1)
    expect(env.client.close).not.toHaveBeenCalled()
  })

  test.each(["session_before_tree", "session_before_switch", "session_before_fork"])(
    "cancelled %s retains recovery; successful tree clears handles but keeps the existing Chrome connection",
    async (beforeEvent) => {
      const env = await fixture()
      env.client.wait.mockRejectedValueOnce(new Error("Wait interrupted"))
      const result = await env.invoke("browser_task", { task: "Read a page" })
      const id = (result.details as { taskIds: string[] }).taskIds[0] ?? ""
      await env.events.get(beforeEvent)?.()
      expect((await env.invoke("browser_task_status", { taskId: id })).isError).toBe(false)
      expect(
        (await env.invoke("browser_task", { task: "Replacement" }, "other-call")).isError,
      ).toBe(true)
      await env.events.get("session_before_tree")?.()
      await env.events.get("session_tree")?.()
      expect((await env.invoke("browser_task_status", { taskId: id })).isError).toBe(true)
      expect(
        (await env.invoke("browser_task", { task: "New branch task" }, "other-call")).isError,
      ).toBe(false)
      expect(env.client.close).not.toHaveBeenCalled()
      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(mocks.launch.mock.calls[0]?.[0].signal.aborted).toBe(false)
    },
  )

  test("incoming tasks need explicit inbox review, acceptance and exact reply confirmation", async () => {
    const env = await fixture()
    await env.command("browser-accept", INCOMING.id)
    expect(env.client.accept).not.toHaveBeenCalled()
    await env.command("browser-inbox")
    expect(env.api.sendMessage).not.toHaveBeenCalled()
    expect(JSON.stringify(env.ctx.ui.notify.mock.calls)).not.toContain(INCOMING.task)
    env.ctx.ui.confirm.mockResolvedValueOnce(false)
    await env.command("browser-accept", INCOMING.id)
    expect(env.client.accept).not.toHaveBeenCalled()
    await env.command("browser-accept", INCOMING.id)
    expect(env.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(env.api.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true })
    expect(env.api.sendMessage.mock.calls[0]?.[0].content).toContain("Do not delegate")
    expect((await env.invoke("browser_task", { task: "Delegate back" })).isError).toBe(true)
    env.ctx.ui.confirm.mockResolvedValueOnce(false)
    expect(
      (await env.invoke("browser_task_reply", { taskId: INCOMING.id, answer: "Selected answer" }))
        .isError,
    ).toBe(true)
    expect(env.client.reply).not.toHaveBeenCalled()
    const reply = await env.invoke("browser_task_reply", {
      taskId: INCOMING.id,
      answer: "Selected answer",
    })
    expect(reply.details).toMatchObject({ status: "completed", answer: "Selected answer" })
    expect(env.ctx.ui.confirm.mock.calls.at(-1)?.[1]).toContain("Selected answer")
    expect((await env.invoke("browser_task", { task: "Another task" })).isError).toBe(true)
    await env.events.get("agent_settled")?.()
    expect((await env.invoke("browser_task", { task: "Another task" })).isError).toBe(false)
  })

  test("uncertain accept, reply and cancel are never replayed", async () => {
    const env = await fixture()
    await env.command("browser-inbox")
    await env.command("browser-accept", INCOMING.id)
    env.client.reply.mockRejectedValueOnce(new Error("Lost reply"))
    for (let i = 0; i < 2; i++)
      expect(
        (await env.invoke("browser_task_reply", { taskId: INCOMING.id, answer: "Answer" })).isError,
      ).toBe(true)
    expect(env.client.reply).toHaveBeenCalledTimes(1)
    await env.command("browser-accept", INCOMING.id)
    expect(env.client.accept).toHaveBeenCalledTimes(1)
    env.client.cancel.mockRejectedValueOnce(new Error("Lost cancel"))
    for (let i = 0; i < 2; i++)
      expect((await env.invoke("browser_task_cancel", { taskId: INCOMING.id })).isError).toBe(true)
    expect(env.client.cancel).toHaveBeenCalledTimes(1)
  })

  test("changed incoming text or a session that becomes busy cannot start a Coding run", async () => {
    const env = await fixture()
    await env.command("browser-inbox")
    env.tasks.set(INCOMING.id, { ...INCOMING, task: "Changed instructions" })
    await env.command("browser-accept", INCOMING.id)
    expect(env.api.sendMessage).not.toHaveBeenCalled()
    const other = await fixture()
    await other.command("browser-inbox")
    other.client.accept.mockImplementationOnce(async (task) => {
      other.ctx.hasPendingMessages.mockReturnValue(true)
      return { ...task, status: "running" }
    })
    await other.command("browser-accept", INCOMING.id)
    expect(other.api.sendMessage).not.toHaveBeenCalled()
  })

  test("shutdown waits for owned cleanup and a replacement factory cannot inherit handles", async () => {
    const env = await fixture()
    const result = await env.invoke("browser_task", { task: "Old session task" })
    const id = (result.details as Task).id
    let release!: () => void
    const closing = new Promise<void>((resolve) => {
      release = resolve
    })
    env.client.close.mockImplementation(() => closing)
    let stopped = false
    const shutdown = Promise.resolve(env.events.get("session_shutdown")?.()).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(env.api.getActiveTools()).not.toContain("browser_task")
    expect((await env.invoke("browser_task_status", { taskId: id })).isError).toBe(true)
    release()
    await shutdown
    const replacement = await fixture(false)
    await replacement.events.get("session_start")?.()
    expect(replacement.api.getActiveTools()).not.toContain("browser_task")
    await replacement.command("browser-connect")
    expect((await replacement.invoke("browser_task_status", { taskId: id })).isError).toBe(true)
    expect(replacement.client.get).not.toHaveBeenCalled()
    await replacement.command("browser-accept", INCOMING.id)
    expect(replacement.client.accept).not.toHaveBeenCalled()
    expect(replacement.api.sendMessage).not.toHaveBeenCalled()
    await replacement.command("browser-disconnect")
  })

  test("shutdown closes without prompting and aborts pending cancellation approval", async () => {
    const env = await fixture()
    const completed = await env.invoke("browser_task", { task: "Read a page" })
    const task = { ...(completed.details as Task), status: "running" as const }
    env.tasks.set(task.id, task)
    await env.invoke("browser_task_status", { taskId: task.id })
    let approve: ((answer: boolean) => void) | undefined
    env.ctx.ui.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve
        }),
    )
    const pending = env.invoke("browser_task_cancel", { taskId: task.id })
    await vi.waitFor(() => expect(approve).toBeDefined())
    await env.events.get("session_shutdown")?.()
    approve?.(true)
    expect((await pending).isError).toBe(true)
    expect(env.ctx.ui.confirm).toHaveBeenCalledTimes(1)
    expect(env.client.close).toHaveBeenCalled()
    expect(env.client.cancel).not.toHaveBeenCalled()
    expect(env.api.getActiveTools()).not.toContain("browser_task")
  })
})
