// PDF.js legacy still requires Promise.withResolvers (Chrome 119).
// Keep this fallback local to the reader and its dedicated worker.
if (!("withResolvers" in Promise)) {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value: <T>() => {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((accept, decline) => {
        resolve = accept
        reject = decline
      })
      return { promise, resolve, reject }
    },
  })
}
