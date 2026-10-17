export const MCP_LIMITS = {
  servers: 8,
  tools: 32,
  pages: 4,
  schemaBytes: 16 * 1024,
  schemaDepth: 8,
  declarationBytes: 64 * 1024,
  requestBytes: 16 * 1024,
  responseBytes: 256 * 1024,
  resultBytes: 48 * 1024,
  timeoutMs: 15_000,
} as const

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
    .byteLength
}

export function mcpEndpoint(value: string): string {
  if (value.length > 2048) throw new Error("MCP endpoint is too long")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Enter a public HTTPS MCP endpoint")
  }
  const host = url.hostname
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("#") ||
    url.href.includes("?") ||
    host.length > 253 ||
    !host.includes(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[\d.]+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host) ||
    /(?:^|\.)(?:localhost|localdomain|home\.arpa)$/.test(host)
  ) {
    throw new Error("Use a public HTTPS hostname without credentials, query, or fragment")
  }
  return url.href
}

export const MCP_FAILURE =
  "MCP request failed or was interrupted. Remote execution may be unknown. Review the server before making a new call; no call was retried."
