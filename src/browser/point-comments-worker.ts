import { assertTabContext } from "./content/tab-context.js"
import { ELEMENT_PICKER_LIMITS } from "./runtime/element-context.js"
import type { RuntimeEvent, RuntimeRequest } from "./runtime/messages.js"
import {
  POINT_COMMENTS_LIMITS,
  type PointCommentsControl,
  type PointCommentsMode,
  type PointCommentsNotification,
  type PointCommentTarget,
  parsePointCommentTarget,
  samePointCommentTargets,
  validateComposerTargets,
} from "./runtime/point-comments.js"
import { type JsonObject, type JsonValue, RuntimeError, type TabContext } from "./runtime/types.js"

type Session = {
  clientId: string
  token: string
  context: TabContext
  windowId: number
  mode: PointCommentsMode
  sequence: number
  targets: PointCommentTarget[]
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  replacement?: { id: string; number: number }
  nextNumber: number
  reserved: Map<string, number>
}
type Pending = {
  clientId: string
  tabId?: number
  windowId?: number
  disconnected: Set<number>
  done: Promise<void>
}
type Dependencies = {
  beforeStart: () => Promise<void>
  context: (expected?: TabContext) => Promise<TabContext>
  windowId: (context: TabContext) => Promise<number>
  validate: (context: TabContext, signal?: AbortSignal) => Promise<void>
  start: (session: Session) => Promise<unknown>
  control: (
    session: Session,
    operation: PointCommentsControl,
    id?: string,
    number?: number,
  ) => Promise<JsonObject>
  cleanup: (context: TabContext, token?: string) => Promise<void>
  emit: (event: RuntimeEvent) => void
}

/** A memory-only UI protocol, never a model tool or mutation authority. */
export class PointCommentsWorker {
  private active?: Session
  private starting?: Pending
  private generation = 0
  private cleanupQueue: Promise<void> = Promise.resolve()
  private dirty = new Map<string, Session>()

  constructor(private readonly deps: Dependencies) {}

