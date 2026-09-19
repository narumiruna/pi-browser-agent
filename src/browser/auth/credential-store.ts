import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai"

export const CREDENTIALS_KEY = "piChromeCredentialsV1"
const CREDENTIALS_WRITE_LOCK = "pi-chrome-credentials-write"

type StorageArea = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">

function throwIfAborted(options?: AuthOperationOptions): void {
  if (options?.signal?.aborted)
    throw new DOMException("Credential operation cancelled", "AbortError")
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null || !("type" in value)) return false
  if (value.type === "api_key") return true
  return (
    value.type === "oauth" &&
    "access" in value &&
    typeof value.access === "string" &&
    "refresh" in value &&
    typeof value.refresh === "string" &&
    "expires" in value &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  )
}

export class ChromeCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly area: StorageArea = chrome.storage.local,
    private readonly locks: LockManager | undefined = typeof navigator === "undefined"
      ? undefined
      : navigator.locks,
  ) {}

  private async readAll(): Promise<Record<string, Credential>> {
    const stored = await this.area.get(CREDENTIALS_KEY)
    const raw = stored[CREDENTIALS_KEY]
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, Credential] => isCredential(entry[1])),
    )
  }

  private enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(() =>
        this.locks
          ? this.locks.request(CREDENTIALS_WRITE_LOCK, { mode: "exclusive" }, operation)
          : operation(),
      )
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(providerId, settled)
    void settled.finally(() => {
      if (this.chains.get(providerId) === settled) this.chains.delete(providerId)
    })
    return result
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options)
    const credential = (await this.readAll())[providerId]
    throwIfAborted(options)
    return credential
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options)
    const all = await this.readAll()
    throwIfAborted(options)
    return Object.entries(all).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      throwIfAborted(options)
      const all = await this.readAll()
      const current = all[providerId]
      const next = await fn(current)
      throwIfAborted(options)
      if (next === undefined) return current
      if (!isCredential(next)) throw new Error("Refusing to persist a malformed credential")
      await this.area.set({ [CREDENTIALS_KEY]: { ...all, [providerId]: next } })
      return next
    })
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      throwIfAborted(options)
      const all = await this.readAll()
      if (!(providerId in all)) return
      delete all[providerId]
      if (Object.keys(all).length === 0) await this.area.remove(CREDENTIALS_KEY)
      else await this.area.set({ [CREDENTIALS_KEY]: all })
    })
  }
}
