import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { initializeSettingsTabs } from "../../src/browser/sidepanel/settings-tabs.js"
import { initializeSkillsSettings } from "../../src/browser/sidepanel/skills-settings.js"
import { SKILL_LIMITS } from "../../src/browser/skills/format.js"
import { SKILLS_STORAGE_KEY, type SkillRecord, SkillStore } from "../../src/browser/skills/store.js"

const html = readFileSync(
  new URL("../../src/browser/sidepanel/index.html", import.meta.url),
  "utf8",
)
const id = "00000000-0000-4000-8000-000000000001"
const original: SkillRecord = {
  id,
  name: "original-skill",
  description: "Original description",
  body: "Original body",
  enabled: false,
}

function source(
  name = "new-skill",
  body = "Reviewed body",
  description = "A useful skill",
): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const environments: { dom: JSDOM; hide: () => void }[] = []
afterEach(() => {
  for (const env of environments.splice(0)) {
    env.hide()
    env.dom.window.close()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(initial: SkillRecord[] = []) {
  const dom = new JSDOM(html)
  const document = dom.window.document
  const get = <T extends HTMLElement>(name: string): T => {
    const element = document.getElementById(name)
    if (!element) throw new Error(`Missing test element: ${name}`)
    return element as T
  }
  const settingsPage = get<HTMLElement>("settings-page")
  settingsPage.hidden = false
  initializeSettingsTabs(settingsPage)
  get<HTMLButtonElement>("settings-tab-skills").click()
  const data: Record<string, unknown> = {
    [SKILLS_STORAGE_KEY]: { version: 1, records: structuredClone(initial) },
  }
  type Changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  const listeners = new Set<Changed>()
  const notify = (changes: Record<string, chrome.storage.StorageChange>, area = "local") => {
    for (const listener of listeners) listener(changes, area)
  }
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values))
      notify({ [SKILLS_STORAGE_KEY]: { newValue: structuredClone(values[SKILLS_STORAGE_KEY]) } })
    }),
  }
  const removeListener = vi.fn((listener: Changed) => listeners.delete(listener))
  const runtime = { sendMessage: vi.fn() }
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("document", document)
  vi.stubGlobal("chrome", {
    storage: {
      local: storage,
      onChanged: { addListener: (listener: Changed) => listeners.add(listener), removeListener },
    },
    runtime,
  })
  const dialog = get<HTMLDialogElement>("skills-delete-dialog")
  const showModal = vi.fn(() => {
    dialog.open = true
  })
  dialog.showModal = showModal
  dialog.close = vi.fn(() => {
    dialog.open = false
    dialog.dispatchEvent(new dom.window.Event("close"))
  })
  const hide = () => dom.window.dispatchEvent(new dom.window.Event("pagehide"))
  environments.push({ dom, hide })
  await initializeSkillsSettings()
  const file = get<HTMLInputElement>("skills-file-input")
  const select = get<HTMLSelectElement>("skills-list")
  const enabled = get<HTMLInputElement>("skills-enabled")
  const button = (name: string) => get<HTMLButtonElement>(name)
  const choose = async (
    text = source(),
    options: { name?: string; size?: number; bytes?: Uint8Array; readError?: Error } = {},
  ) => {
    const chosen = new dom.window.File([text], options.name ?? "SKILL.md", { type: "text/plain" })
    const read = vi.fn(async () => {
      if (options.readError) throw options.readError
      return options.bytes
        ? Uint8Array.from(options.bytes).buffer
        : new TextEncoder().encode(text).buffer
    })
    Object.defineProperty(chosen, "arrayBuffer", { value: read })
    if (options.size !== undefined) Object.defineProperty(chosen, "size", { value: options.size })
    Object.defineProperty(file, "files", { configurable: true, value: [chosen] })
    file.dispatchEvent(new dom.window.Event("change"))
    await settle()
    return read
  }
  const selectSkill = (value = id) => {
    select.value = value
    select.dispatchEvent(new dom.window.Event("change"))
  }
  return {
    dom,
    document,
    get,
    file,
    select,
    enabled,
    button,
    choose,
    selectSkill,
    dialog,
    showModal,
    storage,
    data,
    notify,
    removeListener,
    runtime,
    hide,
    store: new SkillStore(),
    preview: get<HTMLElement>("skills-preview"),
    installedPreview: get<HTMLElement>("skills-installed-preview"),
    status: get<HTMLElement>("skills-status"),
  }
}

