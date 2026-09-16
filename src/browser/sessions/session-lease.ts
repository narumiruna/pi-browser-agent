const LOCK_PREFIX = "pi-chrome-session:"

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

  async claim(id: string): Promise<boolean> {
    if (this.current?.id === id) return true

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

    const previous = this.current
    this.current = { id, release, completion }
    if (previous) {
      previous.release()
      await previous.completion
    }
    return true
  }

  async release(): Promise<void> {
    const current = this.current
    if (!current) return
    this.current = undefined
    current.release()
    await current.completion
  }
}
