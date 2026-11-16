/** Five profile-wide provider slots, including all panels and PDF readers. */
export async function withTranslationSlot<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!navigator.locks) throw new Error("Translation requires browser Web Locks support")
  for (;;) {
    signal?.throwIfAborted()
    for (let index = 0; index < 5; index += 1) {
      const result = await navigator.locks.request(
        `pi-browser-agent-translation-${index}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return undefined
          signal?.throwIfAborted()
          return { value: await operation() }
        },
      )
      if (result) return result.value
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const timer = setTimeout(finish, 50)
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        reject(new DOMException("Translation cancelled", "AbortError"))
      }
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}
