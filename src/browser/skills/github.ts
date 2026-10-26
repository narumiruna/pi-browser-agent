import { hasApprovedHostPermission } from "../permissions.js"
import { SKILL_LIMITS, SkillError } from "./format.js"

export const GITHUB_API_ORIGIN = "https://api.github.com"

export interface GitHubSkillCandidate {
  path: string
  sha: string
  size: number
}

export interface GitHubSkillListing {
  repository: string
  commit: string
  candidates: GitHubSkillCandidate[]
}

const SHA = /^[a-f0-9]{40}$/
const COMMIT_BYTES = 131_072
const TREE_BYTES = 2_097_152
const BLOB_BYTES = 131_072
const MAX_ENTRIES = 10_000
const MAX_CANDIDATES = 200
const TIMEOUT_MS = 30_000
const INVALID_RESPONSE = "Invalid GitHub response"
const INVALID_SELECTION = "Invalid GitHub skill selection"
const PERMISSION_ERROR = "GitHub API host approval is required"
const CANCELLED = "GitHub read cancelled"
const REQUEST_FAILED =
  "GitHub request failed; check the canonical repository and host access. Redirects are not allowed"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sha(value: unknown): value is string {
  return typeof value === "string" && value.length === 40 && SHA.test(value)
}

function size(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Accept repository roots only. A conventional terminal .git suffix is removed. */
export function parseGitHubRepository(input: string): string {
  const invalid = () =>
    new SkillError("Enter a GitHub repository as owner/repo or an HTTPS repository-root URL")
  if (typeof input !== "string" || input.length > 512) throw invalid()
  let source = input.trim()
  if (/^https:\/\//i.test(source)) {
    // Check raw syntax, not URL.port: URL normalizes an explicit :443 away.
    const match = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/?$/i.exec(source)
    if (!match?.[1]) throw invalid()
    source = match[1]
  }
  source = source.replace(/\.git$/i, "")
  if (/\s/.test(source)) throw invalid()
  const parts = source.split("/")
  const owner = parts[0]
  const repository = parts[1]
  if (
    parts.length !== 2 ||
    !owner ||
    owner.length > 39 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(owner) ||
    owner.includes("--") ||
    !repository ||
    repository.length > 100 ||
    !/^[a-z0-9_.-]+$/i.test(repository) ||
    repository === "." ||
    repository === ".." ||
    /\.git$/i.test(repository)
  )
    throw invalid()
  return `${owner}/${repository}`.toLowerCase()
}

function safePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 1024) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject unsafe untrusted path characters.
  const unsafe = /[\u0000-\u001f\u007f-\u009f\\%:?#]/u
  const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
  if (unsafe.test(value) || invalidUnicode.test(value)) return false
  const parts = value.split("/")
  return (
    parts.length <= 64 &&
    parts.every((part) => part.length > 0 && part.length <= 255 && part !== "." && part !== "..")
  )
}

function skillPath(path: string): boolean {
  return path === "SKILL.md" || (path.startsWith("skills/") && path.endsWith("/SKILL.md"))
}

function root(path: string): string {
  return path === "SKILL.md" ? "" : path.slice(0, -"SKILL.md".length)
}

