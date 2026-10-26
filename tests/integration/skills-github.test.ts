import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import { initializeSkillsSettings } from "../../src/browser/sidepanel/skills-settings.js"
import { SkillRun } from "../../src/browser/skills/run.js"
import { SKILLS_STORAGE_KEY, type SkillRecord, SkillStore } from "../../src/browser/skills/store.js"

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const API = "https://api.github.com"
const PATTERN = `${API}/*`
const APPROVALS = "piBrowserAgentApprovedHostPermissions"
const COMMIT = "a".repeat(40)
const TREE = "b".repeat(40)
const BLOB = "c".repeat(40)
const PATH = "skills/.curated/example/SKILL.md"
const NAME = "github-review"
const DESCRIPTION = "Review the café safely."
const BODY =
  "<script>window.skillInjected=true</script>\nReview scripts/task.py and references/guide.md as text.\n"

function source(body = BODY): string {
  return `---\nname: ${NAME}\ndescription: >-\n  Review the café\n  safely.\nlicense: MIT\ncompatibility: Requires a local Python interpreter\nmetadata:\n  author: synthetic-review-author\nallowed-tools: Read\n---\n${body}`
}

function fixture(url: string, text = source(), path = PATH): Response {
  const bytes = Buffer.from(text, "utf8")
  const value = url.endsWith("/commits?per_page=1")
    ? [
        {
          sha: COMMIT,
          commit: { tree: { sha: TREE }, message: "Default branch is release, not main" },
        },
      ]
    : url.endsWith(`/git/trees/${TREE}?recursive=1`)
      ? {
          sha: TREE,
          truncated: false,
          tree: [{ path, mode: "100644", type: "blob", sha: BLOB, size: bytes.length }],
        }
      : url.endsWith(`/git/blobs/${BLOB}`)
        ? { sha: BLOB, encoding: "base64", size: bytes.length, content: bytes.toString("base64") }
        : undefined
  if (!value) throw new Error(`Unexpected network request: ${url}`)
  return Response.json(value)
}

const environments: JSDOM[] = []
afterEach(() => {
  for (const dom of environments.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"))
    dom.window.close()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(initial: SkillRecord[] = []) {
  const dom = new JSDOM(html)
  environments.push(dom)
  const document = dom.window.document
  const get = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id)
    if (!node) throw new Error(`Missing test element: ${id}`)
    return node as T
  }
  const data: Record<string, unknown> = {
    [SKILLS_STORAGE_KEY]: { version: 1, records: structuredClone(initial) },
    [APPROVALS]: [],
  }
  type Changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  const changed = new Set<Changed>()
  const removed = new Set<() => void>()
  let granted = true
  let allowed = true
  const runtime = { sendMessage: vi.fn() }
  const permissions = {
    // A broad Chrome grant does not provide app-level GitHub approval.
    contains: vi.fn(async () => allowed),
    request: vi.fn(async () => granted),
    onRemoved: {
      addListener: (listener: () => void) => removed.add(listener),
      removeListener: (listener: () => void) => removed.delete(listener),
    },
  }
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, newValue]) => [key, { newValue }]),
      )
      Object.assign(data, structuredClone(values))
      for (const listener of changed) listener(changes, "local")
    }),
  }
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", document)
  vi.stubGlobal("chrome", {
    runtime,
    permissions,
    storage: {
      local: storage,
      onChanged: {
        addListener: (listener: Changed) => changed.add(listener),
        removeListener: (listener: Changed) => changed.delete(listener),
      },
    },
  })
  const network = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    fixture(String(input)),
  )
  vi.stubGlobal("fetch", network)
  const state = await initializeSkillsSettings()
  const input = get<HTMLInputElement>("skills-github-repository")
  const candidates = get<HTMLSelectElement>("skills-github-candidates")
  const button = (id: string) => get<HTMLButtonElement>(id)
  const inputRepository = (value: string) => {
    input.value = value
    input.dispatchEvent(new dom.window.Event("input"))
  }
  const idle = () => vi.waitFor(() => expect(state.isBusy()).toBe(false))
  const find = async (value = "openai/skills") => {
    inputRepository(value)
    button("skills-github-fetch").click()
    await idle()
  }
  const review = async (path = PATH) => {
    candidates.value = path
    candidates.dispatchEvent(new dom.window.Event("change"))
    button("skills-github-review").click()
    await idle()
  }
  const store = new SkillStore()
  return {
    dom,
    get,
    data,
    storage,
    permissions,
    runtime,
    network,
    state,
    inputRepository,
    button,
    candidates,
    idle,
    find,
    review,
    store,
    preview: get<HTMLElement>("skills-preview"),
    status: get<HTMLElement>("skills-status"),
    deny: () => {
      granted = false
    },
    revoke: () => {
      allowed = false
      for (const listener of removed) listener()
    },
  }
}

