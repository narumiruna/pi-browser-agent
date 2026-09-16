import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import WebSocket, { type RawData, WebSocketServer } from "ws"
import {
  BridgeError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type EventFrame,
  MAX_FRAME_BYTES,
  MAX_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseProtocolFrame,
  type RequestFrame,
  type ResponseFrame,
  serializeProtocolFrame,
  type TabContext,
  toBridgeError,
} from "../protocol/index.js"
import {
  createChallenge,
  parseExtensionOrigin,
  toChallengeFrame,
  verifyAuthenticationProof,
} from "./authentication.js"
import { type BridgeConfig, BridgeConfigStore } from "./config.js"

interface PendingRequest {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout>
  socket: WebSocket
  abortCleanup?: () => void
}

interface ConnectionState {
  socket: WebSocket
  extensionId: string
  origin: string
  authenticated: boolean
  challenge: ReturnType<typeof createChallenge>
  clientId?: string
  extensionVersion?: string
  tabContext?: TabContext
  authenticationTimeout?: ReturnType<typeof setTimeout>
}

export interface BridgeServerStatus {
  listening: boolean
  port: number
  paired: boolean
  connected: boolean
  extensionId?: string
  extensionVersion?: string
  tabContext?: TabContext
}

export interface BridgeRequestOptions {
  confirmed?: boolean
  signal?: AbortSignal
  tabContext?: TabContext
  timeoutMs?: number
}

