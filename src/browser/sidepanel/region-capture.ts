import { t } from "../i18n/index.js"
import { type RuntimeEvent, sendRuntimeRequest } from "../runtime/messages.js"
import { pngDimensions } from "../runtime/png.js"
import {
  parseRegionCaptureState,
  REGION_CAPTURE_LIMITS,
  type RegionCaptureState,
  type RegionOwner,
} from "../runtime/region-capture.js"
import { RuntimeError, type TabContext } from "../runtime/types.js"
import { element } from "./ui.js"

type Phase =
  | "idle"
  | "starting"
  | "selecting"
  | "capturing"
  | "cleanup"
  | "attaching"
  | "retry-cleanup"
  | "retry-attach"
interface Options {
  getContext: () => Promise<TabContext | undefined>
  getSessionId: () => string
  requestSiteAccess: (url: string) => Promise<boolean>
  canStart: () => boolean
  preflight: () => number
  confirm: (error: RuntimeError, signal: AbortSignal) => Promise<boolean>
  onAttach: (image: Blob, accept: () => void) => Promise<void>
  focusComposer: () => void
  onChange: () => void
  onError: (error: unknown) => void
  request?: typeof sendRuntimeRequest
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function sameContext(left: TabContext, right?: TabContext): boolean {
  return left.tabId === right?.tabId && left.url === right.url && left.epoch === right.epoch
}

/** Attach only a validated crop after confirmed removal of its protected selection surface. */
export class RegionCaptureController {
  private readonly button = element<HTMLButtonElement>("region-capture")
  private readonly request: typeof sendRuntimeRequest
  private phase: Phase = "idle"
  private state: RegionCaptureState = { active: false }
  private owner?: RegionOwner
  private context?: TabContext
  private sessionId?: string
  private generation = 0
  private handledCommit = -1
  private abort?: AbortController
  private cleanupRequired = false
  private mayHaveDispatchedStart = false
  private stopping?: Promise<void>
  private crop?: Blob
  private disposed = false