test("approved GitHub review imports a disabled v1 snapshot; enabled runtime loading is local and metadata-free", async () => {
  const env = await setup()
  expect(env.network).not.toHaveBeenCalled()
  expect(env.permissions.request).not.toHaveBeenCalled()
  env.inputRepository("https://github.com/OpenAI/skills")
  env.button("skills-github-fetch").click()
  // The permission request starts in the click handler, before an asynchronous boundary.
  expect(env.permissions.request).toHaveBeenCalledExactlyOnceWith({ origins: [PATTERN] })
  await env.idle()
  expect(env.data[APPROVALS]).toEqual([PATTERN])
  expect(env.network).toHaveBeenCalledTimes(2)
  expect(env.candidates.value).toBe("")
  expect(env.button("skills-github-review").disabled).toBe(true)
  expect(env.state.hasDraft()).toBe(false)
  expect(await env.store.list()).toEqual([])
  env.candidates.value = PATH
  env.candidates.dispatchEvent(new env.dom.window.Event("change"))
  await env.idle()
  expect(env.network).toHaveBeenCalledTimes(2)
  expect(env.state.hasDraft()).toBe(false)
  env.button("skills-github-review").click()
  await env.idle()
  expect(env.network).toHaveBeenCalledTimes(3)
  expect(env.preview.textContent).toContain(source())
  for (const value of [
    DESCRIPTION,
    "openai/skills",
    PATH,
    COMMIT,
    "synthetic-review-author",
    "not available",
  ]) {
    expect(env.preview.textContent).toContain(value)
  }
  expect(env.preview.querySelector("script")).toBeNull()
  expect((env.dom.window as unknown as { skillInjected?: boolean }).skillInjected).toBeUndefined()
  expect(env.get<HTMLAnchorElement>("skills-source-link").href).toBe(
    `https://github.com/openai/skills/blob/${COMMIT}/${PATH}`,
  )
  expect(env.state.hasDraft()).toBe(true)
  expect(await env.store.list()).toEqual([])
  expect(env.runtime.sendMessage).not.toHaveBeenCalled()
  env.button("skills-import-reviewed").click()
  await env.idle()
  const installed = (await env.store.list())[0]
  expect(installed).toEqual({
    id: expect.any(String),
    name: NAME,
    description: DESCRIPTION,
    body: BODY,
    enabled: false,
  })
  if (!installed) throw new Error("Missing imported skill")
  expect(env.data[SKILLS_STORAGE_KEY]).toEqual({ version: 1, records: [installed] })
  expect(new SkillRun(await env.store.list()).tools()).toEqual([])
  const enabled = env.get<HTMLInputElement>("skills-enabled")
  enabled.checked = true
  enabled.dispatchEvent(new env.dom.window.Event("change"))
  await env.idle()
  const run = new SkillRun(await env.store.list())
  expect(JSON.parse(run.catalog)).toEqual([
    { id: installed.id, name: NAME, description: DESCRIPTION },
  ])
  await env.store.remove(installed.id)
  const tool = run.tools()[0]
  if (!tool) throw new Error("Missing skills_load")
  const loaded = await tool.execute("local-load", { id: installed.id })
  const serialized = JSON.stringify(loaded)
  const loadedText = loaded.content.find((part) => part.type === "text")
  if (loadedText?.type !== "text") throw new Error("Missing loaded text")
  expect(JSON.parse(loadedText.text).body).toBe(BODY)
  for (const value of [
    "synthetic-review-author",
    "MIT",
    "Requires a local Python",
    COMMIT,
    PATH,
    "openai/skills",
    "allowed-tools",
  ]) {
    expect(JSON.stringify(installed)).not.toContain(value)
    expect(run.catalog).not.toContain(value)
    expect(serialized).not.toContain(value)
  }
  expect(env.network).toHaveBeenCalledTimes(3)
  for (const [url, init] of env.network.mock.calls) {
    expect(String(url).startsWith(`${API}/repos/openai/skills/`)).toBe(true)
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" })
    expect(new Headers(init?.headers).has("Authorization")).toBe(false)
  }
  expect(env.runtime.sendMessage).not.toHaveBeenCalled()
  run.finish()
})

