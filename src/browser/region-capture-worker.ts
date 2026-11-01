import { assertTabContext } from "./content/tab-context.js"
import { cropRegionPng } from "./region-crop.js"
import type { RuntimeEvent, RuntimeRequest } from "./runtime/messages.js"
import {
  parseRegionCaptureState,
  REGION_CAPTURE_LIMITS,
  REGION_CAPTURE_REASONS,
  type RegionCaptureNotification,
  type RegionCaptureOperation,
  type RegionCaptureReason,
  type RegionCaptureState,
  type RegionRectangle,
} from "./runtime/region-capture.js"
import { type JsonValue, RuntimeError, type TabContext } from "./runtime/types.js"

type Session = {
  clientId: string
  token: string
  context: TabContext
  windowId: number
  version: number
  expiresAt: number
  operationId: string
  state: RegionCaptureState
  timer?: ReturnType<typeof setTimeout>
  busy: boolean
}
type PendingStart = {
  clientId: string
  version: number
  tabId?: number
  windowId?: number
  disconnectedWindows: Set<number>
  done: Promise<void>
}

type Dependencies = {
  beforeStart: () => Promise<void>
  context: (expected?: TabContext) => Promise<TabContext>
  windowId: (context: TabContext) => Promise<number>
  validate: (context: TabContext, signal?: AbortSignal) => Promise<void>
  execute: (
    operation: RegionCaptureOperation,
    session: Pick<Session, "token" | "context">,
    rectangle?: RegionRectangle,
  ) => Promise<unknown>
  cleanup: (context: TabContext, token?: string) => Promise<void>
  emit: (event: RuntimeEvent) => void
  capturePermission: (confirmed?: boolean) => Promise<void>
  capture: (
    request: RuntimeRequest<"regionCapture.capture">,
    context: TabContext,
  ) => Promise<JsonValue>
}

/** Memory-only ownership. The content surface does not authorize capture or a new owner. */
export class RegionCaptureWorker {
  private active?: Session
  private starting?: PendingStart
  private version = 0
  private cleanupQueue: Promise<void> = Promise.resolve()
  private dirty = new Map<string, Session>()

  constructor(private readonly deps: Dependencies) {}

  get occupied(): boolean {
    return !!this.active || !!this.starting || this.dirty.size > 0
  }

  private cancelled(): never {
    throw new RuntimeError("REQUEST_CANCELLED", "Region capture was cancelled or replaced")
  }

  private assertOwner(session: Session, signal?: AbortSignal): void {
    if (signal?.aborted || this.active !== session || session.version !== this.version)
      this.cancelled()
    if (Date.now() >= session.expiresAt) {
      void this.cancel("timeout").catch(() => undefined)
      this.cancelled()
    }
  }

  private emit(session: Session, state: RegionCaptureState, reason?: RegionCaptureReason): void {
    this.deps.emit({
      kind: "event",
      name: state.active ? "regionCapture.changed" : "regionCapture.cancelled",
      payload: {
        clientId: session.clientId,
        operationId: session.operationId,
        state,
        ...(reason ? { reason } : {}),
      },
      tabContext: session.context,
    })
  }

  private clean(session: Session): Promise<void> {
    this.dirty.set(session.token, session)
    this.cleanupQueue = this.cleanupQueue
      .catch(() => undefined)
      .then(async () => {
        await this.deps.cleanup(session.context, session.token)
        this.dirty.delete(session.token)
      })
    return this.cleanupQueue
  }

