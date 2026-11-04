import { runInNewContext } from "node:vm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ExistingChromeConnection,
  readChromeEndpoint,
} from "../../.pi/extensions/browser-tasks/chrome-connection.js"
import {
  type LocalConnection,
  type LocalRequest,
  REQUEST_FAILURE,
} from "../../src/browser/coding-agent/protocol.js"

const fs = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock("node:fs/promises", () => ({ open: fs.open }))

const CLIENT = "11111111-1111-4111-8111-111111111111"
const PENDING = "22222222-2222-4222-8222-222222222222"
const APPROVED = "33333333-3333-4333-8333-333333333333"
const EXTENSION = "a".repeat(32)
const URL = `chrome-extension://${EXTENSION}/sidebar/index.html`
const ENDPOINT = `ws://127.0.0.1:54231/devtools/browser/${APPROVED}`
type Message = { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
type FakeTarget = { targetId: string; type: string; url: string; tab?: boolean; windowId?: number }

class FakeSocket extends EventTarget {
  static sockets: FakeSocket[] = []
  static product: unknown = "Chrome/156.0.0.0"
  static apiVersion = 2
  static panelReady = true
  static deny = false
  static existingSettings = true
  static autoApprove = true
  static sameGeneration = false
  static wrongWindow = false
  static ordinaryTab = false
  readyState = 0
  closed = false
  state: LocalConnection | null = null
  messages: Message[] = []
  requests: { role: string; request: LocalRequest }[] = []
  holdSend = false
  oversizedResponse = false
  release?: () => void
  targets: FakeTarget[] = [
    {
      targetId: "wrong-extension",
      type: "page",
      url: `chrome-extension://${"b".repeat(32)}/sidebar/index.html?view=settings`,
    },
    { targetId: "web", type: "page", url: "https://example.test/" },
    { targetId: "panel", type: "other", url: URL, tab: FakeSocket.ordinaryTab },
  ]

  constructor(readonly address: string) {
    super()
    FakeSocket.sockets.push(this)
    if (FakeSocket.existingSettings)
      this.targets.push({
        targetId: "settings",
        type: "page",
        url: `${URL}?view=settings`,
        tab: true,
      })
    queueMicrotask(() => {
      if (FakeSocket.deny) this.close()
      else {
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
      }
    })
  }

  event(method: string, params: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method, params }) }))
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  }

  send(text: string): void {
    const message = JSON.parse(text) as Message
    this.messages.push(message)
    void this.handle(message).then(
      (result) => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: message.id,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
              result,
            }),
          }),
        )
      },
      () => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: message.id,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
              error: { message: "private-path-or-token" },
            }),
          }),
        )
      },
    )
  }

  private async handle(message: Message): Promise<unknown> {
    const { method, params } = message
    if (method === "Browser.getVersion") return { product: FakeSocket.product }
    if (method === "Target.setDiscoverTargets" || method === "Target.detachFromTarget") return {}
    if (method === "Target.getTargets") return { targetInfos: this.targets }
    if (method === "Target.createTarget") {
      expect(params).toEqual({ url: `${URL}?view=settings` })
      this.targets.push({
        targetId: "settings",
        type: "page",
        url: params.url as string,
        tab: true,
      })
      return { targetId: "settings" }
    }
    if (method === "Target.attachToTarget") {
      expect(params.flatten).toBe(true)
      const target = this.targets.find((item) => item.targetId === params.targetId)
      expect(target?.url.startsWith(`chrome-extension://${EXTENSION}/sidebar/index.html`)).toBe(
        true,
      )
      return { sessionId: `session-${params.targetId}` }
    }
    if (method !== "Runtime.evaluate") throw new Error("Unexpected CDP operation")
    expect(message.sessionId).toMatch(/^session-(settings|panel|ordinary|wrong-window)$/)
    expect(Object.keys(params).sort()).toEqual(["awaitPromise", "expression", "returnByValue"])
    const target = this.targets.find((item) => `session-${item.targetId}` === message.sessionId)
    if (!target) throw new Error()
    const role = target.targetId === "settings" ? "settings" : "conversation"
    let sent = false
    const value = await runInNewContext(params.expression as string, {
      TextEncoder,
      location: { href: target.url },
      document: {
        body: { dataset: { conversationReady: FakeSocket.panelReady ? "true" : "false" } },
      },
      chrome: { tabs: { getCurrent: async () => (target.tab ? { id: 42 } : undefined) } },
      __piBrowserLocal: {
        version: FakeSocket.apiVersion,
        role,
        dispatch: async (request: LocalRequest) => {
          this.requests.push({ role, request })
          if (request.method === "connect")
            this.state = { clientId: CLIENT, generation: PENDING, windowId: 4, state: "pending" }
          if (
            request.method === "status" &&
            this.state?.state === "pending" &&
            FakeSocket.autoApprove
          ) {
            this.state = {
              ...this.state,
              state: "approved",
              generation: FakeSocket.sameGeneration ? PENDING : APPROVED,
              windowId: FakeSocket.wrongWindow ? 9 : 4,
            }
            const panel = this.targets.find((item) => item.targetId === "panel")
            if (panel) panel.type = "page"
          }
          if (request.method === "disconnect") {
            this.state = null
            return { ok: true, value: null }
          }
          if (["connect", "status"].includes(request.method))
            return {
              ok: true,
              value:
                target.windowId !== undefined && target.windowId !== this.state?.windowId
                  ? null
                  : this.state,
            }
          if (request.method === "send") {
            sent = true
            if (this.oversizedResponse) return { ok: true, value: "x".repeat(48 * 1024) }
          }
          return {
            ok: true,
            value: {
              id: request.id,
              from: "coding",
              to: "browser",
              task: request.task ?? "test",
              status: "queued",
            },
          }
        },
      },
    })
    if (sent && this.holdSend)
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    return { result: { type: typeof value, value } }
  }
}

