import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { waitForCondition } from "../../src/browser/runtime/condition-wait.js"
import { RuntimeError } from "../../src/browser/runtime/types.js"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("worker condition scheduling", () => {
  test("probes immediately, polls at 250 ms, and cleans up after a match", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = waitForCondition(probe, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({ matched: true, elapsedMs: 250 })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("uses a distinct timeout and does not retain a polling timer", async () => {
    const probe = vi.fn(async () => false)
    const result = waitForCondition(probe, new AbortController().signal, 501)
    const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" })
    await vi.advanceTimersByTimeAsync(501)
    await assertion
    expect(probe).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("defaults to a 5000 ms deadline", async () => {
    const result = waitForCondition(async () => false, new AbortController().signal)
    const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  test("cancels during the polling delay without another probe", async () => {
    const controller = new AbortController()
    const probe = vi.fn(async () => false)
    const result = waitForCondition(probe, controller.signal)
    const assertion = expect(result).rejects.toMatchObject({ code: "REQUEST_CANCELLED" })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await assertion
    await vi.advanceTimersByTimeAsync(10000)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(["cancel", "timeout"])("%s releases an unresolved injection", async (end) => {
    const controller = new AbortController()
    let probeSignal: AbortSignal | undefined
    let finish: (value: boolean) => void = () => undefined
    const probe = vi.fn((signal: AbortSignal) => {
      probeSignal = signal
      return new Promise<boolean>((resolve) => {
        finish = resolve
      })
    })
    const result = waitForCondition(probe, controller.signal, 1000)
    const assertion = expect(result).rejects.toMatchObject({
      code: end === "cancel" ? "REQUEST_CANCELLED" : "TIMEOUT",
    })
    if (end === "cancel") controller.abort()
    else await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(probeSignal?.aborted).toBe(true)
    finish(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(probe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("does not enter an already canceled probe", async () => {
    const controller = new AbortController()
    controller.abort()
    const probe = vi.fn(async () => true)
    await expect(waitForCondition(probe, controller.signal)).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
    expect(probe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("observes a rejected probe that cancels before returning its promise", async () => {
    const controller = new AbortController()
    const probe = vi.fn(() => {
      controller.abort()
      return Promise.reject(new Error("Probe failed after cancellation"))
    })
    await expect(waitForCondition(probe, controller.signal)).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("propagates fatal probe errors without retrying", async () => {
    const error = new RuntimeError("STALE_CONTEXT", "The page changed")
    const probe = vi.fn(async () => {
      throw error
    })
    await expect(waitForCondition(probe, new AbortController().signal)).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(probe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
