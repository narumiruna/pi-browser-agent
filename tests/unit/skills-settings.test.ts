import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as i18n from "../../src/browser/i18n/index.js"
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
  const onStateChange = vi.fn()
  const state = await initializeSkillsSettings(onStateChange)
  const file = get<HTMLInputElement>("skills-file-input")
  const list = get<HTMLUListElement>("skills-list")
  const selectionButton = (value = id) => {
    const button = Array.from(list.querySelectorAll("button")).find(
      (button) => button.dataset.skillId === value,
    )
    if (!button) throw new Error(`Missing skill button: ${value}`)
    return button
  }
  const selectedButton = () => list.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
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
  const selectSkill = (value = id) => selectionButton(value).click()
  return {
    dom,
    document,
    get,
    file,
    list,
    selectionButton,
    selectedButton,
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
    state,
    onStateChange,
    review: get<HTMLElement>("skills-review"),
    selectedName: get<HTMLElement>("skills-selected-name"),
    installedControls: get<HTMLElement>("skills-installed-controls"),
    emptyState: get<HTMLElement>("skills-empty"),
    store: new SkillStore(),
    preview: get<HTMLElement>("skills-preview"),
    installedPreview: get<HTMLElement>("skills-installed-preview"),
    status: get<HTMLElement>("skills-status"),
  }
}