const ctor = FakeSocket as unknown as typeof WebSocket
const live: ExistingChromeConnection[] = []
function driver(): ExistingChromeConnection {
  const connection = new ExistingChromeConnection(ENDPOINT, ctor)
  live.push(connection)
  return connection
}
async function connected(): Promise<{ connection: ExistingChromeConnection; socket: FakeSocket }> {
  const connection = driver()
  expect(
    await connection.connect(
      { extensionId: EXTENSION, clientId: CLIENT },
      new AbortController().signal,
    ),
  ).toEqual({ clientId: CLIENT, generation: APPROVED, windowId: 4, state: "approved" })
  return { connection, socket: FakeSocket.sockets[0] as FakeSocket }
}
const request = (task = "test"): LocalRequest => ({
  method: "send",
  clientId: CLIENT,
  generation: APPROVED,
  id: "task-one",
  task,
})

beforeEach(() => {
  FakeSocket.sockets = []
  FakeSocket.product = "Chrome/156.0.0.0"
  FakeSocket.deny = false
  FakeSocket.existingSettings = true
  FakeSocket.autoApprove = true
  FakeSocket.sameGeneration = false
  FakeSocket.wrongWindow = false
  FakeSocket.ordinaryTab = false
  FakeSocket.apiVersion = 2
  FakeSocket.panelReady = true
})
afterEach(async () => {
  for (const connection of live.splice(0)) await connection.close()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("existing Chrome endpoint metadata", () => {
  function metadata(bytes: Uint8Array): {
    close: ReturnType<typeof vi.fn>
    read: ReturnType<typeof vi.fn>
  } {
    const close = vi.fn(async () => {})
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const chunk = bytes.subarray(position, position + Math.min(length, 17))
      buffer.set(chunk, offset)
      return { bytesRead: chunk.byteLength }
    })
    fs.open.mockResolvedValue({ read, close })
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local")
    return { read, close }
  }

  it.each(["", "\n", "\r\n"])(
    "reads only bounded fixed metadata with final line ending %j",
    async (ending) => {
      const file = metadata(
        Buffer.from(
          `54231${ending === "\r\n" ? "\r\n" : "\n"}/devtools/browser/${APPROVED}${ending}`,
        ),
      )
      expect(await readChromeEndpoint()).toBe(ENDPOINT)
      expect(fs.open).toHaveBeenCalledExactlyOnceWith(
        "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data\\DevToolsActivePort",
        "r",
      )
      expect(file.close).toHaveBeenCalledOnce()
      expect(file.read.mock.calls.every((call) => call[1] + call[2] <= 1024)).toBe(true)
    },
  )

  it.each([
    `0\n/devtools/browser/${APPROVED}`,
    `65536\n/devtools/browser/${APPROVED}`,
    `05423\n/devtools/browser/${APPROVED}`,
    `54231\nws://remote.test/devtools/browser/${APPROVED}`,
    `54231\n/devtools/browser/${APPROVED}?token=secret`,
    `54231\n/devtools/browser/${APPROVED}\nextra`,
    `54231\n/devtools/browser/${APPROVED}\n\n`,
    ` 54231\n/devtools/browser/${APPROVED}`,
    "x".repeat(1025),
    "\uFEFF54231\n/devtools/browser/test",
  ])("rejects malformed metadata without exposing it", async (text) => {
    const file = metadata(Buffer.from(text))
    await expect(readChromeEndpoint()).rejects.toThrow(REQUEST_FAILURE)
    expect(file.close).toHaveBeenCalledOnce()
  })

  it("rejects invalid UTF-8 and does not read extra profile files", async () => {
    metadata(new Uint8Array([0xff]))
    await expect(readChromeEndpoint()).rejects.toThrow(REQUEST_FAILURE)
    expect(fs.open).toHaveBeenCalledTimes(1)
  })
})

