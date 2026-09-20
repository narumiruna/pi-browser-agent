import { afterEach, describe, expect, test, vi } from "vitest"
import {
  BOOKMARKS_PERMISSION,
  hasBookmarkPermission,
  hasHostPermission,
  hasHostPermissions,
  hasScreenshotPermission,
  requestBookmarkPermission,
  requestHostPermission,
  requestHostPermissions,
  requestScreenshotPermission,
  SCREENSHOT_HOST_PERMISSION,
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

  test("checks and requests optional all-sites screenshot access", async () => {
    const contains = vi.fn().mockResolvedValue(false)
    const request = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("chrome", { permissions: { contains, request } })

    await expect(hasScreenshotPermission()).resolves.toBe(false)
    await expect(requestScreenshotPermission()).resolves.toBe(true)
    expect(contains).toHaveBeenCalledWith({ origins: [SCREENSHOT_HOST_PERMISSION] })
    expect(request).toHaveBeenCalledWith({ origins: [SCREENSHOT_HOST_PERMISSION] })
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
    expect(contains).toHaveBeenNthCalledWith(1, { origins: ["http://localhost/*"] })

    await expect(
      hasHostPermissions([
        "https://auth.openai.com/*",
        "https://chatgpt.com/backend-api",
        "https://auth.openai.com/oauth/token",
      ]),
    ).resolves.toBe(false)
    expect(contains).toHaveBeenNthCalledWith(2, {
      origins: ["https://auth.openai.com/*", "https://chatgpt.com/*"],
    })
  })

  test("requests only normalized, deduplicated destination permissions", async () => {
    const request = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("chrome", { permissions: { request } })

    await expect(requestHostPermission("https://example.test:8443/path")).resolves.toBe(true)
    expect(request).toHaveBeenNthCalledWith(1, { origins: ["https://example.test/*"] })

    await expect(
      requestHostPermissions([
        "https://example.test/one",
        "https://api.example.test/v1",
        "https://example.test/two",
      ]),
    ).resolves.toBe(true)
    expect(request).toHaveBeenNthCalledWith(2, {
      origins: ["https://example.test/*", "https://api.example.test/*"],
    })
  })
})
