import { t } from "../i18n/index.js"
import { retainPairIds, type TargetReferencePair } from "../runtime/target-reference.js"

export interface PairItem {
  id: string
  label: string
  active: boolean
}

export class TargetReferenceComposer {
  private pair?: TargetReferencePair
  private items: readonly PairItem[] = []
  constructor(
    private readonly root: HTMLElement,
    private readonly changed: () => void,
    private readonly blocked: () => boolean,
  ) {}

  get active(): boolean {
    return this.pair !== undefined
  }
  get complete(): boolean {
    return !this.pair || Boolean(this.pair.targetId && this.pair.referenceId)
  }
  clear(): void {
    this.pair = undefined
  }

  accept(ids: ReadonlySet<string>): void {
    if (!this.pair) return
    const current = [this.pair.targetId, this.pair.referenceId].filter(
      (id): id is string => id !== undefined,
    )
    if (current.length && current.every((id) => ids.has(id))) this.pair = undefined
    else
      this.pair = retainPairIds(
        this.pair,
        new Set(this.items.map((item) => item.id).filter((id) => !ids.has(id))),
      )
  }

  snapshot(): TargetReferencePair | undefined {
    if (!this.complete) throw new Error(t("Select a distinct target and reference"))
    return this.pair && { ...this.pair }
  }
  refresh(items: readonly PairItem[]): void {
    this.items = items
    this.pair = retainPairIds(
      this.pair,
      new Set(items.filter((item) => item.active).map((item) => item.id)),
    )
    this.root.hidden = !this.pair
    this.root.replaceChildren()
    if (!this.pair) return
    const document = this.root.ownerDocument
    for (const role of ["targetId", "referenceId"] as const) {
      const value = items.find((item) => item.id === this.pair?.[role])?.label ?? t("Not selected")
      const label = document.createElement("span")
      label.textContent =
        role === "targetId"
          ? t("Target: {target}", { target: value })
          : t("Reference: {reference}", { reference: value })
      this.root.append(label)
    }
    const clear = document.createElement("button")
    clear.type = "button"
    clear.textContent = t("Clear pair")
    clear.disabled = this.blocked()
    clear.addEventListener("click", () => {
      if (this.blocked()) return
      this.pair = undefined
      this.changed()
    })
    this.root.append(clear)
  }
  controls(id: string): HTMLElement {
    const document = this.root.ownerDocument
    const controls = document.createElement("span")
    controls.className = "pair-actions"
    const trigger = document.createElement("button")
    trigger.type = "button"
    trigger.className = "icon-button pair-menu-trigger"
    trigger.title = t("Attachment actions")
    trigger.setAttribute("aria-label", trigger.title)
    trigger.setAttribute("aria-haspopup", "menu")
    trigger.setAttribute("aria-expanded", "false")
    trigger.dataset.pairRole = "menu"
    trigger.dataset.attachmentId = id
    trigger.disabled = this.blocked() || !this.items.some((item) => item.id === id && item.active)
    trigger.innerHTML =
      '<svg class="radix-icon" viewBox="0 0 15 15" aria-hidden="true"><circle cx="3" cy="7.5" r="1"/><circle cx="7.5" cy="7.5" r="1"/><circle cx="12" cy="7.5" r="1"/></svg>'
    const menu = document.createElement("div")
    menu.id = `pair-menu-${id}`
    menu.className = "pair-actions-menu"
    menu.setAttribute("popover", "auto")
    menu.setAttribute("role", "menu")
    menu.setAttribute("aria-label", trigger.title)
    trigger.setAttribute("popovertarget", menu.id)
    trigger.setAttribute("aria-controls", menu.id)
    const buttons: HTMLButtonElement[] = []
    let focusLast = false
    menu.addEventListener("beforetoggle", (event) => {
      const open = (event as ToggleEvent).newState === "open"
      trigger.setAttribute("aria-expanded", String(open))
      menu.toggleAttribute("data-open", open)
    })
    menu.addEventListener("toggle", () => {
      if (!menu.isConnected || !menu.hasAttribute("data-open")) return
      const view = document.defaultView
      if (!view) return
      const anchor = trigger.getBoundingClientRect()
      const bounds = menu.getBoundingClientRect()
      menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, view.innerWidth - bounds.width - 8))}px`
      const above = anchor.top - bounds.height - 4
      menu.style.top = `${Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 4, view.innerHeight - bounds.height - 8))}px`
      const enabled = buttons.filter((button) => !button.disabled)
      ;(focusLast ? enabled.at(-1) : enabled[0])?.focus()
      focusLast = false
    })
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) || trigger.disabled) return
      event.preventDefault()
      if (event.repeat) return
      focusLast = event.key === "ArrowUp"
      if (!menu.hasAttribute("data-open")) trigger.click()
    })
    menu.addEventListener("keydown", (event) => {
      if (event.repeat && ["Enter", " "].includes(event.key)) {
        event.preventDefault()
        return
      }
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
        }
        menu.hidePopover()
        trigger.focus()
        return
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
      event.preventDefault()
      const enabled = buttons.filter((button) => !button.disabled)
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : (index + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length
      enabled[next]?.focus()
    })
    for (const role of ["targetId", "referenceId"] as const) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.pairRole = role
      button.dataset.attachmentId = id
      button.textContent = role === "targetId" ? t("Use as target") : t("Use as reference")
      button.setAttribute("role", "menuitemradio")
      button.setAttribute("aria-checked", String(this.pair?.[role] === id))
      const other = role === "targetId" ? "referenceId" : "targetId"
      button.disabled =
        this.blocked() ||
        !this.items.some((item) => item.id === id && item.active) ||
        this.pair?.[other] === id
      button.addEventListener("click", () => {
        if (
          this.blocked() ||
          button.disabled ||
          !this.items.some((item) => item.id === id && item.active)
        )
          return
        if (menu.hasAttribute("data-open")) menu.hidePopover()
        this.pair = { ...this.pair, [role]: id }
        this.changed()
      })
      buttons.push(button)
      menu.append(button)
    }
    controls.append(trigger, menu)
    return controls
  }
}
