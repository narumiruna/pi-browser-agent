import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { McpConnection } from "../../src/browser/mcp/client.js"
import { MCP_FAILURE } from "../../src/browser/mcp/policy.js"
import * as store from "../../src/browser/mcp/store.js"
import * as permissions from "../../src/browser/permissions.js"
import { initializeMcpSettings } from "../../src/browser/sidepanel/mcp-settings.js"
import type { ConfirmSettingsAction } from "../../src/browser/sidepanel/settings-confirmation.js"
import { endpoint, mcpEnvironment } from "../support/mcp.js"

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const secret = "private-draft-token-value"
const environments: JSDOM[] = []

afterEach(() => {
  for (const dom of environments.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"))
    dom.window.close()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function serverAt(servers: store.McpServer[], index: number): store.McpServer {
  const server = servers[index]
  if (!server) throw new Error(`Missing test server: ${index}`)
  return server
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function setup(count = 0) {
  const env = mcpEnvironment()
  const request = vi.spyOn(permissions, "requestHostPermission").mockResolvedValue(true)
  vi.spyOn(permissions, "hasApprovedHostPermission").mockResolvedValue(true)
  const discover = vi.spyOn(McpConnection.prototype, "discover").mockResolvedValue([])
  vi.spyOn(McpConnection.prototype, "disconnect").mockResolvedValue(undefined)
  const fetch = vi.fn().mockRejectedValue(new Error("Unexpected network request"))
  vi.stubGlobal("fetch", fetch)
  const servers: store.McpServer[] = []
  for (const name of ["Alpha", "Beta"].slice(0, count)) {
    servers.push(await store.saveMcpServer({ name, endpoint, token: "stored-token-value" }))
  }
  env.local.set.mockClear()
  const dom = new JSDOM(html)
  environments.push(dom)
  const document = dom.window.document
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", document)
  vi.stubGlobal("Option", dom.window.Option)
  const get = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id)
    if (!value) throw new Error(`Missing test element: ${id}`)
    return value as T
  }
  get<HTMLElement>("settings-page").hidden = false
  get<HTMLElement>("settings-panel-model").hidden = true
  get<HTMLElement>("settings-panel-mcp").hidden = false
  const confirm = vi.fn<ConfirmSettingsAction>().mockResolvedValue(false)
  const isDirty = await initializeMcpSettings(confirm)
  const select = get<HTMLSelectElement>("mcp-server")
  const name = get<HTMLInputElement>("mcp-name")
  const address = get<HTMLInputElement>("mcp-endpoint")
  const token = get<HTMLInputElement>("mcp-token")
  const clearToken = get<HTMLInputElement>("mcp-clear-token")
  const button = (id: string) => get<HTMLButtonElement>(`mcp-${id}`)
  const choose = (id: string) => {
    select.value = id
    select.dispatchEvent(new dom.window.Event("change"))
  }
  const input = (field: HTMLInputElement, value: string) => {
    field.value = value
    field.dispatchEvent(new dom.window.Event("input"))
  }
  const fields = () => ({
    name: name.value,
    endpoint: address.value,
    token: token.value,
    clearToken: clearToken.checked,
  })
  return {
    ...env,
    dom,
    document,
    servers,
    confirm,
    isDirty,
    select,
    name,
    endpoint: address,
    token,
    clearToken,
    button,
    choose,
    input,
    fields,
    status: get<HTMLElement>("mcp-status"),
    request,
    discover,
    fetch,
  }
}

describe("MCP settings", () => {
  test("treats an untouched blank New server form as clean", async () => {
    const env = await setup(1)
    expect(env.isDirty()).toBe(false)
    expect(env.button("connect").disabled).toBe(true)
    env.choose(serverAt(env.servers, 0).id)
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.name.value).toBe("Alpha")
    expect(env.token.type).toBe("password")
    expect(env.token.value).toBe("")
    expect(env.isDirty()).toBe(false)
    env.choose("")
    expect(env.isDirty()).toBe(false)
  })

  test("reports unsaved saved-server fields and token changes", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    env.input(env.name, "Edited")
    expect(env.isDirty()).toBe(true)
    expect(env.button("connect").disabled).toBe(true)
    env.input(env.name, "Alpha")
    expect(env.isDirty()).toBe(false)
    env.input(env.token, secret)
    expect(env.isDirty()).toBe(true)
    env.input(env.token, "")
    env.clearToken.checked = true
    expect(env.isDirty()).toBe(true)
  })

  test.each(["name", "endpoint"] as const)(
    "retains a typed token after %s validation fails and saves a corrected retry",
    async (invalid) => {
      const env = await setup()
      env.input(env.name, invalid === "name" ? "" : "New server")
      env.input(env.endpoint, invalid === "endpoint" ? "not a URL" : endpoint)
      env.input(env.token, secret)
      env.button("save").click()
      await settle()
      expect(env.token.value).toBe(secret)
      expect(env.isDirty()).toBe(true)
      expect(env.local.set).not.toHaveBeenCalled()
      expect(env.status.textContent).not.toContain(secret)
      expect(env.status.textContent).toContain(invalid === "name" ? "name" : "endpoint")
      env.input(env.name, "New server")
      env.input(env.endpoint, endpoint)
      env.button("save").click()
      await settle()
      expect(await store.listMcpServers()).toMatchObject([{ name: "New server", hasToken: true }])
      expect(JSON.stringify(env.data[store.MCP_TOKENS_KEY])).toContain(secret)
      expect(env.token.value).toBe("")
      expect(env.isDirty()).toBe(false)
      expect(env.document.body.textContent).not.toContain(secret)
      expect(env.fetch).not.toHaveBeenCalled()
    },
  )

  test("retains tokens on storage failure and clears them on pagehide", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    env.input(env.token, secret)
    env.local.set.mockRejectedValueOnce(new Error(secret))
    env.button("save").click()
    await settle()
    expect(env.token.value).toBe(secret)
    expect(env.status.textContent).toBe(MCP_FAILURE)
    expect(env.isDirty()).toBe(true)
    env.dom.window.dispatchEvent(new env.dom.window.Event("pagehide"))
    expect(env.token.value).toBe("")
  })

  test("reports even an unchanged local save as dirty while its write is pending", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const write = env.local.set.getMockImplementation()
    env.local.set.mockImplementationOnce(async (values) => {
      await pending
      await write?.(values)
    })
    env.button("save").click()
    expect(env.isDirty()).toBe(true)
    expect(env.select.disabled).toBe(true)
    finish()
    await settle()
    expect(env.isDirty()).toBe(false)
  })

  test.each(["saved", "new"])(
    "restores %s selection before confirmation, keeps all drafts on Cancel, and discards on confirm",
    async (initial) => {
      const env = await setup(2)
      const previousId = initial === "saved" ? serverAt(env.servers, 0).id : ""
      env.choose(previousId)
      env.input(env.name, "Draft name")
      env.input(env.endpoint, `${endpoint}/draft`)
      env.input(env.token, secret)
      env.clearToken.checked = true
      const draft = env.fields()
      const previousStatus = env.status.textContent
      let answer!: (confirmed: boolean) => void
      env.confirm.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          }),
      )
      env.choose(serverAt(env.servers, 1).id)
      expect(env.select.value).toBe(previousId)
      expect(env.fields()).toEqual(draft)
      expect(env.select.disabled).toBe(true)
      // Even a synthetic second change cannot open another confirmation or change the target.
      env.choose("")
      expect(env.select.value).toBe(previousId)
      expect(env.confirm).toHaveBeenCalledOnce()
      answer(false)
      await settle()
      expect(env.status.textContent).toBe(previousStatus)
      expect(env.select.value).toBe(previousId)
      expect(env.fields()).toEqual(draft)
      expect(env.isDirty()).toBe(true)
      env.confirm.mockResolvedValueOnce(true)
      env.choose(serverAt(env.servers, 1).id)
      await settle()
      expect(env.select.value).toBe(serverAt(env.servers, 1).id)
      expect(env.fields()).toEqual({ name: "Beta", endpoint, token: "", clearToken: false })
      expect(env.isDirty()).toBe(false)
      expect(env.local.set).not.toHaveBeenCalled()
      expect(JSON.stringify(env.confirm.mock.calls)).not.toContain(secret)
    },
  )

  test("server and token removal names the saved server and deletes nothing on Cancel", async () => {
    const env = await setup(1)
    const server = serverAt(env.servers, 0)
    env.choose(server.id)
    env.input(env.name, "Unsaved name")
    env.input(env.token, secret)
    const draft = env.fields()
    env.button("remove").click()
    await settle()
    expect(env.confirm).toHaveBeenCalledWith({
      title: "Remove MCP server and token?",
      message: expect.stringContaining("“Alpha”? Its stored token will be deleted."),
      confirmLabel: "Remove server and token",
    })
    expect(await store.listMcpServers()).toEqual([server])
    expect(env.local.set).not.toHaveBeenCalled()
    expect(env.fields()).toEqual(draft)
    const remove = vi.spyOn(store, "removeMcpServer")
    env.confirm.mockResolvedValueOnce(true)
    env.button("remove").click()
    await settle()
    expect(remove).toHaveBeenCalledWith(server.id, server.revision)
    expect(await store.listMcpServers()).toEqual([])
    expect(env.data[store.MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
    expect(env.select.value).toBe("")
    expect(env.token.value).toBe("")
    expect(env.isDirty()).toBe(false)
  })

  test("uses the captured saved revision when deletion is confirmed after an external edit", async () => {
    const env = await setup(1)
    const server = serverAt(env.servers, 0)
    env.choose(server.id)
    env.input(env.token, secret)
    let answer!: (confirmed: boolean) => void
    env.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const remove = vi.spyOn(store, "removeMcpServer")
    env.button("remove").click()
    const changed = await store.saveMcpServer({ ...server, name: "External edit" })
    answer(true)
    await settle()
    expect(remove).toHaveBeenCalledWith(server.id, server.revision)
    expect(await store.listMcpServers()).toEqual([changed])
    expect(JSON.stringify(env.data[store.MCP_TOKENS_KEY])).toContain("stored-token-value")
    expect(env.status.textContent).toContain("changed")
    expect(env.token.value).toBe(secret)
    expect(env.select.disabled).toBe(false)
  })

  test("requires an explicit draft discard before Disable refreshes the form", async () => {
    const env = await setup(1)
    const server = serverAt(env.servers, 0)
    env.choose(server.id)
    env.input(env.name, "Draft name")
    env.input(env.token, secret)
    const draft = env.fields()
    const disable = vi.spyOn(store, "setMcpConnection")
    env.button("disable").click()
    await settle()
    expect(env.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("“Alpha”"),
        confirmLabel: "Discard and disable",
      }),
    )
    expect(disable).not.toHaveBeenCalled()
    expect(env.fields()).toEqual(draft)
    env.confirm.mockResolvedValueOnce(true)
    env.button("disable").click()
    await settle()
    expect(disable).toHaveBeenCalledWith(server.id, false, server.revision)
    expect(env.fields()).toEqual({ name: "Alpha", endpoint, token: "", clearToken: false })
    expect(env.isDirty()).toBe(false)
  })

  test("requests host permission synchronously in Connect without a confirmation", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    env.button("connect").click()
    expect(env.request).toHaveBeenCalledWith(endpoint)
    expect(env.confirm).not.toHaveBeenCalled()
    await settle()
    expect(env.discover).toHaveBeenCalledOnce()
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test("does not discard or delete after pagehide while confirmation is pending", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    let answer!: (confirmed: boolean) => void
    env.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    env.button("remove").click()
    env.dom.window.dispatchEvent(new env.dom.window.Event("pagehide"))
    answer(true)
    await settle()
    expect(env.local.set).not.toHaveBeenCalled()
    expect(await store.listMcpServers()).toEqual(env.servers)
  })
})
