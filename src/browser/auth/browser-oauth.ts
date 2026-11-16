import type { Provider } from "@earendil-works/pi-ai"
import { hasApprovedHostPermission } from "../permissions.js"
import { boundedResponse } from "../runtime/bounded-response.js"
import { ANTHROPIC_OAUTH_ORIGINS, createBrowserAnthropicOAuth } from "./anthropic-oauth.js"
import { AUTH_ORIGINS } from "./codex-oauth.js"
import {
  createBrowserGitHubCopilotOAuth,
  GITHUB_COPILOT_OAUTH_ORIGINS,
} from "./github-copilot-oauth.js"
import { createBrowserKimiOAuth, KIMI_OAUTH_ORIGINS } from "./kimi-oauth.js"
import { createBrowserOpenRouterOAuth, OPENROUTER_OAUTH_ORIGINS } from "./openrouter-oauth.js"
import { createBrowserRadiusOAuth, RADIUS_OAUTH_ORIGINS } from "./radius-oauth.js"
import { createBrowserXaiOAuth, XAI_OAUTH_ORIGINS } from "./xai-oauth.js"

const adapters = {
  anthropic: [createBrowserAnthropicOAuth, ANTHROPIC_OAUTH_ORIGINS],
  "github-copilot": [createBrowserGitHubCopilotOAuth, GITHUB_COPILOT_OAUTH_ORIGINS],
  "kimi-coding": [createBrowserKimiOAuth, KIMI_OAUTH_ORIGINS],
  openrouter: [createBrowserOpenRouterOAuth, OPENROUTER_OAUTH_ORIGINS],
  radius: [createBrowserRadiusOAuth, RADIUS_OAUTH_ORIGINS],
  xai: [createBrowserXaiOAuth, XAI_OAUTH_ORIGINS],
} as const

export function browserOAuthOrigins(providerId: string): readonly string[] {
  if (providerId === "openai-codex") return AUTH_ORIGINS
  return Object.hasOwn(adapters, providerId) ? adapters[providerId as keyof typeof adapters][1] : []
}

export function browserOAuth(providerId: string): Provider["auth"]["oauth"] {
  if (!Object.hasOwn(adapters, providerId)) return undefined
  const [create, origins] = adapters[providerId as keyof typeof adapters]
  return create({
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !origins.some(
          (origin) => !origin.includes("*.") && new URL(origin).origin === url.origin,
        ) ||
        !(await hasApprovedHostPermission(url))
      ) {
        throw new Error("Account endpoint permission is required")
      }
      return boundedResponse(
        await fetch(url, {
          ...init,
          credentials: "omit",
          redirect: "error",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        }),
        524_288,
      )
    },
  }) as Provider["auth"]["oauth"]
}
