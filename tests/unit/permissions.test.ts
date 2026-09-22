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

  test("does not treat broad screenshot access as approval for an exact origin", async () => {
    const contains = vi.fn().mockResolvedValue(true)
    const getAll = vi.fn().mockResolvedValue({ origins: [SCREENSHOT_HOST_PERMISSION] })
    const get = vi.fn().mockResolvedValue({ piBrowserAgentApprovedHostPermissions: [] })
    const set = vi.fn()
    vi.stubGlobal("chrome", {
      permissions: { contains, getAll },
      storage: { local: { get, set } },
    })

    await expect(hasHostPermission("https://example.test/path")).resolves.toBe(false)
    expect(getAll).toHaveBeenCalledOnce()
    expect(set).not.toHaveBeenCalled()
  })

  test("uses stored app approval without consulting broad Chrome grants", async () => {
    const contains = vi.fn().mockResolvedValue(true)
    const getAll = vi.fn()
    const get = vi.fn().mockResolvedValue({
      piBrowserAgentApprovedHostPermissions: ["https://example.test/*"],
    })
    vi.stubGlobal("chrome", {
      permissions: { contains, getAll },
      storage: { local: { get } },
    })

    await expect(hasHostPermission("https://example.test/path")).resolves.toBe(true)
    expect(getAll).not.toHaveBeenCalled()
  })

  test("migrates an independently granted exact origin to app approval", async () => {
    const contains = vi.fn().mockResolvedValue(true)
    const getAll = vi.fn().mockResolvedValue({ origins: ["https://example.test/*"] })
    const get = vi.fn().mockResolvedValue({ piBrowserAgentApprovedHostPermissions: [] })
    const set = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("chrome", {
      permissions: { contains, getAll },
      storage: { local: { get, set } },
    })

    await expect(hasHostPermission("https://example.test/path")).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith({
      piBrowserAgentApprovedHostPermissions: ["https://example.test/*"],
    })
  })

  test("requests only normalized, deduplicated destination permissions and records approval", async () => {
    const request = vi.fn().mockResolvedValue(true)
    let approved: string[] = []
    const get = vi.fn(async () => ({ piBrowserAgentApprovedHostPermissions: approved }))
    const set = vi.fn(async (value: { piBrowserAgentApprovedHostPermissions: string[] }) => {
      approved = value.piBrowserAgentApprovedHostPermissions
    })
    vi.stubGlobal("chrome", {
      permissions: { request },
      storage: { local: { get, set } },
    })

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
    expect(set).toHaveBeenLastCalledWith({
      piBrowserAgentApprovedHostPermissions: [
        "https://api.example.test/*",
        "https://example.test/*",
      ],
    })
  })

  test("serializes concurrent host approval updates", async () => {
    const request = vi.fn().mockResolvedValue(true)
    const lockRequest = vi.fn(
      async (_name: string, _options: LockOptions, operation: () => Promise<void>) => operation(),
    )
    let approved: string[] = []
    const get = vi.fn(async () => ({ piBrowserAgentApprovedHostPermissions: approved }))
    const set = vi.fn(async (value: { piBrowserAgentApprovedHostPermissions: string[] }) => {
      approved = value.piBrowserAgentApprovedHostPermissions
    })
    vi.stubGlobal("chrome", {
      permissions: { request },
      storage: { local: { get, set } },
    })
    vi.stubGlobal("navigator", { locks: { request: lockRequest } })

    await Promise.all([
      requestHostPermission("https://one.example.test/path"),
      requestHostPermission("https://two.example.test/path"),
    ])

    expect(approved).toEqual(["https://one.example.test/*", "https://two.example.test/*"])
    expect(lockRequest).toHaveBeenCalledTimes(2)
    expect(lockRequest).toHaveBeenCalledWith(
      "pi-browser-agent-approved-host-permissions-write",
      { mode: "exclusive" },
      expect.any(Function),
    )
  })
})
