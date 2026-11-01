import { t } from "../i18n/index.js"
import type { SelectedElementContext } from "../runtime/element-context.js"
import { type RuntimeEvent, sendRuntimeRequest } from "../runtime/messages.js"
import {
  POINT_COMMENTS_LIMITS,
  type PointCommentPin,
  parsePointCommentTarget,
  samePointCommentTargets,
  validateComposerTargets,
} from "../runtime/point-comments.js"
import type { TabContext } from "../runtime/types.js"
import { element } from "./ui.js"

export type PointCommentCard = {
  id: string
  number: number
  note: string
  active: boolean
  label: string
  context?: SelectedElementContext
}
interface Options {
  getContext: () => Promise<TabContext | undefined>
  getElements: () => SelectedElementContext[]
  requestSiteAccess: (url: string) => Promise<boolean>
  canStart: () => boolean
  onChange: () => void
  onCancel: () => void
  onError: (error: unknown) => void
  appendText: (text: string) => void
  request?: typeof sendRuntimeRequest
}
const same = (a: TabContext, b: TabContext): boolean =>
  a.tabId === b.tabId && a.url === b.url && a.epoch === b.epoch
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Notes stay in this trusted panel. The page receives numbers and target geometry only. */
export class PointCommentsController {
  private readonly button = element<HTMLButtonElement>("point-comments")
  private readonly output = element<HTMLElement>("point-comment-cards")
  private readonly request: typeof sendRuntimeRequest
  private cards: PointCommentCard[] = []
  private readonly nodes = new Map<string, HTMLElement>()
  private clientId?: string
  private dispatchedStart = false
  private context?: TabContext
  private generation = 0
  private workerGeneration?: number
  private sequence = 0
  private nextNumber = 1
  private live = false
  private starting = false
  private updating = false
  private cleanupRequired = false
  private stopping?: Promise<void>
  private preparing = false
  private prepared = new Map<string, string>()

