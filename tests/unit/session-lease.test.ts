import { describe, expect, test } from "vitest"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"

class FakeLockManager {
  private readonly held = new Set<string>()

  async request(
    name: string,
    _options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>,
  ): Promise<void> {
    if (this.held.has(name)) return callback(null)
    this.held.add(name)
    try {
      await callback({ name, mode: "exclusive" } as Lock)
    } finally {
      this.held.delete(name)
    }
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held].map((name) => ({ name, mode: "exclusive", clientId: "test" })),
      pending: [],
    }
  }
}

describe("session leases", () => {
  test("allows only one live owner and releases ownership", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = new SessionLease(locks)
    const second = new SessionLease(locks)

    await expect(first.claim("session-1")).resolves.toBe(true)
    await expect(first.protectedSessionIds()).resolves.toEqual(new Set(["session-1"]))
    await expect(second.claim("session-1")).resolves.toBe(false)
    await first.release()
    await expect(second.claim("session-1")).resolves.toBe(true)
    await second.release()
  })
})