  constructor(private readonly options: Options) {
    this.request = options.request ?? sendRuntimeRequest
    let enterGeneration: number | undefined
    this.button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return
      event.preventDefault()
      if (event.isTrusted && !event.repeat) enterGeneration = this.generation
    })
    this.button.addEventListener("keyup", (event) => {
      if (event.key !== "Enter") return
      event.preventDefault()
      const generation = enterGeneration
      enterGeneration = undefined
      if (event.isTrusted && generation === this.generation) this.button.click()
    })
    this.button.addEventListener("blur", () => {
      enterGeneration = undefined
    })
    this.button.addEventListener("click", () =>
      this.run(() => {
        if (this.phase === "retry-cleanup" || this.phase === "retry-attach")
          return this.attachCrop()
        return this.occupied ? this.cancel() : this.start()
      }),
    )
    this.refresh()
  }

  get occupied(): boolean {
    return this.phase !== "idle" || this.cleanupRequired || !!this.stopping
  }
  get sendBlocked(): boolean {
    return this.occupied
  }
  private changed(): void {
    this.refresh()
    this.options.onChange()
  }
  private run(action: () => Promise<void>): void {
    void action().catch(this.options.onError)
  }
  private assertCurrent(generation: number): void {
    if (
      this.disposed ||
      generation !== this.generation ||
      this.sessionId !== this.options.getSessionId() ||
      this.abort?.signal.aborted
    )
      throw new RuntimeError("REQUEST_CANCELLED", "Region capture was cancelled")
  }
  private resultState(value: unknown): RegionCaptureState {
    if (
      !record(value) ||
      value.clientId !== this.owner?.clientId ||
      value.operationId !== this.owner?.operationId
    )
      throw new Error("Invalid region capture owner")
    return parseRegionCaptureState(value.state)
  }
  private remember(state: RegionCaptureState): boolean {
    if (state.active && this.state.active && state.revision < this.state.revision) return false
    this.state = state
    return true
  }

  refresh(): void {
    const label =
      this.phase === "retry-cleanup"
        ? t("Retry region cleanup")
        : this.phase === "retry-attach"
          ? t("Retry region attachment")
          : this.occupied
            ? t("Cancel region capture")
            : t("Capture region")
    this.button.ariaLabel = label
    this.button.title = `${label}\n${t("Chrome temporarily captures the full viewport. Only the crop leaves the worker. Drag to attach a crop. Arrow keys move; Shift+Arrow resizes; Alt uses 1 px. Enter attaches; Escape cancels.")}`
    this.button.setAttribute("aria-pressed", String(this.occupied))
    this.button.disabled = !this.occupied && !this.options.canStart()
  }

  async start(): Promise<void> {
    if (this.occupied) return
    if (!this.options.canStart())
      throw new Error(t("Finish or cancel region capture before sending"))
    const generation = ++this.generation
    this.handledCommit = -1
    this.owner = { clientId: crypto.randomUUID(), operationId: crypto.randomUUID() }
    this.sessionId = this.options.getSessionId()
    this.abort = new AbortController()
    this.phase = "starting"
    this.changed()
    try {
      const initial = await this.options.getContext()
      this.assertCurrent(generation)
      if (!initial) throw new Error(t("Region capture is unavailable on this page"))
      this.context = initial
      if (!(await this.options.requestSiteAccess(initial.url)))
        throw new Error(t("Region capture is unavailable on this page"))
      this.assertCurrent(generation)
      const context = await this.options.getContext()
      this.assertCurrent(generation)
      if (!context || context.tabId !== initial.tabId || context.url !== initial.url)
        throw new Error(t("The page changed. Select a new region."))
      if (!this.options.canStart()) throw new Error(t("Region capture is unavailable on this page"))
      this.context = context
      this.cleanupRequired = true
      // A lost reply can still leave a live surface. Set this before dispatch.
      this.mayHaveDispatchedStart = true
      const value = await this.request("regionCapture.start", this.owner, {
        tabContext: context,
        signal: this.abort.signal,
      })
      this.assertCurrent(generation)
      const state = this.resultState(value)
      if (!state.active) throw new Error(t("Region capture is unavailable on this page"))
      this.remember(state)
      this.cleanupRequired = false
      this.phase = "selecting"
      this.changed()
      // Keep focus on the owned page surface for keyboard selection.
      this.captureCommittedSelection()
    } catch (error) {
      if (generation !== this.generation) return
      await this.cancel(false).catch(() => undefined)
      if (
        error instanceof RuntimeError &&
        error.message === "Reset page pinch zoom before capturing a region"
      )
        throw new Error(t("Reset page pinch zoom before capturing a region"))
      throw error
    }
  }

  private captureCommittedSelection(): void {
    const state = this.state
    if (
      this.phase !== "selecting" ||
      !state.active ||
      !state.rectangle ||
      state.dragging ||
      state.frozen ||
      state.committedRevision === null ||
      state.committedRevision !== state.revision ||
      state.committedRevision <= this.handledCommit
    )
      return
    const selectionRevision = state.committedRevision
    this.handledCommit = selectionRevision
    // A notification is only a hint. The worker checks this revision against its live surface.
    this.run(() => this.captureSelection(selectionRevision))
  }

  private async cleanupSurface(): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.mayHaveDispatchedStart || !this.owner || !this.context) return
    const owner = this.owner
    const context = this.context
    this.cleanupRequired = true
    this.phase = "cleanup"
    this.stopping = Promise.resolve()
      .then(async () => {
        const value = await this.request("regionCapture.stop", owner, { tabContext: context })
        if (!record(value) || value.active !== false)
          throw new Error(t("Could not confirm region cleanup. Reload the page before sending."))
        this.state = { active: false }
        this.cleanupRequired = false
        this.mayHaveDispatchedStart = false
        this.context = undefined
      })
      .catch(() => {
        throw new Error(t("Could not confirm region cleanup. Reload the page before sending."))
      })
      .finally(() => {
        this.stopping = undefined
        this.changed()
      })
    this.changed()
    return this.stopping
  }

  private async captureSelection(selectionRevision: number): Promise<void> {
    if (!this.owner || !this.context || this.phase !== "selecting") return
    const generation = this.generation
    this.assertCurrent(generation)
    // Local preflight only: no credential setup or provider host permission.
    const maxBytes = this.options.preflight()
    this.phase = "capturing"
    this.changed()
    try {
      const signal = this.abort?.signal
      if (!signal) throw new Error("Missing region operation")
      let value: unknown
      try {
        value = await this.request(
          "regionCapture.capture",
          { ...this.owner, maxBytes, selectionRevision },
          { signal, tabContext: this.context },
        )
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== "CONFIRMATION_REQUIRED") throw error
        this.assertCurrent(generation)
        if (!(await this.options.confirm(error, signal)))
          throw new RuntimeError("REQUEST_CANCELLED", "Screenshot consent was cancelled")
        this.assertCurrent(generation)
        const budget = this.options.preflight()
        value = await this.request(
          "regionCapture.capture",
          { ...this.owner, maxBytes: budget, selectionRevision },
          { signal, tabContext: this.context, confirmed: true },
        )
      }
      this.assertCurrent(generation)
      if (
        !record(value) ||
        value.clientId !== this.owner?.clientId ||
        value.operationId !== this.owner.operationId ||
        value.mimeType !== "image/png" ||
        typeof value.dataUrl !== "string" ||
        !value.dataUrl.startsWith("data:image/png;base64,")
      )
        throw new Error(t("Could not capture the region. Select again or retry."))
      const data = value.dataUrl.slice("data:image/png;base64,".length)
      const dimensions = pngDimensions(data)
      if (
        !dimensions ||
        dimensions.width !== value.width ||
        dimensions.height !== value.height ||
        dimensions.width > REGION_CAPTURE_LIMITS.maxDimension ||
        dimensions.height > REGION_CAPTURE_LIMITS.maxDimension ||
        dimensions.width * dimensions.height > REGION_CAPTURE_LIMITS.maxPixels ||
        data.length > 4_000_000 ||
        data.length % 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      )
        throw new Error(t("Could not capture the region. Select again or retry."))
      const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
        type: "image/png",
      })
      if (!blob.size || blob.size > maxBytes)
        throw new Error(t("Composer images must use 3 MB or less in total"))
      this.crop = blob
    } catch (error) {
      if (generation !== this.generation) return
      if (!this.cleanupRequired) this.phase = "selecting"
      this.changed()
      throw error
    }
    await this.attachCrop()
  }

  private async attachCrop(): Promise<void> {
    if (!this.crop || this.phase === "attaching" || this.stopping) return
    const generation = this.generation
    try {
      this.assertCurrent(generation)
      await this.cleanupSurface()
      this.assertCurrent(generation)
      this.phase = "attaching"
      this.changed()
      this.options.preflight()
      await this.options.onAttach(this.crop, () => this.assertCurrent(generation))
      this.assertCurrent(generation)
      this.crop = undefined
      this.reset()
      this.changed()
      this.options.focusComposer()
    } catch (error) {
      if (generation !== this.generation) return
      this.phase = this.cleanupRequired ? "retry-cleanup" : "retry-attach"
      this.changed()
      throw error
    }
  }

  private reset(): void {
    ++this.generation
    this.owner = undefined
    this.context = undefined
    this.sessionId = undefined
    this.abort = undefined
    this.cleanupRequired = false
    this.phase = "idle"
    this.state = { active: false }
  }

  async cancel(restoreFocus = true): Promise<void> {
    ++this.generation
    this.abort?.abort()
    this.crop = undefined
    try {
      await this.cleanupSurface()
      this.reset()
    } finally {
      this.changed()
      if (restoreFocus && !this.disposed && !this.button.disabled)
        this.button.focus({ preventScroll: true })
    }
  }

  onEvent(event: RuntimeEvent): void {
    if (!this.occupied || !record(event.payload)) return
    if (this.sessionId !== this.options.getSessionId()) {
      this.run(() => this.cancel(false))
      return
    }
    if (
      event.name === "tab.changed" &&
      this.context &&
      !sameContext(this.context, event.tabContext)
    ) {
      this.run(() => this.cancel(false))
      return
    }
    if (
      !event.name.startsWith("regionCapture.") ||
      event.payload.clientId !== this.owner?.clientId ||
      event.payload.operationId !== this.owner?.operationId ||
      !this.context ||
      !sameContext(this.context, event.tabContext) ||
      this.stopping
    )
      return
    if (event.name === "regionCapture.cancelled") {
      if (event.payload.reason === "unsupported-viewport")
        this.options.onError(new Error(t("Reset page pinch zoom before capturing a region")))
      this.run(() => this.cancel(false))
      return
    }
    if (
      event.name === "regionCapture.changed" &&
      ["starting", "selecting", "capturing"].includes(this.phase)
    ) {
      try {
        const state = parseRegionCaptureState(event.payload.state)
        if (!state.active) {
          this.run(() => this.cancel(false))
          return
        }
        if (!this.remember(state)) return
        this.changed()
        this.captureCommittedSelection()
      } catch {
        this.run(() => this.cancel(false))
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.run(() => this.cancel(false))
  }
}
