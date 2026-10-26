import { safeErrorMessage } from "../auth/redaction.js"
import { t, translateDiagnostic } from "../i18n/index.js"
import type { SessionTreeItem } from "../sessions/session-tree.js"

interface SessionTreeDialogOptions {
  dialog: HTMLDialogElement
  list: HTMLElement
  error: HTMLElement
  onSelect: (id: string | null) => Promise<void>
}

type DialogTreeItem = Omit<SessionTreeItem, "id" | "role"> & { id: string | null; role: string }

interface TreeRow {
  id: string | null
  parentId: string | null
  selectable: boolean
  element: HTMLElement
}

function boundedText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160)
}

export class SessionTreeDialog {
  private rows: TreeRow[] = []
  private pending = false
  private invokingElement: HTMLElement | null = null
  private readonly cancel: HTMLButtonElement | null
  private readonly labelsList: boolean

  constructor(private readonly options: SessionTreeDialogOptions) {
    const { dialog, list } = options
    this.cancel = dialog.querySelector<HTMLButtonElement>("[data-tree-cancel]")
    list.setAttribute("role", "tree")
    this.labelsList = !list.hasAttribute("aria-label") && !list.hasAttribute("aria-labelledby")
    if (this.labelsList) list.setAttribute("aria-label", t("Conversation tree"))
    this.cancel?.addEventListener("click", () => this.close())
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault()
      this.close()
    })
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      this.close()
    })
    dialog.addEventListener("close", () => {
      if (!dialog.open) this.restoreFocus()
    })
  }

  get isOpen(): boolean {
    return this.options.dialog.open
  }

  open(items: readonly SessionTreeItem[], activeLeafId: string | null): void {
    if (this.pending || this.isOpen) return
    const { dialog, list } = this.options
    if (this.labelsList) list.setAttribute("aria-label", t("Conversation tree"))
    const activeElement = dialog.ownerDocument.activeElement
    this.invokingElement =
      activeElement instanceof (dialog.ownerDocument.defaultView?.HTMLElement ?? HTMLElement) &&
      !dialog.contains(activeElement)
        ? activeElement
        : null
    this.setError()
    list.replaceChildren()
    this.rows = []
    const parents = new Set(items.map((item) => item.parentId))
    this.addRow(
      {
        id: null,
        parentId: null,
        depth: -1,
        role: "root",
        label: t("Start of conversation"),
        selectable: true,
        active: activeLeafId === null,
        onActivePath: true,
      },
      items.length > 0,
    )
    for (const item of items) this.addRow(item, parents.has(item.id))
    this.setPending(false)
    dialog.showModal()
    this.focusRow(
      Math.max(
        0,
        this.rows.findIndex((row) => row.id === activeLeafId),
      ),
    )
  }

  close(): void {
    if (this.pending || !this.isOpen) return
    this.options.dialog.close()
    this.restoreFocus()
  }

  setError(error?: unknown): void {
    this.options.error.textContent =
      error === undefined ? "" : translateDiagnostic(safeErrorMessage(error))
  }

  private addRow(item: DialogTreeItem, hasChildren: boolean): void {
    const { id, parentId, depth, role, selectable, active, onActivePath } = item
    const { list } = this.options
    const element = list.ownerDocument.createElement("div")
    element.className = "session-tree-item"
    element.setAttribute("role", "treeitem")
    element.setAttribute("aria-level", String(depth + 2))
    if (hasChildren) element.setAttribute("aria-expanded", "true")
    if (active) element.setAttribute("aria-current", "location")
    element.dataset.onActivePath = String(onActivePath)
    element.dataset.nodeId = id ?? ""
    element.dataset.role = role
    const indent = String(Math.min(20, Math.max(0, depth + 1)))
    element.dataset.depth = indent
    element.style.setProperty("--tree-depth", indent)
    element.tabIndex = -1
    if (id !== null) {
      const roleLabel = list.ownerDocument.createElement("span")
      roleLabel.className = "session-tree-role"
      roleLabel.textContent =
        role === "user"
          ? t("User")
          : role === "assistant"
            ? t("Assistant")
            : role === "toolResult"
              ? t("Tool result")
              : boundedText(role)
      element.append(roleLabel)
    }
    const text = list.ownerDocument.createElement("span")
    text.className = "session-tree-label"
    text.textContent = boundedText(item.label)
    element.append(text)
    const status = list.ownerDocument.createElement("span")
    status.className = "session-tree-status"
    status.textContent = [
      active ? t("Current position") : onActivePath ? t("Active path") : "",
      selectable ? "" : t("Unavailable boundary"),
    ]
      .filter(Boolean)
      .join(" · ")
    element.append(status)
    const index = this.rows.length
    const row = { id, parentId, selectable, element }
    this.rows.push(row)
    element.addEventListener("focus", () => {
      for (const candidate of this.rows) candidate.element.tabIndex = candidate === row ? 0 : -1
    })
    element.addEventListener("click", () => {
      if (this.pending || !this.isOpen) return
      this.focusRow(index)
      void this.select(row)
    })
    element.addEventListener("keydown", (event) => this.onKeyDown(event, index))
    list.append(element)
  }

  private focusRow(index: number): void {
    const element = this.rows[index]?.element
    element?.focus()
    element?.scrollIntoView?.({ block: "nearest" })
  }

  private onKeyDown(event: KeyboardEvent, index: number): void {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    const row = this.rows[index]
    if (!row || !this.isOpen) return
    let next = index
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(index + 1, this.rows.length - 1)
        break
      case "ArrowUp":
        next = Math.max(index - 1, 0)
        break
      case "Home":
        next = 0
        break
      case "End":
        next = this.rows.length - 1
        break
      case "ArrowLeft":
        if (row.id !== null)
          next = this.rows.findIndex((candidate) => candidate.id === row.parentId)
        break
      case "ArrowRight":
        next = this.rows.findIndex(
          (candidate) => candidate.id !== null && candidate.parentId === row.id,
        )
        break
      case "Enter":
      case " ":
        event.preventDefault()
        event.stopPropagation()
        void this.select(row)
        return
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    if (next >= 0) this.focusRow(next)
  }

  private setPending(pending: boolean): void {
    this.pending = pending
    this.options.dialog.setAttribute("aria-busy", String(pending))
    this.options.list.setAttribute("aria-busy", String(pending))
    if (this.cancel) this.cancel.disabled = pending
    for (const row of this.rows) {
      row.element.setAttribute("aria-disabled", String(pending || !row.selectable))
    }
  }

  private async select(row: TreeRow): Promise<void> {
    if (this.pending || !this.isOpen || !row.selectable) return
    this.setError()
    this.setPending(true)
    try {
      await this.options.onSelect(row.id)
    } catch (error) {
      this.setError(error)
      this.setPending(false)
      row.element.focus()
      return
    }
    this.setPending(false)
    this.close()
  }

  private restoreFocus(): void {
    const target = this.invokingElement
    this.invokingElement = null
    const { dialog } = this.options
    const current = dialog.ownerDocument.activeElement
    if (
      target?.isConnected &&
      !target.matches(":disabled, [hidden], [inert]") &&
      !target.closest("[hidden], [inert]") &&
      (current === dialog.ownerDocument.body ||
        current === target ||
        (current && dialog.contains(current)))
    ) {
      target.focus()
    }
  }
}
