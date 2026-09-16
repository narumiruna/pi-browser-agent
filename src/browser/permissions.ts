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
