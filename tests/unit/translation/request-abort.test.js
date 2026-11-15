import assert from "node:assert/strict"
import { afterEach, test, vi } from "vitest"
import * as Abort from "../../../src/browser/translation/shared/abort.js"

afterEach(() => vi.useRealTimers())

test("request scopes forward parent cancellation and preserve its reason", () => {
  const parent = new AbortController()
  const scope = Abort.createRequestAbortScope(parent.signal)
  const reason = new DOMException("Session replaced", "AbortError")
  parent.abort(reason)
  assert.equal(scope.signal.aborted, true)
  assert.equal(scope.signal.reason, reason)
  scope.dispose()
})

test("request scopes enforce a two-minute deadline without aborting their parent", () => {
  vi.useFakeTimers()
  assert.equal(Abort.TRANSLATION_BATCH_DEADLINE_MS, 120_000)
  const parent = new AbortController()
  const scope = Abort.createRequestAbortScope(parent.signal)
  vi.advanceTimersByTime(119_999)
  assert.equal(scope.signal.aborted, false)
  vi.advanceTimersByTime(1)
  assert.equal(scope.signal.aborted, true)
  assert.equal(scope.signal.reason.message, "request-timeout")
  assert.equal(parent.signal.aborted, false)
  scope.dispose()
})

test("disposing request scopes removes timers and parent listeners without aborting", () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  const scope = Abort.createRequestAbortScope(parent.signal)
  scope.dispose()
  scope.dispose()
  parent.abort()
  vi.advanceTimersByTime(120_000)
  assert.equal(scope.signal.aborted, false)
  assert.equal(vi.getTimerCount(), 0)
})

test("already canceled parents abort a request without leaving a deadline timer", () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  parent.abort()
  const scope = Abort.createRequestAbortScope(parent.signal)
  assert.equal(scope.signal.aborted, true)
  scope.dispose()
  assert.equal(vi.getTimerCount(), 0)
})
