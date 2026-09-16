import { Agent } from "@earendil-works/pi-agent-core"
import { createModels } from "@earendil-works/pi-ai"
import { stream as streamCodexSse } from "@earendil-works/pi-ai/api/openai-codex-responses"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"

// This file is bundled independently by scripts/probe-browser-boundary.mjs. It proves that the
// selected agent, provider factory, and concrete Codex SSE path stay inside the browser boundary.
export const browserBoundary = { Agent, createModels, openaiCodexProvider, streamCodexSse }
