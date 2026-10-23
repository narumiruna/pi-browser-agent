import { describe, expect, test } from "vitest"
import {
  actionDiagnostics,
  contextUnavailableError,
} from "../../src/browser/runtime/action-diagnostics.js"
import type { RuntimeRequest } from "../../src/browser/runtime/messages.js"

describe("page-context diagnostics", () => {
  test("records only safe resolution metadata", () => {
    const context = {
      tabId: 7,
      epoch: 3,
      url: "https://user:password@example.test/private?token=secret#private",
    }
    const request: RuntimeRequest = {
      kind: "request",
      requestId: "request-1",
      method: "page.type",
      params: { selector: "#private-control", text: "private-form-text" },
      tabContext: context,
    }
    const diagnostics = actionDiagnostics(request, "dispatch", "available", context, 4)
    expect(diagnostics).toEqual({
      requestId: "request-1",
      toolName: "page.type",
      targetResolutionSource: "request_context",
      contextState: "available",
      actionStage: "dispatch",
      expected: { tabId: 7, documentEpoch: 3 },
      tabId: 7,
      documentEpoch: 3,
      windowId: 4,
    })
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private|password|secret|https|selector|form-text/,
    )
  })

  test.each([
    ["none", "missing", "TAB_NOT_BOUND"],
    ["restricted", "unsupported_url", "UNSUPPORTED_URL"],
    ["file", "unsupported_url", "UNSUPPORTED_URL"],
    ["pdf", "unsupported_url", "UNSUPPORTED_URL"],
    ["restricted", "permission_denied", "PERMISSION_DENIED"],
  ] as const)("distinguishes %s with %s", (kind, state, code) => {
    expect(contextUnavailableError(kind, state)).toMatchObject({ code })
    expect(contextUnavailableError(kind, state).message).not.toBe(
      "Open an HTTP or HTTPS page before using browser tools",
    )
  })
})