describe("Skills settings", () => {
  test("keeps file selection disabled until initialization attaches its handlers", async () => {
    const dom = new JSDOM(html)
    try {
      const file = dom.window.document.getElementById("skills-file-input") as HTMLInputElement
      expect(file.disabled).toBe(true)
    } finally {
      dom.window.close()
    }

    const env = await setup()
    expect(env.file.disabled).toBe(false)
    await env.choose()
    expect(env.preview.textContent).toContain("Reviewed body")
  })

  test("uses labeled native keyboard controls and explains disclosure and retention", async () => {
    const env = await setup()
    expect(env.file.type).toBe("file")
    expect(env.file.multiple).toBe(false)
    expect(env.file.accept).toContain(".md")
    expect(env.select.tagName).toBe("SELECT")
    expect(env.enabled.type).toBe("checkbox")
    expect(env.file.labels?.length).toBe(1)
    expect(env.select.labels?.length).toBe(1)
    expect(env.enabled.labels?.length).toBe(1)
    expect(env.status.getAttribute("role")).toBe("status")
    expect(env.preview.tabIndex).toBe(0)
    env.preview.focus()
    expect(env.document.activeElement).toBe(env.preview)
    for (const name of ["skills-import-reviewed", "skills-replace-reviewed", "skills-delete"])
      expect(env.button(name).disabled).toBe(true)
    const section = env.file.closest("section")?.textContent
    expect(section).toContain("Scripts and supporting files are not supported")
    expect(section).toContain("only when you submit a chat message")
    expect(section).toContain("saved session history")
    expect(section).toContain("next run, not an active run")
    expect(section).toContain("save independently")
  })

  test("previews malicious HTML and dependency warnings as text before any save", async () => {
    const env = await setup()
    const body = '<script>alert(1)</script><img src=x onerror="alert(2)">\nRun scripts/task.py'
    const description = '<svg onload="alert(3)">Untrusted</svg>'
    await env.choose(source("html-skill", body, description))
    expect(env.preview.textContent).toContain("Name: html-skill")
    expect(env.preview.textContent).toContain(description)
    expect(env.preview.textContent).toContain(body)
    expect(env.preview.textContent).toContain("Compatibility warnings:")
    expect(env.preview.textContent).toContain("may require scripts")
    expect(env.preview.children).toHaveLength(0)
    expect(env.storage.set).not.toHaveBeenCalled()
    expect(env.runtime.sendMessage).not.toHaveBeenCalled()
    expect(env.button("skills-import-reviewed").disabled).toBe(false)
    expect(env.button("skills-replace-reviewed").disabled).toBe(true)
  })

  test("imports only on explicit action, starts disabled, and clears the review", async () => {
    const env = await setup()
    await env.choose()
    env.button("skills-import-reviewed").click()
    await settle()
    expect(await env.store.list()).toMatchObject([{ name: "new-skill", enabled: false }])
    expect(env.select.value).toBe("")
    expect(env.document.activeElement).toBe(env.select)
    expect(env.file.value).toBe("")
    expect(env.preview.textContent).toBe("No file reviewed.")
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    expect(env.status.textContent).toContain("imported disabled")
  })

  test("blocks repeated saves and safely refreshes queued storage changes", async () => {
    const env = await setup()
    await env.choose()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = env.storage.set.getMockImplementation()
    env.storage.set.mockImplementationOnce(async (values) => {
      await pending
      await save?.(values)
    })
    env.button("skills-import-reviewed").click()
    env.button("skills-import-reviewed").click()
    expect(env.file.disabled).toBe(true)
    expect(env.select.disabled).toBe(true)
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    release?.()
    await settle()
    expect(await env.store.list()).toHaveLength(1)
    expect(env.storage.set).toHaveBeenCalledOnce()
    expect(env.status.textContent).toContain("imported disabled")
    expect(env.select.disabled).toBe(false)
    expect(env.document.activeElement).toBe(env.select)
  })

  test("previews an installed skill and saves enable/disable independently", async () => {
    const env = await setup([original])
    env.selectSkill()
    expect(env.installedPreview.textContent).toContain(original.body)
    env.enabled.focus()
    env.enabled.click()
    await settle()
    expect((await env.store.list())[0]?.enabled).toBe(true)
    expect(env.enabled.checked).toBe(true)
    expect(env.document.activeElement).toBe(env.enabled)
    expect(env.select.value).toBe(id)
    env.enabled.click()
    await settle()
    expect((await env.store.list())[0]?.enabled).toBe(false)
    expect(env.runtime.sendMessage).not.toHaveBeenCalled()
  })

  test("requires explicit replacement and retains the ID while disabling the replacement", async () => {
    const env = await setup([{ ...original, enabled: true }])
    env.selectSkill()
    await env.choose(source("replacement", "New reviewed content"))
    expect((await env.store.list())[0]?.body).toBe(original.body)
    expect(env.installedPreview.textContent).toContain(original.body)
    expect(env.preview.textContent).toContain("New reviewed content")
    expect(env.button("skills-replace-reviewed").disabled).toBe(false)
    env.button("skills-replace-reviewed").click()
    await settle()
    expect(await env.store.list()).toMatchObject([
      { id, name: "replacement", body: "New reviewed content", enabled: false },
    ])
    expect(env.select.value).toBe("")
    expect(env.preview.textContent).toBe("No file reviewed.")
  })

  test("a duplicate import never implicitly replaces an existing record", async () => {
    const env = await setup([original])
    env.selectSkill()
    await env.choose(source(original.name, "Do not replace implicitly"))
    env.button("skills-import-reviewed").click()
    await settle()
    expect(await env.store.list()).toEqual([original])
    expect(env.status.textContent).toContain("explicit replacement")
    expect(env.preview.textContent).toContain("Do not replace implicitly")
  })

  test("deletion requires a native dialog confirmation and supports cancellation", async () => {
    const env = await setup([original])
    env.selectSkill()
    env.button("skills-delete").click()
    expect(env.showModal).toHaveBeenCalledOnce()
    expect(env.dialog.open).toBe(true)
    expect(env.document.activeElement).toBe(env.button("skills-cancel-delete"))
    expect(await env.store.list()).toEqual([original])
    env.button("skills-cancel-delete").click()
    expect(env.dialog.open).toBe(false)
    expect(await env.store.list()).toEqual([original])
    env.button("skills-delete").click()
    const cancel = new env.dom.window.Event("cancel", { cancelable: true })
    env.dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(env.dialog.open).toBe(false)
    expect(await env.store.list()).toEqual([original])
    env.button("skills-delete").click()
    env.button("skills-confirm-delete").click()
    await settle()
    expect(await env.store.list()).toEqual([])
    expect(env.select.value).toBe("")
    expect(env.status.textContent).toContain("Previous session history is retained")
  })

  test.each([
    { name: "other.md", size: 10, message: "named SKILL.md" },
    { name: "SKILL.md", size: SKILL_LIMITS.inputBytes + 1, message: "at most 65536 bytes" },
  ])("rejects $name at $size bytes before reading", async ({ name, size, message }) => {
    const env = await setup([original])
    const read = await env.choose(source(), { name, size })
    expect(read).not.toHaveBeenCalled()
    expect(env.status.textContent).toContain(message)
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    expect(await env.store.list()).toEqual([original])
  })

  test("rejects invalid files and clears any previous reviewed draft", async () => {
    const env = await setup([original])
    await env.choose()
    await env.choose("<img src=x onerror=alert(1)>")
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    expect(env.preview.textContent).toBe("No file reviewed.")
    expect(env.status.textContent).toContain("frontmatter")
    expect(env.status.children).toHaveLength(0)
    expect(await env.store.list()).toEqual([original])
  })

  test("rejects invalid UTF-8 without saving", async () => {
    const env = await setup([original])
    await env.choose(source(), { bytes: new Uint8Array([0xc3, 0x28]) })
    expect(env.status.textContent).toContain("valid UTF-8")
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    expect(await env.store.list()).toEqual([original])
  })

  test("a failed file read preserves records and permits another file selection", async () => {
    const env = await setup([original])
    await env.choose(source(), { readError: new Error("File could not be read") })
    expect(env.status.textContent).toBe("File could not be read")
    expect(env.file.disabled).toBe(false)
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    expect(await env.store.list()).toEqual([original])
    await env.choose()
    expect(env.button("skills-import-reviewed").disabled).toBe(false)
  })

  test("handles cancellation and rejects multiple files even if the picker is bypassed", async () => {
    const env = await setup()
    const read = vi.fn()
    const chosen = new env.dom.window.File([source()], "SKILL.md")
    Object.defineProperty(chosen, "arrayBuffer", { value: read })
    Object.defineProperty(env.file, "files", { configurable: true, value: [chosen, chosen] })
    env.file.dispatchEvent(new env.dom.window.Event("change"))
    await settle()
    expect(env.status.textContent).toContain("Select one")
    expect(read).not.toHaveBeenCalled()
    Object.defineProperty(env.file, "files", { value: [] })
    env.file.dispatchEvent(new env.dom.window.Event("change"))
    await settle()
    expect(env.status.textContent).toBe("No file selected.")
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
  })

  test("reports an initial storage read failure without changing records", async () => {
    vi.spyOn(SkillStore.prototype, "list").mockRejectedValueOnce(new Error("Storage unavailable"))
    const env = await setup([original])
    expect(env.status.textContent).toBe("Storage unavailable")
    expect(env.storage.set).not.toHaveBeenCalled()
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    env.selectSkill()
    expect(env.installedPreview.textContent).toContain(original.body)
  })

  test.each(["import", "replace", "enable", "delete"])(
    "a failed %s preserves installed records and restores controls",
    async (action) => {
      const env = await setup([original])
      env.selectSkill()
      if (action === "import" || action === "replace") await env.choose()
      env.storage.set.mockRejectedValueOnce(new Error("Storage failed <img src=x>"))
      if (action === "enable") env.enabled.click()
      else if (action === "delete") {
        env.button("skills-delete").click()
        env.button("skills-confirm-delete").click()
      } else env.button(`skills-${action}-reviewed`).click()
      await settle()
      expect(await env.store.list()).toEqual([original])
      expect(env.status.textContent).toBe("Storage failed <img src=x>")
      expect(env.status.children).toHaveLength(0)
      expect(env.select.disabled).toBe(false)
      expect(env.enabled.checked).toBe(false)
      if (action === "import" || action === "replace") {
        expect(env.preview.textContent).toContain("Reviewed body")
        expect(env.button(`skills-${action}-reviewed`).disabled).toBe(false)
      }
    },
  )

  test("external storage changes refresh records and cancel pending deletion safely", async () => {
    const env = await setup([original])
    env.selectSkill()
    await env.choose()
    env.button("skills-delete").click()
    env.data[SKILLS_STORAGE_KEY] = { version: 1, records: [{ ...original, body: "External body" }] }
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    expect(env.dialog.open).toBe(false)
    expect(env.installedPreview.textContent).toContain("External body")
    expect(env.preview.textContent).toContain("Reviewed body")
    env.button("skills-confirm-delete").click()
    await settle()
    expect(await env.store.list()).toHaveLength(1)
    env.data[SKILLS_STORAGE_KEY] = { version: 1, records: [] }
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    expect(env.select.value).toBe("")
    expect(env.enabled.disabled).toBe(true)
  })

  test("rejects a stale replacement even before the external change event arrives", async () => {
    const env = await setup([original])
    env.selectSkill()
    await env.choose()
    const changed = { ...original, body: "More recent body" }
    env.data[SKILLS_STORAGE_KEY] = { version: 1, records: [changed] }
    env.button("skills-replace-reviewed").click()
    await settle()
    expect(await env.store.list()).toEqual([changed])
    expect(env.status.textContent).toContain("changed")
    expect(env.select.value).toBe("")
    expect(env.preview.textContent).toContain("Reviewed body")
  })

  test("preserves the native checkbox state while its write is pending", async () => {
    const env = await setup([original])
    env.selectSkill()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = env.storage.set.getMockImplementation()
    if (!save) throw new Error("Missing storage implementation")
    env.storage.set.mockImplementationOnce(async (values) => {
      await pending
      await save(values)
    })
    env.enabled.click()
    expect(env.enabled.checked).toBe(true)
    expect(env.enabled.disabled).toBe(true)
    await settle()
    expect(env.enabled.checked).toBe(true)
    release()
    await settle()
    expect(env.enabled.checked).toBe(true)
    expect(env.enabled.disabled).toBe(false)
    expect(await env.store.list()).toEqual([{ ...original, enabled: true }])
  })

  test.each(["enable", "replace", "delete"])(
    "rejects %s if another context replaces content after the review preflight",
    async (action) => {
      const env = await setup([original])
      env.selectSkill()
      if (action === "replace") await env.choose()
      const changed = { ...original, body: "Content not reviewed in this window" }
      env.storage.get.mockImplementationOnce(async (key: string) => {
        const result = { [key]: structuredClone(env.data[key]) }
        // No onChanged event yet: the atomic store check must still reject this write.
        env.data[SKILLS_STORAGE_KEY] = { version: 1, records: [changed] }
        return result
      })
      if (action === "enable") env.enabled.click()
      else if (action === "replace") env.button("skills-replace-reviewed").click()
      else {
        env.button("skills-delete").click()
        env.button("skills-confirm-delete").click()
      }
      await settle()
      expect(await env.store.list()).toEqual([changed])
      expect(env.storage.set).not.toHaveBeenCalled()
      expect(env.status.textContent).toContain("selected skill changed")
    },
  )

  test("ignores unrelated events and removes the storage listener on pagehide", async () => {
    const env = await setup([original])
    const reads = env.storage.get.mock.calls.length
    env.notify({ otherKey: {} })
    env.notify({ [SKILLS_STORAGE_KEY]: {} }, "sync")
    await settle()
    expect(env.storage.get).toHaveBeenCalledTimes(reads)
    env.hide()
    expect(env.removeListener).toHaveBeenCalledOnce()
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    expect(env.storage.get).toHaveBeenCalledTimes(reads)
  })

  test("does not finish a file review after pagehide", async () => {
    const env = await setup()
    let finish: ((value: ArrayBuffer) => void) | undefined
    const chosen = new env.dom.window.File([source()], "SKILL.md")
    Object.defineProperty(chosen, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve
        }),
    })
    Object.defineProperty(env.file, "files", { value: [chosen] })
    env.file.dispatchEvent(new env.dom.window.Event("change"))
    env.hide()
    finish?.(new TextEncoder().encode(source()).buffer)
    await settle()
    expect(env.preview.textContent).toBe("No file reviewed.")
    expect(env.storage.set).not.toHaveBeenCalled()
  })

  test("renders installed metadata as text and bounds defensive previews", async () => {
    const env = await setup()
    const malicious = {
      ...original,
      name: "<img src=x>",
      description: "<svg onload=alert(1)>",
      body: "x".repeat(SKILL_LIMITS.inputBytes + 1000),
    }
    vi.spyOn(SkillStore.prototype, "list").mockResolvedValue([malicious])
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    env.selectSkill()
    expect(env.select.options[1]?.textContent).toContain("<img src=x>")
    expect(env.select.querySelector("img")).toBeNull()
    expect(env.installedPreview.textContent).toContain("<svg onload=alert(1)>")
    expect(env.installedPreview.children).toHaveLength(0)
    expect(env.installedPreview.textContent?.length).toBeLessThan(SKILL_LIMITS.inputBytes + 200)
  })
})
