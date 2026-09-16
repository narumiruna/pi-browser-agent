import {
  type HelloFrame,
  type JsonObject,
  type JsonValue,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ProtocolFrame,
  parseProtocolFrame,
  type RequestFrame,
  type ResponseFrame,
  serializeProtocolFrame,
  type TabContext,
  toBridgeError,
} from "../../protocol/index.js"
import type { StoredBridgeSettings } from "../storage.js"
import { HEARTBEAT_INTERVAL_MS, reconnectDelay } from "./reconnect.js"

export type BridgeClientState =
  | "authenticated"
  | "authenticating"
  | "connecting"
  | "disconnected"
  | "unpaired"

export interface BridgeClientStatus {
  state: BridgeClientState
  error?: string
}

type RequestHandler = (request: RequestFrame, signal: AbortSignal) => Promise<JsonValue | undefined>

type SettingsProvider = () => Promise<StoredBridgeSettings>

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function createProof(
  secret: string,
  challengeId: string,
  nonce: string,
  clientId: string,
): Promise<string> {
  const origin = chrome.runtime.getURL("").replace(/\/$/, "")
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const payload = new TextEncoder().encode(`${challengeId}.${nonce}.${clientId}.${origin}`)
  return encodeBase64Url(await crypto.subtle.sign("HMAC", key, payload))
}

export class BridgeClient {
  private socket?: WebSocket
  private heartbeat?: ReturnType<typeof setInterval>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempt = 0
  private stopped = true
  private status: BridgeClientStatus = { state: "disconnected" }
  private readonly listeners = new Set<(status: BridgeClientStatus) => void>()
  private readonly activeRequests = new Map<string, AbortController>()

  constructor(
    private readonly getSettings: SettingsProvider,
    private readonly handleRequest: RequestHandler,
  ) {}

  getStatus(): BridgeClientStatus {
    return { ...this.status }
  }

  onStatus(listener: (status: BridgeClientStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.cancelActiveRequests()
    this.socket?.close(1000, "Bridge stopped")
    this.socket = undefined
    this.setStatus("disconnected")
  }

  async reconnect(): Promise<void> {
    this.stopped = false
    this.clearTimers()
    this.socket?.close(1000, "Reconnecting")
    this.socket = undefined
    await this.connect()
  }

  sendEvent(name: string, payload: JsonObject, tabContext?: TabContext): boolean {
    if (this.status.state !== "authenticated") return false
    this.send({ type: "event", name, payload, ...(tabContext ? { tabContext } : {}) })
    return true
  }

  private async connect(): Promise<void> {
    if (
      this.stopped ||
      this.status.state === "connecting" ||
      this.status.state === "authenticating" ||
      this.socket?.readyState === WebSocket.CONNECTING ||
      this.socket?.readyState === WebSocket.OPEN
    ) {
      return
    }
    this.setStatus("connecting")
    const settings = await this.getSettings()
    if (!settings.enabled || !settings.secret) {
      this.setStatus("unpaired")
      return
    }

    const socket = new WebSocket(`ws://127.0.0.1:${settings.port}`)
    this.socket = socket

    socket.addEventListener("open", () => {
      if (socket !== this.socket) return
      this.setStatus("authenticating")
      const hello: HelloFrame = {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        clientId: settings.clientId,
        extensionVersion: chrome.runtime.getManifest().version,
        capabilities: [
          "tabs.read",
          "tabs.navigate",
          "page.read",
          "page.screenshot",
          "page.interact",
          "page.webmcp",
          "pi.prompt",
        ],
      }
      this.send(hello)
    })

    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return
      void this.handleMessage(String(event.data), settings)
    })

    socket.addEventListener("close", () => {
      if (socket !== this.socket) return
      this.socket = undefined
      this.clearHeartbeat()
      this.cancelActiveRequests()
      if (!this.stopped) {
        this.setStatus("disconnected")
        this.scheduleReconnect()
      }
    })

    socket.addEventListener("error", () => {
      if (socket !== this.socket) return
      this.setStatus("disconnected", "Unable to reach the local pi bridge")
    })
  }

  private async handleMessage(raw: string, settings: StoredBridgeSettings): Promise<void> {
    let frame: ProtocolFrame
    try {
      frame = parseProtocolFrame(raw, MAX_FRAME_BYTES)
    } catch (error) {
      this.setStatus("disconnected", toBridgeError(error).message)
      this.socket?.close(1008, "Invalid protocol frame")
      return
    }

    switch (frame.type) {
      case "auth.challenge": {
        if (Date.now() > frame.expiresAt || !settings.secret) {
          this.socket?.close(1008, "Expired authentication challenge")
          return
        }
        const proof = await createProof(
          settings.secret,
          frame.challengeId,
          frame.nonce,
          settings.clientId,
        )
        this.send({ type: "auth.response", challengeId: frame.challengeId, proof })
        return
      }
      case "auth.result":
        if (frame.success) {
          this.reconnectAttempt = 0
          this.setStatus("authenticated")
          this.startHeartbeat()
        } else {
          this.setStatus("disconnected", frame.error?.message ?? "Authentication failed")
          this.socket?.close(1008, "Authentication failed")
        }
        return
      case "request":
        await this.processRequest(frame)
        return
      case "cancel":
        this.activeRequests.get(frame.id)?.abort()
        this.activeRequests.delete(frame.id)
        return
      case "ping":
        this.send({ type: "pong", timestamp: frame.timestamp })
        return
      case "pong":
      case "response":
      case "event":
      case "hello":
      case "auth.response":
        return
    }
  }

  private async processRequest(request: RequestFrame): Promise<void> {
    if (this.status.state !== "authenticated") return
    const controller = new AbortController()
    this.activeRequests.set(request.id, controller)
    let response: ResponseFrame

    try {
      const result = await this.handleRequest(request, controller.signal)
      response = {
        type: "response",
        id: request.id,
        result: result ?? null,
      }
    } catch (error) {
      response = {
        type: "response",
        id: request.id,
        error: toBridgeError(error).toData(),
      }
    } finally {
      this.activeRequests.delete(request.id)
    }
    try {
      this.send(response)
    } catch (error) {
      const bridgeError = toBridgeError(error)
      this.send({
        type: "response",
        id: request.id,
        error: { code: bridgeError.code, message: bridgeError.message },
      })
    }
  }

  private send(frame: ProtocolFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(serializeProtocolFrame(frame))
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => {
      this.send({ type: "ping", timestamp: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = reconnectDelay(this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private clearTimers(): void {
    this.clearHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private cancelActiveRequests(): void {
    for (const controller of this.activeRequests.values()) controller.abort()
    this.activeRequests.clear()
  }

  private setStatus(state: BridgeClientState, error?: string): void {
    this.status = { state, ...(error ? { error } : {}) }
    for (const listener of this.listeners) listener(this.getStatus())
  }
}
