import { afterEach, describe, expect, test, vi } from "vitest"
import {
  BOOKMARKS_PERMISSION,
  hasBookmarkPermission,
  hasHostPermission,
  requestBookmarkPermission,
  requestHostPermission,
  toHostPermissionPattern,
} from "../../src/browser/permissions.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser permissions", () => {
  test("checks and requests only optional bookmark access", async () => {
    const contains = vi.fn().mockResolvedValue(false)
    const request = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("chrome", { permissions: { contains, request } })

    await expect(hasBookmarkPermission()).resolves.toBe(false)
    await expect(requestBookmarkPermission()).resolves.toBe(true)
    expect(contains).toHaveBeenCalledWith({ permissions: [BOOKMARKS_PERMISSION] })
    expect(request).toHaveBeenCalledWith({ permissions: [BOOKMARKS_PERMISSION] })
  })

  test("normalizes HTTP and HTTPS URLs to origin patterns without ports", () => {
    expect(toHostPermissionPattern("http://localhost:3000/path")).toBe("http://localhost/*")
    expect(toHostPermissionPattern("https://example.test:8443/path")).toBe("https://example.test/*")
    expect(toHostPermissionPattern("http://[::1]:3000/path")).toBe("http://[::1]/*")
  })

  test("rejects unsupported URL schemes", () => {
    expect(() => toHostPermissionPattern("ftp://example.test/file")).toThrow(/HTTP or HTTPS/)
  })

  test("checks the normalized destination permission", async () => {
    const contains = vi.fn().mockResolvedValue(false)
    vi.stubGlobal("chrome", { permissions: { contains } })

    await expect(hasHostPermission("http://localhost:3000/path")).resolves.toBe(false)
    expect(contains).toHaveBeenCalledWith({ origins: ["http://localhost/*"] })
  })

  test("requests only the normalized destination permission", async () => {
    const request = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("chrome", { permissions: { request } })

    await expect(requestHostPermission("https://example.test:8443/path")).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith({ origins: ["https://example.test/*"] })
  })
})
