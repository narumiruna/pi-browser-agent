export function createContentLifecycle(options = {}) {
  const {
    document = globalThis.document,
    window = globalThis.window,
    scrollListenerOptions,
    onSchedule,
  } = options
  let started = false
  let scrollHandler = null
  let resizeHandler = null

  function start() {
    if (started) {
      return false
    }

    scrollHandler = () => onSchedule?.()
    resizeHandler = () => onSchedule?.()
    document?.addEventListener?.("scroll", scrollHandler, scrollListenerOptions)
    window?.addEventListener?.("resize", resizeHandler)
    started = true
    return true
  }

  function cleanup() {
    if (!started) {
      return false
    }

    document?.removeEventListener?.("scroll", scrollHandler, scrollListenerOptions)
    window?.removeEventListener?.("resize", resizeHandler)
    scrollHandler = null
    resizeHandler = null
    started = false
    return true
  }

  return { cleanup, start }
}

export default { createContentLifecycle }
