import { t } from "../i18n/index.js"
import { type RuntimeEvent, sendRuntimeRequest } from "../runtime/messages.js"
import {
  isPageAnnotationColor,
  PAGE_ANNOTATION_COLORS,
  PAGE_ANNOTATION_LIMITS,
  type PageAnnotationColor,
  type PageAnnotationState,
  type PageAnnotationUpdate,
  parsePageAnnotationState,
} from "../runtime/page-annotation.js"
import { RuntimeError, type TabContext } from "../runtime/types.js"
import { element } from "./ui.js"

interface PageAnnotationOptions {
  getContext: () => Promise<TabContext | undefined>
  requestSiteAccess: (url: string) => Promise<boolean>
  canStart: () => boolean
  onChange: () => void
  onCancel: () => void
  onError: (error: unknown) => void
  request?: typeof sendRuntimeRequest
}

const colorLabels = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  white: "White",
  black: "Black",
} as const

function sameContext(left: TabContext, right: TabContext): boolean {
  return left.tabId === right.tabId && left.url === right.url && left.epoch === right.epoch
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Owns the panel controls; editable strokes remain in the isolated page world. */
export class PageAnnotationController {
  private readonly button = element<HTMLButtonElement>("page-pen")
  private readonly colors = element<HTMLSelectElement>("page-pen-color")
  private readonly controls = element<HTMLElement>("page-pen-controls")
  private readonly width = element<HTMLInputElement>("page-pen-width")
  private readonly undo = element<HTMLButtonElement>("page-pen-undo")
  private readonly clear = element<HTMLButtonElement>("page-pen-clear")
  private readonly cancel = element<HTMLButtonElement>("page-pen-cancel")
  private readonly request: typeof sendRuntimeRequest
  private state: PageAnnotationState = { active: false }
  private clientId?: string
  private context?: TabContext
  private generation = 0
  private starting = false
  private updating = false
  private capturing = false
  private cleanupRequired = false
  private stopping?: Promise<void>
  private submissionCleanup = false
  private color: PageAnnotationColor = "red"

  constructor(private readonly options: PageAnnotationOptions) {
    this.request = options.request ?? sendRuntimeRequest
    this.button.addEventListener("click", () => this.run(() => this.toggle()))
    this.colors.addEventListener("change", () => {
      if (!isPageAnnotationColor(this.colors.value)) return
      this.color = this.colors.value
      this.render()
      if (this.active) this.run(() => this.update({ action: "color", color: this.color }))
    })
    this.width.addEventListener("input", () => {
      this.run(() => this.update({ action: "width", width: Number(this.width.value) }))
    })
    this.undo.addEventListener("click", () => this.run(() => this.update({ action: "undo" })))
    this.clear.addEventListener("click", () => this.run(() => this.update({ action: "clear" })))
    this.cancel.addEventListener("click", () => this.run(() => this.stop()))
    this.width.value = String(PAGE_ANNOTATION_LIMITS.defaultPenWidth)
    this.render()
  }

  get active(): boolean {
    return this.state.active
  }

  get occupied(): boolean {
    return this.starting || this.active || this.cleanupRequired || this.stopping !== undefined
  }

  get hasMarks(): boolean {
    return this.state.active && this.state.hasStrokes
  }

  get sendBlocked(): boolean {
    return (
      this.starting ||
      this.updating ||
      this.capturing ||
      this.cleanupRequired ||
      this.stopping !== undefined ||
      (this.state.active && this.state.drawing)
    )
  }

  get tabContext(): TabContext | undefined {
    return this.context
  }

  refresh(): void {
    this.render()
  }

  private run(action: () => Promise<void>): void {
    void action().catch(this.options.onError)
  }

  private changed(): void {
    this.render()
    this.options.onChange()
  }

  private render(): void {
    this.button.ariaLabel = this.button.title = t(
      this.occupied ? "Cancel page drawing" : "Draw on page",
    )
    this.button.setAttribute("aria-pressed", String(this.occupied))
    this.button.style.setProperty("--pen-color", PAGE_ANNOTATION_COLORS[this.color])
    this.button.disabled = !this.occupied && !this.options.canStart()
    this.colors.ariaLabel = t("Pen color")
    this.colors.value = this.color
    this.colors.disabled =
      this.starting ||
      this.updating ||
      this.capturing ||
      this.cleanupRequired ||
      (this.state.active && this.state.drawing)
    for (const option of this.colors.options) {
      if (isPageAnnotationColor(option.value)) option.textContent = t(colorLabels[option.value])
    }
    this.controls.hidden = !this.occupied
    this.controls.ariaLabel = t("Page drawing controls")
    this.width.disabled = !this.active || this.sendBlocked
    this.undo.disabled = this.clear.disabled = !this.hasMarks || this.sendBlocked
    this.cancel.disabled = this.stopping !== undefined
  }

  async toggle(): Promise<void> {
    if (this.occupied) return this.stop()
    if (!this.options.canStart())
      throw new Error(t("Wait for the current operation to finish before drawing"))
    const generation = ++this.generation
    const clientId = crypto.randomUUID()
    this.clientId = clientId
    this.starting = true
    this.changed()
    try {
      const initial = await this.options.getContext()
      if (generation !== this.generation) return
      if (!initial) throw new Error(t("Open an HTTP or HTTPS page before drawing"))
      this.context = initial
      if (!(await this.options.requestSiteAccess(initial.url))) {
        throw new Error(t("Site access is required to draw on this page"))
      }
      if (generation !== this.generation) return
      const context = await this.options.getContext()
      if (generation !== this.generation) return
      if (!context || context.tabId !== initial.tabId || context.url !== initial.url) {
        throw new Error(t("The page changed before drawing could start. Start drawing again."))
      }
      if (!this.options.canStart())
        throw new Error(t("Wait for the current operation to finish before drawing"))
      this.context = context
      const result = await this.request(
        "pageAnnotation.start",
        {
          clientId,
          color: this.color,
          width: Number(this.width.value),
        },
        { tabContext: context },
      )
      if (generation !== this.generation) return
      if (!record(result) || result.clientId !== clientId)
        throw new Error("Invalid annotation owner")
      this.state = parsePageAnnotationState(result.state)
      if (!this.state.active)
        throw new Error(t("Page drawing could not start. Reload the page and try again."))
    } catch (error) {
      if (generation !== this.generation) return
      // A failed start can have installed a surface before its response was lost.
      await this.stop(false).catch(() => undefined)
      throw error
    } finally {
      if (generation === this.generation) {
        this.starting = false
        this.changed()
      }
    }
  }

  private async update(
    update:
      | Omit<Extract<PageAnnotationUpdate, { action: "color" }>, "clientId">
      | Omit<Extract<PageAnnotationUpdate, { action: "width" }>, "clientId">
      | { action: "undo" | "clear" | "resume" },
  ): Promise<void> {
    if (!this.clientId || !this.context || !this.active || this.updating || this.capturing) return
    const generation = this.generation
    const focusedControl =
      document.activeElement === this.colors
        ? this.colors
        : document.activeElement === this.width
          ? this.width
          : undefined
    this.updating = true
    this.changed()
    try {
      const result = await this.request(
        "pageAnnotation.update",
        {
          clientId: this.clientId,
          ...update,
        },
        { tabContext: this.context },
      )
      if (generation !== this.generation) return
      if (!record(result) || result.clientId !== this.clientId)
        throw new Error("Invalid annotation owner")
      const state = parsePageAnnotationState(result.state)
      if (!this.state.active || !state.active || state.revision >= this.state.revision)
        this.state = state
    } finally {
      this.updating = false
      this.changed()
      if (
        generation === this.generation &&
        focusedControl &&
        !focusedControl.disabled &&
        document.activeElement === document.body
      )
        focusedControl.focus({ preventScroll: true })
    }
  }

  async resume(): Promise<void> {
    if (!this.cleanupRequired) await this.update({ action: "resume" })
  }

  async capture(
    signal: AbortSignal,
    confirm: (error: RuntimeError) => Promise<boolean>,
  ): Promise<Blob> {
    if (!this.clientId || !this.context || !this.hasMarks || this.sendBlocked) {
      throw new Error(t("Add a mark before sending page drawing"))
    }
    const generation = this.generation
    const clientId = this.clientId
    const context = this.context
    this.capturing = true
    this.changed()
    try {
      let result: unknown
      try {
        result = await this.request(
          "pageAnnotation.capture",
          { clientId },
          { signal, tabContext: context },
        )
      } catch (error) {
        if (
          !(error instanceof RuntimeError) ||
          error.code !== "CONFIRMATION_REQUIRED" ||
          !(await confirm(error))
        )
          throw error
        if (generation !== this.generation || signal.aborted)
          throw new Error("Cancelled annotation")
        result = await this.request(
          "pageAnnotation.capture",
          { clientId },
          {
            signal,
            tabContext: context,
            confirmed: true,
          },
        )
      }
      if (generation !== this.generation || signal.aborted) throw new Error("Cancelled annotation")
      if (
        !record(result) ||
        result.clientId !== clientId ||
        !record(result.tabContext) ||
        !sameContext(context, result.tabContext as unknown as TabContext) ||
        result.mimeType !== "image/png" ||
        typeof result.dataUrl !== "string" ||
        !result.dataUrl.startsWith("data:image/png;base64,") ||
        result.dataUrl.length > 3_000_000
      )
        throw new Error("Invalid annotation capture")
      const data = atob(result.dataUrl.slice("data:image/png;base64,".length))
      if (!data.length) throw new Error("Empty annotation capture")
      return new Blob([Uint8Array.from(data, (character) => character.charCodeAt(0))], {
        type: "image/png",
      })
    } catch (error) {
      if (generation === this.generation && !signal.aborted) {
        await this.request(
          "pageAnnotation.update",
          { clientId, action: "resume" },
          { tabContext: context },
        ).catch(() => undefined)
      }
      if (signal.aborted || generation !== this.generation) throw error
      throw new Error(
        t("Could not capture page drawing. Your marks were kept when safe. Try again."),
      )
    } finally {
      this.capturing = false
      this.changed()
    }
  }

  async stop(cancelSubmission = true): Promise<void> {
    if (cancelSubmission) this.options.onCancel()
    ++this.generation
    this.starting = false
    if (this.stopping) return this.stopping
    const clientId = this.clientId
    if (!clientId) return
    this.cleanupRequired = true
    this.submissionCleanup = !cancelSubmission
    this.stopping = Promise.resolve().then(async () => {
      try {
        // Cleanup can target the original document after worker restart or a window switch.
        // This context is never reused to authorize page reads or capture.
        const context = this.context
        const result = await this.request(
          "pageAnnotation.stop",
          { clientId },
          context ? { tabContext: context } : {},
        )
        if (!record(result) || result.active !== false)
          throw new Error("Unconfirmed annotation cleanup")
        this.state = { active: false }
        this.clientId = undefined
        this.context = undefined
        this.cleanupRequired = false
      } catch {
        throw new Error(t("Could not confirm drawing cleanup. Reload the page before sending."))
      } finally {
        this.stopping = undefined
        this.submissionCleanup = false
        this.changed()
      }
    })
    this.changed()
    return this.stopping
  }

  onEvent(event: RuntimeEvent): void {
    if (typeof event.name !== "string" || !record(event.payload)) return
    if (
      event.name === "tab.changed" &&
      this.context &&
      (!event.tabContext || !sameContext(this.context, event.tabContext))
    ) {
      this.run(() => this.stop())
      return
    }
    if (!event.name.startsWith("pageAnnotation.") || event.payload.clientId !== this.clientId)
      return
    if (!event.tabContext || !this.context || !sameContext(event.tabContext, this.context)) return
    if (event.name === "pageAnnotation.cancelled") {
      ++this.generation
      if (!(this.submissionCleanup && ["user", "cancelled"].includes(String(event.payload.reason))))
        this.options.onCancel()
      this.state = { active: false }
      this.starting = false
      // Cancellation invalidates work; only a stop reply confirms that cleanup completed.
      this.cleanupRequired = true
      if (!this.stopping) this.run(() => this.stop(false))
      if (
        ["protection-lost", "viewport-changed", "invalid-result"].includes(
          String(event.payload.reason),
        )
      ) {
        this.options.onError(
          new Error(
            t(
              "Page drawing stopped because the page or its protection changed. Start drawing again.",
            ),
          ),
        )
      }
    } else if (event.name === "pageAnnotation.changed") {
      try {
        const state = parsePageAnnotationState(event.payload.state)
        if (!this.state.active || !state.active || state.revision >= this.state.revision)
          this.state = state
      } catch {
        this.run(() => this.stop())
      }
    }
    this.changed()
  }
}
