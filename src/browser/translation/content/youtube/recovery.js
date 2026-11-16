import { waitForAbortable } from "../../shared/abort.js"

const RECOVERY_INTERVAL_MS = 10000
// Allow delivery of the background's 30-second attempt result.
const RECOVERY_MESSAGE_TIMEOUT_MS = 31000
const MAX_RECOVERY_ATTEMPTS = 3

export function createSubtitleRecovery(options) {
  const { window, getVideoKey, isActive, sendStart, onAttempt, onStarted, onFailure } = options
  let generation = 0
  let identity = null
  let pending = null
  let controller = null
  let timer = null
  let attempts = 0
  let lastAttemptAt = -Infinity
  let exhausted = false

  function cancel() {
    generation += 1
    controller?.abort()
    controller = null
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    pending = null
    identity = null
  }

  function reset() {
    cancel()
    attempts = 0
    lastAttemptAt = -Infinity
    exhausted = false
  }

  function beginRequest(recovery = false) {
    identity = {
      videoKey: getVideoKey(),
      requestId: `youtube-${Date.now()}-${++generation}-${Math.random().toString(36).slice(2, 8)}`,
      recovery,
    }
    return identity
  }

  function isCurrent(request) {
    return identity === request && request.videoKey === getVideoKey()
  }

  function acceptsStartup(payload) {
    if (payload.youtubeVideoKey && payload.youtubeVideoKey !== getVideoKey()) return false
    return (
      !payload.youtubeRequestId ||
      (identity?.requestId === payload.youtubeRequestId && isCurrent(identity))
    )
  }

  function recover() {
    if (pending) return pending
    if (timer !== null || exhausted || !isActive()) return Promise.resolve(false)
    const delay = RECOVERY_INTERVAL_MS - (Date.now() - lastAttemptAt)
    if (delay > 0) {
      timer = window.setTimeout(() => {
        timer = null
        recover()
      }, delay)
      return Promise.resolve(false)
    }
    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      exhausted = true
      onFailure?.({ ok: false }, true)
      return Promise.resolve(false)
    }
    attempts += 1
    const request = beginRequest(true)
    controller = new AbortController()
    const attemptController = controller
    const deadline = window.setTimeout(() => attemptController.abort(), RECOVERY_MESSAGE_TIMEOUT_MS)
    onAttempt?.(attempts)
    pending = waitForAbortable(
      Promise.resolve().then(() => {
        lastAttemptAt = Date.now()
        return sendStart(request)
      }),
      attemptController.signal,
    )
      .catch(() => ({ ok: false, retryable: true }))
      .then((response) => {
        if (!isCurrent(request)) return false
        if (response?.ok) {
          onStarted?.(response)
          return true
        }
        exhausted =
          response?.retryable === false ||
          Boolean(response?.openOptions) ||
          attempts >= MAX_RECOVERY_ATTEMPTS
        onFailure?.(response, exhausted)
        if (!exhausted) {
          const retryDelay = Math.max(0, RECOVERY_INTERVAL_MS - (Date.now() - lastAttemptAt))
          timer = window.setTimeout(() => {
            timer = null
            recover()
          }, retryDelay)
        }
        return false
      })
      .finally(() => {
        window.clearTimeout(deadline)
        if (isCurrent(request)) {
          pending = null
          controller = null
        }
      })
    return pending
  }

  return {
    acceptsStartup,
    beginRequest,
    cancel,
    delivered() {
      attempts = 0
      exhausted = false
    },
    getIdentity: () => identity,
    getSummary: () => ({
      attempts,
      exhausted,
      inProgress: pending !== null || timer !== null,
    }),
    isCurrent,
    isRecovering: () => pending !== null || timer !== null,
    recover,
    reset,
  }
}
