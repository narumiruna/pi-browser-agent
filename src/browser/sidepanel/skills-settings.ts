import { type ParsedSkill, parseSkill, SKILL_LIMITS } from "../skills/format.js"
import { SKILLS_STORAGE_KEY, type SkillRecord, SkillStore } from "../skills/store.js"
import { element, type SettingsSectionState, setErrorOutput } from "./ui.js"

/** Skill controls save independently. Report unsaved reviews and pending operations. */
export async function initializeSkillsSettings(
  onStateChange: () => void = () => {},
): Promise<SettingsSectionState> {
  const store = new SkillStore()
  const list = element<HTMLUListElement>("skills-list")
  const selectedName = element<HTMLElement>("skills-selected-name")
  const review = element<HTMLElement>("skills-review")
  const installedControls = element<HTMLElement>("skills-installed-controls")
  const emptyState = element<HTMLElement>("skills-empty")
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
  let selectedId = ""
  const items = new Map<
    string,
    {
      item: HTMLLIElement
      button: HTMLButtonElement
      name: HTMLElement
      description: HTMLElement
      badge: HTMLElement
    }
  >()
  let reviewed: ParsedSkill | undefined
  let deletion: SkillRecord | undefined
  let busy = false
  let disposed = false
  let refreshPending = false
  let focusAfterSave: HTMLElement | undefined

  function selected(): SkillRecord | undefined {
    return records.find((record) => record.id === selectedId)
  }

  function textPreview(skill: Pick<ParsedSkill, "name" | "description" | "body">): string {
    return `Name: ${skill.name.slice(0, SKILL_LIMITS.name)}\n\nDescription: ${skill.description.slice(0, SKILL_LIMITS.description)}\n\nBody:\n${skill.body.slice(0, SKILL_LIMITS.inputBytes)}`
  }

  function updateControls(): void {
    const record = selected()
    installedControls.hidden = !record
    selectedName.textContent = record?.name ?? "Selected skill"
    emptyState.hidden = records.length !== 0
    file.disabled = busy
    for (const [id, { button }] of items) {
      button.disabled = busy
      button.setAttribute("aria-pressed", String(id === selectedId))
    }
    review.hidden = !reviewed
    importButton.hidden = !reviewed
    replaceButton.hidden = !reviewed || !record
    enabled.disabled = deleteButton.disabled = busy || !record
    if (!busy) enabled.checked = record?.enabled ?? false
    importButton.disabled = busy || !reviewed
    replaceButton.disabled = busy || !reviewed || !record
    confirmDelete.disabled = busy || !deletion
    cancelDelete.disabled = busy
    installedPreview.textContent = record ? textPreview(record) : "No installed skill selected."
    onStateChange()
  }

  function clearReview(): void {
    reviewed = undefined
    file.value = ""
    preview.textContent = "No file reviewed."
    updateControls()
  }

  function closeDeletion(): void {
    deletion = undefined
    if (dialog.open) dialog.close()
  }

  async function refresh(id = selectedId): Promise<void> {
    const current = await store.list()
    if (disposed) return
    records = current
    selectedId = records.some((record) => record.id === id) ? id : ""
    for (const [key, entry] of items) {
      if (!records.some((record) => record.id === key)) {
        entry.item.remove()
        items.delete(key)
      }
    }
    for (const [index, record] of records.entries()) {
      let entry = items.get(record.id)
      if (!entry) {
        const item = document.createElement("li")
        const button = document.createElement("button")
        button.type = "button"
        button.className = "resource-item"
        button.dataset.skillId = record.id
        const text = document.createElement("span")
        text.className = "resource-item-text"
        const name = document.createElement("strong")
        const description = document.createElement("small")
        const badge = document.createElement("span")
        badge.className = "state-badge"
        text.append(name, description)
        button.append(text, badge)
        item.append(button)
        const skillId = record.id
        button.addEventListener("click", () => {
          if (busy || disposed) return
          closeDeletion()
          selectedId = skillId
          updateControls()
        })
        entry = { item, button, name, description, badge }
        items.set(record.id, entry)
      }
      entry.name.textContent = record.name
      entry.description.textContent = record.description
      entry.badge.textContent = record.enabled ? "Enabled" : "Disabled"
      // Keep existing buttons attached so storage refresh does not remove keyboard focus.
      if (list.children[index] !== entry.item)
        list.insertBefore(entry.item, list.children[index] ?? null)
    }
    updateControls()
  }

  async function perform(action: () => Promise<void>, reportWorking = true): Promise<void> {
    if (busy || disposed) return
    const focusedControl = [
      file,
      enabled,
      importButton,
      replaceButton,
      deleteButton,
      ...Array.from(items.values(), ({ button }) => button),
    ].find((control) => control === document.activeElement)
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
        // Disabling a focused control can move native focus to the document body.
        // Restore only that lost focus, never focus moved to another control.
        if (
          focusedControl?.isConnected &&
          !focusedControl.hasAttribute("disabled") &&
          !focusedControl.closest("[hidden]") &&
          document.activeElement === document.body
        )
          focusedControl.focus()
        if (refreshPending) {
          refreshPending = false
          refreshFromStorage()
        } else if (focusAfterSave) {
          const target = focusAfterSave.isConnected ? focusAfterSave : file
          focusAfterSave = undefined
          if (!target.hasAttribute("disabled") && !target.closest("[hidden]")) target.focus()
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
      const record = await store.import(parsed)
      if (disposed) return
      clearReview()
      await refresh(record.id)
      focusAfterSave = items.get(record.id)?.button ?? file
      status.textContent = "Skill imported disabled. Review and enable it for the next run."
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
      await refresh(record.id)
      focusAfterSave = items.get(record.id)?.button ?? file
      status.textContent = "Selected skill replaced and disabled. Changes apply to the next run."
    })
  })
  enabled.addEventListener("change", () => {
    const record = selected()
    const value = enabled.checked
    if (!record) return
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
      focusAfterSave = items.values().next().value?.button ?? file
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
  return {
    hasDraft: () => !disposed && reviewed !== undefined,
    isBusy: () => !disposed && busy,
  }
}
