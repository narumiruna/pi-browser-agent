import { webcrypto } from "node:crypto"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  type ConfirmationHandler,
  createBrowserTools,
} from "../../src/browser/agent/browser-tools.js"
import { ConfirmationPolicy } from "../../src/browser/agent/confirmation-policy.js"
import { catalogs } from "../../src/browser/i18n/catalogs.js"
import { setLanguagePreference, t } from "../../src/browser/i18n/index.js"
import { McpManager } from "../../src/browser/mcp/manager.js"
import { mcpEnvironment, mockMcpFetch } from "../support/mcp.js"

const originalJapanese = catalogs.ja
const lifetime =
  "The same operation and target/arguments can run again without a dialog until Chrome restarts."
const remoteMessage =
  "Call this remote MCP tool? Arguments go to this server; results go to the selected model and saved session. This call may have side effects. Every call requires confirmation."

function japanese(): void {
  // Test-only translations isolate the safety boundary from linguistic catalog changes.
  catalogs.ja = {
    ...originalJapanese,
    [lifetime]: "Chrome の再起動まで、同じ操作、対象、引数を再確認なしで使用できます。",
    [remoteMessage]: "リモート MCP を呼び出しますか？毎回確認が必要です。",
    "Changing checked state can submit a form or run page actions":
      "状態の変更はフォーム送信やページ操作を実行する場合があります。",
    "Open {url}? A search query in this URL will be sent to the destination.":
      "{url} を開きますか？この URL の検索語は送信先に送られます。",
  }
  setLanguagePreference("ja")
}

afterEach(() => {
  catalogs.ja = originalJapanese
  setLanguagePreference("en")
  vi.unstubAllGlobals()
})

