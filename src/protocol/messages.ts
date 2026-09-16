import type { BridgeCapability } from "./capabilities.js"
import type { BridgeErrorData } from "./errors.js"

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface TabContext {
  tabId: number
  url: string
  epoch: number
}

export interface HelloFrame {
  type: "hello"
  protocolVersion: number
  clientId: string
  extensionVersion: string
  capabilities: BridgeCapability[]
}

export interface AuthChallengeFrame {
  type: "auth.challenge"
  challengeId: string
  nonce: string
  expiresAt: number
}

export interface AuthResponseFrame {
  type: "auth.response"
  challengeId: string
  proof: string
}

export interface AuthResultFrame {
  type: "auth.result"
  success: boolean
  error?: BridgeErrorData
}

export interface RequestFrame {
  type: "request"
  id: string
  method: string
  params: JsonObject
  timeoutMs: number
  tabContext?: TabContext
  confirmed?: boolean
}

export interface ResponseFrame {
  type: "response"
  id: string
  result?: JsonValue
  error?: BridgeErrorData
}

export interface EventFrame {
  type: "event"
  name: string
  payload: JsonObject
  tabContext?: TabContext
}

export interface CancelFrame {
  type: "cancel"
  id: string
}

export interface PingFrame {
  type: "ping"
  timestamp: number
}

export interface PongFrame {
  type: "pong"
  timestamp: number
}

export type ProtocolFrame =
  | AuthChallengeFrame
  | AuthResponseFrame
  | AuthResultFrame
  | CancelFrame
  | EventFrame
  | HelloFrame
  | PingFrame
  | PongFrame
  | RequestFrame
  | ResponseFrame

export const BRIDGE_METHODS = [
  "browser.getConnectionState",
  "tabs.getActive",
  "tabs.navigate",
  "page.getVisibleText",
  "page.getSelection",
  "page.captureVisible",
  "page.click",
  "page.type",
  "webmcp.listTools",
  "webmcp.callTool",
] as const

export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === "string" && BRIDGE_METHODS.includes(value as BridgeMethod)
}