function withoutNested(candidates: GitHubSkillCandidate[]): GitHubSkillCandidate[] {
  const roots = new Set(candidates.map((candidate) => root(candidate.path)))
  return candidates
    .filter(({ path }) => {
      if (path !== "SKILL.md" && roots.has("")) return false
      const parts = path.split("/")
      for (let i = 1; i < parts.length - 1; i++) {
        if (roots.has(`${parts.slice(0, i).join("/")}/`)) return false
      }
      return true
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function treeCandidates(value: unknown, treeSha: string): GitHubSkillCandidate[] {
  if (
    !record(value) ||
    value.sha !== treeSha ||
    !Array.isArray(value.tree) ||
    typeof value.truncated !== "boolean"
  ) {
    throw new SkillError(INVALID_RESPONSE)
  }
  if (value.truncated)
    throw new SkillError("GitHub tree is truncated; no partial listing is available")
  if (value.tree.length > MAX_ENTRIES)
    throw new SkillError("GitHub tree exceeds the 10000-entry limit")
  const paths = new Set<string>()
  const candidates: GitHubSkillCandidate[] = []
  for (const entry of value.tree) {
    if (!record(entry) || !safePath(entry.path) || !sha(entry.sha) || paths.has(entry.path))
      throw new SkillError(INVALID_RESPONSE)
    paths.add(entry.path)
    const regular = entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")
    const other =
      (entry.type === "tree" && entry.mode === "040000") ||
      (entry.type === "blob" && entry.mode === "120000") ||
      (entry.type === "commit" && entry.mode === "160000")
    if ((!regular && !other) || (entry.type === "blob" && !size(entry.size)))
      throw new SkillError(INVALID_RESPONSE)
    if (regular && skillPath(entry.path))
      candidates.push({ path: entry.path, sha: entry.sha, size: entry.size as number })
  }
  const result = withoutNested(candidates)
  if (result.length > MAX_CANDIDATES)
    throw new SkillError("GitHub listing exceeds the 200-candidate limit")
  return result
}

/** Copy and validate public inputs before any await; caller mutation cannot retarget a read. */
function selection(
  listing: GitHubSkillListing,
  candidate: GitHubSkillCandidate,
): { listing: GitHubSkillListing; candidate: GitHubSkillCandidate } {
  if (
    !record(listing) ||
    typeof listing.repository !== "string" ||
    !sha(listing.commit) ||
    !Array.isArray(listing.candidates) ||
    listing.candidates.length > MAX_CANDIDATES
  )
    throw new SkillError(INVALID_SELECTION)
  let repository: string
  try {
    repository = parseGitHubRepository(listing.repository)
  } catch {
    throw new SkillError(INVALID_SELECTION)
  }
  if (repository !== listing.repository) throw new SkillError(INVALID_SELECTION)
  const paths = new Set<string>()
  const candidates: GitHubSkillCandidate[] = []
  for (const item of listing.candidates) {
    if (
      !record(item) ||
      !safePath(item.path) ||
      !skillPath(item.path) ||
      !sha(item.sha) ||
      !size(item.size) ||
      paths.has(item.path)
    )
      throw new SkillError(INVALID_SELECTION)
    paths.add(item.path)
    candidates.push({ path: item.path, sha: item.sha, size: item.size })
  }
  if (withoutNested(candidates).length !== candidates.length || !record(candidate))
    throw new SkillError(INVALID_SELECTION)
  const selected = candidates.find(
    (item) =>
      item.path === candidate.path && item.sha === candidate.sha && item.size === candidate.size,
  )
  if (!selected) throw new SkillError(INVALID_SELECTION)
  return { listing: { repository, commit: listing.commit, candidates }, candidate: selected }
}

/** A user-opened, immutable source link; never used as a network endpoint. */
export function githubSkillSourceUrl(
  listing: GitHubSkillListing,
  candidate: GitHubSkillCandidate,
): string {
  const checked = selection(listing, candidate)
  return `https://github.com/${checked.listing.repository}/blob/${checked.listing.commit}/${checked.candidate.path.split("/").map(encodeURIComponent).join("/")}`
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  active(signal)
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

interface ReadOperation {
  signal: AbortSignal
  approved(): Promise<void>
}

async function operation<T>(
  caller: AbortSignal,
  work: (operation: ReadOperation) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const signal = controller.signal
  let live = true
  const abort = (message: string) => {
    if (live && !signal.aborted) controller.abort(new SkillError(message))
  }
  const onAbort = () => abort(CANCELLED)
  const approved = async () => {
    active(signal)
    let allowed = false
    try {
      allowed = await hasApprovedHostPermission(GITHUB_API_ORIGIN)
    } catch {
      /* Fail closed. */
    }
    if (!allowed) abort(PERMISSION_ERROR)
    active(signal)
  }
  // Check actual access on every removal. Removing an unrelated grant must not abort.
  let removalCheck: Promise<void> = Promise.resolve()
  let removalVersion = 0
  const onRemoved = () => {
    removalVersion++
    removalCheck = approved().catch(() => {})
  }
  const timer = setTimeout(() => abort("GitHub read timed out after 30 seconds"), TIMEOUT_MS)
  caller.addEventListener("abort", onAbort, { once: true })
  chrome.permissions.onRemoved.addListener(onRemoved)
  try {
    if (caller.aborted) onAbort()
    active(signal)
    const result = await abortable(
      (async () => {
        const result = await work({ signal, approved })
        let checkedVersion: number
        do {
          checkedVersion = removalVersion
          await removalCheck
          await approved()
        } while (checkedVersion !== removalVersion)
        active(signal)
        return result
      })(),
      signal,
    )
    active(signal)
    return result
  } catch (error) {
    active(signal)
    if (error instanceof SkillError) throw error
    throw new SkillError(REQUEST_FAILED)
  } finally {
    live = false
    clearTimeout(timer)
    caller.removeEventListener("abort", onAbort)
    chrome.permissions.onRemoved.removeListener(onRemoved)
    controller.abort(new SkillError(CANCELLED))
  }
}

function rateInfo(headers: Headers): string {
  const integer = (name: string, max: number): number | undefined => {
    const value = headers.get(name)
    if (!value || !/^\d{1,12}$/.test(value)) return
    const number = Number(value)
    return Number.isSafeInteger(number) && number <= max ? number : undefined
  }
  const remaining = integer("x-ratelimit-remaining", 1_000_000_000)
  const reset = integer("x-ratelimit-reset", 253_402_300_799)
  return (
    (remaining === undefined ? "" : ` Rate limit remaining: ${remaining}.`) +
    (reset === undefined ? "" : ` Rate limit reset: ${new Date(reset * 1000).toISOString()}.`)
  )
}

async function request(path: string, limit: number, operation: ReadOperation): Promise<unknown> {
  await operation.approved()
  active(operation.signal)
  let response: Response
  try {
    response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
      signal: operation.signal,
    })
  } catch {
    throw new SkillError(REQUEST_FAILED)
  }
  if (operation.signal.aborted) {
    void response.body?.cancel().catch(() => {})
    active(operation.signal)
  }
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {})
    const message =
      (response.status >= 300 && response.status < 400) || response.redirected
        ? "GitHub redirected the request; enter the canonical repository"
        : response.status === 404
          ? "GitHub repository or object is unavailable"
          : response.status === 403 || response.status === 429
            ? "GitHub API access was denied or rate limited"
            : "GitHub request failed"
    throw new SkillError(message + rateInfo(response.headers))
  }
  if (!response.body) throw new SkillError(INVALID_RESPONSE)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let complete = false
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await abortable(reader.read(), operation.signal)
      } catch {
        active(operation.signal)
        throw new SkillError(REQUEST_FAILED)
      }
      const { done, value } = chunk
      active(operation.signal)
      if (done) {
        complete = true
        break
      }
      received += value.byteLength
      if (received > limit) throw new SkillError("GitHub response exceeds the received-byte limit")
      chunks.push(value)
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new SkillError(INVALID_RESPONSE)
  }
}