export class BridgeServer {
  private httpServer?: Server
  private webSocketServer?: WebSocketServer
  private config: BridgeConfig = { port: 17_373 }
  private active?: ConnectionState
  private readonly connections = new Set<ConnectionState>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: EventFrame) => void>()
  private readonly statusListeners = new Set<(status: BridgeServerStatus) => void>()

  constructor(private readonly configStore = new BridgeConfigStore()) {}

  async start(): Promise<void> {
    if (this.httpServer) return
    this.config = await this.configStore.load()

    const httpServer = createServer((_request, response) => {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      })
      response.end("Pi Chrome Bridge accepts authenticated WebSocket connections only.\n")
    })
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    this.httpServer = httpServer
    this.webSocketServer = webSocketServer

    httpServer.on("upgrade", (request, socket, head) => {
      try {
        const { extensionId } = parseExtensionOrigin(request.headers.origin)
        if (this.config.allowedExtensionId && this.config.allowedExtensionId !== extensionId) {
          throw new BridgeError(
            "AUTHENTICATION_FAILED",
            "This pi bridge is paired with another Chrome extension",
          )
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request)
        })
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
        socket.destroy()
      }
    })

    webSocketServer.on("connection", (socket, request) => {
      const { extensionId, origin } = parseExtensionOrigin(request.headers.origin)
      const challenge = createChallenge()
      const state: ConnectionState = {
        socket,
        extensionId,
        origin,
        authenticated: false,
        challenge,
      }
      state.authenticationTimeout = setTimeout(
        () => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1008, "Authentication timed out")
        },
        Math.max(1, challenge.expiresAt - Date.now()),
      )
      this.connections.add(state)
      this.send(socket, toChallengeFrame(state.challenge))

      socket.on("message", (data) => {
        void this.handleMessage(state, data)
      })
      socket.on("close", () => this.removeConnection(state))
      socket.on("error", () => this.removeConnection(state))
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        httpServer.off("error", onError)
        resolve()
      }
      httpServer.once("error", onError)
      httpServer.once("listening", onListening)
      httpServer.listen(this.config.port, "127.0.0.1")
    }).catch(async (error) => {
      await this.stop()
      throw error
    })
    this.emitStatus()
  }

  async stop(): Promise<void> {
    const httpServer = this.httpServer
    const webSocketServer = this.webSocketServer
    this.httpServer = undefined
    this.webSocketServer = undefined
    this.active = undefined

    for (const connection of this.connections) {
      if (connection.authenticationTimeout) clearTimeout(connection.authenticationTimeout)
      connection.socket.terminate()
    }
    this.connections.clear()
    this.rejectAllPending(new BridgeError("CONNECTION_CLOSED", "Pi bridge stopped"))

    if (webSocketServer) {
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
    }
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
    }
    this.emitStatus()
  }

  async createPairing(): Promise<{ secret: string; port: number }> {
    const { config, secret } = await this.configStore.createPairing()
    this.config = config
    this.disconnectActive("Pairing rotated")
    this.emitStatus()
    return { secret, port: config.port }
  }

  async revoke(): Promise<void> {
    this.config = await this.configStore.revoke()
    this.disconnectActive("Pairing revoked")
    this.emitStatus()
  }

  getStatus(): BridgeServerStatus {
    const address = this.httpServer?.address() as AddressInfo | null | undefined
    return {
      listening: Boolean(this.httpServer?.listening),
      port: address?.port ?? this.config.port,
      paired: Boolean(this.config.secret),
      connected: Boolean(this.active?.authenticated),
      ...(this.active?.extensionId ? { extensionId: this.active.extensionId } : {}),
      ...(this.active?.extensionVersion ? { extensionVersion: this.active.extensionVersion } : {}),
      ...(this.active?.tabContext ? { tabContext: this.active.tabContext } : {}),
    }
  }

  onEvent(listener: (event: EventFrame) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStatus(listener: (status: BridgeServerStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.getStatus())
    return () => this.statusListeners.delete(listener)
  }

  async request(
    method: string,
    params: Record<string, never> | Record<string, unknown>,
    options: BridgeRequestOptions = {},
  ): Promise<unknown> {
    const connection = this.active
    if (!connection?.authenticated || connection.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError("NOT_CONNECTED", "Pair and connect the Chrome extension first")
    }
    if (options.signal?.aborted) {
      throw new BridgeError("REQUEST_CANCELLED", "Browser request was cancelled")
    }

    const id = randomUUID()
    const timeoutMs = Math.min(
      MAX_REQUEST_TIMEOUT_MS,
      Math.max(1, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    )
    const request: RequestFrame = {
      type: "request",
      id,
      method,
      params: params as RequestFrame["params"],
      timeoutMs,
      ...((options.tabContext ?? connection.tabContext)
        ? { tabContext: options.tabContext ?? connection.tabContext }
        : {}),
      ...(options.confirmed ? { confirmed: true } : {}),
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        this.send(connection.socket, { type: "cancel", id })
        reject(new BridgeError("REQUEST_TIMEOUT", `Browser request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const pending: PendingRequest = { resolve, reject, timeout, socket: connection.socket }

      if (options.signal) {
        const onAbort = () => {
          this.pending.delete(id)
          clearTimeout(timeout)
          this.send(connection.socket, { type: "cancel", id })
          reject(new BridgeError("REQUEST_CANCELLED", "Browser request was cancelled"))
        }
        options.signal.addEventListener("abort", onAbort, { once: true })
        pending.abortCleanup = () => options.signal?.removeEventListener("abort", onAbort)
      }

      this.pending.set(id, pending)
      try {
        this.send(connection.socket, request)
      } catch (error) {
        this.finishPending(id)
        reject(error)
      }
    })
  }

  private async handleMessage(connection: ConnectionState, data: RawData): Promise<void> {
    try {
      const frame = parseProtocolFrame(data.toString("utf8"))
      if (frame.type === "hello") {
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          throw new BridgeError(
            "UNSUPPORTED_PROTOCOL",
            `Expected protocol ${PROTOCOL_VERSION}, received ${frame.protocolVersion}`,
          )
        }
        connection.clientId = frame.clientId
        connection.extensionVersion = frame.extensionVersion
        return
      }
      if (frame.type === "auth.response") {
        await this.authenticate(connection, frame.challengeId, frame.proof)
        return
      }
      if (!connection.authenticated) {
        throw new BridgeError("AUTHENTICATION_REQUIRED", "Authenticate before sending messages")
      }

      switch (frame.type) {
        case "response":
          this.handleResponse(connection, frame)
          return
        case "event":
          if (frame.name === "pairing.revoke") {
            await this.revoke()
            return
          }
          if (frame.tabContext) connection.tabContext = frame.tabContext
          for (const listener of this.eventListeners) listener(frame)
          this.emitStatus()
          return
        case "ping":
          this.send(connection.socket, { type: "pong", timestamp: frame.timestamp })
          return
        case "pong":
        case "cancel":
        case "request":
        case "auth.challenge":
        case "auth.result":
          return
      }
    } catch (error) {
      const bridgeError = toBridgeError(error)
      if (!connection.authenticated && connection.socket.readyState === WebSocket.OPEN) {
        this.send(connection.socket, {
          type: "auth.result",
          success: false,
          error: bridgeError.toData(),
        })
      }
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.close(1008, bridgeError.message.slice(0, 120))
      }
    }
  }

  private async authenticate(
    connection: ConnectionState,
    challengeId: string,
    proof: string,
  ): Promise<void> {
    if (!connection.clientId) {
      throw new BridgeError("AUTHENTICATION_FAILED", "Send hello before authentication")
    }
    if (!this.config.secret) {
      throw new BridgeError("AUTHENTICATION_FAILED", "Run /chrome-pair in pi first")
    }
    if (
      this.config.allowedExtensionId &&
      this.config.allowedExtensionId !== connection.extensionId
    ) {
      throw new BridgeError("AUTHENTICATION_FAILED", "Chrome extension id is not paired")
    }
    verifyAuthenticationProof({
      challenge: connection.challenge,
      challengeId,
      clientId: connection.clientId,
      origin: connection.origin,
      proof,
      secret: this.config.secret,
    })

    if (!this.config.allowedExtensionId) {
      this.config = await this.configStore.bindExtension(connection.extensionId)
    }
    if (this.active && this.active !== connection) {
      this.disconnectActive("Replaced by a new authenticated connection")
    }
    connection.authenticated = true
    if (connection.authenticationTimeout) clearTimeout(connection.authenticationTimeout)
    connection.authenticationTimeout = undefined
    this.active = connection
    this.send(connection.socket, { type: "auth.result", success: true })
    this.emitStatus()
  }

  private handleResponse(connection: ConnectionState, response: ResponseFrame): void {
    const pending = this.pending.get(response.id)
    if (!pending || pending.socket !== connection.socket) return
    this.finishPending(response.id)
    if (response.error) {
      pending.reject(
        new BridgeError(response.error.code, response.error.message, response.error.details),
      )
    } else {
      pending.resolve(response.result)
    }
  }

  private finishPending(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pending.abortCleanup?.()
    this.pending.delete(id)
  }

  private send(socket: WebSocket, frame: Parameters<typeof serializeProtocolFrame>[0]): void {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError("CONNECTION_CLOSED", "Chrome bridge connection is closed")
    }
    socket.send(serializeProtocolFrame(frame))
  }

  private removeConnection(connection: ConnectionState): void {
    if (connection.authenticationTimeout) clearTimeout(connection.authenticationTimeout)
    connection.authenticationTimeout = undefined
    this.connections.delete(connection)
    if (this.active === connection) {
      this.active = undefined
      for (const [id, pending] of this.pending) {
        if (pending.socket !== connection.socket) continue
        this.finishPending(id)
        pending.reject(new BridgeError("CONNECTION_CLOSED", "Chrome bridge connection closed"))
      }
      this.emitStatus()
    }
  }

  private disconnectActive(reason: string): void {
    this.active?.socket.close(1000, reason)
    this.active = undefined
    this.rejectAllPending(new BridgeError("CONNECTION_CLOSED", reason))
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.finishPending(id)
      pending.reject(error)
    }
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.statusListeners) listener(status)
  }
}
