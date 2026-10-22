import { type ParsedSkill, parseSkill, SKILL_LIMITS } from "../skills/format.js"
import { SKILLS_STORAGE_KEY, type SkillRecord, SkillStore } from "../skills/store.js"
import { element, setErrorOutput } from "./ui.js"

/** Skill controls save independently of the general Settings form. */
export async function initializeSkillsSettings(): Promise<void> {
  const store = new SkillStore()
  const select = element<HTMLSelectElement>("skills-list")
  const file = element<HTMLInputElement>("skills-file-input")
  const installedPreview = element<HTMLElement>("skills-installed-preview")
  const preview = element<HTMLElement>("skills-preview")
  const status = element<HTMLElement>("skills-status")
  const enabled = element<HTMLInputElement>("skills-enabled")
  const importButton = element<HTMLButtonElement>("skills-import-reviewed")
  const replaceButton = element<HTMLButtonElement>("skills-replace-reviewed")
  const deleteButton = element<HTMLButtonElement>("skills-delete")
  const dialog = element<HTMLDialogElement>("skills-delete-dialog")
  const deleteName = element<HTMLElement>("skills-delete-name")
  const confirmDelete = element<HTMLButtonElement>("skills-confirm-delete")
  const cancelDelete = element<HTMLButtonElement>("skills-cancel-delete")
  let records: SkillRecord[] = []
  let reviewed: ParsedSkill | undefined
  let deletion: SkillRecord | undefined
  let busy = false
  let disposed = false
  let refreshPending = false
  let focusAfterSave: HTMLElement | undefined

  function selected(): SkillRecord | undefined {
    return records.find((record) => record.id === select.value)
  }

  function textPreview(skill: Pick<ParsedSkill, "name" | "description" | "body">): string {
    return `Name: ${skill.name.slice(0, SKILL_LIMITS.name)}\n\nDescription: ${skill.description.slice(0, SKILL_LIMITS.description)}\n\nBody:\n${skill.body.slice(0, SKILL_LIMITS.inputBytes)}`
  }

  function updateControls(): void {
    const record = selected()
    select.disabled = file.disabled = busy
    enabled.disabled = deleteButton.disabled = busy || !record
    if (!busy) enabled.checked = record?.enabled ?? false
    importButton.disabled = busy || !reviewed
    replaceButton.disabled = busy || !reviewed || !record
    confirmDelete.disabled = busy || !deletion
    cancelDelete.disabled = busy
    installedPreview.textContent = record ? textPreview(record) : "No installed skill selected."
  }

  function clearReview(): void {
    reviewed = undefined
    file.value = ""
    preview.textContent = "No file reviewed."
  }

  function closeDeletion(): void {
    deletion = undefined
    if (dialog.open) dialog.close()
  }

  async function refresh(id = select.value): Promise<void> {
    const current = await store.list()
    if (disposed) return
    records = current
    const empty = document.createElement("option")
    empty.value = ""
    empty.textContent = "Select an installed skill"
    select.replaceChildren(
      empty,
      ...records.map((record) => {
        const option = document.createElement("option")
        option.value = record.id
        option.textContent = `${record.name} (${record.enabled ? "enabled" : "disabled"})`
        return option
      }),
    )
    select.value = records.some((record) => record.id === id) ? id : ""
    updateControls()
  }

  async function perform(action: () => Promise<void>, reportWorking = true): Promise<void> {
    if (busy || disposed) return
    busy = true
    updateControls()
    if (reportWorking) status.textContent = "Working…"
    try {
      await action()
    } catch (error) {
      if (!disposed) setErrorOutput(status, error)
    } finally {
      busy = false
      if (!disposed) {
        updateControls()
        if (refreshPending) {
          refreshPending = false
          refreshFromStorage()
        } else if (focusAfterSave) {
          const target = focusAfterSave
          focusAfterSave = undefined
          if (!target.hasAttribute("disabled")) target.focus()
        }
      }
    }
  }

  // The API has stable IDs. Do not apply a reviewed action to a changed record.
  async function requireUnchanged(record: SkillRecord): Promise<void> {
    const current = (await store.list()).find((item) => item.id === record.id)
    if (
      !current ||
      current.name !== record.name ||
      current.description !== record.description ||
      current.body !== record.body ||
      current.enabled !== record.enabled
    ) {
      await refresh("")
      throw new Error("The selected skill changed. Select and review it again.")
    }
  }

  function refreshFromStorage(): void {
    closeDeletion()
    void perform(async () => {
      await refresh()
    }, false)
  }

  select.addEventListener("change", () => {
    closeDeletion()
    updateControls()
  })
  file.addEventListener("change", () => {
    // Capture FileList before clearing the input so the same file can be selected again.
    const count = file.files?.length ?? 0
    const chosen = file.files?.[0]
    void perform(async () => {
      clearReview()
      if (!chosen || count === 0) {
        status.textContent = "No file selected."
        return
      }
      if (count !== 1 || chosen.name !== "SKILL.md")
        throw new Error("Select one UTF-8 text file named SKILL.md.")
      if (chosen.size > SKILL_LIMITS.inputBytes)
        throw new Error(`SKILL.md must be at most ${SKILL_LIMITS.inputBytes} bytes.`)
      const bytes = new Uint8Array(await chosen.arrayBuffer())
      if (disposed) return
      const parsed = parseSkill(bytes)
      reviewed = parsed
      const warnings = parsed.warnings
        .slice(0, 20)
        .map((warning) => warning.slice(0, SKILL_LIMITS.description))
        .join("\n")
      preview.textContent = `${textPreview(parsed)}\n\nCompatibility warnings:\n${warnings || "No specific warnings. Static review cannot detect every unsupported dependency."}`
      status.textContent =
        "Review the name, description, body, and warnings before saving. Nothing has been imported."
    })
  })

  importButton.addEventListener("click", () => {
    const parsed = reviewed
    if (!parsed) return
    void perform(async () => {
      await store.import(parsed)
      if (disposed) return
      clearReview()
      await refresh("")
      focusAfterSave = select
      status.textContent =
        "Skill imported disabled. Select it to review and enable it for the next run."
    })
  })
  replaceButton.addEventListener("click", () => {
    const record = selected()
    const parsed = reviewed
    if (!record || !parsed) return
    void perform(async () => {
      await requireUnchanged(record)
      if (disposed) return
      await store.replace(record.id, parsed, record)
      if (disposed) return
      clearReview()
      await refresh("")
      focusAfterSave = select
      status.textContent = "Selected skill replaced and disabled. Changes apply to the next run."
    })
  })
  enabled.addEventListener("change", () => {
    const record = selected()
    const value = enabled.checked
    if (!record) return
    if (document.activeElement === enabled) focusAfterSave = enabled
    void perform(async () => {
      await requireUnchanged(record)
      if (disposed) return
      await store.setEnabled(record.id, value, record)
      await refresh(record.id)
      if (!disposed)
        status.textContent = `Skill ${value ? "enabled" : "disabled"} for the next run.`
    })
  })
  deleteButton.addEventListener("click", () => {
    if (busy || disposed || dialog.open) return
    const record = selected()
    if (!record) return
    deletion = { ...record }
    deleteName.textContent = record.name.slice(0, SKILL_LIMITS.name)
    updateControls()
    dialog.showModal()
    cancelDelete.focus()
  })
  cancelDelete.addEventListener("click", closeDeletion)
  dialog.addEventListener("close", () => {
    deletion = undefined
    updateControls()
  })
  dialog.addEventListener("cancel", (event) => {
    // Stop the Settings page Escape handler from closing the whole page.
    event.preventDefault()
    closeDeletion()
  })
  confirmDelete.addEventListener("click", () => {
    const record = deletion
    if (!record || !dialog.open) return
    closeDeletion()
    void perform(async () => {
      await requireUnchanged(record)
      if (disposed) return
      await store.remove(record.id, record)
      if (disposed) return
      clearReview()
      await refresh("")
      focusAfterSave = select
      status.textContent = "Skill deleted. Previous session history is retained."
    })
  })

  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (disposed || area !== "local" || !(SKILLS_STORAGE_KEY in changes)) return
    if (busy) {
      refreshPending = true
      closeDeletion()
    } else refreshFromStorage()
  }
  chrome.storage.onChanged.addListener(changed)
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true
      closeDeletion()
      clearReview()
      chrome.storage.onChanged.removeListener(changed)
    },
    { once: true },
  )
  clearReview()
  await perform(async () => {
    await refresh("")
    if (!disposed) status.textContent = "Skills save independently. Imported skills start disabled."
  })
}
