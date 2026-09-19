import { hasBookmarkPermission } from "./permissions.js"
import { type JsonObject, RuntimeError } from "./runtime/types.js"

export const MAX_BOOKMARK_RESULTS = 50

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOOKMARK_RESULTS) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Bookmark result limit must be between 1 and ${MAX_BOOKMARK_RESULTS}`,
    )
  }
}

async function bookmarkPermissionGranted(): Promise<boolean> {
  try {
    return await hasBookmarkPermission()
  } catch {
    return false
  }
}

async function readBookmarks(
  operation: () => Promise<chrome.bookmarks.BookmarkTreeNode[]>,
): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  if (!(await bookmarkPermissionGranted())) {
    throw new RuntimeError("PERMISSION_DENIED", "Chrome bookmark access is not granted")
  }
  try {
    return await operation()
  } catch {
    if (!(await bookmarkPermissionGranted())) {
      throw new RuntimeError("PERMISSION_DENIED", "Chrome bookmark access was revoked")
    }
    throw new RuntimeError("INTERNAL_ERROR", "Chrome could not read bookmarks")
  }
}

function normalizeBookmark(node: chrome.bookmarks.BookmarkTreeNode): JsonObject {
  const bookmark: JsonObject = {
    title: node.title,
    type: node.url === undefined ? "folder" : "bookmark",
  }
  if (node.url !== undefined) bookmark.url = node.url
  return bookmark
}

function boundedResult(nodes: chrome.bookmarks.BookmarkTreeNode[], limit: number): JsonObject {
  return {
    items: nodes.slice(0, limit).map(normalizeBookmark),
    limit,
    truncated: nodes.length > limit,
  }
}

export async function searchBookmarks(query: string, limit: number): Promise<JsonObject> {
  validateLimit(limit)
  const normalizedQuery = query.trim()
  if (!normalizedQuery || normalizedQuery.length > 500) {
    throw new RuntimeError("INVALID_REQUEST", "Bookmark search query must be 1 to 500 characters")
  }
  const nodes = await readBookmarks(() => chrome.bookmarks.search(normalizedQuery))
  return boundedResult(nodes, limit)
}

export async function getRecentBookmarks(limit: number): Promise<JsonObject> {
  validateLimit(limit)
  const nodes = await readBookmarks(() => chrome.bookmarks.getRecent(limit + 1))
  return boundedResult(nodes, limit)
}