  /** Invalidate synchronously; finish all possible late setup before confirming cleanup. */
  cancel(reason: RegionCaptureReason, tabId?: number, clientId?: string): Promise<void> {
    const pending = this.starting
    const session = this.active
    const matchesPending =
      !!pending &&
      (tabId === undefined || pending.tabId === tabId) &&
      (clientId === undefined || pending.clientId === clientId)
    const matchesSession =
      !!session &&
      (tabId === undefined || session.context.tabId === tabId) &&
      (clientId === undefined || session.clientId === clientId)
    if (!matchesPending && !matchesSession) return this.cleanupQueue
    this.version += 1
    let cleaning: Promise<void> = Promise.resolve()
    if (matchesSession && session) {
      this.active = undefined
      clearTimeout(session.timer)
      this.emit(session, { active: false }, reason)
      cleaning = this.clean(session)
    }
    // Observe early failures even while setup is outstanding.
    const cleaned = cleaning.then(
      () => undefined,
      () => undefined,
    )
    return (async () => {
      await cleaned
      if (matchesPending) await pending?.done
      await this.cleanupQueue
    })()
  }

  disconnect(windowId: number): void {
    const pending = this.starting
    pending?.disconnectedWindows.add(windowId)
    if (pending?.windowId === windowId || this.active?.windowId === windowId) {
      void this.cancel("panel-disconnected").catch(() => undefined)
    }
  }

  navigation(tabId: number): void {
    void this.cancel("navigation", tabId).catch(() => undefined)
  }

  contextChanged(reason: RegionCaptureReason): void {
    void this.cancel(reason).catch(() => undefined)
  }

  async accessChanged(): Promise<void> {
    const session = this.active
    if (!session) return
    try {
      await this.deps.validate(session.context)
      if (session.state.active && session.state.frozen) await this.deps.capturePermission(true)
    } catch {
      if (this.active === session) await this.cancel("access-revoked")
    }
  }

  async orphanCleanup(context: TabContext): Promise<void> {
    // No live ownership exists on worker restart. A new start waits for this queue.
    this.cleanupQueue = this.cleanupQueue
      .catch(() => undefined)
      .then(() => this.deps.cleanup(context))
    await this.cleanupQueue
  }