describe("existing Chrome fixed CDP adapter", () => {
  it.each([
    undefined,
    null,
    "",
    "Chrome/143.0.0.0",
    "Firefox/156.0",
    "Chrome/NaN.0",
    "Chrome/9999999999999999999999.0",
  ])(
    "rejects unsupported native Chrome metadata before opening extension views: %j",
    async (product) => {
      FakeSocket.product = product
      const connection = driver()
      await expect(
        connection.connect(
          { extensionId: EXTENSION, clientId: CLIENT },
          new AbortController().signal,
        ),
      ).rejects.toThrow(REQUEST_FAILURE)
      expect(FakeSocket.sockets[0]?.messages.map((message) => message.method)).toEqual([
        "Browser.getVersion",
      ])
    },
  )
  it.each([
    ENDPOINT.replace("127.0.0.1", "localhost"),
    ENDPOINT.replace("127.0.0.1", "192.168.1.1"),
    ENDPOINT.replace("ws:", "wss:"),
    ENDPOINT.replace(":54231", ":0"),
    ENDPOINT.replace(":54231", ":65536"),
    `${ENDPOINT}?token=private`,
    `${ENDPOINT}/extra`,
    `${ENDPOINT}\n`,
    ENDPOINT.replace("127.0.0.1", "user:pass@127.0.0.1"),
  ])("rejects non-exact local browser endpoints before opening a socket", (value) => {
    expect(() => new ExistingChromeConnection(value, ctor)).toThrow(REQUEST_FAILURE)
    expect(FakeSocket.sockets).toHaveLength(0)
  })

  it("requires a pinned extension ID and valid client ID", async () => {
    const connection = driver()
    for (const extensionId of ["", "q".repeat(32), `${EXTENSION}\n`, `${EXTENSION}/other`]) {
      await expect(
        connection.connect({ extensionId, clientId: CLIENT }, new AbortController().signal),
      ).rejects.toThrow()
    }
    await expect(
      connection.connect(
        { extensionId: EXTENSION, clientId: `${CLIENT}\n` },
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(FakeSocket.sockets).toHaveLength(0)
  })

  it("reports native and app approval phases and never synthesizes gestures", async () => {
    const connection = driver()
    const statuses: string[] = []
    await connection.connect(
      { extensionId: EXTENSION, clientId: CLIENT },
      new AbortController().signal,
      (status) => statuses.push(status),
    )
    expect(statuses).toEqual(["chrome-approval", "browser-approval"])
    const socket = FakeSocket.sockets[0] as FakeSocket
    expect(socket.address).toBe(ENDPOINT)
    expect(socket.requests.filter(({ request }) => request.method === "connect")).toHaveLength(1)
    const allowed = [
      "Browser.getVersion",
      "Target.getTargets",
      "Target.setDiscoverTargets",
      "Target.attachToTarget",
      "Target.detachFromTarget",
      "Runtime.evaluate",
    ]
    expect(socket.messages.every((message) => allowed.includes(message.method))).toBe(true)
    expect(JSON.stringify(socket.messages)).not.toMatch(
      /userGesture|permissions|Storage|cookies|Browser\.close|Target\.closeTarget|Input\./,
    )
    expect(
      socket.messages
        .filter((message) => message.method === "Runtime.evaluate")
        .every((message) => (message.params.expression as string).includes("location.href ===")),
    ).toBe(true)
  })

  it("can create one exact Settings tab and leaves all Chrome targets open", async () => {
    FakeSocket.existingSettings = false
    const { connection, socket } = await connected()
    expect(
      socket.messages.filter((message) => message.method === "Target.createTarget"),
    ).toHaveLength(1)
    await connection.close()
    await connection.close()
    expect(socket.targets.some((target) => target.targetId === "settings")).toBe(true)
    expect(
      socket.messages.some((message) => /closeTarget|Browser.close/.test(message.method)),
    ).toBe(false)
    expect(socket.requests.filter(({ request }) => request.method === "disconnect")).toHaveLength(1)
    expect(socket.closed).toBe(true)
  })

  it("keeps JSON request text as data and returns the Browser response envelope", async () => {
    const { connection, socket } = await connected()
    const task = `"});globalThis.pwned=true;//\n<script>secret</script>`
    const result = await connection.evaluate(request(task), new AbortController().signal)
    expect(result).toEqual({
      ok: true,
      value: { id: "task-one", from: "coding", to: "browser", task, status: "queued" },
    })
    expect(
      socket.requests
        .filter(({ request }) => request.method === "send")
        .map(({ request }) => request.task),
    ).toEqual([task])
    await expect(connection.evaluate(request(task), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(socket.requests.filter(({ request }) => request.method === "send")).toHaveLength(1)
  })

  it("fails closed on native denial without returning a private CDP error", async () => {
    FakeSocket.deny = true
    const connection = driver()
    await expect(
      connection.connect(
        { extensionId: EXTENSION, clientId: CLIENT },
        new AbortController().signal,
      ),
    ).rejects.toThrow(REQUEST_FAILURE)
    expect(connection.signal.aborted).toBe(true)
    expect(FakeSocket.sockets[0]?.messages).toHaveLength(0)
  })

  it.each(["same-generation", "wrong-window"])(
    "requires fresh approved generation and unchanged window: %s",
    async (mode) => {
      FakeSocket.sameGeneration = mode === "same-generation"
      FakeSocket.wrongWindow = mode === "wrong-window"
      const connection = driver()
      await expect(
        connection.connect(
          { extensionId: EXTENSION, clientId: CLIENT },
          new AbortController().signal,
        ),
      ).rejects.toThrow(REQUEST_FAILURE)
      expect(FakeSocket.sockets[0]?.requests.some(({ request }) => request.method === "send")).toBe(
        false,
      )
    },
  )

  it("waits for complete conversation readiness before activating a connection", async () => {
    vi.useFakeTimers()
    FakeSocket.panelReady = false
    const connection = driver()
    const work = connection.connect(
      { extensionId: EXTENSION, clientId: CLIENT },
      new AbortController().signal,
    )
    let connected = false
    void work.then(() => {
      connected = true
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(connected).toBe(false)
    expect(FakeSocket.sockets[0]?.requests.some(({ role }) => role === "conversation")).toBe(false)
    FakeSocket.panelReady = true
    await vi.advanceTimersByTimeAsync(500)
    await expect(work).resolves.toMatchObject({ state: "approved" })
  })

  it("rejects the old draft-only API before requesting a connection", async () => {
    vi.useFakeTimers()
    FakeSocket.apiVersion = 1
    const connection = driver()
    const cancel = new AbortController()
    const work = connection.connect({ extensionId: EXTENSION, clientId: CLIENT }, cancel.signal)
    const rejected = expect(work).rejects.toThrow(REQUEST_FAILURE)
    await vi.advanceTimersByTimeAsync(500)
    cancel.abort()
    await rejected
    expect(FakeSocket.sockets[0]?.requests).toEqual([])
  })

  it("does not substitute an ordinary conversation tab for the SidePanel", async () => {
    vi.useFakeTimers()
    FakeSocket.ordinaryTab = true
    const connection = driver()
    const cancel = new AbortController()
    const work = connection.connect({ extensionId: EXTENSION, clientId: CLIENT }, cancel.signal)
    const rejected = expect(work).rejects.toThrow(REQUEST_FAILURE)
    await vi.advanceTimersByTimeAsync(500)
    cancel.abort()
    await rejected
    expect(FakeSocket.sockets[0]?.requests.some(({ role }) => role === "conversation")).toBe(false)
  })

  it("skips an ordinary same-URL tab and discovers a SidePanel that opens later", async () => {
    vi.useFakeTimers()
    const connection = driver()
    const work = connection.connect(
      { extensionId: EXTENSION, clientId: CLIENT },
      new AbortController().signal,
    )
    const socket = FakeSocket.sockets[0] as FakeSocket
    socket.targets = socket.targets.filter((target) => target.targetId !== "panel")
    socket.targets.unshift({ targetId: "ordinary", type: "page", url: URL, tab: true })
    setTimeout(() => socket.targets.push({ targetId: "panel", type: "page", url: URL }), 500)
    await vi.advanceTimersByTimeAsync(750)
    await expect(work).resolves.toMatchObject({ state: "approved", windowId: 4 })
    expect(
      socket.messages
        .filter((message) => message.method === "Target.detachFromTarget")
        .map((message) => message.params.sessionId),
    ).toContain("session-ordinary")
    expect(
      socket.requests
        .filter(({ role }) => role === "conversation")
        .every(({ request }) => request.method === "status"),
    ).toBe(true)
    await expect(
      connection.evaluate(request(), new AbortController().signal),
    ).resolves.toHaveProperty("ok", true)
    expect(
      socket.messages
        .filter(
          (message) =>
            message.method === "Runtime.evaluate" &&
            (message.params.expression as string).includes('"method":"send"'),
        )
        .map((message) => message.sessionId),
    ).toEqual(["session-panel"])
  })

  it("skips a SidePanel in a different window before selecting the approved window", async () => {
    const connection = driver()
    const work = connection.connect(
      { extensionId: EXTENSION, clientId: CLIENT },
      new AbortController().signal,
    )
    const socket = FakeSocket.sockets[0] as FakeSocket
    socket.targets.unshift({ targetId: "wrong-window", type: "page", url: URL, windowId: 9 })
    await expect(work).resolves.toMatchObject({ state: "approved", windowId: 4 })
    expect(
      socket.messages
        .filter((message) => message.method === "Target.detachFromTarget")
        .map((message) => message.params.sessionId),
    ).toContain("session-wrong-window")
    await expect(
      connection.evaluate(request(), new AbortController().signal),
    ).resolves.toHaveProperty("ok", true)
    expect(
      socket.messages
        .filter(
          (message) =>
            message.method === "Runtime.evaluate" &&
            (message.params.expression as string).includes('"method":"send"'),
        )
        .map((message) => message.sessionId),
    ).toEqual(["session-panel"])
  })

  it("revokes its pending registration when setup is cancelled", async () => {
    vi.useFakeTimers()
    FakeSocket.autoApprove = false
    const connection = driver()
    const cancel = new AbortController()
    const work = connection.connect({ extensionId: EXTENSION, clientId: CLIENT }, cancel.signal)
    const rejected = expect(work).rejects.toThrow(REQUEST_FAILURE)
    await vi.advanceTimersByTimeAsync(500)
    cancel.abort()
    await rejected
    expect(
      FakeSocket.sockets[0]?.requests
        .filter(({ request }) => request.method === "disconnect")
        .map(({ request }) => request.generation),
    ).toEqual([PENDING])
  })

  it.each(["Target.targetDestroyed", "Target.detachedFromTarget", "Target.targetInfoChanged"])(
    "aborts on pinned target loss: %s",
    async (method) => {
      const { connection, socket } = await connected()
      socket.event(
        method,
        method === "Target.targetDestroyed"
          ? { targetId: "panel" }
          : method === "Target.detachedFromTarget"
            ? { sessionId: "session-panel" }
            : { targetInfo: { targetId: "panel", url: "https://example.test/", type: "page" } },
      )
      expect(connection.signal.aborted).toBe(true)
      await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
        REQUEST_FAILURE,
      )
      expect(socket.requests.some(({ request }) => request.method === "send")).toBe(false)
    },
  )

  it("allows Settings to close after the approved SidePanel is bound", async () => {
    const { connection, socket } = await connected()
    socket.event("Target.targetDestroyed", { targetId: "settings" })
    socket.event("Target.detachedFromTarget", { sessionId: "session-settings" })
    expect(connection.signal.aborted).toBe(false)
    await expect(
      connection.evaluate(request(), new AbortController().signal),
    ).resolves.toHaveProperty("ok", true)
    await connection.close()
    expect(
      socket.requests
        .filter(({ request }) => request.method === "disconnect")
        .map(({ role }) => role),
    ).toEqual(["conversation"])
  })

  it("detects idle scope revocation without reconnecting", async () => {
    vi.useFakeTimers()
    const { connection, socket } = await connected()
    socket.state = { clientId: CLIENT, generation: PENDING, windowId: 4, state: "rejected" }
    await vi.advanceTimersByTimeAsync(250)
    expect(connection.signal.aborted).toBe(true)
    expect(FakeSocket.sockets).toHaveLength(1)
    await connection.close()
    expect(socket.requests.some(({ request }) => request.method === "disconnect")).toBe(false)
  })

  it("rechecks scope before a request and never sends with stale metadata", async () => {
    const { connection, socket } = await connected()
    socket.state = { clientId: CLIENT, generation: APPROVED, windowId: 8, state: "approved" }
    await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(connection.signal.aborted).toBe(true)
    expect(socket.requests.some(({ request }) => request.method === "send")).toBe(false)
  })

  it("ignores a late cancelled mutation response and never replays it", async () => {
    const { connection, socket } = await connected()
    socket.holdSend = true
    const cancel = new AbortController()
    const work = connection.evaluate(request(), cancel.signal)
    const rejected = expect(work).rejects.toThrow(REQUEST_FAILURE)
    await vi.waitFor(() => expect(socket.release).toBeTypeOf("function"))
    cancel.abort()
    await rejected
    socket.release?.()
    await Promise.resolve()
    await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(socket.requests.filter(({ request }) => request.method === "send")).toHaveLength(1)
    expect(connection.signal.aborted).toBe(false)
  })

  it("aborts immediately when approved metadata disappears", async () => {
    const { connection, socket } = await connected()
    socket.state = null
    await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(connection.signal.aborted).toBe(true)
    expect(socket.requests.some(({ request }) => request.method === "send")).toBe(false)
  })

  it("correlates both CDP request ID and flat session ID", async () => {
    const { connection, socket } = await connected()
    socket.holdSend = true
    const work = connection.evaluate(request(), new AbortController().signal)
    const rejected = expect(work).rejects.toThrow(REQUEST_FAILURE)
    await vi.waitFor(() => expect(socket.release).toBeTypeOf("function"))
    const sent = socket.messages
      .filter(
        (message) =>
          message.method === "Runtime.evaluate" &&
          (message.params.expression as string).includes('"method":"send"'),
      )
      .at(-1)
    expect(sent).toBeDefined()
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: sent?.id,
          sessionId: "other-session",
          result: { result: { value: { ok: true, value: null } } },
        }),
      }),
    )
    await rejected
    expect(connection.signal.aborted).toBe(true)
    expect(socket.closed).toBe(true)
    socket.release?.()
    expect(socket.requests.filter(({ request }) => request.method === "send")).toHaveLength(1)
  })

  it.each(["invalid-json", "oversized", "binary"])(
    "rejects invalid inbound CDP frames: %s",
    async (kind) => {
      const { connection, socket } = await connected()
      const data =
        kind === "oversized"
          ? "x".repeat(48 * 1024 * 8 + 1)
          : kind === "binary"
            ? new Uint8Array([1, 2, 3])
            : "not-json"
      socket.dispatchEvent(new MessageEvent("message", { data }))
      expect(connection.signal.aborted).toBe(true)
      expect(socket.closed).toBe(true)
    },
  )

  it("bounds API response bytes and does not replay an uncertain mutation", async () => {
    const { connection, socket } = await connected()
    socket.oversizedResponse = true
    await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(socket.requests.filter(({ request }) => request.method === "send")).toHaveLength(1)
  })

  it("expires a dispatched operation after fifteen seconds without replay", async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    })
    const { connection, socket } = await connected()
    socket.holdSend = true
    const work = connection.evaluate(request(), new AbortController().signal)
    const rejected = expect(work).rejects.toThrow(REQUEST_FAILURE)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.release).toBeTypeOf("function")
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    socket.release?.()
    await expect(connection.evaluate(request(), new AbortController().signal)).rejects.toThrow(
      REQUEST_FAILURE,
    )
    expect(socket.requests.filter(({ request }) => request.method === "send")).toHaveLength(1)
  })

  it("rejects scope mismatch, extra request keys, and oversized tasks before dispatch", async () => {
    const { connection, socket } = await connected()
    for (const value of [
      { ...request(), generation: PENDING },
      { ...request(), clientId: PENDING },
      { ...request(), code: "doAnything()" },
      request("x".repeat(8193)),
    ])
      await expect(connection.evaluate(value, new AbortController().signal)).rejects.toThrow()
    expect(socket.requests.some(({ request }) => request.method === "send")).toBe(false)
  })
})
