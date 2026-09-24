import { hasBookmarkPermission, hasHostPermission } from "../permissions.js"
import type { JsonObject } from "../runtime/types.js"
import type { ConfirmationMode } from "../storage.js"
import { withExclusiveStorageWrite } from "../storage-lock.js"

const KEY = "piBrowserAgentConfirmationApprovalsV1"
const LOCK = "pi-browser-agent-confirmation-approvals-write"
const MAX_APPROVALS = 256

/** Only explicit, stable operation identities may be reused. Never put private arguments in storage. */
export interface ApprovalScope {
  operation: string
  identity: readonly string[]
  permissionUrl?: string
  bookmarkPermission?: boolean
}

type ShowConfirmation = (
  message: string,
  details?: JsonObject,
  signal?: AbortSignal,
) => Promise<boolean>

function readKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const record = value as { version?: unknown; keys?: unknown }
  if (
    record.version !== 1 ||
    !Array.isArray(record.keys) ||
    record.keys.length > MAX_APPROVALS ||
    !record.keys.every((key: unknown) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
  )
    return []
  return record.keys as string[]
}

async function digest(scope: ApprovalScope): Promise<string | undefined> {
  const bytes = new TextEncoder().encode(JSON.stringify([scope.operation, ...scope.identity]))
  if (bytes.byteLength > 64 * 1024) return undefined
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function storage(mode: ConfirmationMode): chrome.storage.StorageArea {
  return mode === "balanced" ? chrome.storage.session : chrome.storage.local
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export class ConfirmationPolicy {
  constructor(
    private readonly mode: () => ConfirmationMode,
    private readonly show: ShowConfirmation,
  ) {}

  async confirm(
    message: string,
    details?: JsonObject,
    signal?: AbortSignal,
    scope?: ApprovalScope,
  ): Promise<boolean> {
    if (signal?.aborted) return false
    const mode = this.mode()
    if (mode === "strict" || !scope) return this.show(message, details, signal)

    const key = await digest(scope)
    if (!key) return this.show(message, details, signal)
    const area = storage(mode)
    // Cached consent never substitutes for a revoked Chrome or app-level permission.
    const access = scope.bookmarkPermission
      ? await hasBookmarkPermission().catch(() => false)
      : scope.permissionUrl
        ? await hasHostPermission(scope.permissionUrl).catch(() => false)
        : true
    if (access) {
      try {
        const stored = await area.get(KEY)
        if (readKeys(stored[KEY]).includes(key) && this.mode() === mode) {
          return !signal?.aborted
        }
      } catch {
        // A storage failure can only remove the shortcut, never approve an operation.
      }
    }
    const lifetime =
      mode === "balanced"
        ? "The same operation and target/arguments can run again without a dialog until Chrome restarts."
        : "The same operation and target/arguments can run again without a dialog after Chrome restarts, until cleared in Settings."
    const approved = await this.show(`${message}\n\n${lifetime}`, details, signal)
    if (!approved || signal?.aborted) return false
    if (this.mode() !== mode) return true
    // The confirmation button may have requested optional access; do not remember an
    // approval if Chrome denied it or the site grant was revoked while the dialog was open.
    const granted = scope.bookmarkPermission
      ? await hasBookmarkPermission().catch(() => false)
      : scope.permissionUrl
        ? await hasHostPermission(scope.permissionUrl).catch(() => false)
        : true
    if (!granted) return true
    await withExclusiveStorageWrite(LOCK, async () => {
      const stored = await area.get(KEY)
      const keys = readKeys(stored[KEY]).filter((item) => item !== key)
      keys.push(key)
      await area.set({ [KEY]: { version: 1, keys: keys.slice(-MAX_APPROVALS) } })
    })
    return true
  }
}

export async function clearConfirmationApprovals(): Promise<void> {
  await withExclusiveStorageWrite(LOCK, async () => {
    await chrome.storage.session.remove(KEY)
    await chrome.storage.local.remove(KEY)
  })
}