  async start(
    request: RuntimeRequest<"regionCapture.start">,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const previous = this.starting
    const stopping = this.cancel("replaced")
    const version = ++this.version
    let finish = (): void => undefined
    const pending: PendingStart = {
      clientId: request.params.clientId,
      version,
      tabId: request.tabContext?.tabId,
      disconnectedWindows: new Set(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
    }
    this.starting = pending
    let session: Session | undefined
    const check = (): void => {
      if (signal?.aborted || this.version !== version) this.cancelled()
    }
    try {
      await stopping.catch(() => undefined)
      await previous?.done
      check()
      await this.deps.beforeStart()
      check()
      const context = await this.deps.context(request.tabContext)
      pending.tabId = context.tabId
      check()
      const windowId = await this.deps.windowId(context)
      pending.windowId = windowId
      if (pending.disconnectedWindows.has(windowId)) this.cancelled()
      check()
      await this.deps.validate(context, signal)
      check()
      for (const old of this.dirty.values()) await this.clean(old)
      await this.orphanCleanup(context)
      check()
      session = {
        clientId: request.params.clientId,
        token: crypto.randomUUID(),
        context,
        windowId,
        version,
        expiresAt: Date.now() + REGION_CAPTURE_LIMITS.lifetimeMs,
        operationId: request.params.operationId,
        state: { active: false },
        busy: false,
      }
      // Own the token before injection. Content can report state before startup returns.
      this.active = session
      session.timer = setTimeout(() => {
        if (this.active === session) void this.cancel("timeout").catch(() => undefined)
      }, REGION_CAPTURE_LIMITS.lifetimeMs)
      const state = await this.execute("start", session)
      this.assertOwner(session, signal)
      await this.deps.validate(context, signal)
      this.assertOwner(session, signal)
      if (!state.active)
        throw new RuntimeError(
          "INTERNAL_ERROR",
          "Could not protect region capture. Reload the page and try again.",
        )
      this.remember(session, state)
      return { state: session.state, clientId: session.clientId, operationId: session.operationId }
    } catch (error) {
      if (session) {
        if (this.active === session) {
          this.active = undefined
          clearTimeout(session.timer)
          this.emit(
            session,
            { active: false },
            error instanceof RuntimeError &&
              error.message === "Reset page pinch zoom before capturing a region"
              ? "unsupported-viewport"
              : "cancelled",
          )
        }
        // A stop may have run before the injected setup finished. Clean again by token.
        await this.clean(session).catch(() => undefined)
      }
      throw error
    } finally {
      if (this.starting === pending) this.starting = undefined
      finish()
    }
  }

  private async execute(
    operation: RegionCaptureOperation,
    session: Session,
    rectangle?: RegionRectangle,
  ): Promise<RegionCaptureState> {
    const value = await this.deps.execute(operation, session, rectangle)
    if (
      typeof value !== "object" ||
      value === null ||
      !("ok" in value) ||
      value.ok !== true ||
      !("result" in value)
    ) {
      throw new RuntimeError("INTERNAL_ERROR", "Region capture could not complete the operation")
    }
    const result = value.result
    if (
      typeof result === "object" &&
      result !== null &&
      "active" in result &&
      result.active === false &&
      "reason" in result
    ) {
      const { reason, ...state } = result
      if (!REGION_CAPTURE_REASONS.some((allowed) => allowed === reason))
        throw new RuntimeError("INVALID_REQUEST", "Invalid region capture reason")
      if (operation === "start" && reason === "unsupported-viewport")
        throw new RuntimeError("INVALID_REQUEST", "Reset page pinch zoom before capturing a region")
      return parseRegionCaptureState(state)
    }
    return parseRegionCaptureState(result)
  }

  private remember(session: Session, state: RegionCaptureState): void {
    if (state.active && session.state.active && state.revision < session.state.revision) return
    session.state = state
    this.emit(session, state)
  }

  private owner(clientId: string, operationId: string): Session {
    const session = this.active
    if (!session || session.clientId !== clientId || session.operationId !== operationId)
      this.cancelled()
    this.assertOwner(session)
    return session
  }

  private async guard(session: Session, signal?: AbortSignal): Promise<void> {
    this.assertOwner(session, signal)
    await this.deps.validate(session.context, signal)
    this.assertOwner(session, signal)
  }

  async update(
    request: RuntimeRequest<"regionCapture.update">,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const session = this.owner(request.params.clientId, request.params.operationId)
    assertTabContext(request.tabContext, session.context)
    if (session.busy) throw new RuntimeError("INVALID_REQUEST", "Region capture is busy")
    session.busy = true
    try {
      await this.guard(session, signal)
      const state = await this.execute("update", session, request.params.rectangle)
      this.assertOwner(session, signal)
      if (!state.active) {
        await this.cancel("protection-lost")
        this.cancelled()
      }
      await this.guard(session, signal)
      this.remember(session, state)
      return { clientId: session.clientId, operationId: session.operationId, state: session.state }
    } catch (error) {
      if (this.active === session) {
        await this.cancel(
          error instanceof RuntimeError && error.code === "PERMISSION_DENIED"
            ? "access-revoked"
            : "protection-lost",
        ).catch(() => undefined)
      }
      throw error
    } finally {
      session.busy = false
    }
  }

  async stop(request: RuntimeRequest<"regionCapture.stop">): Promise<JsonValue> {
    const clientId = request.params.clientId
    if (
      (this.active &&
        (this.active.clientId !== clientId ||
          this.active.operationId !== request.params.operationId)) ||
      (this.starting && this.starting.clientId !== clientId)
    )
      this.cancelled()
    const context = this.active?.context
    if (context) assertTabContext(request.tabContext, context)
    const hadOwner = !!this.active || !!this.starting
    if (hadOwner) {
      await this.cancel("user", undefined, clientId)
    } else {
      await this.cleanupQueue.catch(() => undefined)
    }
    for (const session of this.dirty.values()) {
      if (session.clientId === clientId && session.operationId === request.params.operationId)
        await this.clean(session)
    }
    if (!hadOwner && this.dirty.size === 0) {
      // Cleanup is not a page read: a restarted panel can retain a surface in another window.
      const target = request.tabContext ?? (await this.deps.context())
      if (this.active || this.starting) this.cancelled()
      await this.orphanCleanup(target)
    }
    return { active: false }
  }

  async capture(
    request: RuntimeRequest<"regionCapture.capture">,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const session = this.owner(request.params.clientId, request.params.operationId)
    assertTabContext(request.tabContext, session.context)
    if (session.busy) throw new RuntimeError("INVALID_REQUEST", "Region capture is busy")
    session.busy = true
    try {
      await this.guard(session, signal)
      await this.deps.capturePermission(request.confirmed)
      await this.guard(session, signal)
      // The state operation independently verifies the live surface's protection.
      const before = await this.execute("state", session)
      this.assertOwner(session, signal)
      if (!before.active || !before.rectangle || before.dragging || before.frozen)
        throw new RuntimeError("INVALID_REQUEST", "Select a region before capture")
      const frozen = await this.execute("freeze", session)
      await this.guard(session, signal)
      if (!frozen.active || !frozen.frozen || frozen.dragging || !frozen.rectangle)
        throw new RuntimeError("INVALID_REQUEST", "Region capture could not freeze the selection")
      this.remember(session, frozen)
      const assertFrozen = async (): Promise<void> => {
        await this.guard(session, signal)
        await this.deps.capturePermission(request.confirmed)
        const state = await this.execute("state", session)
        this.assertOwner(session, signal)
        if (
          !state.active ||
          !state.frozen ||
          state.dragging ||
          JSON.stringify(state.rectangle) !== JSON.stringify(frozen.rectangle) ||
          state.revision !== frozen.revision ||
          state.width !== frozen.width ||
          state.height !== frozen.height
        )
          throw new RuntimeError("STALE_CONTEXT", "Region capture changed during capture")
      }
      await assertFrozen()
      let image = await this.deps.capture(request, session.context)
      await assertFrozen()
      if (
        typeof image !== "object" ||
        image === null ||
        Array.isArray(image) ||
        typeof image.dataUrl !== "string"
      )
        throw new RuntimeError("INVALID_REQUEST", "Invalid region source image")
      let source = image.dataUrl
      image = null
      try {
        const crop = await cropRegionPng(
          source,
          frozen.rectangle,
          frozen,
          request.params.maxBytes,
          assertFrozen,
        )
        await assertFrozen()
        return { ...crop, clientId: session.clientId, operationId: session.operationId }
      } finally {
        source = ""
      }
    } catch (error) {
      if (
        this.active === session &&
        error instanceof RuntimeError &&
        error.code === "STALE_CONTEXT"
      ) {
        await this.cancel("viewport-changed").catch(() => undefined)
      }
      if (this.active === session) {
        try {
          await this.guard(session, signal)
          const state = await this.execute("state", session)
          this.assertOwner(session, signal)
          if (!state.active)
            throw new RuntimeError("STALE_CONTEXT", "Region capture lost its protection")
          const editable = state.frozen ? await this.execute("resume", session) : state
          await this.guard(session, signal)
          if (!editable.active || editable.frozen)
            throw new RuntimeError("STALE_CONTEXT", "Region capture could not resume")
          this.remember(session, editable)
        } catch {
          await this.cancel("protection-lost").catch(() => undefined)
        }
      }
      throw error
    } finally {
      session.busy = false
    }
  }

  async notification(
    message: RegionCaptureNotification,
    sender: chrome.runtime.MessageSender,
  ): Promise<JsonValue> {
    const session = this.active
    if (
      !session ||
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== session.context.tabId ||
      sender.frameId !== 0 ||
      message.token !== session.token
    )
      throw new RuntimeError("PERMISSION_DENIED", "Invalid region capture notification")
    this.assertOwner(session)
    assertTabContext(message.tabContext, session.context)
    await this.guard(session)
    if (!message.state.active) {
      // Do not await startup or cleanup: startup can be waiting for this acknowledgement.
      void this.cancel(message.reason ?? "page").catch(() => undefined)
    } else {
      this.remember(session, message.state)
    }
    return { accepted: true }
  }
}