describe("Skills settings", () => {
  test("translates only skill-owned errors, not arbitrary exceptions with the same text", async () => {
    const env = await setup()
    const translate = vi
      .spyOn(i18n, "translateKnownMessage")
      .mockImplementation((message) => `Localized: ${message}`)
    const message = "Skill must start with frontmatter enclosed by --- delimiter lines"
    await env.choose("not frontmatter")
    expect(env.status.textContent).toBe(`Localized: ${message}`)
    expect(translate).toHaveBeenCalledWith(message)
    translate.mockClear()
    await env.choose(source(), { readError: new Error(message) })
    expect(env.status.textContent).toBe(message)
    expect(translate).not.toHaveBeenCalled()
    expect(env.state.hasDraft()).toBe(false)
  })

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
    expect(env.state.hasDraft()).toBe(false)
    expect(env.state.isBusy()).toBe(false)
    expect(env.review.hidden).toBe(true)
    expect(env.list.children).toHaveLength(0)
    expect(env.installedControls.hidden).toBe(true)
    expect(env.emptyState.hidden).toBe(false)
    expect(env.emptyState.textContent).toContain("No skills installed.")
    await env.choose()
    expect(env.preview.textContent).toContain("Reviewed body")
    expect(env.state.hasDraft()).toBe(true)
    expect(env.review.hidden).toBe(false)
    expect(env.installedControls.hidden).toBe(true)
  })

  test("uses labeled native keyboard controls and explains disclosure and retention", async () => {
    const env = await setup()
    expect(env.file.type).toBe("file")
    expect(env.file.multiple).toBe(false)
    expect(env.file.accept).toContain(".md")
    expect(env.list.tagName).toBe("UL")
    expect(env.list.getAttribute("aria-label")).toBe("Installed skills")
    expect(env.list.querySelector("select")).toBeNull()
    expect(env.enabled.type).toBe("checkbox")
    expect(env.file.labels?.length).toBe(1)
    expect(env.enabled.labels?.length).toBe(1)
    expect(env.status.getAttribute("role")).toBe("status")
    expect(env.preview.tabIndex).toBe(0)
    env.file.focus()
    expect(env.document.activeElement).toBe(env.file)
    expect(env.file.tabIndex).toBe(0)
    for (const name of ["skills-import-reviewed", "skills-replace-reviewed", "skills-delete"])
      expect(env.button(name).disabled).toBe(true)
    const section = env.file.closest("section")?.textContent
    expect(section).toContain("Scripts and supporting files are not supported")
    expect(section).toContain("only when you submit a chat message")
    expect(section).toContain("saved session history")
    expect(section).toContain("next run, not an active run")
    expect(section).toContain("save independently")
    expect(section).toContain("Save general settings")
    const help = env.file.closest("section")?.querySelector("details")
    expect(help?.querySelector("summary")?.textContent).toBe("Skill requirements and data sharing")
    expect(help?.open).toBe(false)
    expect(help?.textContent).toContain("only when you submit a chat message")
    expect(env.preview.closest("details")).toBeNull()
    expect(env.button("skills-import-reviewed").closest("details")).toBeNull()
    await env.choose()
    env.preview.focus()
    expect(env.document.activeElement).toBe(env.preview)
  })

  test("lists installed names, descriptions, and states without selecting a record", async () => {
    const second = {
      ...original,
      id: "00000000-0000-4000-8000-000000000002",
      name: "other",
      enabled: true,
    }
    const env = await setup([original, second])
    expect(env.list.children).toHaveLength(2)
    expect(env.installedControls.hidden).toBe(true)
    expect(env.selectedButton()).toBeNull()
    for (const record of [original, second]) {
      const button = env.selectionButton(record.id)
      expect(button.parentElement?.tagName).toBe("LI")
      expect(button.type).toBe("button")
      expect(button.tabIndex).toBe(0)
      expect(button.getAttribute("aria-pressed")).toBe("false")
      expect(button.textContent).toContain(record.name)
      expect(button.textContent).toContain(record.description)
      expect(button.textContent).toContain(record.enabled ? "Enabled" : "Disabled")
    }
    env.selectionButton().focus()
    env.selectionButton().click()
    expect(env.document.activeElement).toBe(env.selectionButton())
    expect(env.selectedName.textContent).toBe(original.name)
    expect(env.installedControls.hidden).toBe(false)
    env.selectSkill(second.id)
    expect(env.selectionButton().getAttribute("aria-pressed")).toBe("false")
    expect(env.selectedButton()).toBe(env.selectionButton(second.id))
    expect(env.enabled.checked).toBe(true)
    expect(env.list.hidden).toBe(false)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.storage.set).not.toHaveBeenCalled()
  })

  test("keeps full long metadata visible through the installed-record limit", async () => {
    const records = Array.from({ length: SKILL_LIMITS.installed }, (_, index) => ({
      ...original,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `skill-${index}-${"x".repeat(50)}`,
      description: "d".repeat(SKILL_LIMITS.description),
    }))
    const env = await setup(records)
    expect(env.list.children).toHaveLength(SKILL_LIMITS.installed)
    for (const record of records) {
      const button = env.selectionButton(record.id)
      expect(button.querySelector("strong")?.textContent).toBe(record.name)
      expect(button.querySelector("small")?.textContent).toBe(record.description)
    }
  })

  test("shows replacement only after valid review with an explicit installed target", async () => {
    const env = await setup([original])
    expect(env.review.hidden).toBe(true)
    expect(env.button("skills-import-reviewed").hidden).toBe(true)
    expect(env.button("skills-replace-reviewed").hidden).toBe(true)
    env.selectSkill()
    expect(env.review.hidden).toBe(true)
    expect(env.button("skills-replace-reviewed").hidden).toBe(true)
    await env.choose()
    expect(env.review.hidden).toBe(false)
    expect(env.button("skills-import-reviewed").hidden).toBe(false)
    expect(env.button("skills-replace-reviewed").hidden).toBe(false)
    expect(env.selectedName.textContent).toBe(original.name)
    await env.choose("invalid")
    expect(env.review.hidden).toBe(true)
    expect(env.button("skills-replace-reviewed").hidden).toBe(true)
    expect(env.selectedButton()).toBe(env.selectionButton())
  })

  test("preserves selected buttons and keyboard focus across storage refresh", async () => {
    const env = await setup([original])
    env.selectSkill()
    const button = env.selectionButton()
    button.focus()
    env.data[SKILLS_STORAGE_KEY] = {
      version: 1,
      records: [{ ...original, description: "Updated description", enabled: true }],
    }
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    expect(env.selectionButton()).toBe(button)
    expect(env.selectedButton()).toBe(button)
    expect(env.document.activeElement).toBe(button)
    expect(button.textContent).toContain("Updated description")
    expect(env.enabled.checked).toBe(true)
    env.file.focus()
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    await settle()
    expect(env.document.activeElement).toBe(env.file)
  })

  test("does not take focus back when it moves during an asynchronous refresh", async () => {
    const env = await setup([original])
    env.selectSkill()
    env.selectionButton().focus()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const get = env.storage.get.getMockImplementation()
    env.storage.get.mockImplementationOnce(async (key) => {
      await pending
      return (await get?.(key)) ?? {}
    })
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    const other = env.get<HTMLButtonElement>("settings-tab-appearance")
    other.focus()
    release()
    await settle()
    expect(env.document.activeElement).toBe(other)
    expect(env.selectedButton()).toBe(env.selectionButton())
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
    const installed = (await env.store.list())[0]
    expect(env.selectedButton()?.dataset.skillId).toBe(installed?.id)
    expect(env.document.activeElement).toBe(env.selectedButton())
    expect(env.enabled.checked).toBe(false)
    expect(env.review.hidden).toBe(true)
    expect(env.file.value).toBe("")
    expect(env.preview.textContent).toBe("No file reviewed.")
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    expect(env.status.textContent).toContain("imported disabled")
    expect(env.installedControls.hidden).toBe(false)
    expect(env.emptyState.hidden).toBe(true)
    expect(env.state.hasDraft()).toBe(false)
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
    expect(env.state.isBusy()).toBe(true)
    expect(env.state.hasDraft()).toBe(true)
    expect(env.button("skills-import-reviewed").disabled).toBe(true)
    env.notify({ [SKILLS_STORAGE_KEY]: {} })
    release?.()
    await settle()
    expect(await env.store.list()).toHaveLength(1)
    expect(env.storage.set).toHaveBeenCalledOnce()
    expect(env.status.textContent).toContain("imported disabled")
    expect(env.state.isBusy()).toBe(false)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.document.activeElement).toBe(env.selectedButton())
  })

  test("previews an installed skill and saves enable/disable independently", async () => {
    const env = await setup([original])
    env.selectSkill()
    expect(env.installedPreview.textContent).toContain(original.body)
    expect(env.installedControls.hidden).toBe(false)
    expect(env.emptyState.hidden).toBe(true)
    env.enabled.focus()
    env.enabled.click()
    await settle()
    expect((await env.store.list())[0]?.enabled).toBe(true)
    expect(env.enabled.checked).toBe(true)
    expect(env.document.activeElement).toBe(env.enabled)
    expect(env.selectedButton()?.dataset.skillId).toBe(id)
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
    expect(env.selectedButton()?.dataset.skillId).toBe(id)
    expect(env.document.activeElement).toBe(env.selectionButton())
    expect(env.review.hidden).toBe(true)
    expect(env.enabled.checked).toBe(false)
    expect(env.preview.textContent).toBe("No file reviewed.")
  })

  test("replacement changes only the explicitly selected target", async () => {
    const second = {
      ...original,
      id: "00000000-0000-4000-8000-000000000002",
      name: "second-skill",
      enabled: true,
    }
    const env = await setup([original, second])
    env.selectSkill()
    await env.choose(source("replacement", "Replacement body"))
    env.selectSkill(second.id)
    expect(env.selectedName.textContent).toBe(second.name)
    expect(env.button("skills-replace-reviewed").hidden).toBe(false)
    env.button("skills-replace-reviewed").click()
    await settle()
    expect(await env.store.list()).toEqual([
      original,
      {
        id: second.id,
        name: "replacement",
        description: "A useful skill",
        body: "Replacement body",
        enabled: false,
      },
    ])
    expect(env.selectedButton()?.dataset.skillId).toBe(second.id)
    expect(env.enabled.checked).toBe(false)
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
    expect(env.state.hasDraft()).toBe(true)
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
    expect(env.selectedButton()).toBeNull()
    expect(env.list.children).toHaveLength(0)
    expect(env.status.textContent).toContain("Previous session history is retained")
    expect(env.installedControls.hidden).toBe(true)
    expect(env.emptyState.hidden).toBe(false)
    expect(env.document.activeElement).toBe(env.file)
  })

  test("deleting an installed skill preserves an unrelated review for later import", async () => {
    const remaining = {
      ...original,
      id: "00000000-0000-4000-8000-000000000002",
      name: "remaining-skill",
    }
    const env = await setup([original, remaining])
    env.selectSkill()
    await env.choose(source("new-skill", "Reviewed body\nReview scripts/task.py as text."))
    const preview = env.preview.textContent
    expect(env.state.hasDraft()).toBe(true)
    env.button("skills-delete").click()
    env.button("skills-confirm-delete").click()
    await settle()
    expect(await env.store.list()).toEqual([remaining])
    expect(env.dialog.open).toBe(false)
    expect(env.selectedButton()).toBeNull()
    expect(env.installedControls.hidden).toBe(true)
    expect(env.document.activeElement).toBe(env.selectionButton(remaining.id))
    expect(env.state.isBusy()).toBe(false)
    expect(env.state.hasDraft()).toBe(true)
    expect(env.review.hidden).toBe(false)
    expect(env.preview.textContent).toBe(preview)
    expect(env.button("skills-import-reviewed").hidden).toBe(false)
    expect(env.button("skills-import-reviewed").disabled).toBe(false)
    expect(env.button("skills-replace-reviewed").hidden).toBe(true)
    expect(env.status.textContent).toContain("Skill deleted")

    env.button("skills-import-reviewed").click()
    await settle()
    expect(await env.store.list()).toEqual([
      remaining,
      {
        id: expect.any(String),
        name: "new-skill",
        description: "A useful skill",
        body: "Reviewed body\nReview scripts/task.py as text.",
        enabled: false,
      },
    ])
    expect(env.state.hasDraft()).toBe(false)
    expect(env.review.hidden).toBe(true)
    expect(env.document.activeElement).toBe(env.selectedButton())
  })

  test.each([
    { name: "other.md", size: 10, message: "named SKILL.md" },
    { name: "SKILL.md", size: SKILL_LIMITS.inputBytes + 1, message: "at most 65,536 bytes" },
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
    expect(env.state.hasDraft()).toBe(false)
    expect(env.review.hidden).toBe(true)
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
      if (action !== "enable") await env.choose()
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
      expect(env.selectionButton().disabled).toBe(false)
      expect(env.state.isBusy()).toBe(false)
      expect(env.enabled.checked).toBe(false)
      if (action !== "enable") {
        expect(env.preview.textContent).toContain("Reviewed body")
        expect(env.review.hidden).toBe(false)
        expect(env.state.hasDraft()).toBe(true)
        expect(env.button("skills-import-reviewed").disabled).toBe(false)
        expect(env.button("skills-replace-reviewed").disabled).toBe(false)
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
    expect(env.selectedButton()).toBeNull()
    expect(env.button("skills-replace-reviewed").hidden).toBe(true)
    expect(env.enabled.disabled).toBe(true)
    expect(env.installedControls.hidden).toBe(true)
    expect(env.emptyState.hidden).toBe(false)
    expect(env.state.hasDraft()).toBe(true)
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
    expect(env.selectedButton()).toBeNull()
    expect(env.button("skills-replace-reviewed").hidden).toBe(true)
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
    expect(env.state.hasDraft()).toBe(false)
    env.onStateChange.mockClear()
    env.enabled.click()
    expect(env.enabled.checked).toBe(true)
    expect(env.enabled.disabled).toBe(true)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.state.isBusy()).toBe(true)
    expect(env.onStateChange).toHaveBeenCalled()
    await settle()
    expect(env.enabled.checked).toBe(true)
    release()
    await settle()
    expect(env.enabled.checked).toBe(true)
    expect(env.enabled.disabled).toBe(false)
    expect(env.state.hasDraft()).toBe(false)
    expect(env.state.isBusy()).toBe(false)
    expect(await env.store.list()).toEqual([{ ...original, enabled: true }])
  })

  test("does not take keyboard focus back after an enable write and queued refresh", async () => {
    const env = await setup([original])
    env.selectSkill()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = env.storage.set.getMockImplementation()
    env.storage.set.mockImplementationOnce(async (values) => {
      await pending
      await save?.(values)
    })
    env.enabled.focus()
    env.enabled.click()
    const other = env.get<HTMLButtonElement>("settings-tab-appearance")
    other.focus()
    release()
    await settle()
    expect(env.document.activeElement).toBe(other)
    expect(env.enabled.checked).toBe(true)
    expect(env.selectedButton()?.dataset.skillId).toBe(id)
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

  test("reports file reading as busy, not as an unreviewed draft", async () => {
    const env = await setup()
    const states: { hasDraft: boolean; isBusy: boolean }[] = []
    env.onStateChange.mockImplementation(() => {
      states.push({ hasDraft: env.state.hasDraft(), isBusy: env.state.isBusy() })
    })
    let finish!: (value: ArrayBuffer) => void
    const chosen = new env.dom.window.File([source()], "SKILL.md")
    Object.defineProperty(chosen, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve
        }),
    })
    Object.defineProperty(env.file, "files", { value: [chosen] })
    env.file.dispatchEvent(new env.dom.window.Event("change"))
    expect(env.state.hasDraft()).toBe(false)
    expect(env.state.isBusy()).toBe(true)
    expect(env.review.hidden).toBe(true)
    finish(new TextEncoder().encode(source()).buffer)
    await settle()
    expect(env.state.hasDraft()).toBe(true)
    expect(env.state.isBusy()).toBe(false)
    expect(states).toContainEqual({ hasDraft: false, isBusy: true })
    expect(states.at(-1)).toEqual({ hasDraft: true, isBusy: false })
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
    expect(env.state.hasDraft()).toBe(false)
    expect(env.state.isBusy()).toBe(true)
    env.hide()
    expect(env.state.hasDraft()).toBe(false)
    expect(env.state.isBusy()).toBe(false)
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
    expect(env.selectionButton().textContent).toContain("<img src=x>")
    expect(env.selectionButton().textContent).toContain("<svg onload=alert(1)>")
    expect(env.list.querySelector("img, svg, script")).toBeNull()
    expect(env.installedPreview.textContent).toContain("<svg onload=alert(1)>")
    expect(env.installedPreview.children).toHaveLength(0)
    expect(env.installedPreview.textContent?.length).toBeLessThan(SKILL_LIMITS.inputBytes + 200)
  })
})
