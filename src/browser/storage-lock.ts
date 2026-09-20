const writeTails = new Map<string, Promise<void>>()

function defaultLockManager(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks
}

export function withExclusiveStorageWrite<T>(
  name: string,
  operation: () => Promise<T>,
  locks: LockManager | undefined = defaultLockManager(),
): Promise<T> {
  const previous = writeTails.get(name) ?? Promise.resolve()
  const result = previous
    .catch(() => undefined)
    .then(() => (locks ? locks.request(name, { mode: "exclusive" }, operation) : operation()))
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  writeTails.set(name, settled)
  void settled.finally(() => {
    if (writeTails.get(name) === settled) writeTails.delete(name)
  })
  return result
}
