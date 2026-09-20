export const BOOKMARKS_PERMISSION = "bookmarks" as const
export const SCREENSHOT_HOST_PERMISSION = "<all_urls>" as const
const APPROVED_HOST_PERMISSIONS_KEY = "piChromeApprovedHostPermissions"
const APPROVED_HOST_PERMISSIONS_LOCK = "pi-chrome-approved-host-permissions-write"
let approvalWriteChain: Promise<void> = Promise.resolve()

export function hasBookmarkPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: [BOOKMARKS_PERMISSION] })
}

export function requestBookmarkPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: [BOOKMARKS_PERMISSION] })
}

export function hasScreenshotPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [SCREENSHOT_HOST_PERMISSION] })
}

export function requestScreenshotPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: [SCREENSHOT_HOST_PERMISSION] })
}

export function toHostPermissionPattern(value: string | URL): string {
  const url = typeof value === "string" ? new URL(value) : value
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Host permissions require an HTTP or HTTPS URL")
  }
  return `${url.protocol}//${url.hostname}/*`
}

function hostPermissionPatterns(values: readonly (string | URL)[]): string[] {
  return [...new Set(values.map(toHostPermissionPattern))]
}

function isNormalizedHostPermission(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    return toHostPermissionPattern(value) === value
  } catch {
    return false
  }
}

async function approvedHostPermissions(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(APPROVED_HOST_PERMISSIONS_KEY)
  const value = stored[APPROVED_HOST_PERMISSIONS_KEY]
  return new Set(Array.isArray(value) ? value.filter(isNormalizedHostPermission) : [])
}

function withHostApprovalWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = approvalWriteChain
    .catch(() => undefined)
    .then(() => {
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks
      return locks
        ? locks.request(APPROVED_HOST_PERMISSIONS_LOCK, { mode: "exclusive" }, operation)
        : operation()
    })
  approvalWriteChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function approveHostPermissions(origins: readonly string[]): Promise<void> {
  return withHostApprovalWriteLock(async () => {
    const approved = await approvedHostPermissions()
    for (const origin of origins) approved.add(origin)
    await chrome.storage.local.set({
      [APPROVED_HOST_PERMISSIONS_KEY]: [...approved].sort(),
    })
  })
}

export async function hasHostPermission(value: string | URL): Promise<boolean> {
  return hasHostPermissions([value])
}

export async function hasHostPermissions(values: readonly (string | URL)[]): Promise<boolean> {
  const origins = hostPermissionPatterns(values)
  if (origins.length === 0) return true
  if (!(await chrome.permissions.contains({ origins }))) return false

  const approved = await approvedHostPermissions()
  if (origins.every((origin) => approved.has(origin))) return true

  const granted = await chrome.permissions.getAll()
  const explicitlyGranted = new Set(granted.origins ?? [])
  if (!origins.every((origin) => explicitlyGranted.has(origin))) return false

  await approveHostPermissions(origins)
  return true
}

export async function requestHostPermission(value: string | URL): Promise<boolean> {
  return requestHostPermissions([value])
}

export async function requestHostPermissions(values: readonly (string | URL)[]): Promise<boolean> {
  const origins = hostPermissionPatterns(values)
  if (origins.length === 0) return true
  if (!(await chrome.permissions.request({ origins }))) return false
  await approveHostPermissions(origins)
  return true
}