  private cancelled(): never {
    throw new RuntimeError("REQUEST_CANCELLED", "Point comments were cancelled or replaced")
  }
  private assert(session: Session, signal?: AbortSignal): void {
    if (
      signal?.aborted ||
      this.active !== session ||
      session.mode.generation !== this.generation ||
      Date.now() >= session.expiresAt
    )
      this.cancelled()
  }
  private async guard(session: Session, signal?: AbortSignal): Promise<void> {
    this.assert(session, signal)
    await this.deps.validate(session.context, signal)
    this.assert(session, signal)
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
  cancel(reason: string, tabId?: number, clientId?: string, settleStartup = true): Promise<void> {
    const pending = this.starting
    const session = this.active
    const ownsPending =
      pending &&
      (tabId === undefined || pending.tabId === tabId) &&
      (clientId === undefined || pending.clientId === clientId)
    const ownsSession =
      session &&
      (tabId === undefined || session.context.tabId === tabId) &&
      (clientId === undefined || session.clientId === clientId)
    if (!ownsPending && !ownsSession) return this.cleanupQueue
    this.generation++
    let cleanup = Promise.resolve()
    if (ownsSession && session) {
      this.active = undefined
      clearTimeout(session.timer)
      this.deps.emit({
        kind: "event",
        name: "pointComments.cancelled",
        payload: { clientId: session.clientId, reason },
        tabContext: session.context,
      })
      cleanup = this.clean(session)
    }
    const settled = cleanup.catch(() => undefined)
    return (async () => {
      await settled
      if (ownsPending && settleStartup) await pending?.done
      await this.cleanupQueue
    })()
  }
  disconnect(windowId: number): void {
    this.starting?.disconnected.add(windowId)
    if (this.starting?.windowId === windowId || this.active?.windowId === windowId)
      void this.cancel("panel-disconnected").catch(() => undefined)
  }
  navigation(tabId: number): void {
    void this.cancel("navigation", tabId).catch(() => undefined)
  }
  contextChanged(reason: string): void {
    void this.cancel(reason).catch(() => undefined)
  }
  async accessChanged(): Promise<void> {
    const session = this.active
    if (!session) return
    try {
      await this.deps.validate(session.context)
    } catch {
      if (this.active === session) await this.cancel("access-revoked")
    }
  }
  async start(
    request: RuntimeRequest<"pointComments.start">,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const previous = this.starting
    const stopping = this.cancel("replaced")
    const generation = ++this.generation
    let finish = (): void => undefined
    const pending: Pending = {
      clientId: request.params.clientId,
      tabId: request.tabContext?.tabId,
      disconnected: new Set(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
    }
    this.starting = pending
    let session: Session | undefined
    const check = (): void => {
      if (signal?.aborted || this.generation !== generation) this.cancelled()
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
      pending.windowId = await this.deps.windowId(context)
      if (pending.disconnected.has(pending.windowId)) this.cancelled()
      check()
      await this.deps.validate(context, signal)
      check()
      for (const old of this.dirty.values()) await this.clean(old)
      await this.deps.cleanup(context)
      check()
      const mode: PointCommentsMode = {
        generation,
        capacity: request.params.capacity,
        nextNumber: request.params.nextNumber,
        ...(request.params.replace ? { replace: request.params.replace } : {}),
        reserved:
          request.params.reserved ?? (request.params.replace ? [request.params.replace] : []),
      }
      session = {
        clientId: request.params.clientId,
        token: crypto.randomUUID(),
        context,
        windowId: pending.windowId,
        mode,
        sequence: 0,
        targets: [],
        expiresAt: Date.now() + POINT_COMMENTS_LIMITS.lifetimeMs,
        replacement: mode.replace,
        nextNumber: mode.nextNumber,
        reserved: new Map(mode.reserved?.map(({ id, number }) => [id, number])),
      }
      this.active = session
      session.timer = setTimeout(() => {
        if (this.active === session) void this.cancel("timeout").catch(() => undefined)
      }, POINT_COMMENTS_LIMITS.lifetimeMs)
      const value = await this.deps.start(session)
      await this.guard(session, signal)
      if (
        typeof value !== "object" ||
        value === null ||
        !("ok" in value) ||
        value.ok !== true ||
        !("result" in value) ||
        typeof value.result !== "object" ||
        value.result === null ||
        !("started" in value.result) ||
        value.result.started !== true
      )
        throw new RuntimeError(
          "INTERNAL_ERROR",
          "Could not protect point comments. Reload the page and try again.",
        )
      return { active: true, clientId: session.clientId, generation }
    } catch (error) {
      if (session) {
        if (this.active === session) {
          this.active = undefined
          clearTimeout(session.timer)
        }
        await this.clean(session).catch(() => undefined)
      }
      throw error
    } finally {
      if (this.starting === pending) this.starting = undefined
      finish()
    }
  }
  private owner(clientId: string): Session {
    const session = this.active
    if (!session || session.clientId !== clientId) this.cancelled()
    this.assert(session)
    return session
  }
  async control(
    request: RuntimeRequest<
      "pointComments.remove" | "pointComments.clear" | "pointComments.reselect"
    >,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const session = this.owner(request.params.clientId)
    assertTabContext(request.tabContext, session.context)
    await this.guard(session, signal)
    const id = "id" in request.params ? request.params.id : undefined
    const number = "number" in request.params ? request.params.number : undefined
    const operation = request.method.slice("pointComments.".length) as
      | "remove"
      | "clear"
      | "reselect"
    if (operation === "reselect") {
      const existing = session.targets.find((target) => target.id === id)
      if ((existing?.number ?? session.reserved.get(id as string)) !== number)
        throw new RuntimeError("INVALID_REQUEST", "Invalid pin replacement")
      session.replacement = { id: id as string, number: number as number }
      session.reserved.set(id as string, number as number)
    }
    if (operation === "clear" || (operation === "remove" && session.replacement?.id === id))
      session.replacement = undefined
    if (operation === "clear") session.reserved.clear()
    if (operation === "remove" && id) session.reserved.delete(id)
    session.targets =
      operation === "clear" ? [] : session.targets.filter((target) => target.id !== id)
    const state = await this.deps.control(session, operation, id, number)
    await this.guard(session, signal)
    if (state.active !== true) {
      void this.cancel("target-changed").catch(() => undefined)
      this.cancelled()
    }
    return { active: true }
  }
  async stop(
    request: RuntimeRequest<"pointComments.stop">,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const clientId = request.params.clientId
    if (request.params.submit) {
      const session = this.owner(clientId)
      assertTabContext(request.tabContext, session.context)
      await this.guard(session, signal)
      const targets = structuredClone(session.targets)
      // Validate live nodes and remove the surface atomically in one injected turn.
      // Keep ownership until final context validation so pending cleanup can be cancelled.
      this.dirty.set(session.token, session)
      this.cleanupQueue = this.cleanupQueue
        .catch(() => undefined)
        .then(async () => {
          await this.guard(session, signal)
          const state = await this.deps.control(session, "submit")
          this.assert(session, signal)
          if (
            state.active !== false ||
            state.sequence !== session.sequence ||
            !samePointCommentTargets(state.targets, targets) ||
            session.reserved.size > 0
          )
            throw new RuntimeError(
              "STALE_CONTEXT",
              "Point comment targets changed. Select them again.",
            )
          this.dirty.delete(session.token)
        })
      await this.cleanupQueue
      await this.guard(session, signal)
      this.active = undefined
      this.generation++
      clearTimeout(session.timer)
      return { active: false, targets }
    }
    const owned = this.active?.clientId === clientId || this.starting?.clientId === clientId
    if ((this.active || this.starting) && !owned) this.cancelled()
    if (owned) await this.cancel("user", undefined, clientId)
    else await this.cleanupQueue.catch(() => undefined)
    for (const session of this.dirty.values())
      if (session.clientId === clientId) await this.clean(session)
    if (!owned) {
      if (this.active || this.starting) this.cancelled()
      await this.deps.cleanup(request.tabContext ?? (await this.deps.context()))
    }
    return { active: false }
  }
  async notification(
    message: PointCommentsNotification,
    sender: chrome.runtime.MessageSender,
  ): Promise<JsonValue> {
    const session = this.active
    if (
      !session ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.tab?.id !== session.context.tabId ||
      message.token !== session.token ||
      message.generation !== session.mode.generation
    )
      throw new RuntimeError("PERMISSION_DENIED", "Invalid point comments notification")
    this.assert(session)
    assertTabContext(message.tabContext, session.context)
    if (message.sequence !== session.sequence + 1)
      throw new RuntimeError("INVALID_REQUEST", "Out-of-order point comment result")
    session.sequence = message.sequence
    if (message.status === "cancelled") {
      // Startup can be awaiting this ACK. Never wait for startup cleanup here.
      void this.cancel(message.reason).catch(() => undefined)
      return { accepted: true }
    }
    await this.guard(session)
    const target = parsePointCommentTarget(message.target)
    const url = new URL(session.context.url)
    url.username = ""
    url.password = ""
    const replacement = session.replacement
    if (
      target.context.pageUrl !== url.href ||
      session.targets.some((item) => item.id === target.id || item.number === target.number) ||
      session.targets.length >= Math.min(session.mode.capacity, ELEMENT_PICKER_LIMITS.elements) ||
      (!replacement && session.targets.length + session.reserved.size >= session.mode.capacity) ||
      (replacement
        ? target.id !== replacement.id || target.number !== replacement.number
        : target.number !== session.nextNumber)
    )
      throw new RuntimeError("INVALID_REQUEST", "Invalid point comment selection")
    validateComposerTargets(
      [],
      [...session.targets, target].map((target) => ({ ...target, note: "" })),
    )
    session.replacement = undefined
    session.reserved.delete(target.id)
    if (!replacement) session.nextNumber++
    session.targets.push(target)
    this.deps.emit({
      kind: "event",
      name: "pointComments.selected",
      payload: {
        clientId: session.clientId,
        generation: session.mode.generation,
        sequence: message.sequence,
        target,
      },
      tabContext: session.context,
    })
    return { accepted: true }
  }
}