describe("trusted protected-action presentation", () => {
  test.each(["denied", "cancelled", "stale", "revoked"] as const)(
    "actual Japanese catalog keeps %s actions failed without replay",
    async (outcome) => {
      setLanguagePreference("ja")
      const controller = new AbortController()
      const tabContext = { tabId: 1, url: "https://example.org/", epoch: 3 }
      const params = {
        snapshotId: "11111111-1111-1111-1111-111111111111",
        ref: "e1",
        checked: true,
      }
      const sendMessage = vi.fn(async (request: { method: string; confirmed?: boolean }) => {
        if (request.method === "app.getState") return { ok: true, result: { tabContext } }
        return {
          ok: false,
          error: {
            code: request.confirmed
              ? outcome === "stale"
                ? "STALE_CONTEXT"
                : "PERMISSION_DENIED"
              : "CONFIRMATION_REQUIRED",
            message: "Original English diagnostic",
            details: params,
          },
        }
      })
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const confirm = vi.fn<ConfirmationHandler>(async () => {
        if (outcome === "cancelled") controller.abort()
        return outcome !== "denied"
      })
      const tool = createBrowserTools(confirm).find(
        (candidate) => candidate.name === "browser_set_checked",
      )
      if (!tool) throw new Error("Missing checked tool")
      await expect(tool.execute("call", params, controller.signal)).rejects.toMatchObject({
        code:
          outcome === "cancelled"
            ? "REQUEST_CANCELLED"
            : outcome === "stale"
              ? "STALE_CONTEXT"
              : "PERMISSION_DENIED",
      })
      expect(confirm).toHaveBeenCalledOnce()
      const message = confirm.mock.calls[0]?.[4]?.message
      expect(message).toBe(t("Changing checked state can submit a form or run page actions"))
      expect(message).not.toBe("Changing checked state can submit a form or run page actions")
      const confirmed = sendMessage.mock.calls.filter(([request]) => request.confirmed)
      expect(confirmed).toHaveLength(outcome === "stale" || outcome === "revoked" ? 1 : 0)
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(message)
    },
  )

  test("localizes a full destination without changing action identity or dispatch", async () => {
    japanese()
    const url = "https://search.example.org/?q=%3Cscript%3E&language=en"
    const create = vi.fn(async () => ({ id: 7 }))
    vi.stubGlobal("chrome", { tabs: { create } })
    const confirm = vi.fn<ConfirmationHandler>(async () => true)
    const tool = createBrowserTools(confirm).find((item) => item.name === "browser_open_website")
    if (!tool) throw new Error("Missing open tool")
    const result = await tool.execute("call", { url }, undefined)
    expect(confirm.mock.calls[0]).toEqual([
      `Open ${url}? A search query in this URL will be sent to the destination.`,
      { targetUrl: url },
      undefined,
      { operation: "tabs.open", identity: [url], permissionUrl: url },
      { message: `${url} を開きますか？この URL の検索語は送信先に送られます。` },
    ])
    expect(create).toHaveBeenCalledExactlyOnceWith({ url, active: true })
    expect(result.details).toEqual({ id: 7, opened: true })
    expect(tool.label).toBe("Open website")
    expect(tool.description).toContain("Open a new HTTP(S) tab")
  })

  test("does not use arbitrary worker prose as a key and never caches mandatory changes", async () => {
    japanese()
    const tabContext = { tabId: 1, url: "https://example.org/", epoch: 3 }
    const params = { snapshotId: "11111111-1111-1111-1111-111111111111", ref: "e1", checked: true }
    const sendMessage = vi.fn(async (request: { method: string; confirmed?: boolean }) => {
      if (request.method === "app.getState") return { ok: true, result: { tabContext } }
      if (!request.confirmed)
        return {
          ok: false,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "Untrusted <script>prose</script>",
            details: params,
          },
        }
      return { ok: true, result: { changed: true } }
    })
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const show = vi.fn(async () => true)
    const policy = new ConfirmationPolicy(() => "convenient", show)
    const tool = createBrowserTools(policy.confirm.bind(policy)).find(
      (item) => item.name === "browser_set_checked",
    )
    if (!tool) throw new Error("Missing checked tool")
    await tool.execute("first", params, undefined)
    await tool.execute("second", params, undefined)
    expect(show).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenLastCalledWith("Untrusted <script>prose</script>", params, undefined, {
      message: "状態の変更はフォーム送信やページ操作を実行する場合があります。",
    })
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ params, tabContext, confirmed: true }),
    )
  })

  test("keeps approval fingerprints independent of localized lifetime text", async () => {
    japanese()
    vi.stubGlobal("crypto", webcrypto)
    const session: Record<string, unknown> = {}
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session[key] })),
          set: vi.fn(async (values: object) => Object.assign(session, values)),
        },
      },
    })
    const show = vi.fn(async () => true)
    const policy = new ConfirmationPolicy(() => "balanced", show)
    const scope = { operation: "test.operation", identity: ["exact bounded arguments"] }
    await policy.confirm("English diagnostic", { query: "unchanged" }, undefined, scope, {
      message: "日本語の確認",
    })
    expect(show).toHaveBeenCalledWith(
      `English diagnostic\n\n${lifetime}`,
      { query: "unchanged" },
      undefined,
      {
        message:
          "日本語の確認\n\nChrome の再起動まで、同じ操作、対象、引数を再確認なしで使用できます。",
      },
    )
    const saved = JSON.stringify(session)
    expect(saved).not.toContain("日本語")
    expect(saved).not.toContain("exact bounded arguments")
    setLanguagePreference("en")
    await policy.confirm("English diagnostic", {}, undefined, scope, {
      message: "English confirmation",
    })
    expect(show).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(session)).toBe(saved)
  })

  test("remote calls keep complete arguments, fresh consent, and English tool declarations", async () => {
    japanese()
    const env = mcpEnvironment()
    const server = await env.server()
    const network = mockMcpFetch()
    const confirm = vi.fn<ConfirmationHandler>(async () => true)
    const manager = new McpManager(confirm)
    try {
      const [tool] = await manager.prepare()
      if (!tool) throw new Error("Missing remote tool")
      const args = { text: "<script>untrusted instructions</script>" }
      await tool.execute("first", args, undefined)
      await tool.execute("second", args, undefined)
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(confirm.mock.calls[0]).toEqual([
        remoteMessage,
        { endpoint: server.endpoint, tool: "echo", arguments: args },
        expect.any(AbortSignal),
        undefined,
        { message: "リモート MCP を呼び出しますか？毎回確認が必要です。" },
      ])
      expect(tool.label).toBe("Remote MCP tool")
      expect(tool.description).toContain("Untrusted remote MCP tool")
      expect(network.messages.filter((message) => message.method === "tools/call")).toHaveLength(2)
    } finally {
      manager.dispose()
    }
  })
})