  constructor(private readonly options: Options) {
    this.request = options.request ?? sendRuntimeRequest
    this.button.addEventListener("click", () =>
      this.run(() => (this.occupied ? this.stop() : this.start())),
    )
    this.refresh()
  }
  get active(): boolean {
    return this.live
  }
  get occupied(): boolean {
    return (
      this.live ||
      this.starting ||
      this.updating ||
      this.cleanupRequired ||
      !!this.stopping ||
      this.preparing
    )
  }
  get pins(): readonly PointCommentCard[] {
    return this.cards
  }
  get tabContext(): TabContext | undefined {
    return this.context
  }
  get sendBlocked(): boolean {
    return (
      this.starting ||
      this.updating ||
      this.cleanupRequired ||
      !!this.stopping ||
      this.preparing ||
      this.cards.some((card) => !card.active)
    )
  }
  private run(action: () => Promise<void>): void {
    void action().catch(this.options.onError)
  }
  private changed(): void {
    this.refresh()
    this.options.onChange()
  }
  private invalidate(): void {
    for (const card of this.cards) {
      card.active = false
      card.context = undefined
    }
    this.live = false
  }
  snapshot(): PointCommentPin[] {
    if (this.sendBlocked)
      throw new Error(t("Remove, reselect, or convert inactive comments before sending"))
    const pins = this.cards.map((card) => {
      if (!card.active || !card.context) throw new Error("Inactive point comment")
      return {
        id: card.id,
        number: card.number,
        note: card.note,
        context: structuredClone(card.context),
      }
    })
    validateComposerTargets(this.options.getElements(), pins)
    return pins
  }
  async start(replace?: PointCommentCard): Promise<void> {
    if (!this.options.canStart() || this.occupied)
      throw new Error(t("Wait for the current operation to finish before commenting"))
    const capacity = 5 - this.options.getElements().length
    const reserved = this.cards
      .filter((card) => !card.active)
      .map(({ id, number }) => ({ id, number }))
    if (capacity < 1) throw new Error(t("Attach up to five page targets"))
    const generation = ++this.generation
    const clientId = crypto.randomUUID()
    this.clientId = clientId
    this.workerGeneration = undefined
    this.sequence = 0
    this.starting = true
    this.changed()
    try {
      const initial = await this.options.getContext()
      if (generation !== this.generation) return
      if (!initial) throw new Error(t("Open an HTTP or HTTPS page before commenting"))
      this.context = initial
      if (!(await this.options.requestSiteAccess(initial.url)))
        throw new Error(t("Site access is required to comment on this page"))
      if (generation !== this.generation) return
      const context = await this.options.getContext()
      if (generation !== this.generation) return
      if (!context || context.tabId !== initial.tabId || context.url !== initial.url)
        throw new Error(t("The page changed. Select comment targets again."))
      if (!this.options.canStart())
        throw new Error(t("Wait for the current operation to finish before commenting"))
      this.context = context
      this.dispatchedStart = true
      const result = await this.request(
        "pointComments.start",
        {
          clientId,
          capacity,
          nextNumber: this.nextNumber,
          ...(reserved.length ? { reserved } : {}),
          ...(replace ? { replace: { id: replace.id, number: replace.number } } : {}),
        },
        { tabContext: context },
      )
      if (generation !== this.generation) return
      if (
        !record(result) ||
        result.clientId !== clientId ||
        result.active !== true ||
        !Number.isSafeInteger(result.generation)
      )
        throw new Error("Invalid point comments startup")
      if (this.workerGeneration !== undefined && this.workerGeneration !== result.generation)
        throw new Error("Invalid point comments generation")
      this.workerGeneration = Number(result.generation)
      this.live = true
    } catch (error) {
      if (generation !== this.generation) return
      await this.stop(false).catch(() => undefined)
      throw error
    } finally {
      if (generation === this.generation) {
        this.starting = false
        this.changed()
      }
    }
  }
  async remove(id: string): Promise<void> {
    if (this.updating || this.preparing) return
    this.options.onCancel()
    const card = this.cards.find((card) => card.id === id)
    if (!card) return
    if (this.live && this.clientId && this.context) {
      this.updating = true
      this.changed()
      try {
        await this.request(
          "pointComments.remove",
          { clientId: this.clientId, id },
          { tabContext: this.context },
        )
      } catch (error) {
        await this.stop(false).catch(() => undefined)
        throw error
      } finally {
        this.updating = false
      }
    }
    this.cards = this.cards.filter((candidate) => candidate.id !== id)
    this.changed()
    this.button.focus({ preventScroll: true })
  }
  async reselect(id: string): Promise<void> {
    if (this.updating || this.preparing) return
    this.options.onCancel()
    const card = this.cards.find((card) => card.id === id)
    if (!card) return
    if (!this.live) return this.start(card)
    if (!this.clientId || !this.context) return
    this.updating = true
    this.changed()
    try {
      await this.request(
        "pointComments.reselect",
        { clientId: this.clientId, id, number: card.number },
        { tabContext: this.context },
      )
      card.active = false
      card.context = undefined
    } catch (error) {
      await this.stop(false).catch(() => undefined)
      throw error
    } finally {
      this.updating = false
      this.changed()
    }
  }
  async convert(id: string): Promise<void> {
    const card = this.cards.find((card) => card.id === id)
    if (!card || card.active || this.occupied) return
    const note = card.note
    await this.remove(id)
    if (note.trim()) this.options.appendText(note)
  }
  async stop(cancelSubmission = true): Promise<void> {
    if (cancelSubmission) this.options.onCancel()
    ++this.generation
    this.starting = false
    this.invalidate()
    if (this.stopping) return this.stopping
    const clientId = this.clientId
    if (!this.dispatchedStart) {
      this.clientId = undefined
      this.context = undefined
      this.cleanupRequired = false
      this.changed()
      return
    }
    if (!clientId) {
      this.changed()
      return
    }
    this.cleanupRequired = true
    this.stopping = Promise.resolve().then(async () => {
      try {
        const result = await this.request(
          "pointComments.stop",
          { clientId },
          this.context ? { tabContext: this.context } : {},
        )
        if (!record(result) || result.active !== false)
          throw new Error("Unconfirmed point comments cleanup")
        this.cleanupRequired = false
        this.dispatchedStart = false
        this.clientId = undefined
        this.context = undefined
      } catch {
        throw new Error(t("Could not confirm comment cleanup. Reload the page before sending."))
      } finally {
        this.stopping = undefined
        this.changed()
      }
    })
    this.changed()
    return this.stopping
  }
  async prepareSubmission(signal: AbortSignal): Promise<PointCommentPin[]> {
    const pins = this.snapshot()
    if (!this.clientId || !this.context || !this.live || signal.aborted)
      throw new Error("Point comments are not active")
    const generation = this.generation
    this.preparing = true
    this.prepared = new Map(pins.map((pin) => [pin.id, pin.note]))
    this.changed()
    try {
      const result = await this.request(
        "pointComments.stop",
        { clientId: this.clientId, submit: true },
        { tabContext: this.context, signal },
      )
      if (generation !== this.generation || signal.aborted)
        throw new Error("Point comments submission was cancelled")
      if (
        !record(result) ||
        result.active !== false ||
        !samePointCommentTargets(
          result.targets,
          pins.map(({ note: _note, ...target }) => target),
        )
      )
        throw new Error("Point comment targets changed")
      this.clientId = undefined
      this.dispatchedStart = false
      this.cleanupRequired = false
      this.invalidate()
      return pins
    } catch (error) {
      await this.stop(false).catch(() => undefined)
      throw error
    } finally {
      this.preparing = false
      this.changed()
    }
  }
  accept(ids: ReadonlySet<string>): void {
    this.cards = this.cards.filter(
      (card) => !ids.has(card.id) || this.prepared.get(card.id) !== card.note,
    )
    this.prepared.clear()
    this.changed()
  }
  disconnected(): void {
    if (!this.occupied && !this.clientId) return
    this.options.onCancel()
    this.run(() => this.stop(false))
  }
  onEvent(event: RuntimeEvent): void {
    if (typeof event.name !== "string" || !record(event.payload)) return
    if (
      event.name === "tab.changed" &&
      this.context &&
      (!event.tabContext || !same(this.context, event.tabContext))
    ) {
      this.run(() => this.stop())
      return
    }
    if (
      !event.name.startsWith("pointComments.") ||
      event.payload.clientId !== this.clientId ||
      !event.tabContext ||
      !this.context ||
      !same(this.context, event.tabContext)
    )
      return
    if (event.name === "pointComments.cancelled") {
      if (this.stopping && event.payload.reason === "user") return
      this.options.onCancel()
      this.run(() => this.stop(false))
      return
    }
    try {
      if (
        !Number.isSafeInteger(event.payload.generation) ||
        (this.workerGeneration !== undefined &&
          this.workerGeneration !== event.payload.generation) ||
        event.payload.sequence !== this.sequence + 1
      )
        throw new Error("Invalid point comments sequence")
      this.workerGeneration = Number(event.payload.generation)
      this.sequence++
      const target = parsePointCommentTarget(event.payload.target)
      const old = this.cards.find((card) => card.id === target.id)
      const card: PointCommentCard = {
        ...target,
        label: `${target.context.tagName}${target.context.id ? `#${target.context.id}` : ""}`,
        note: old?.note ?? "",
        active: true,
      }
      const next = this.cards.filter((card) => card.id !== target.id).concat(card)
      if (next.length + this.options.getElements().length > 5)
        throw new Error(t("Attach up to five page targets"))
      validateComposerTargets(
        this.options.getElements(),
        next
          .filter((card) => card.active && card.context)
          .map((card) => ({
            id: card.id,
            number: card.number,
            note: card.note,
            context: card.context as SelectedElementContext,
          })),
      )
      if (old) this.cards[this.cards.indexOf(old)] = card
      else this.cards.push(card)
      this.nextNumber = Math.max(this.nextNumber, target.number + 1)
      this.live = true
      this.changed()
    } catch (error) {
      this.run(() => this.stop())
      this.options.onError(error)
    }
  }
  refresh(): void {
    this.button.ariaLabel = this.button.title = t("Comment on elements")
    this.button.setAttribute("aria-pressed", String(this.occupied))
    this.button.disabled = !this.occupied && !this.options.canStart()
    this.output.hidden = this.cards.length === 0
    for (const [id, node] of this.nodes)
      if (!this.cards.some((card) => card.id === id)) {
        node.remove()
        this.nodes.delete(id)
      }
    for (const card of this.cards) {
      let node = this.nodes.get(card.id)
      if (!node) {
        node = document.createElement("section")
        node.className = "point-comment-card"
        node.dataset.pinId = card.id
        const label = document.createElement("label")
        const status = document.createElement("span")
        status.className = "point-comment-status"
        const note = document.createElement("textarea")
        note.id = `point-comment-note-${card.id}`
        note.maxLength = POINT_COMMENTS_LIMITS.note
        note.rows = 2
        label.htmlFor = note.id
        note.addEventListener("input", () => {
          const current = this.cards.find((candidate) => candidate.id === card.id)
          if (!current) return
          const previous = current.note
          current.note = note.value.slice(0, POINT_COMMENTS_LIMITS.note)
          try {
            validateComposerTargets(
              this.options.getElements(),
              this.cards
                .filter((card) => card.active && card.context)
                .map((card) => ({
                  id: card.id,
                  number: card.number,
                  note: card.note,
                  context: card.context as SelectedElementContext,
                })),
            )
          } catch (error) {
            current.note = previous
            note.value = previous
            this.options.onError(error)
          }
          this.options.onCancel()
          this.options.onChange()
        })
        node.append(label, status, note)
        for (const action of ["remove", "reselect", "convert"] as const) {
          const button = document.createElement("button")
          button.type = "button"
          button.className = "point-comment-action"
          button.dataset.action = action
          button.addEventListener("click", () => this.run(() => this[action](card.id)))
          node.append(button)
        }
        this.nodes.set(card.id, node)
        this.output.append(node)
      }
      node.dataset.active = String(card.active)
      const label = node.querySelector("label") as HTMLLabelElement
      label.textContent = `${t("Comment {number}", { number: card.number })} — ${card.label}`
      const status = node.querySelector(".point-comment-status") as HTMLElement
      status.textContent = card.active ? "" : t("Inactive target")
      const note = node.querySelector("textarea") as HTMLTextAreaElement
      if (note.value !== card.note) note.value = card.note
      note.placeholder = t("Describe the requested change")
      note.disabled = this.preparing
      for (const button of node.querySelectorAll("button")) {
        const action = button.dataset.action
        button.textContent =
          action === "remove"
            ? t("Remove")
            : action === "reselect"
              ? t("Reselect target")
              : t("Use note only")
        button.disabled =
          this.preparing ||
          this.updating ||
          this.starting ||
          this.cleanupRequired ||
          !!this.stopping
        if (action === "convert") button.hidden = card.active || this.occupied
      }
    }
  }
}
