export const BOOKMARKS_PERMISSION = "bookmarks" as const

export function hasBookmarkPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: [BOOKMARKS_PERMISSION] })
}

export function requestBookmarkPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: [BOOKMARKS_PERMISSION] })
}

export function toHostPermissionPattern(value: string | URL): string {
  const url = typeof value === "string" ? new URL(value) : value
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Host permissions require an HTTP or HTTPS URL")
  }
  return `${url.protocol}//${url.hostname}/*`
}

export async function hasHostPermission(value: string | URL): Promise<boolean> {
  return chrome.permissions.contains({ origins: [toHostPermissionPattern(value)] })
}

export async function requestHostPermission(value: string | URL): Promise<boolean> {
  return requestHostPermissions([value])
}

export async function requestHostPermissions(values: readonly (string | URL)[]): Promise<boolean> {
  const origins = [...new Set(values.map(toHostPermissionPattern))]
  if (origins.length === 0) return true
  return chrome.permissions.request({ origins })
}
