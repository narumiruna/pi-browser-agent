import { afterEach, describe, expect, test, vi } from "vitest"
import {
  getRecentBookmarks,
  MAX_BOOKMARK_RESULTS,
  searchBookmarks,
} from "../../src/browser/bookmarks.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

function bookmark(index: number): chrome.bookmarks.BookmarkTreeNode {
  return {
    id: String(index),
    parentId: "1",
    index,
    title: `Bookmark ${index}`,
    url: `https://example.test/${index}`,
    dateAdded: index,
    syncing: false,
  }
}

describe("read-only bookmark adapter", () => {
  test("denies reads before calling the bookmarks API when permission is absent", async () => {
    const search = vi.fn()
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn().mockResolvedValue(false) },
      bookmarks: { search },
    })

    await expect(searchBookmarks("example", 10)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    })
    expect(search).not.toHaveBeenCalled()
  })

  test("normalizes and caps search results", async () => {
    const nodes = Array.from({ length: MAX_BOOKMARK_RESULTS + 2 }, (_, index) => bookmark(index))
    nodes[0] = { id: "folder", title: "Folder", syncing: false }
    const search = vi.fn().mockResolvedValue(nodes)
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn().mockResolvedValue(true) },
      bookmarks: { search },
    })

    await expect(searchBookmarks("  example  ", MAX_BOOKMARK_RESULTS)).resolves.toEqual({
      items: [
        { title: "Folder", type: "folder" },
        ...nodes.slice(1, MAX_BOOKMARK_RESULTS).map((node) => ({
          title: node.title,
          type: "bookmark",
          url: node.url,
        })),
      ],
      limit: MAX_BOOKMARK_RESULTS,
      truncated: true,
    })
    expect(search).toHaveBeenCalledWith("example")
  })

  test("reads one extra recent bookmark to report truncation", async () => {
    const getRecent = vi.fn().mockResolvedValue([bookmark(1), bookmark(2), bookmark(3)])
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn().mockResolvedValue(true) },
      bookmarks: { getRecent },
    })

    await expect(getRecentBookmarks(2)).resolves.toMatchObject({
      items: [{ title: "Bookmark 1" }, { title: "Bookmark 2" }],
      limit: 2,
      truncated: true,
    })
    expect(getRecent).toHaveBeenCalledWith(3)
  })

  test.each([
    ["search", () => searchBookmarks("query", 0)],
    ["recent", () => getRecentBookmarks(MAX_BOOKMARK_RESULTS + 1)],
  ])("rejects an out-of-range %s limit", async (_name, operation) => {
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn().mockResolvedValue(true) },
      bookmarks: {},
    })
    await expect(operation()).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })

  test("maps permission revocation during an API call without exposing Chrome errors", async () => {
    const contains = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    vi.stubGlobal("chrome", {
      permissions: { contains },
      bookmarks: { search: vi.fn().mockRejectedValue(new Error("sensitive browser detail")) },
    })

    await expect(searchBookmarks("example", 10)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: "Chrome bookmark access was revoked",
    })
  })

  test("maps other bookmark API failures to a generic internal error", async () => {
    const contains = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("chrome", {
      permissions: { contains },
      bookmarks: { getRecent: vi.fn().mockRejectedValue(new Error("sensitive browser detail")) },
    })

    await expect(getRecentBookmarks(10)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Chrome could not read bookmarks",
    })
  })
})
