import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as i18n from "../../src/browser/i18n/index.js"
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

async function setup(count = 0, enabled = false) {
  const env = mcpEnvironment()
  const request = vi.spyOn(permissions, "requestHostPermission").mockResolvedValue(true)
  vi.spyOn(permissions, "hasApprovedHostPermission").mockResolvedValue(true)
  const discover = vi.spyOn(McpConnection.prototype, "discover").mockResolvedValue([])
  vi.spyOn(McpConnection.prototype, "disconnect").mockResolvedValue(undefined)
  const fetch = vi.fn().mockRejectedValue(new Error("Unexpected network request"))
  vi.stubGlobal("fetch", fetch)
  const servers: store.McpServer[] = []
  for (let index = 0; index < count; index++) {
    const server = await store.saveMcpServer({
      name: ["Alpha", "Beta"][index] ?? `Server ${index + 1}`,
      endpoint,
      token: "stored-token-value",
    })
    servers.push(enabled ? await store.setMcpConnection(server.id, true, server.revision) : server)
  }
  env.local.set.mockClear()
  const dom = new JSDOM(html)
  environments.push(dom)
  const document = dom.window.document
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", document)
  const get = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id)
    if (!value) throw new Error(`Missing test element: ${id}`)
    return value as T
  }
  get<HTMLElement>("settings-page").hidden = false
  get<HTMLElement>("settings-panel-model").hidden = true
  get<HTMLElement>("settings-panel-mcp").hidden = false
  const confirm = vi.fn<ConfirmSettingsAction>().mockResolvedValue(false)
  const changed = vi.fn()
  const state = await initializeMcpSettings(confirm, changed)
  const list = get<HTMLUListElement>("mcp-servers")
  const selectedId = () =>
    list.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.dataset.serverId ?? ""
  const serverButton = (id: string): HTMLButtonElement => {
    const button = list.querySelector<HTMLButtonElement>(`button[data-server-id="${id}"]`)
    if (!button) throw new Error(`Missing server button: ${id}`)
    return button
  }
  const name = get<HTMLInputElement>("mcp-name")
  const address = get<HTMLInputElement>("mcp-endpoint")
  const token = get<HTMLInputElement>("mcp-token")
  const clearToken = get<HTMLInputElement>("mcp-clear-token")
  const button = (id: string) => get<HTMLButtonElement>(`mcp-${id}`)
  const choose = (id: string) => {
    if (id) serverButton(id).click()
    else button("new").click()
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
    isDirty: state.hasDraft,
    state,
    changed,
    list,
    selectedId,
    serverButton,
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
  test("classifies original fixed validation errors before translating field presentation", async () => {
    const env = await setup()
    vi.spyOn(i18n, "translateKnownMessage").mockImplementation((message) => `Localized: ${message}`)
    env.input(env.name, "")
    env.input(env.endpoint, endpoint)
    env.button("save").click()
    await vi.waitFor(() => expect(env.name.getAttribute("aria-invalid")).toBe("true"))
    expect(env.document.getElementById("mcp-name-error")?.textContent).toBe(
      "Localized: Enter an MCP server name of at most 80 characters",
    )
    expect(env.status.textContent).toBe(
      "Localized: Enter an MCP server name of at most 80 characters",
    )
    expect(env.token.value).toBe("")
    expect(env.request).not.toHaveBeenCalled()
  })

  test("does not infer progress state from translated display text", async () => {
    const env = await setup()
    env.input(env.name, "New server")
    env.input(env.endpoint, endpoint)
    vi.spyOn(i18n, "t").mockImplementation((key) => {
      if (
        key === "Saving disconnected…" ||
        key === "Saved disconnected. Select Test and enable to make tools available for new runs."
      )
        return "Same translated progress and result"
      return key
    })
    env.button("save").click()
    await vi.waitFor(() => expect(env.isDirty()).toBe(false))
    expect(env.status.textContent).toBe("Same translated progress and result")
  })

  test.each([0, 1, 2, 8])("renders %i saved servers as native list buttons", async (count) => {
    const env = await setup(count)
    expect(env.list.tagName).toBe("UL")
    expect(env.list.children).toHaveLength(count)
    expect(env.document.getElementById("mcp-server")).toBeNull()
    expect(env.document.getElementById("mcp-empty")?.hidden).toBe(count > 0)
    expect(env.button("new").disabled).toBe(count === 8)
    for (const server of env.servers) {
      const button = env.serverButton(server.id)
      expect(button.type).toBe("button")
      expect(button.parentElement?.tagName).toBe("LI")
      expect(button.textContent).toContain(server.name)
      expect(button.textContent).toContain(server.endpoint)
      expect(button.textContent).toContain("Disabled")
      button.focus()
      env.choose(server.id)
      expect(button.getAttribute("aria-pressed")).toBe("true")
      expect(env.list.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
      expect(env.document.activeElement).toBe(button)
      expect(env.name.value).toBe(server.name)
      expect(env.token.value).toBe("")
    }
    if (count === 8) {
      env.input(env.name, "Edited eighth server")
      expect(env.button("save").disabled).toBe(false)
      expect(env.document.getElementById("mcp-action-hint")?.textContent).toContain("Save")
    }
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.request).not.toHaveBeenCalled()
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test("shows the eight-server limit without permitting a ninth save", async () => {
    const env = await setup(8)
    expect(env.document.getElementById("mcp-action-hint")?.textContent).toContain("eight-server")
    env.input(env.name, "Ninth server")
    env.input(env.endpoint, endpoint)
    expect(env.button("save").disabled).toBe(true)
    env.button("save").click()
    expect(env.local.set).not.toHaveBeenCalled()
    expect(await store.listMcpServers()).toHaveLength(8)
  })

  test("renders long untrusted names and endpoints as text without active markup", async () => {
    const env = await setup()
    const name = `<img src=x onerror=alert(1)>${"x".repeat(50)}`
    const address = `${endpoint}/${"long-path-".repeat(180)}`
    env.input(env.name, name)
    env.input(env.endpoint, address)
    env.button("save").click()
    await settle()
    const server = serverAt(await store.listMcpServers(), 0)
    expect(env.serverButton(server.id).textContent).toContain(name)
    expect(env.serverButton(server.id).textContent).toContain(address)
    expect(env.document.getElementById("mcp-editor-title")?.textContent).toBe(`Edit ${name}`)
    expect(env.list.querySelector("img, script, a")).toBeNull()
    expect(env.fetch).not.toHaveBeenCalled()
  })

  test("exposes only applicable actions and keeps saved actions independent", async () => {
    const env = await setup(1)
    expect(env.button("save").classList.contains("primary")).toBe(true)
    expect(env.button("connect").hidden).toBe(true)
    expect(env.button("disable").hidden).toBe(true)
    expect(env.document.getElementById("mcp-danger-zone")?.hidden).toBe(true)
    const server = serverAt(env.servers, 0)
    env.choose(server.id)
    expect(env.button("save").disabled).toBe(true)
    expect(env.button("save").classList.contains("primary")).toBe(false)
    expect(env.button("connect").hidden).toBe(false)
    expect(env.button("connect").classList.contains("primary")).toBe(true)
    expect(env.document.getElementById("mcp-danger-zone")?.hidden).toBe(false)
    env.button("save").click()
    env.button("disable").click()
    expect(env.local.set).not.toHaveBeenCalled()
    env.input(env.name, "Edited")
    expect(env.button("save").disabled).toBe(false)
    expect(env.button("connect").hidden).toBe(true)
    env.button("save").click()
    await settle()
    expect(env.request).not.toHaveBeenCalled()
    expect(env.discover).not.toHaveBeenCalled()
    env.button("connect").click()
    await settle()
    expect(env.button("disable").hidden).toBe(false)
    expect(env.serverButton(server.id).textContent).toContain("Enabled")
    expect(env.document.getElementById("mcp-action-hint")?.textContent).toContain(
      "not a live connection",
    )
  })

  test("restores lost Save and Disable focus to the next action", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    env.input(env.name, "Edited")
    env.button("save").focus()
    env.button("save").click()
    await settle()
    expect(env.document.activeElement).toBe(env.button("connect"))
    env.button("connect").click()
    await settle()
    env.button("disable").focus()
    env.button("disable").click()
    await settle()
    expect(env.button("disable").hidden).toBe(true)
    expect(env.document.activeElement).toBe(env.button("connect"))
  })

  test("does not take focus back after a user moves away during discovery", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    let release!: () => void
    env.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([])
        }),
    )
    env.button("connect").focus()
    env.button("connect").click()
    await settle()
    const elsewhere = env.document.getElementById("settings-tab-model")
    if (!elsewhere) throw new Error("Missing navigation target")
    elsewhere.focus()
    release()
    await settle()
    expect(env.document.activeElement).toBe(elsewhere)
    expect(env.state.isBusy()).toBe(false)
  })

  test("reports a pristine connection test as busy, not as a draft, and does not replay failure", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    let fail!: (error: Error) => void
    env.discover.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const transitions: boolean[] = []
    env.changed.mockImplementation(() => transitions.push(env.state.isBusy()))
    env.button("connect").click()
    expect(env.status.textContent).toContain("Testing")
    expect(env.state.isBusy()).toBe(true)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.button("remove").disabled).toBe(true)
    await settle()
    fail(new Error(secret))
    await settle()
    expect(env.state.isBusy()).toBe(false)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.status.textContent).toBe(MCP_FAILURE)
    expect(env.button("connect").disabled).toBe(false)
    expect(env.button("disable").hidden).toBe(true)
    expect(transitions[0]).toBe(true)
    expect(transitions.at(-1)).toBe(false)
    expect(env.discover).toHaveBeenCalledOnce()
    expect(await store.listMcpServers()).toMatchObject([{ enabled: false, approved: false }])
    expect(env.document.body.textContent).not.toContain(secret)
  })

  test.each(["short", "private token with spaces"])(
    "associates safe token validation and retains %s",
    async (value) => {
      const env = await setup()
      env.input(env.name, "Valid name")
      env.input(env.endpoint, endpoint)
      env.input(env.token, value)
      env.button("save").focus()
      env.button("save").click()
      await settle()
      const error = env.document.getElementById("mcp-token-error")
      expect(error?.hidden).toBe(false)
      expect(error?.textContent).toContain("16 to 4096")
      expect(env.token.getAttribute("aria-describedby")).toContain("mcp-token-error")
      expect(env.token.getAttribute("aria-invalid")).toBe("true")
      expect(env.document.activeElement).toBe(env.token)
      expect(env.token.value).toBe(value)
      expect(env.local.set).not.toHaveBeenCalled()
      expect(env.document.body.textContent).not.toContain(value)
      env.input(env.token, secret)
      expect(error?.hidden).toBe(true)
      expect(env.token.hasAttribute("aria-invalid")).toBe(false)
      env.button("save").click()
      await settle()
      expect(env.state.hasDraft()).toBe(false)
      expect(env.token.value).toBe("")
    },
  )

  test("preserves or explicitly clears a token, but never transfers it to another endpoint", async () => {
    const env = await setup(1)
    const server = serverAt(env.servers, 0)
    env.choose(server.id)
    env.input(env.name, "Renamed")
    env.button("save").click()
    await settle()
    expect(await store.listMcpServers()).toMatchObject([{ hasToken: true }])
    env.clearToken.checked = true
    env.clearToken.dispatchEvent(new env.dom.window.Event("input"))
    env.button("save").click()
    await settle()
    expect(await store.listMcpServers()).toMatchObject([{ hasToken: false }])
    env.input(env.token, secret)
    env.button("save").click()
    await settle()
    env.input(env.endpoint, `${endpoint}/changed`)
    env.button("save").click()
    await settle()
    expect(await store.listMcpServers()).toMatchObject([{ hasToken: false }])
    expect(env.data[store.MCP_TOKENS_KEY]).toEqual({ version: 1, tokens: {} })
    expect(env.request).not.toHaveBeenCalled()
  })

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
      const field = invalid === "name" ? env.name : env.endpoint
      const error = env.document.getElementById(`${field.id}-error`)
      expect(error?.hidden).toBe(false)
      expect(field.getAttribute("aria-describedby")).toContain(`${field.id}-error`)
      expect(field.getAttribute("aria-invalid")).toBe("true")
      expect(env.document.activeElement).toBe(field)
      env.input(env.name, "New server")
      env.input(env.endpoint, endpoint)
      expect(error?.hidden).toBe(true)
      expect(field.hasAttribute("aria-invalid")).toBe(false)
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

  test("reports a save as busy without inventing a draft after the write completes", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    expect(env.button("save").disabled).toBe(true)
    env.input(env.name, "Updated")
    const changes: { busy: boolean; draft: boolean }[] = []
    env.changed.mockImplementation(() => {
      changes.push({ busy: env.state.isBusy(), draft: env.state.hasDraft() })
    })
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
    expect(env.state.isBusy()).toBe(true)
    expect(env.button("new").disabled).toBe(true)
    expect(env.serverButton(serverAt(env.servers, 0).id).disabled).toBe(true)
    finish()
    await settle()
    expect(env.isDirty()).toBe(false)
    expect(env.state.isBusy()).toBe(false)
    expect(changes).toContainEqual({ busy: true, draft: true })
    expect(changes).toContainEqual({ busy: true, draft: false })
    expect(changes.at(-1)).toEqual({ busy: false, draft: false })
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
      expect(env.selectedId()).toBe(previousId)
      expect(env.fields()).toEqual(draft)
      expect(env.state.isBusy()).toBe(true)
      expect(env.serverButton(serverAt(env.servers, 1).id).disabled).toBe(true)
      // Even a synthetic second change cannot open another confirmation or change the target.
      env.choose("")
      expect(env.selectedId()).toBe(previousId)
      expect(env.confirm).toHaveBeenCalledOnce()
      answer(false)
      await settle()
      expect(env.status.textContent).toBe(previousStatus)
      expect(env.selectedId()).toBe(previousId)
      expect(env.fields()).toEqual(draft)
      expect(env.isDirty()).toBe(true)
      expect(env.state.isBusy()).toBe(false)
      env.confirm.mockResolvedValueOnce(true)
      env.choose(serverAt(env.servers, 1).id)
      await settle()
      expect(env.selectedId()).toBe(serverAt(env.servers, 1).id)
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
    expect(env.selectedId()).toBe("")
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
    expect(env.serverButton(server.id).disabled).toBe(false)
  })

  test("requires an explicit draft discard before Disable refreshes the form", async () => {
    const env = await setup(1, true)
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

  test("notifies busy state during a pristine removal confirmation without reporting a draft", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    let answer!: (confirmed: boolean) => void
    env.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const transitions: boolean[] = []
    env.changed.mockImplementation(() => transitions.push(env.state.isBusy()))
    env.button("remove").click()
    expect(env.state.isBusy()).toBe(true)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.button("save").disabled).toBe(true)
    expect(env.button("remove").disabled).toBe(true)
    answer(false)
    await settle()
    expect(transitions).toEqual([true, false])
    expect(env.state.hasDraft()).toBe(false)
    expect(env.local.set).not.toHaveBeenCalled()
  })

  test("does not enable an old preview after an external revision change", async () => {
    const env = await setup(1)
    const server = serverAt(env.servers, 0)
    env.choose(server.id)
    let finish!: (tools: never[]) => void
    env.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const close = vi.spyOn(McpConnection.prototype, "close")
    env.button("connect").click()
    await settle()
    const current = serverAt(await store.listMcpServers(), 0)
    const changed = await store.saveMcpServer({ ...current, name: "External edit" })
    expect(close).toHaveBeenCalled()
    finish([])
    await settle()
    expect(await store.listMcpServers()).toEqual([changed])
    expect(env.status.textContent).toContain("changed")
    expect(env.discover).toHaveBeenCalledOnce()
    expect(env.document.getElementById("mcp-tools")?.textContent).toBe("")
  })

  test("does not connect after pagehide while host approval is pending", async () => {
    const env = await setup(1)
    env.choose(serverAt(env.servers, 0).id)
    let answer!: (allowed: boolean) => void
    env.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    env.button("connect").click()
    expect(env.state.isBusy()).toBe(true)
    env.dom.window.dispatchEvent(new env.dom.window.Event("pagehide"))
    expect(env.state.isBusy()).toBe(false)
    answer(true)
    await settle()
    expect(env.discover).not.toHaveBeenCalled()
    expect(env.local.set).not.toHaveBeenCalled()
    expect(env.storageListeners.size).toBe(0)
    expect(env.permissionListeners.size).toBe(0)
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
