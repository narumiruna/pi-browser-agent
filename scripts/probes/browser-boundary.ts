import { Agent } from "@earendil-works/pi-agent-core"
import { createModels } from "@earendil-works/pi-ai"
import { stream as streamCodexSse } from "@earendil-works/pi-ai/api/openai-codex-responses"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createBrowserProviders } from "../../src/browser/auth/provider.js"
import { McpManager } from "../../src/browser/mcp/manager.js"

// This file is bundled independently by scripts/probe-browser-boundary.mjs. It proves that the
// agent, browser provider registry, and concrete Codex SSE path stay inside the browser boundary.
export const browserBoundary = {
  Client,
  StreamableHTTPClientTransport,
  McpManager,
  Agent,
  createModels,
  createBrowserProviders,
  openaiCodexProvider,
  streamCodexSse,
}
