import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import WebSocket from "ws"
import { createAuthenticationProof } from "../../src/pi/authentication.js"
import { BridgeServer } from "../../src/pi/bridge-server.js"
import { BridgeConfigStore } from "../../src/pi/config.js"
import {
  PROTOCOL_VERSION,
  type ProtocolFrame,
  parseProtocolFrame,
  serializeProtocolFrame,
} from "../../src/protocol/index.js"

const extensionId = "b".repeat(32)
const origin = `chrome-extension://${extensionId}`

async function getFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port")
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

interface TestClient {
  socket: WebSocket
  requests: ProtocolFrame[]
}

async function connectClient(options: {
  port: number
  secret: string
  requestHandler?: (frame: Extract<ProtocolFrame, { type: "request" }>) => Promise<unknown>
  protocolVersion?: number
}): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${options.port}`, { origin })
  const requests: ProtocolFrame[] = []

  return new Promise<TestClient>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Client authentication timed out")), 5_000)
    socket.on("error", reject)
    socket.on("message", (raw) => {
      const frame = parseProtocolFrame(raw.toString())
      if (frame.type === "auth.challenge") {
        socket.send(
          serializeProtocolFrame({
            type: "hello",
            protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
            clientId: "integration-client",
            extensionVersion: "0.1.0-test",
            capabilities: ["page.read", "pi.prompt"],
          }),
        )
        const proof = createAuthenticationProof(options.secret, frame, "integration-client", origin)
        socket.send(
          serializeProtocolFrame({
            type: "auth.response",
            challengeId: frame.challengeId,
            proof,
          }),
        )
        return
      }
      if (frame.type === "auth.result") {
        clearTimeout(timeout)
        if (frame.success) resolve({ socket, requests })
        else reject(new Error(frame.error?.message ?? "Authentication failed"))
        return
      }
      if (frame.type === "request") {
        requests.push(frame)
        if (!options.requestHandler) return
        void options
          .requestHandler(frame)
          .then((result) => {
            socket.send(
              serializeProtocolFrame({
                type: "response",
                id: frame.id,
                result: result as Extract<ProtocolFrame, { type: "response" }>["result"],
              }),
            )
          })
          .catch((error: unknown) => {
            socket.send(
              serializeProtocolFrame({
                type: "response",
                id: frame.id,
                error: {
                  code: "INTERNAL_ERROR",
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
            )
          })
        return
      }
      requests.push(frame)
    })
  })
}

const servers: BridgeServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  sockets.length = 0
  for (const server of servers) await server.stop()
  servers.length = 0
})

async function makeServer(): Promise<{
  server: BridgeServer
  store: BridgeConfigStore
  port: number
  secret: string
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-chrome-bridge-"))
  const store = new BridgeConfigStore(join(directory, "config.json"))
  const port = await getFreePort()
  const secret = Buffer.alloc(32, port % 255).toString("base64url")
  await store.save({ port, secret })
  const server = new BridgeServer(store)
  servers.push(server)
  await server.start()
  return { server, store, port, secret }
}

describe("BridgeServer", () => {
  test("binds to loopback and completes authenticated concurrent round trips", async () => {
    const { server, port, secret } = await makeServer()
    const client = await connectClient({
      port,
      secret,
      requestHandler: async (request) => {
        const sequence = request.params.sequence
        await new Promise((resolve) => setTimeout(resolve, sequence === 1 ? 30 : 5))
        return { sequence }
      },
    })
    sockets.push(client.socket)

    const [first, second] = await Promise.all([
      server.request("page.getVisibleText", { sequence: 1 }),
      server.request("page.getVisibleText", { sequence: 2 }),
    ])

    expect(first).toEqual({ sequence: 1 })
    expect(second).toEqual({ sequence: 2 })
    expect(server.getStatus()).toMatchObject({
      connected: true,
      extensionId,
      listening: true,
      port,
    })
  })

  test("rejects web origins before upgrading", async () => {
    const { port } = await makeServer()
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://malicious.example" })
    sockets.push(socket)

    await expect(
      new Promise((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      }),
    ).rejects.toThrow(/403/)
  })

  test("rejects incorrect secrets and unsupported protocol versions", async () => {
    const { port, secret } = await makeServer()

    await expect(
      connectClient({ port, secret: Buffer.alloc(32, 99).toString("base64url") }),
    ).rejects.toThrow(/incorrect/)

    await expect(connectClient({ port, secret, protocolVersion: 999 })).rejects.toThrow(
      /Expected protocol/,
    )
  })

  test("rejects old pending requests when an authenticated client is replaced", async () => {
    const { server, port, secret } = await makeServer()
    const first = await connectClient({ port, secret })
    sockets.push(first.socket)
    const pending = server.request("page.getVisibleText", {}, { timeoutMs: 5_000 })
    const rejection = expect(pending).rejects.toThrow(/Replaced by a new authenticated connection/)

    const second = await connectClient({ port, secret })
    sockets.push(second.socket)

    await rejection
    expect(server.getStatus().connected).toBe(true)
  })

  test("times out unanswered requests and sends cancellation", async () => {
    const { server, port, secret } = await makeServer()
    const client = await connectClient({ port, secret })
    sockets.push(client.socket)

    await expect(server.request("page.getVisibleText", {}, { timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.requests.some((frame) => frame.type === "cancel")).toBe(true)
  })

  test("reports a port conflict without leaving partial server state", async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
    const address = occupied.address()
    if (!address || typeof address === "string") throw new Error("Unable to occupy test port")

    const directory = await mkdtemp(join(tmpdir(), "pi-chrome-conflict-"))
    const store = new BridgeConfigStore(join(directory, "config.json"))
    await store.save({ port: address.port })
    const conflicting = new BridgeServer(store)
    servers.push(conflicting)

    await expect(conflicting.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
    expect(conflicting.getStatus().listening).toBe(false)
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    )
  })

  test("persists browser-initiated revocation before acknowledging with close", async () => {
    const { server, store, port, secret } = await makeServer()
    const client = await connectClient({ port, secret })
    sockets.push(client.socket)
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString("utf8") }),
      )
    })

    client.socket.send(
      serializeProtocolFrame({ type: "event", name: "pairing.revoke", payload: {} }),
    )

    await expect(closed).resolves.toEqual({ code: 1000, reason: "Pairing revoked" })
    expect(server.getStatus()).toMatchObject({ connected: false, paired: false })
    await expect(store.load()).resolves.toEqual({ port })
  })

  test("stops idempotently and releases the port for reload", async () => {
    const { server, port } = await makeServer()
    await server.stop()
    await server.stop()

    const directory = await mkdtemp(join(tmpdir(), "pi-chrome-reload-"))
    const store = new BridgeConfigStore(join(directory, "config.json"))
    await store.save({ port })
    const replacement = new BridgeServer(store)
    servers.push(replacement)
    await expect(replacement.start()).resolves.toBeUndefined()
  })
})