test.each(["duplicate", "quota"] as const)(
  "%s failure preserves GitHub review and installed records",
  async (kind) => {
    const initial = Array.from({ length: kind === "quota" ? 20 : 1 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: kind === "duplicate" ? NAME : `installed-${index}`,
      description: "Installed fixture",
      body: "Original body",
      enabled: true,
    }))
    const env = await setup(initial)
    await env.find()
    await env.review()
    const preview = env.preview.textContent
    env.button("skills-import-reviewed").click()
    await env.idle()
    expect(env.status.textContent).toContain(
      kind === "duplicate" ? "explicit replacement" : "Installed skill limit",
    )
    expect(await env.store.list()).toEqual(initial)
    expect(env.preview.textContent).toBe(preview)
    expect(env.state.hasDraft()).toBe(true)
    expect(env.button("skills-import-reviewed").disabled).toBe(false)
    expect(env.network).toHaveBeenCalledTimes(3)
  },
)

test("root SKILL.md on the returned default-branch commit supports explicit stable-ID replacement", async () => {
  const original = {
    id: "00000000-0000-4000-8000-000000000001",
    name: NAME,
    description: "Old description",
    body: "Old body",
    enabled: true,
  }
  const env = await setup([original])
  env.network.mockImplementation(async (input) => fixture(String(input), source(), "SKILL.md"))
  await env.find("example/release-branch")
  await env.review("SKILL.md")
  expect(env.network.mock.calls.map(([url]) => String(url))).toEqual([
    `${API}/repos/example/release-branch/commits?per_page=1`,
    `${API}/repos/example/release-branch/git/trees/${TREE}?recursive=1`,
    `${API}/repos/example/release-branch/git/blobs/${BLOB}`,
  ])
  const selected = env.get<HTMLUListElement>("skills-list").querySelector("button")
  if (!selected) throw new Error("Missing installed skill")
  selected.click()
  expect(await env.store.list()).toEqual([original])
  env.button("skills-replace-reviewed").click()
  await env.idle()
  expect(await env.store.list()).toEqual([
    { ...original, description: DESCRIPTION, body: BODY, enabled: false },
  ])
})

test.each(["cancel", "source", "dispose", "revoke"] as const)(
  "%s aborts a pending blob and rejects a late response",
  async (action) => {
    const env = await setup()
    await env.find()
    let release!: (value: Response) => void
    let signal: AbortSignal | undefined
    env.network.mockImplementationOnce(async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    env.candidates.value = PATH
    env.candidates.dispatchEvent(new env.dom.window.Event("change"))
    env.button("skills-github-review").click()
    await vi.waitFor(() => expect(signal).toBeDefined())
    if (action === "cancel") env.button("skills-github-cancel").click()
    if (action === "source") env.inputRepository("example/new-source")
    if (action === "dispose") env.dom.window.dispatchEvent(new env.dom.window.Event("pagehide"))
    if (action === "revoke") env.revoke()
    await env.idle()
    expect(signal?.aborted).toBe(true)
    if (action === "source") {
      await env.find("example/new-source")
      await env.review()
      expect(env.preview.textContent).toContain("example/new-source")
    }
    const preview = env.preview.textContent
    release(fixture(`${API}/repos/openai/skills/git/blobs/${BLOB}`))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(env.preview.textContent).toBe(preview)
    expect(await env.store.list()).toEqual([])
    expect(env.state.hasDraft()).toBe(action === "source")
  },
)

test("host denial issues no request; revocation after listing prevents the selected blob read", async () => {
  const env = await setup()
  env.deny()
  await env.find()
  expect(env.status.textContent).toContain("not granted")
  expect(env.network).not.toHaveBeenCalled()
  expect(env.data[APPROVALS]).toEqual([])
  expect(env.get<HTMLInputElement>("skills-file-input").disabled).toBe(false)
  env.permissions.request.mockResolvedValue(true)
  await env.find()
  expect(env.network).toHaveBeenCalledTimes(2)
  env.revoke()
  await env.review()
  expect(env.status.textContent).toContain("host approval is required")
  expect(env.network).toHaveBeenCalledTimes(2)
  expect(env.state.hasDraft()).toBe(false)
  expect(await env.store.list()).toEqual([])
})
