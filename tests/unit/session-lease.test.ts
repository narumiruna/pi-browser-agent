import { describe, expect, test, vi } from "vitest"
import { SessionLease } from "../../src/browser/sessions/session-lease.js"

class FakeLockManager {
  private readonly held = new Set<string>()
  private readonly tails = new Map<string, Promise<void>>()

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T> {
    if (options.ifAvailable && this.tails.has(name)) return callback(null)
    const previous = this.tails.get(name) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(name, tail)
    await previous
    this.held.add(name)
    try {
      return await callback({ name, mode: "exclusive" } as Lock)
    } finally {
      this.held.delete(name)
      if (this.tails.get(name) === tail) this.tails.delete(name)
      release()
    }
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held].map((name) => ({ name, mode: "exclusive", clientId: "test" })),
      pending: [],
    }
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
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

  test("refuses a clear while another panel owns a session and keeps its own lease", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = new SessionLease(locks)
    const second = new SessionLease(locks)
    await first.claim("first")
    await second.claim("second")
    const clear = vi.fn(async () => undefined)

    await expect(first.clearWithReplacement("replacement", clear)).rejects.toThrow(
      "Close the other Side Panels",
    )
    expect(clear).not.toHaveBeenCalled()
    expect(first.sessionId).toBe("first")
    await expect(first.protectedSessionIds()).resolves.toEqual(new Set(["first", "second"]))
    await first.release()
    await second.release()
  })

  test("keeps the original lease if clearing fails and can retry", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const lease = new SessionLease(locks)
    await lease.claim("original")
    await expect(
      lease.clearWithReplacement("replacement", async () => {
        await expect(lease.protectedSessionIds()).resolves.toEqual(
          new Set(["original", "replacement"]),
        )
        throw new Error("Clear failed")
      }),
    ).rejects.toThrow("Clear failed")
    expect(lease.sessionId).toBe("original")
    await expect(lease.protectedSessionIds()).resolves.toEqual(new Set(["original"]))

    await lease.clearWithReplacement("replacement", async () => undefined)
    expect(lease.sessionId).toBe("replacement")
    await expect(lease.protectedSessionIds()).resolves.toEqual(new Set(["replacement"]))
    await lease.release()
  })

  test("a query error prevents deletion without losing ownership", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const lease = new SessionLease(locks)
    await lease.claim("original")
    vi.spyOn(locks, "query").mockRejectedValueOnce(new Error("Query failed"))
    const clear = vi.fn(async () => undefined)
    await expect(lease.clearWithReplacement("replacement", clear)).rejects.toThrow("Query failed")
    expect(clear).not.toHaveBeenCalled()
    expect(lease.sessionId).toBe("original")
    await expect(lease.protectedSessionIds()).resolves.toEqual(new Set(["original"]))
    await lease.release()
  })

  test("a failed replacement claim prevents deletion and keeps the original lease", async () => {
    const manager = new FakeLockManager()
    const locks = manager as unknown as LockManager
    const lease = new SessionLease(locks)
    await lease.claim("original")
    const request = manager.request.bind(manager)
    vi.spyOn(manager, "request").mockImplementation((name, options, callback) => {
      if (name === "pi-browser-agent-session:replacement") {
        return Promise.reject(new Error("Claim failed"))
      }
      return request(name, options, callback)
    })
    const clear = vi.fn(async () => undefined)
    await expect(lease.clearWithReplacement("replacement", clear)).rejects.toThrow("Claim failed")
    expect(clear).not.toHaveBeenCalled()
    expect(lease.sessionId).toBe("original")
    await expect(lease.protectedSessionIds()).resolves.toEqual(new Set(["original"]))
    await lease.release()
  })

  test("does not let a new claim enter between the ownership query and clear", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = new SessionLease(locks)
    const second = new SessionLease(locks)
    await first.claim("original")
    const entered = deferred()
    const release = deferred()
    const query = locks.query.bind(locks)
    vi.spyOn(locks, "query").mockImplementationOnce(async () => {
      const snapshot = await query()
      entered.resolve()
      await release.promise
      return snapshot
    })
    let cleared = false
    const clearing = first.clearWithReplacement("replacement", async () => {
      cleared = true
    })
    await entered.promise
    const prepare = vi.fn(async () => !cleared)
    const claiming = second.claim("original", prepare)
    await Promise.resolve()
    expect(prepare).not.toHaveBeenCalled()
    release.resolve()
    await clearing
    await expect(claiming).resolves.toBe(false)
    expect(prepare).toHaveBeenCalledOnce()
    expect(second.sessionId).toBeUndefined()
    await expect(first.protectedSessionIds()).resolves.toEqual(new Set(["replacement"]))
    await first.release()
  })

  test("a claim already in progress makes a later clear refuse", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const first = new SessionLease(locks)
    const second = new SessionLease(locks)
    await first.claim("first")
    const entered = deferred()
    const release = deferred()
    const claiming = second.claim("second", async () => {
      entered.resolve()
      await release.promise
      return true
    })
    await entered.promise
    const clear = vi.fn(async () => undefined)
    const clearing = first.clearWithReplacement("replacement", clear)
    release.resolve()
    await expect(claiming).resolves.toBe(true)
    await expect(clearing).rejects.toThrow("Close the other Side Panels")
    expect(clear).not.toHaveBeenCalled()
    await first.release()
    await second.release()
  })

  test("rejected or failed preparation keeps the previous session owned", async () => {
    const locks = new FakeLockManager() as unknown as LockManager
    const lease = new SessionLease(locks)
    await lease.claim("original")
    await expect(lease.claim("missing", async () => false)).resolves.toBe(false)
    await expect(
      lease.claim("invalid", async () => {
        throw new Error("Invalid record")
      }),
    ).rejects.toThrow("Invalid record")
    expect(lease.sessionId).toBe("original")
    await expect(lease.protectedSessionIds()).resolves.toEqual(new Set(["original"]))
    await lease.release()
  })
})
