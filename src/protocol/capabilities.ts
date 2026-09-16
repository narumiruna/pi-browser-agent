export const BRIDGE_CAPABILITIES = [
  "tabs.read",
  "tabs.navigate",
  "page.read",
  "page.screenshot",
  "page.interact",
  "page.webmcp",
  "pi.prompt",
] as const

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number]

export function isBridgeCapability(value: unknown): value is BridgeCapability {
  return typeof value === "string" && BRIDGE_CAPABILITIES.includes(value as BridgeCapability)
}
