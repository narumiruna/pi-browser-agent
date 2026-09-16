const LOCK_PREFIX = "pi-chrome-session:"
const CLAIM_COORDINATION_LOCK = "pi-chrome-session-claims"

interface HeldLease {
  id: string
  release: () => void
  completion: Promise<void>
}

export class SessionLease {
  private current?: HeldLease

  constructor(private readonly locks: LockManager = navigator.locks) {}

  get sessionId(): string | undefined {
    return this.current?.id
  }

  async claim(id: string, beforeSwitch?: () => Promise<void>): Promise<boolean> {
    return this.withExclusiveClaims(async () => {
      if (this.current?.id === id) {
        await beforeSwitch?.()
        return true
      }

      const next = await this.acquire(id)
      if (!next) return false
      try {
        await beforeSwitch?.()
      } catch (error) {
        next.release()
        await next.completion
        throw error
      }

      const previous = this.current
      this.current = next
      if (previous) {
        previous.release()
        await previous.completion
      }
      return true
    })
  }

  async runIfAvailable(id: string, operation: () => Promise<void>): Promise<boolean> {
    const lease = await this.acquire(id)
    if (!lease) return false
    try {
      await operation()
      return true
    } finally {
      lease.release()
      await lease.completion
    }
  }

  async withExclusiveClaims<T>(operation: () => Promise<T>): Promise<T> {
    return this.locks.request(CLAIM_COORDINATION_LOCK, { mode: "exclusive" }, async () =>
      operation(),
    )
  }

  async protectedSessionIds(): Promise<ReadonlySet<string>> {
    const snapshot = await this.locks.query()
    return new Set(
      snapshot.held
        ?.map((lock) => lock.name)
        .filter((name): name is string => typeof name === "string" && name.startsWith(LOCK_PREFIX))
        .map((name) => name.slice(LOCK_PREFIX.length)) ?? [],
    )
  }

  async release(): Promise<void> {
    const current = this.current
    if (!current) return
    this.current = undefined
    current.release()
    await current.completion
  }

  private async acquire(id: string): Promise<HeldLease | undefined> {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reportAcquisition = (_acquired: boolean): void => undefined
    const acquired = new Promise<boolean>((resolve) => {
      reportAcquisition = resolve
    })
    const completion = this.locks.request(
      `${LOCK_PREFIX}${id}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          reportAcquisition(false)
          return
        }
        reportAcquisition(true)
        await held
      },
    )
    void completion.catch(() => reportAcquisition(false))
    if (!(await acquired)) {
      await completion
      return undefined
    }
    return { id, release, completion }
  }
}
