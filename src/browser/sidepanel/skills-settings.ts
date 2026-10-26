import { safeErrorMessage } from "../auth/redaction.js"
import { t, translateDiagnostic, translateKnownMessage } from "../i18n/index.js"
import { requestHostPermission } from "../permissions.js"
import { type ParsedSkill, parseSkill, SKILL_LIMITS, SkillError } from "../skills/format.js"
import {
  GITHUB_API_ORIGIN,
  type GitHubSkillListing,
  githubSkillSourceUrl,
  listGitHubSkills,
  parseGitHubRepository,
  readGitHubSkill,
} from "../skills/github.js"
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
  const repository = element<HTMLInputElement>("skills-github-repository")
  const findGitHub = element<HTMLButtonElement>("skills-github-fetch")
  const cancelFetch = element<HTMLButtonElement>("skills-github-cancel")
  const gitHubResults = element<HTMLElement>("skills-github-results")
  const candidates = element<HTMLSelectElement>("skills-github-candidates")
  const reviewGitHub = element<HTMLButtonElement>("skills-github-review")
  const sourceLink = element<HTMLAnchorElement>("skills-source-link")
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
  let listing: GitHubSkillListing | undefined
  let network: AbortController | undefined
  let deletion: SkillRecord | undefined
  let busy = false
  let disposed = false
  let refreshPending = false
  let focusAfterSave: HTMLElement | undefined

  function selected(): SkillRecord | undefined {
    return records.find((record) => record.id === selectedId)
  }

  function textPreview(skill: Pick<ParsedSkill, "name" | "description" | "body">): string {
    return t("Name: {name}\n\nDescription: {description}\n\nBody:\n{body}", {
      name: skill.name.slice(0, SKILL_LIMITS.name),
      description: skill.description.slice(0, SKILL_LIMITS.description),
      body: skill.body.slice(0, SKILL_LIMITS.inputBytes),
    })
  }

  function updateControls(): void {
    const record = selected()
    installedControls.hidden = !record
    selectedName.textContent = record?.name ?? t("Selected skill")
    emptyState.hidden = records.length !== 0
    file.disabled = busy
    // A source edit can cancel a pending fetch without waiting for its response.
    repository.disabled = busy && !network
    findGitHub.disabled = busy || !repository.value.trim()
    cancelFetch.hidden = !network
    cancelFetch.disabled = !network || network.signal.aborted
    gitHubResults.hidden = !listing
    candidates.disabled = busy || !listing?.candidates.length
    reviewGitHub.disabled = busy || !listing || !candidates.value
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
    installedPreview.textContent = record ? textPreview(record) : t("No installed skill selected.")
    onStateChange()
  }

  function clearReview(): void {
    reviewed = undefined
    file.value = ""
    preview.textContent = t("No file reviewed.")
    sourceLink.hidden = true
    sourceLink.removeAttribute("href")
    updateControls()
  }

  function clearListing(): void {
    listing = undefined
    const placeholder = document.createElement("option")
    placeholder.value = ""
    placeholder.textContent = t("Select a SKILL.md")
    candidates.replaceChildren(placeholder)
  }

  function showReview(
    bytes: Uint8Array,
    origin?: { listing: GitHubSkillListing; path: string },
  ): void {
    const parsed = parseSkill(bytes)
    const warnings = parsed.warnings
      .slice(0, 20)
      .map((warning) => translateKnownMessage(warning))
      .join("\n")
    const parts = [textPreview(parsed)]
    if (origin) {
      const candidate = origin.listing.candidates.find((item) => item.path === origin.path)
      if (!candidate) throw new SkillError("Select a GitHub SKILL.md to review.")
      const url = githubSkillSourceUrl(origin.listing, candidate)
      parts.push(
        t("Repository: {repository}\nPath: {path}\nCommit: {commit}", {
          repository: origin.listing.repository,
          path: candidate.path,
          commit: origin.listing.commit,
        }),
      )
      sourceLink.href = url
      sourceLink.hidden = false
    }
    parts.push(
      t("Original SKILL.md:\n{source}", {
        source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      }),
    )
    preview.textContent = t("{preview}\n\nCompatibility warnings:\n{warnings}", {
      preview: parts.join("\n\n"),
      warnings:
        warnings ||
        t("No specific warnings. Static review cannot detect every unsupported dependency."),
    })
    reviewed = parsed
    status.textContent = t(
      "Review the name, description, body, and warnings before saving. Nothing has been imported.",
    )
  }

  function fetchGitHub(
    action: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ): void {
    if (busy || disposed) return
    const operation = new AbortController()
    network = operation
    const current = () => !disposed && network === operation && !operation.signal.aborted
    void perform(async () => {
      try {
        await action(operation.signal, current)
      } catch (error) {
        if (!operation.signal.aborted) throw error
      } finally {
        if (network === operation) network = undefined
      }
    })
  }

  async function awaitHostApproval(
    approval: Promise<boolean>,
    signal: AbortSignal,
  ): Promise<boolean> {
    let onAbort = () => {}
    const cancelled = new Promise<boolean>((resolve) => {
      onAbort = () => resolve(false)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try {
      // Chrome's prompt cannot be dismissed here. A late grant must not resume cancelled work.
      return await Promise.race([approval, cancelled])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
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
      entry.badge.textContent = record.enabled ? t("Enabled") : t("Disabled")
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
      repository,
      findGitHub,
      candidates,
      reviewGitHub,
      enabled,
      importButton,
      replaceButton,
      deleteButton,
      ...Array.from(items.values(), ({ button }) => button),
    ].find((control) => control === document.activeElement)
    busy = true
    updateControls()
    if (reportWorking) status.textContent = t("Working…")
    try {
      await action()
    } catch (error) {
      if (!disposed)
        setErrorOutput(
          status,
          error instanceof SkillError
            ? translateKnownMessage(safeErrorMessage(error))
            : translateDiagnostic(error),
        )
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
      throw new Error(t("The selected skill changed. Select and review it again."))
    }
  }

  function refreshFromStorage(): void {
    closeDeletion()
    void perform(async () => {
      await refresh()
    }, false)
  }

  repository.addEventListener("input", () => {
    if (disposed) return
    network?.abort()
    clearListing()
    clearReview()
    status.textContent = t("Repository changed. Find GitHub skills again.")
  })
  cancelFetch.addEventListener("click", () => {
    if (!network || disposed) return
    network.abort()
    status.textContent = t("GitHub fetch cancelled.")
    updateControls()
  })
  findGitHub.addEventListener("click", () => {
    fetchGitHub(async (signal, current) => {
      const name = parseGitHubRepository(repository.value)
      clearListing()
      clearReview()
      // No asynchronous work before this call: Chrome requires the button gesture.
      const granted = await awaitHostApproval(requestHostPermission(GITHUB_API_ORIGIN), signal)
      if (!current()) return
      if (!granted)
        throw new SkillError("GitHub access was not granted. Local file import is still available.")
      const result = await listGitHubSkills(name, signal)
      if (!current()) return
      listing = result
      for (const candidate of result.candidates) {
        const option = document.createElement("option")
        option.value = candidate.path
        option.textContent = candidate.path
        candidates.append(option)
      }
      status.textContent = result.candidates.length
        ? t("GitHub results: {total}. Select one SKILL.md to review.", {
            total: result.candidates.length,
          })
        : t("No SKILL.md files found at the repository root or under skills/.")
      focusAfterSave = candidates
    })
  })
  candidates.addEventListener("change", () => {
    if (busy || disposed) return
    clearReview()
  })
  reviewGitHub.addEventListener("click", () => {
    const snapshot = listing
    const candidate = snapshot?.candidates.find((item) => item.path === candidates.value)
    if (!snapshot || !candidate) return
    fetchGitHub(async (signal, current) => {
      clearReview()
      const bytes = await readGitHubSkill(snapshot, candidate, signal)
      if (!current()) return
      showReview(bytes, { listing: snapshot, path: candidate.path })
      focusAfterSave = preview
    })
  })

  file.addEventListener("change", () => {
    // Capture FileList before clearing the input so the same file can be selected again.
    const count = file.files?.length ?? 0
    const chosen = file.files?.[0]
    void perform(async () => {
      clearListing()
      clearReview()
      if (!chosen || count === 0) {
        status.textContent = t("No file selected.")
        return
      }
      if (count !== 1 || chosen.name !== "SKILL.md")
        throw new Error(t("Select one UTF-8 text file named SKILL.md."))
      if (chosen.size > SKILL_LIMITS.inputBytes)
        throw new Error(
          t("SKILL.md must be at most {bytes} bytes.", { bytes: SKILL_LIMITS.inputBytes }),
        )
      const bytes = new Uint8Array(await chosen.arrayBuffer())
      if (disposed) return
      showReview(bytes)
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
      status.textContent = t("Skill imported disabled. Review and enable it for the next run.")
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
      status.textContent = t("Selected skill replaced and disabled. Changes apply to the next run.")
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
        status.textContent = value
          ? t("Skill enabled for the next run.")
          : t("Skill disabled for the next run.")
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
      await refresh("")
      focusAfterSave = items.values().next().value?.button ?? file
      status.textContent = t("Skill deleted. Previous session history is retained.")
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
      network?.abort()
      clearListing()
      closeDeletion()
      clearReview()
      chrome.storage.onChanged.removeListener(changed)
    },
    { once: true },
  )
  clearListing()
  clearReview()
  await perform(async () => {
    await refresh("")
    if (!disposed)
      status.textContent = t("Skills save independently. Imported skills start disabled.")
  })
  return {
    hasDraft: () => !disposed && reviewed !== undefined,
    isBusy: () => !disposed && busy,
  }
}
