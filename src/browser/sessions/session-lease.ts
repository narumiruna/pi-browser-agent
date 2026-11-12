const LOCK_PREFIX = "pi-browser-agent-session:"
const OWNERSHIP_LOCK = "pi-browser-agent-session-ownership"

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

  async claim(id: string, prepare?: () => Promise<boolean>): Promise<boolean> {
    return this.locks.request(OWNERSHIP_LOCK, { mode: "exclusive" }, () =>
      this.claimCoordinated(id, prepare),
    )
  }

  async clearWithReplacement(id: string, clear: () => Promise<void>): Promise<void> {
    await this.locks.request(OWNERSHIP_LOCK, { mode: "exclusive" }, async () => {
      const protectedIds = await this.protectedSessionIds()
      if ([...protectedIds].some((id) => id !== this.current?.id)) {
        throw new Error("Close the other Side Panels before clearing all session data")
      }
      // Claim the replacement before deleting data. A failed clear keeps the old lease.
      const claimed = await this.claimCoordinated(id, async () => {
        await clear()
        return true
      })
      if (!claimed) throw new Error("Unable to claim a replacement session")
    })
  }

  private async claimCoordinated(id: string, prepare?: () => Promise<boolean>): Promise<boolean> {
    if (this.current?.id === id) return prepare ? prepare() : true

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
      return false
    }

    try {
      if (prepare && !(await prepare())) {
        release()
        await completion
        return false
      }
    } catch (error) {
      release()
      await completion
      throw error
    }

    const previous = this.current
    this.current = { id, release, completion }
    if (previous) {
      previous.release()
      await previous.completion
    }
    return true
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
}
