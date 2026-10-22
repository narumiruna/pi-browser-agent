import { RuntimeError } from "./types.js"

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    // Observe the probe even if it canceled synchronously before returning its promise.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

/** Worker-owned scheduling. Probes are read-only and must check the supplied signal. */
export async function waitForCondition(
  probe: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
  timeoutMs = 5000,
): Promise<{ matched: true; elapsedMs: number }> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const cancel = () =>
    controller.abort(new RuntimeError("REQUEST_CANCELLED", "Browser request was cancelled"))
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  const deadline = setTimeout(
    () => controller.abort(new RuntimeError("TIMEOUT", "The browser condition was not observed")),
    timeoutMs,
  )
  let delay: ReturnType<typeof setTimeout> | undefined
  try {
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason
      const matched = await untilAborted(probe(controller.signal), controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason
      if (matched) return { matched: true, elapsedMs: Date.now() - startedAt }
      await untilAborted(
        new Promise<void>((resolve) => {
          delay = setTimeout(resolve, 250)
        }),
        controller.signal,
      )
      clearTimeout(delay)
      delay = undefined
    }
  } finally {
    clearTimeout(deadline)
    clearTimeout(delay)
    signal.removeEventListener("abort", cancel)
  }
}