export async function listGitHubSkills(
  repository: string,
  signal: AbortSignal,
): Promise<GitHubSkillListing> {
  const normalized = parseGitHubRepository(repository)
  return operation(signal, async (op) => {
    const commits = await request(`/repos/${normalized}/commits?per_page=1`, COMMIT_BYTES, op)
    if (!Array.isArray(commits) || commits.length !== 1) throw new SkillError(INVALID_RESPONSE)
    const item: unknown = commits[0]
    if (
      !record(item) ||
      !sha(item.sha) ||
      !record(item.commit) ||
      !record(item.commit.tree) ||
      !sha(item.commit.tree.sha)
    )
      throw new SkillError(INVALID_RESPONSE)
    const tree = await request(
      `/repos/${normalized}/git/trees/${item.commit.tree.sha}?recursive=1`,
      TREE_BYTES,
      op,
    )
    return {
      repository: normalized,
      commit: item.sha,
      candidates: treeCandidates(tree, item.commit.tree.sha),
    }
  })
}

export async function readGitHubSkill(
  listing: GitHubSkillListing,
  candidate: GitHubSkillCandidate,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const checked = selection(listing, candidate)
  if (checked.candidate.size > SKILL_LIMITS.inputBytes)
    throw new SkillError("GitHub skill exceeds the 65536-byte source limit")
  return operation(signal, async (op) => {
    const value = await request(
      `/repos/${checked.listing.repository}/git/blobs/${checked.candidate.sha}`,
      BLOB_BYTES,
      op,
    )
    if (
      !record(value) ||
      value.sha !== checked.candidate.sha ||
      value.size !== checked.candidate.size ||
      value.encoding !== "base64" ||
      typeof value.content !== "string"
    )
      throw new SkillError(INVALID_RESPONSE)
    // GitHub wraps Base64 with LF. Reject all other whitespace and noncanonical padding.
    const content = value.content.replaceAll("\n", "")
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
      throw new SkillError("Invalid GitHub skill Base64")
    let binary: string
    try {
      binary = atob(content)
    } catch {
      throw new SkillError("Invalid GitHub skill Base64")
    }
    if (btoa(binary) !== content) throw new SkillError("Invalid GitHub skill Base64")
    if (binary.length > SKILL_LIMITS.inputBytes)
      throw new SkillError("GitHub skill exceeds the 65536-byte source limit")
    if (binary.length !== checked.candidate.size) throw new SkillError(INVALID_RESPONSE)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new SkillError("GitHub skill must be valid UTF-8 text")
    }
    return bytes
  })
}
