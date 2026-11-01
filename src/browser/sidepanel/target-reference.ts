import { t } from "../i18n/index.js"
import { retainPairIds, type TargetReferencePair } from "../runtime/target-reference.js"

export interface PairItem {
  id: string
  label: string
  active: boolean
  retained?: boolean
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
      new Set(items.filter((item) => item.active || item.retained).map((item) => item.id)),
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
    for (const role of ["targetId", "referenceId"] as const) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.pairRole = role
      button.dataset.attachmentId = id
      button.textContent = role === "targetId" ? t("Use as target") : t("Use as reference")
      button.setAttribute("aria-pressed", String(this.pair?.[role] === id))
      const other = role === "targetId" ? "referenceId" : "targetId"
      button.disabled =
        this.blocked() ||
        !this.items.some((item) => item.id === id && item.active) ||
        this.pair?.[other] === id
      button.addEventListener("click", () => {
        if (this.blocked() || button.disabled) return
        this.pair = { ...this.pair, [role]: id }
        this.changed()
      })
      controls.append(button)
    }
    return controls
  }
}
