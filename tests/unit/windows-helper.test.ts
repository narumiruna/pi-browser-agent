import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  HELPER_FRAME_BYTES,
  type HelperEvent,
} from "../../.pi/extensions/browser-tasks/chrome-connection.js"
import { runWindowsHelper } from "../../.pi/extensions/browser-tasks/windows-helper.js"
import type { LocalRequest } from "../../src/browser/coding-agent/protocol.js"

const CLIENT = "11111111-1111-4111-8111-111111111111"
const GENERATION = "22222222-2222-4222-8222-222222222222"
const EXTENSION = "a".repeat(32)
const identity = { clientId: CLIENT, generation: GENERATION, windowId: 4, state: "approved" }
const connect = { type: "connect", id: 1, extensionId: EXTENSION, clientId: CLIENT }
const request: LocalRequest = { method: "inbox", clientId: CLIENT, generation: GENERATION }
const runs: { input: PassThrough; done: Promise<void> }[] = []

function harness(
  options: {
    pendingConnect?: boolean
    pendingRequest?: boolean
    oversizedResult?: boolean
    fail?: boolean
  } = {},
) {
  const input = new PassThrough()
  const events: HelperEvent[] = []
  const lifetime = new AbortController()
  const wait = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private raw error")), { once: true })
      if (signal.aborted) reject(new Error())
    })
  const driver = {
    signal: lifetime.signal,
    connect: vi.fn(
      async (
        _target: unknown,
        signal: AbortSignal,
        onStatus?: (status: "chrome-approval" | "browser-approval") => void,
      ) => {
        onStatus?.("chrome-approval")
        if (options.fail) throw new Error("private debug endpoint and token")
        onStatus?.("browser-approval")
        if (options.pendingConnect) return await wait(signal)
        return identity
      },
    ),
    evaluate: vi.fn(async (_request: LocalRequest, signal: AbortSignal) => {
      if (options.pendingRequest) return await wait(signal)
      return { ok: true, value: options.oversizedResult ? "x".repeat(HELPER_FRAME_BYTES) : [] }
    }),
    close: vi.fn(async () => {
      lifetime.abort()
    }),
  }
  const factory = vi.fn(async () => driver)
  const done = runWindowsHelper(
    input,
    async (line) => {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(HELPER_FRAME_BYTES)
      expect(line.endsWith("\n")).toBe(true)
      events.push(JSON.parse(line) as HelperEvent)
    },
    { createConnection: factory, stopInput: () => input.destroy() },
  )
  runs.push({ input, done })
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`)
  const response = async (id: number) => {
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "response" && event.id === id)).toBe(true),
    )
    return events.find((event) => event.type === "response" && event.id === id)
  }
  return { input, events, driver, factory, done, send, response, lifetime }
}

afterEach(async () => {
  for (const run of runs.splice(0)) {
    run.input.destroy()
    await run.done
  }
})

describe("Windows helper bounded stdio", () => {
  it("imports without opening a socket and waits for an explicit connect", async () => {
    const test = harness()
    await vi.waitFor(() => expect(test.events).toEqual([{ type: "ready", version: 1 }]))
    expect(test.factory).not.toHaveBeenCalled()
    test.input.end()
    await test.done
    expect(test.factory).not.toHaveBeenCalled()
  })

  it("reports fixed statuses, handles one connect, and returns Browser envelopes", async () => {
    const test = harness()
    test.send(connect)
    expect(await test.response(1)).toEqual({ type: "response", id: 1, ok: true, value: identity })
    expect(test.events.slice(0, 3)).toEqual([
      { type: "ready", version: 1 },
      { type: "status", status: "chrome-approval" },
      { type: "status", status: "browser-approval" },
    ])
    test.send({ type: "request", id: 2, request })
    expect(await test.response(2)).toEqual({
      type: "response",
      id: 2,
      ok: true,
      value: { ok: true, value: [] },
    })
    test.send({ ...connect, id: 3 })
    expect(await test.response(3)).toEqual({
      type: "response",
      id: 3,
      ok: false,
      error: "invalid-request",
    })
    expect(test.factory).toHaveBeenCalledOnce()
    expect(test.driver.evaluate).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal))
    test.send({ type: "close", id: 4 })
    expect(await test.response(4)).toEqual({ type: "response", id: 4, ok: true, value: null })
    await test.done
  })

  it("rejects requests before connection setup without dispatch", async () => {
    const test = harness()
    test.send({ type: "request", id: 1, request })
    expect(await test.response(1)).toEqual({
      type: "response",
      id: 1,
      ok: false,
      error: "connection-stopped",
    })
    expect(test.driver.evaluate).not.toHaveBeenCalled()
    expect(test.factory).not.toHaveBeenCalled()
  })

  it("processes close while native or Browser approval is pending", async () => {
    const test = harness({ pendingConnect: true })
    test.send(connect)
    await vi.waitFor(() => expect(test.driver.connect).toHaveBeenCalledOnce())
    test.send({ type: "request", id: 2, request })
    expect(await test.response(2)).toMatchObject({ ok: false, error: "connection-stopped" })
    test.send({ type: "close", id: 3 })
    expect(await test.response(3)).toMatchObject({ ok: true, value: null })
    expect(await test.response(1)).toMatchObject({ ok: false, error: "connection-stopped" })
    await test.done
    expect(test.driver.close).toHaveBeenCalled()
    expect(test.driver.evaluate).not.toHaveBeenCalled()
  })

  it("uses only fixed failure codes and never raw Chrome errors", async () => {
    const test = harness({ fail: true })
    test.send(connect)
    expect(await test.response(1)).toEqual({
      type: "response",
      id: 1,
      ok: false,
      error: "chrome-unavailable",
    })
    expect(JSON.stringify(test.events)).not.toMatch(/private|endpoint|token/)
  })

  it.each([
    "not-json\n",
    "\n",
    " {}\n",
    "\uFEFF{}\n",
    `${JSON.stringify({ ...connect, endpoint: "ws://remote.test" })}\n`,
    `${JSON.stringify({ ...connect, extensionId: `${EXTENSION}\n` })}\n`,
    `${JSON.stringify({ ...connect, clientId: `${CLIENT}\n` })}\n`,
    `${JSON.stringify({ ...connect, id: 0 })}\n`,
    `${JSON.stringify({ ...connect, id: 1.5 })}\n`,
    `${JSON.stringify({ ...connect, id: Number.MAX_SAFE_INTEGER + 1 })}\n`,
    `${JSON.stringify({ type: "request", id: 1, request: { ...request, script: "anything" } })}\n`,
    `${JSON.stringify({ type: "close", id: 1, extra: true })}\n`,
    "x".repeat(HELPER_FRAME_BYTES + 1),
  ])("rejects invalid/noisy input without connecting", async (text) => {
    const test = harness()
    test.input.write(text)
    expect(await test.response(0)).toEqual({
      type: "response",
      id: 0,
      ok: false,
      error: "invalid-request",
    })
    await test.done
    expect(test.factory).not.toHaveBeenCalled()
  })

  it("rejects invalid UTF-8 across chunk boundaries", async () => {
    const test = harness()
    test.input.write(Buffer.from([0x7b, 0xc3]))
    test.input.write(Buffer.from([0x28, 0x7d, 0x0a]))
    expect(await test.response(0)).toMatchObject({ ok: false, error: "invalid-request" })
    await test.done
    expect(test.factory).not.toHaveBeenCalled()
  })

  it("rejects repeated and nonmonotonic IDs without replay", async () => {
    const test = harness()
    test.send(connect)
    await test.response(1)
    test.send({ type: "request", id: 1, request })
    expect(await test.response(0)).toMatchObject({ ok: false, error: "invalid-request" })
    await test.done
    expect(test.driver.evaluate).not.toHaveBeenCalled()
    expect(test.driver.connect).toHaveBeenCalledOnce()
  })

  it("accepts fragmented frames and rejects a truncated final frame", async () => {
    const test = harness()
    const text = `${JSON.stringify(connect)}\n`
    test.input.write(text.slice(0, 12))
    test.input.write(text.slice(12))
    await test.response(1)
    test.input.end('{"type":')
    await test.done
    expect(test.events).toContainEqual({
      type: "response",
      id: 0,
      ok: false,
      error: "invalid-request",
    })
    expect(test.driver.close).toHaveBeenCalled()
  })

  it("accepts one close even when eight ordinary requests are pending", async () => {
    const test = harness({ pendingRequest: true })
    test.send(connect)
    await test.response(1)
    for (let id = 2; id <= 9; id++) test.send({ type: "request", id, request })
    await vi.waitFor(() => expect(test.driver.evaluate).toHaveBeenCalledTimes(8))
    test.send({ type: "close", id: 10 })
    expect(await test.response(10)).toEqual({ type: "response", id: 10, ok: true, value: null })
    await test.done
    expect(test.events.some((event) => event.type === "response" && event.id === 0)).toBe(false)
    expect(test.driver.close).toHaveBeenCalled()
    expect(test.driver.evaluate).toHaveBeenCalledTimes(8)
  })

  it("limits concurrent handlers to eight and cancels without replay", async () => {
    const test = harness({ pendingRequest: true })
    test.send(connect)
    await test.response(1)
    for (let id = 2; id < 11; id++) test.send({ type: "request", id, request })
    expect(await test.response(0)).toMatchObject({ ok: false, error: "invalid-request" })
    await test.done
    expect(test.driver.evaluate).toHaveBeenCalledTimes(8)
    expect(test.driver.close).toHaveBeenCalled()
  })

  it("bounds exported frames even if an injected driver violates its response limit", async () => {
    const test = harness({ oversizedResult: true })
    test.send(connect)
    await test.response(1)
    test.send({ type: "request", id: 2, request })
    expect(await test.response(2)).toEqual({
      type: "response",
      id: 2,
      ok: false,
      error: "browser-unavailable",
    })
  })

  it("stops on connection scope loss instead of reopening a socket", async () => {
    const test = harness()
    test.send(connect)
    await test.response(1)
    test.lifetime.abort()
    await test.done
    expect(test.factory).toHaveBeenCalledOnce()
    expect(test.driver.close).toHaveBeenCalled()
  })

  it("bounds a blocked stdout writer without spawning a driver", async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const factory = vi.fn()
    const done = runWindowsHelper(input, () => new Promise<void>(() => {}), {
      createConnection: factory,
      stopInput: () => input.destroy(),
    })
    runs.push({ input, done })
    try {
      await vi.advanceTimersByTimeAsync(2100)
      await done
      expect(factory).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("closes on stdin end and cancels an in-flight request", async () => {
    const test = harness({ pendingRequest: true })
    test.send(connect)
    await test.response(1)
    test.send({ type: "request", id: 2, request })
    await vi.waitFor(() => expect(test.driver.evaluate).toHaveBeenCalledOnce())
    test.input.end()
    await test.done
    expect(test.events).toContainEqual({
      type: "response",
      id: 2,
      ok: false,
      error: "connection-stopped",
    })
  })
})
