function waitForAbortable(operation, signal) {
  const pending = Promise.resolve(operation)
  if (!signal) {
    return pending
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    }
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        if (signal.aborted) {
          onAbort()
        } else {
          resolve(value)
        }
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        if (signal.aborted) {
          onAbort()
        } else {
          reject(error)
        }
      },
    )
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

// A non-subtitle batch may need more time than a live caption, but must not stall forever.
const TRANSLATION_BATCH_DEADLINE_MS = 120_000

function createRequestAbortScope(parentSignal, timeoutMs = TRANSLATION_BATCH_DEADLINE_MS) {
  const controller = new AbortController()
  const cancel = () => controller.abort(parentSignal.reason)
  let timer
  if (parentSignal?.aborted) {
    cancel()
  } else {
    parentSignal?.addEventListener("abort", cancel, { once: true })
    timer = setTimeout(() => controller.abort(new Error("request-timeout")), timeoutMs)
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parentSignal?.removeEventListener("abort", cancel)
    },
  }
}

export { createRequestAbortScope, TRANSLATION_BATCH_DEADLINE_MS, waitForAbortable }
