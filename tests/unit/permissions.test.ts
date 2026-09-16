import { afterEach, describe, expect, test, vi } from "vitest"
import { hasHostPermission, toHostPermissionPattern } from "../../src/browser/permissions.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser host permissions", () => {
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
})
