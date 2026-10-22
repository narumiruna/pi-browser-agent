import { afterEach, describe, expect, test, vi } from "vitest"
import { BROWSER_TOOL_OPTIONS, createBrowserTools } from "../../src/browser/agent/browser-tools.js"
import { ConfirmationPolicy } from "../../src/browser/agent/confirmation-policy.js"
import { CONFIRMATION_MODES } from "../../src/browser/storage.js"

const tabContext = { tabId: 1, url: "https://example.test/", epoch: 1 }
const reference = { snapshotId: "11111111-1111-1111-1111-111111111111", ref: "e1" }

function toolNamed(name: string, tools = createBrowserTools(vi.fn())) {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return tool
}

afterEach(() => vi.unstubAllGlobals())

describe("browser action tool execution", () => {
  test.each([
    [
      "browser_list_elements",
      "page.listElements",
      { role: "checkbox", type: "checkbox", name: "Accept", offset: 50 },
    ],
    ["browser_find_text", "page.findText", { query: "Ready", selector: "main", offset: 42 }],
    ["browser_wait_for", "page.waitFor", { selector: "#ready", state: "visible", timeoutMs: 3000 }],
    ["browser_wait_for", "page.waitFor", { text: "Ready" }],
    ["browser_set_checked", "page.setChecked", { ...reference, checked: true }],
    ["browser_get_select_options", "page.getSelectOptions", { ...reference, offset: 50 }],
  ] as const)("%s forwards exact parameters and wraps page data", async (name, method, params) => {
    const result = { marker: "untrusted page data" }
    const sendMessage = vi.fn(async (request: { method: string }) => ({
      ok: true,
      result: request.method === "app.getState" ? { tabContext } : result,
    }))
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const confirm = vi.fn()
    const tool = toolNamed(name, createBrowserTools(confirm))
    const response = await tool.execute("id", params, undefined)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ method, params, tabContext }),
    )
    expect(response.details).toEqual(result)
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Untrusted browser"),
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(tool).toMatchObject({
      executionMode: "sequential",
      replay: name === "browser_set_checked" ? "never" : "safe",
    })
    expect(BROWSER_TOOL_OPTIONS.find((item) => item.name === name)).toMatchObject({
      name,
      description: tool.description,
    })
  })

  test.each(CONFIRMATION_MODES)(
    "checked-state changes need fresh consent in %s mode",
    async (mode) => {
      const sendMessage = vi.fn(async (request: { method: string; confirmed?: boolean }) => {
        if (request.method === "app.getState") return { ok: true, result: { tabContext } }
        if (!request.confirmed)
          return {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED",
              message: "Activate checkbox?",
              details: { ...reference, checked: true },
            },
          }
        return { ok: true, result: { changed: true, checked: true } }
      })
      // Storage is deliberately unavailable: this operation must not cache approval.
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const show = vi.fn().mockResolvedValue(true)
      const policy = new ConfirmationPolicy(() => mode, show)
      const confirm = vi.fn(policy.confirm.bind(policy))
      const tool = toolNamed("browser_set_checked", createBrowserTools(confirm))
      const params = { ...reference, checked: true }
      await tool.execute("first", params, undefined)
      // The mock returns a new challenge each time; real reference freshness is worker-owned.
      await tool.execute("second", params, undefined)
      expect(show).toHaveBeenCalledTimes(2)
      for (const args of confirm.mock.calls) expect(args).toHaveLength(3)
      expect(show).toHaveBeenLastCalledWith("Activate checkbox?", params, undefined)
      expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: "page.setChecked",
          params,
          confirmed: true,
          tabContext,
        }),
      )
    },
  )

  test.each(CONFIRMATION_MODES)(
    "checked-state denial does not activate in %s mode",
    async (mode) => {
      const sendMessage = vi.fn(async (request: { method: string }) =>
        request.method === "app.getState"
          ? { ok: true, result: { tabContext } }
          : { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Activate?" } },
      )
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const show = vi.fn().mockResolvedValue(false)
      const policy = new ConfirmationPolicy(() => mode, show)
      const tool = toolNamed("browser_set_checked", createBrowserTools(policy.confirm.bind(policy)))
      await expect(
        tool.execute("id", { ...reference, checked: true }, undefined),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
      expect(show).toHaveBeenCalledOnce()
      expect(sendMessage).toHaveBeenCalledTimes(2)
      expect(sendMessage.mock.calls.some(([request]) => "confirmed" in request)).toBe(false)
    },
  )

  test.each(CONFIRMATION_MODES)(
    "checked-state no-op does not ask for consent in %s mode",
    async (mode) => {
      const sendMessage = vi.fn(async (request: { method: string }) => ({
        ok: true,
        result:
          request.method === "app.getState" ? { tabContext } : { changed: false, checked: true },
      }))
      vi.stubGlobal("chrome", { runtime: { sendMessage } })
      const show = vi.fn()
      const policy = new ConfirmationPolicy(() => mode, show)
      const tool = toolNamed("browser_set_checked", createBrowserTools(policy.confirm.bind(policy)))
      expect(
        (await tool.execute("id", { ...reference, checked: true }, undefined)).details,
      ).toEqual({ changed: false, checked: true })
      expect(show).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledTimes(2)
    },
  )

  test("does not retry a failed confirmed checked-state operation", async () => {
    const sendMessage = vi.fn(async (request: { method: string; confirmed?: boolean }) => {
      if (request.method === "app.getState") return { ok: true, result: { tabContext } }
      return {
        ok: false,
        error: {
          code: request.confirmed ? "STALE_CONTEXT" : "CONFIRMATION_REQUIRED",
          message: "Target changed",
        },
      }
    })
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const confirm = vi.fn().mockResolvedValue(true)
    const tool = toolNamed("browser_set_checked", createBrowserTools(confirm))
    await expect(
      tool.execute("id", { ...reference, checked: true }, undefined),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" })
    expect(confirm).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(tool.replay).toBe("never")
  })

  test("cancellation during checked-state confirmation prevents activation", async () => {
    const controller = new AbortController()
    const sendMessage = vi.fn(async (request: { method: string }) =>
      request.method === "app.getState"
        ? { ok: true, result: { tabContext } }
        : { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "Activate?" } },
    )
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const tool = toolNamed(
      "browser_set_checked",
      createBrowserTools(async () => {
        controller.abort()
        return true
      }),
    )
    await expect(
      tool.execute("id", { ...reference, checked: true }, controller.signal),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  test("reports wait timeout without an action confirmation or retry", async () => {
    const sendMessage = vi.fn(async (request: { method: string }) =>
      request.method === "app.getState"
        ? { ok: true, result: { tabContext } }
        : { ok: false, error: { code: "TIMEOUT", message: "Condition was not observed" } },
    )
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    const confirm = vi.fn()
    await expect(
      toolNamed("browser_wait_for", createBrowserTools(confirm)).execute(
        "id",
        { text: "Ready" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" })
    expect(confirm).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  test.each([
    "browser_find_text",
    "browser_wait_for",
    "browser_set_checked",
    "browser_get_select_options",
  ])("%s cannot access a page in a no-page turn", async (name) => {
    const sendMessage = vi.fn()
    vi.stubGlobal("chrome", { runtime: { sendMessage } })
    await expect(
      toolNamed(
        name,
        createBrowserTools(vi.fn(), () => false),
      ).execute("id", {}, undefined),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
