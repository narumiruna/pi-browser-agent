import assert from "node:assert/strict"
import { afterEach, test, vi } from "vitest"
import { createSubtitleRecovery } from "../../../src/browser/translation/content/youtube/recovery.js"

afterEach(() => vi.useRealTimers())

function fixture(sendStart = async () => ({ ok: true, sessionId: "new" })) {
  let videoKey = "video-a"
  const attempts = []
  const started = []
  const failures = []
  const recovery = createSubtitleRecovery({
    window: globalThis,
    getVideoKey: () => videoKey,
    isActive: () => true,
    sendStart,
    onAttempt: (attempt) => attempts.push(attempt),
    onStarted: (response) => started.push(response),
    onFailure: (response, exhausted) => failures.push({ response, exhausted }),
  })
  return {
    recovery,
    attempts,
    started,
    failures,
    navigate: () => {
      videoKey = "video-b"
      recovery.cancel()
    },
  }
}

test("session recovery shares one start and rejects old startup identity", async () => {
  let resolve
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const first = f.recovery.recover()
  const second = f.recovery.recover()
  await Promise.resolve()
  assert.deepEqual(f.attempts, [1])
  const identity = f.recovery.getIdentity()
  assert.equal(
    f.recovery.acceptsStartup({
      youtubeVideoKey: "video-a",
      youtubeRequestId: identity.requestId,
    }),
    true,
  )
  assert.equal(
    f.recovery.acceptsStartup({
      youtubeVideoKey: "video-b",
      youtubeRequestId: identity.requestId,
    }),
    false,
  )
  resolve({ ok: true, sessionId: "new" })
  await Promise.all([first, second])
  assert.equal(f.started.length, 1)
})

test("recovery has three attempts at least ten seconds apart, then stops", async () => {
  vi.useFakeTimers()
  const f = fixture(async () => ({ ok: false, retryable: true }))
  await f.recovery.recover()
  assert.deepEqual(f.attempts, [1])
  await vi.advanceTimersByTimeAsync(9999)
  assert.deepEqual(f.attempts, [1])
  await vi.advanceTimersByTimeAsync(1)
  assert.deepEqual(f.attempts, [1, 2])
  await vi.advanceTimersByTimeAsync(10000)
  assert.deepEqual(f.attempts, [1, 2, 3])
  await vi.advanceTimersByTimeAsync(60000)
  await f.recovery.recover()
  assert.equal(f.attempts.length, 3)
  assert.equal(f.failures.at(-1).exhausted, true)
  assert.equal(vi.getTimerCount(), 0)
})

test("diagnostic work cannot shorten the ten-second interval between actual startup sends", async () => {
  vi.useFakeTimers()
  const starts = []
  let attempt = 0
  const recovery = createSubtitleRecovery({
    window: globalThis,
    getVideoKey: () => "video-a",
    isActive: () => true,
    onAttempt() {
      vi.advanceTimersByTime(++attempt === 1 ? 100 : 1)
    },
    sendStart: async () => {
      starts.push(Date.now())
      return { ok: false, retryable: true }
    },
  })
  await recovery.recover()
  await vi.advanceTimersByTimeAsync(10000)
  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 10000)
  recovery.cancel()
})

test("navigation and cleanup ignore an in-flight recovery response", async () => {
  let resolve
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = f.recovery.recover()
  await Promise.resolve()
  f.navigate()
  resolve({ ok: true, sessionId: "old" })
  await pending
  assert.equal(f.started.length, 0)
})

test("configuration failure does not retry or open Settings", async () => {
  vi.useFakeTimers()
  const f = fixture(async () => ({
    ok: false,
    retryable: false,
    openOptions: true,
  }))
  await f.recovery.recover()
  await vi.advanceTimersByTimeAsync(60000)
  assert.equal(f.attempts.length, 1)
  assert.equal(f.failures.at(-1).exhausted, true)
})

test("a messaging call that never settles cannot block recovery forever", async () => {
  vi.useFakeTimers()
  const f = fixture(() => new Promise(() => {}))
  const pending = f.recovery.recover()
  await vi.advanceTimersByTimeAsync(31000)
  await pending
  assert.equal(f.failures.length, 1)
  assert.equal(f.failures[0].exhausted, false)
  f.recovery.cancel()
  await vi.runAllTimersAsync()
  assert.equal(vi.getTimerCount(), 0)
})

test("successful startup alone does not reset the outage attempt budget", async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.recovery.recover()
  await vi.advanceTimersByTimeAsync(10000)
  await f.recovery.recover()
  assert.deepEqual(f.attempts, [1, 2])
  f.recovery.delivered()
  await vi.advanceTimersByTimeAsync(10000)
  await f.recovery.recover()
  assert.deepEqual(f.attempts, [1, 2, 1])
})
