import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { SkillError } from "../../src/browser/skills/format.js"
import {
  GITHUB_API_ORIGIN,
  type GitHubSkillCandidate,
  type GitHubSkillListing,
  githubSkillSourceUrl,
  listGitHubSkills,
  parseGitHubRepository,
  readGitHubSkill,
} from "../../src/browser/skills/github.js"

const COMMIT = "a".repeat(40)
const TREE = "b".repeat(40)
const BLOB = "c".repeat(40)
const OTHER = "d".repeat(40)
const ORIGIN_PATTERN = `${GITHUB_API_ORIGIN}/*`
const SOURCE = "---\nname: synthetic\ndescription: Synthetic fixture\n---\nReview only. 🙂\n"
const bytes = new TextEncoder().encode(SOURCE)
const candidate = { path: "skills/.curated/synthetic/SKILL.md", sha: BLOB, size: bytes.length }
const listing: GitHubSkillListing = {
  repository: "example/skills",
  commit: COMMIT,
  candidates: [candidate],
}
const signal = () => new AbortController().signal
const json = (value: unknown) => new Response(JSON.stringify(value))
const commit = () => [
  { sha: COMMIT, commit: { tree: { sha: TREE, url: "https://evil.example/tree" } } },
]
const file = (path = candidate.path, extra: Record<string, unknown> = {}) => ({
  path,
  sha: BLOB,
  size: bytes.length,
  mode: "100644",
  type: "blob",
  ...extra,
})
const tree = (entries: unknown[] = [file()]) => ({ sha: TREE, truncated: false, tree: entries })
const base64 = (input: Uint8Array) =>
  btoa(Array.from(input, (byte) => String.fromCharCode(byte)).join(""))
const blob = (extra: Record<string, unknown> = {}) => ({
  sha: BLOB,
  size: bytes.length,
  encoding: "base64",
  content: `${base64(bytes)}\n`,
  url: "https://evil.example/blob",
  ...extra,
})

function environment() {
  const state = { native: true, approved: true }
  const listeners = new Set<() => void>()
  const contains = vi.fn(async () => state.native)
  const get = vi.fn(async () => ({
    piBrowserAgentApprovedHostPermissions: state.approved ? [ORIGIN_PATTERN] : [],
  }))
  const set = vi.fn()
  const request = vi.fn()
  const addListener = vi.fn((listener: () => void) => {
    listeners.add(listener)
  })
  const removeListener = vi.fn((listener: () => void) => {
    listeners.delete(listener)
  })
  vi.stubGlobal("chrome", {
    permissions: { contains, request, onRemoved: { addListener, removeListener } },
    storage: { local: { get, set } },
  })
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal("fetch", fetch)
  return {
    state,
    contains,
    get,
    set,
    request,
    listeners,
    fetch,
    addListener,
    removeListener,
    removed() {
      for (const listener of listeners) listener()
    },
    list(entries: unknown[] = [file()]) {
      fetch.mockResolvedValueOnce(json(commit())).mockResolvedValueOnce(json(tree(entries)))
    },
    clean() {
      expect(listeners.size).toBe(0)
      expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length)
      expect(vi.getTimerCount()).toBe(0)
      expect(request).not.toHaveBeenCalled()
      expect(set).not.toHaveBeenCalled()
    },
  }
}

async function drain() {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("GitHub repository input", () => {
  test.each([
    ["openai/skills", "openai/skills"],
    [" Example/Skill_Repo.git ", "example/skill_repo"],
    ["https://github.com/Example/Skills", "example/skills"],
    ["HTTPS://GITHUB.COM/Example/Skills.git/", "example/skills"],
    ["a/.hidden", "a/.hidden"],
  ])("normalizes %s", (input, expected) => expect(parseGitHubRepository(input)).toBe(expected))

  test.each([
    "",
    "example",
    "example/skills/",
    "example/skills/path",
    "example/skills?",
    "example/skills#",
    "https://github.com/example/skills?",
    "https://github.com/example/skills#",
    "https://github.com/example/skills?x=y",
    "https://github.com/example/skills#readme",
    "https://github.com/example/skills/tree/main",
    "https://github.com/example/skills/blob/main/SKILL.md",
    "https://github.com:443/example/skills",
    "https://github.com:8443/example/skills",
    "https://user@github.com/example/skills",
    "https://user:secret@github.com/example/skills",
    "http://github.com/example/skills",
    "git@github.com:example/skills.git",
    "ssh://git@github.com/example/skills",
    "git://github.com/example/skills",
    "https://api.github.com/example/skills",
    "https://github.com.evil.example/example/skills",
    "https://github.com./example/skills",
    "//github.com/example/skills",
    "https://github.com/example/skills/../other",
    "https://github.com/example%2Fother/skills",
    "https://github.com/example/skills%2e",
    "https://github.com\\example/skills",
    "-example/skills",
    "example-/skills",
    "ex--ample/skills",
    "example/..",
    "example/.",
    "example/.git",
    "example/skills.git.git",
    "example/skill name",
    "example/技能",
    "exam\nple/skills",
    "example\n/skills",
    `${"a".repeat(40)}/skills`,
    `example/${"a".repeat(101)}`,
    "a".repeat(513),
  ])("rejects %s with a local diagnostic", (input) => {
    expect(() => parseGitHubRepository(input)).toThrow(SkillError)
    expect(() => parseGitHubRepository(input)).toThrow("Enter a GitHub repository")
  })
  test("validates non-string runtime input", () =>
    expect(() => parseGitHubRepository(null as unknown as string)).toThrow(SkillError))
})

describe("immutable path-only GitHub discovery", () => {
  test("uses exactly two fixed API reads and lazily reads only the selected blob", async () => {
    const env = environment()
    env.list()
    const result = await listGitHubSkills("https://github.com/Example/Skills.git", signal())
    expect(result).toEqual(listing)
    expect(env.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${GITHUB_API_ORIGIN}/repos/example/skills/commits?per_page=1`,
      `${GITHUB_API_ORIGIN}/repos/example/skills/git/trees/${TREE}?recursive=1`,
    ])
    expect(env.contains).toHaveBeenCalledTimes(3)
    env.clean()
    env.fetch.mockResolvedValueOnce(json(blob()))
    expect(await readGitHubSkill(result, { ...candidate }, signal())).toEqual(bytes)
    expect(env.fetch).toHaveBeenCalledTimes(3)
    expect(env.fetch.mock.calls[2]?.[0]).toBe(
      `${GITHUB_API_ORIGIN}/repos/example/skills/git/blobs/${BLOB}`,
    )
    expect(env.contains).toHaveBeenCalledTimes(5)
    for (const [url, init] of env.fetch.mock.calls) {
      expect(new URL(String(url)).origin).toBe(GITHUB_API_ORIGIN)
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      })
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ["accept", "application/vnd.github+json"],
      ])
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    for (const [details] of env.contains.mock.calls as unknown as [{ origins: string[] }][])
      expect(details).toEqual({ origins: [ORIGIN_PATTERN] })
    expect(githubSkillSourceUrl(result, candidate)).toBe(
      `https://github.com/example/skills/blob/${COMMIT}/${candidate.path}`,
    )
    env.clean()
  })

  test("discovers category/dot directories, preserves full-path identity, and sorts deterministically", async () => {
    const env = environment()
    const paths = [
      "skills/z/same/SKILL.md",
      "skills/.system/same/SKILL.md",
      "skills/.curated/same/SKILL.md",
      "skills/.experimental/same/SKILL.md",
      "skills/direct/SKILL.md",
      "skills/SKILL.md",
    ]
    env.list(
      paths
        .slice(0, -1)
        .map((path, index) =>
          file(path, { sha: index % 2 ? OTHER : BLOB, mode: index % 2 ? "100755" : "100644" }),
        ),
    )
    const result = await listGitHubSkills("example/skills", signal())
    expect(result.candidates.map(({ path }) => path)).toEqual(paths.slice(0, -1).sort())
    expect(new Set(result.candidates.map(({ path }) => path)).size).toBe(5)
    expect(env.fetch).toHaveBeenCalledTimes(2)
    env.clean()
  })

  test("does not assume frontmatter names equal directory names", async () => {
    const env = environment()
    env.list([file("skills/not-the-frontmatter-name/SKILL.md")])
    const result = await listGitHubSkills("example/skills", signal())
    env.fetch.mockResolvedValueOnce(json(blob()))
    expect(
      new TextDecoder().decode(
        await readGitHubSkill(result, result.candidates[0] as GitHubSkillCandidate, signal()),
      ),
    ).toBe(SOURCE)
    env.clean()
  })

  test("excludes unsupported layouts, wrong case, symlinks, and submodules", async () => {
    const env = environment()
    env.list([
      file(".agents/skills/a/SKILL.md"),
      file("plugins/a/skills/a/SKILL.md"),
      file("skills/a/skill.md"),
      file("skills/a/SKILL.md.bak"),
      file("skills/a/SKILL.md", { mode: "120000" }),
      file("skills/b/SKILL.md", { type: "commit", mode: "160000", size: undefined }),
      file("skills/c/SKILL.md", { type: "tree", mode: "040000", size: undefined }),
    ])
    expect((await listGitHubSkills("example/skills", signal())).candidates).toEqual([])
    expect(env.fetch).toHaveBeenCalledTimes(2)
    env.clean()
  })

  test.each([false, true])(
    "suppresses nested skills independently of response order (root=%s)",
    async (rootSkill) => {
      const env = environment()
      env.list([
        file("skills/a/.nested/SKILL.md"),
        file("skills/a/SKILL.md"),
        file("skills/a/nested/SKILL.md"),
        file("skills/ab/SKILL.md"),
        ...(rootSkill ? [file("SKILL.md")] : []),
      ])
      expect(
        (await listGitHubSkills("example/skills", signal())).candidates.map(({ path }) => path),
      ).toEqual(rootSkill ? ["SKILL.md"] : ["skills/a/SKILL.md", "skills/ab/SKILL.md"])
      env.clean()
    },
  )

  test("supports a skill directly at skills/SKILL.md and suppresses its descendants", async () => {
    const env = environment()
    env.list([file(), file("skills/SKILL.md")])
    expect(
      (await listGitHubSkills("example/skills", signal())).candidates.map(({ path }) => path),
    ).toEqual(["skills/SKILL.md"])
    env.clean()
  })

  test("accepts exactly 10000 tree entries and 200 candidates", async () => {
    const env = environment()
    env.list(
      Array.from({ length: 10000 }, (_, i) =>
        file(i < 200 ? `skills/skill-${i}/SKILL.md` : `other/${i}.txt`),
      ),
    )
    expect((await listGitHubSkills("example/skills", signal())).candidates).toHaveLength(200)
    env.clean()
  })

  test.each(["entries", "candidates"])(
    "rejects excessive %s without returning a partial list",
    async (kind) => {
      const env = environment()
      env.list(
        Array.from({ length: kind === "entries" ? 10001 : 201 }, (_, i) =>
          file(`skills/${i}/SKILL.md`),
        ),
      )
      await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
        kind === "entries" ? "10000-entry limit" : "200-candidate limit",
      )
      expect(env.fetch).toHaveBeenCalledTimes(2)
      env.clean()
    },
  )

  test.each([
    null,
    {},
    [],
    { ...tree(), sha: OTHER },
    { ...tree(), sha: TREE.toUpperCase() },
    { ...tree(), truncated: undefined },
    { ...tree(), truncated: "false" },
    { ...tree(), tree: {} },
  ])("rejects invalid tree shape and source binding: %j", async (value) => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(commit())).mockResolvedValueOnce(json(value))
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "Invalid GitHub response",
    )
    env.clean()
  })

  test("rejects truncated trees rather than fetching subtrees", async () => {
    const env = environment()
    env.fetch
      .mockResolvedValueOnce(json(commit()))
      .mockResolvedValueOnce(json({ ...tree(), truncated: true }))
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "GitHub tree is truncated",
    )
    expect(env.fetch).toHaveBeenCalledTimes(2)
    env.clean()
  })

  test.each([
    null,
    {},
    file("../SKILL.md"),
    file("/SKILL.md"),
    file("skills//SKILL.md"),
    file("skills/./SKILL.md"),
    file("skills/../SKILL.md"),
    file("skills/\\evil/SKILL.md"),
    file("skills/%2e%2e/SKILL.md"),
    file("skills/a?b/SKILL.md"),
    file("skills/a#b/SKILL.md"),
    file("skills/a:b/SKILL.md"),
    file("skills/\u0000/SKILL.md"),
    file("skills/\uD800/SKILL.md"),
    file(`skills/${"x".repeat(256)}/SKILL.md`),
    file(`${"x/".repeat(65)}SKILL.md`),
    file(`${"x/".repeat(512)}SKILL.md`),
    file(undefined, { sha: "a".repeat(39) }),
    file(undefined, { sha: BLOB.toUpperCase() }),
    file(undefined, { sha: `${BLOB}\n` }),
    file(undefined, { sha: `../${BLOB}` }),
    file(undefined, { mode: "100600" }),
    file(undefined, { type: "tree" }),
    file(undefined, { size: -1 }),
    file(undefined, { size: 1.2 }),
    file(undefined, { size: "12" }),
    file(undefined, { size: Number.MAX_SAFE_INTEGER + 1 }),
    file(undefined, { size: undefined }),
  ])("rejects malformed or unsafe tree entry: %j", async (entry) => {
    const env = environment()
    env.list([entry])
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "Invalid GitHub response",
    )
    env.clean()
  })

  test("rejects duplicate full paths even if their SHAs differ", async () => {
    const env = environment()
    env.list([file(), file(undefined, { sha: OTHER })])
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "Invalid GitHub response",
    )
    env.clean()
  })

  test.each([
    null,
    {},
    [],
    [commit()[0], commit()[0]],
    [{ sha: OTHER }],
    [{ sha: COMMIT, commit: { tree: { sha: TREE.toUpperCase() } } }],
    [{ sha: COMMIT.toUpperCase(), commit: { tree: { sha: TREE } } }],
    [{ sha: "main", commit: { tree: { sha: TREE } } }],
  ])("rejects malformed commit resolution without a tree read: %j", async (value) => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(value))
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "Invalid GitHub response",
    )
    expect(env.fetch).toHaveBeenCalledTimes(1)
    env.clean()
  })
})

describe("selected GitHub blob validation", () => {
  test.each([
    null,
    {},
    { ...listing, repository: "https://evil.example/x/y" },
    { ...listing, repository: "Example/Skills" },
    { ...listing, repository: "example/skills.git" },
    { ...listing, commit: "main" },
    { ...listing, commit: COMMIT.toUpperCase() },
    { ...listing, commit: `${COMMIT}\n` },
    { ...listing, candidates: null },
    { ...listing, candidates: Array(201).fill(candidate) },
    { ...listing, candidates: [candidate, candidate] },
    { ...listing, candidates: [candidate, { ...candidate, path: "SKILL.md" }] },
    { ...listing, candidates: [{ ...candidate, path: "skills/../SKILL.md" }] },
    { ...listing, candidates: [{ ...candidate, path: "other/SKILL.md" }] },
    { ...listing, candidates: [{ ...candidate, size: -1 }] },
    { ...listing, candidates: [{ ...candidate, sha: "x" }] },
  ])("validates external listing before fetching: %j", async (value) => {
    const env = environment()
    await expect(readGitHubSkill(value as GitHubSkillListing, candidate, signal())).rejects.toThrow(
      "Invalid GitHub skill selection",
    )
    expect(() => githubSkillSourceUrl(value as GitHubSkillListing, candidate)).toThrow(SkillError)
    expect(env.fetch).not.toHaveBeenCalled()
    env.clean()
  })

  test.each([
    null,
    {},
    { ...candidate, path: "skills/other/SKILL.md" },
    { ...candidate, sha: OTHER },
    { ...candidate, size: bytes.length + 1 },
  ])("requires path, SHA, and size membership in the listing: %j", async (value) => {
    const env = environment()
    await expect(readGitHubSkill(listing, value as GitHubSkillCandidate, signal())).rejects.toThrow(
      "Invalid GitHub skill selection",
    )
    expect(env.fetch).not.toHaveBeenCalled()
    env.clean()
  })

  test("snapshots mutable public objects before asynchronous permission checks", async () => {
    const env = environment()
    const local = structuredClone(listing)
    const selected = local.candidates[0] as GitHubSkillCandidate
    env.fetch.mockResolvedValueOnce(json(blob()))
    const pending = readGitHubSkill(local, selected, signal())
    local.repository = "attacker/other"
    local.commit = OTHER
    selected.sha = OTHER
    selected.path = "SKILL.md"
    selected.size = 0
    expect(await pending).toEqual(bytes)
    expect(env.fetch.mock.calls[0]?.[0]).toBe(
      `${GITHUB_API_ORIGIN}/repos/example/skills/git/blobs/${BLOB}`,
    )
    env.clean()
  })

  test("source links encode safe Unicode and spaces, and pin the commit rather than a branch", () => {
    const selected = { ...candidate, path: "skills/日本 語/SKILL.md" }
    expect(githubSkillSourceUrl({ ...listing, candidates: [selected] }, selected)).toBe(
      `https://github.com/example/skills/blob/${COMMIT}/skills/%E6%97%A5%E6%9C%AC%20%E8%AA%9E/SKILL.md`,
    )
  })

  test.each([
    null,
    {},
    blob({ sha: OTHER }),
    blob({ sha: BLOB.toUpperCase() }),
    blob({ size: bytes.length + 1 }),
    blob({ size: String(bytes.length) }),
    blob({ encoding: "utf-8" }),
    blob({ content: null }),
    blob({ content: "YQ==" }),
  ])("rejects blob shape or SHA/size mismatch: %j", async (value) => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(value))
    await expect(readGitHubSkill(listing, candidate, signal())).rejects.toThrow(
      "Invalid GitHub response",
    )
    expect(env.fetch).toHaveBeenCalledTimes(1)
    env.clean()
  })

  test.each([
    "YQ=",
    "YQ",
    "Y===",
    "YQ==!",
    "Y Q==",
    "YQ==\t",
    "YQ==\r\n",
    "YQ==YQ==",
    "YQ-_",
    "YR==",
    "YWJ=",
    "====",
  ])("rejects noncanonical Base64 %j", async (content) => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(blob({ content })))
    await expect(readGitHubSkill(listing, candidate, signal())).rejects.toThrow(
      "Invalid GitHub skill Base64",
    )
    env.clean()
  })

  test.each([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f]])(
    "rejects invalid UTF-8 source bytes %j",
    async (...values) => {
      const input = Uint8Array.from(values)
      const selected = { ...candidate, size: input.length }
      const env = environment()
      env.fetch.mockResolvedValueOnce(json(blob({ size: input.length, content: base64(input) })))
      await expect(
        readGitHubSkill({ ...listing, candidates: [selected] }, selected, signal()),
      ).rejects.toThrow("GitHub skill must be valid UTF-8 text")
      env.clean()
    },
  )

  test("preserves exact BOM, Unicode, line endings, and LF-wrapped Base64 bytes", async () => {
    const input = new TextEncoder().encode(
      "\uFEFF---\r\nname: other\r\ndescription: Other\r\n---\r\n漢字🙂\r\n",
    )
    const selected = { ...candidate, size: input.length }
    const env = environment()
    env.fetch.mockResolvedValueOnce(
      json(
        blob({
          size: input.length,
          content: base64(input)
            .match(/.{1,7}/g)
            ?.join("\n"),
        }),
      ),
    )
    expect(
      await readGitHubSkill({ ...listing, candidates: [selected] }, selected, signal()),
    ).toEqual(input)
    env.clean()
  })

  test.each([65536, 65537])("enforces the decoded source limit at %s bytes", async (length) => {
    const selected = { ...candidate, size: length }
    const input = new Uint8Array(length).fill(97)
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(blob({ size: length, content: base64(input) })))
    const pending = readGitHubSkill({ ...listing, candidates: [selected] }, selected, signal())
    if (length === 65536) expect(await pending).toEqual(input)
    else {
      await expect(pending).rejects.toThrow("65536-byte source limit")
      expect(env.fetch).not.toHaveBeenCalled()
    }
    env.clean()
  })

  test("does not trust a small declared size when decoded content exceeds the source limit", async () => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(blob({ content: base64(new Uint8Array(65537)) })))
    await expect(readGitHubSkill(listing, candidate, signal())).rejects.toThrow(
      "65536-byte source limit",
    )
    env.clean()
  })
})

describe("bounded GitHub response reads and local diagnostics", () => {
  test.each(["commit", "tree", "blob"])(
    "caps actual streamed %s bytes and cancels unread data",
    async (kind) => {
      const env = environment()
      if (kind === "tree") env.fetch.mockResolvedValueOnce(json(commit()))
      let cancelled = false
      let pulled = 0
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++
            controller.enqueue(new Uint8Array(32768))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "Content-Length": "1" } },
      )
      env.fetch.mockResolvedValueOnce(response)
      const pending =
        kind === "blob"
          ? readGitHubSkill(listing, candidate, signal())
          : listGitHubSkills("example/skills", signal())
      await expect(pending).rejects.toThrow("GitHub response exceeds the received-byte limit")
      expect(cancelled).toBe(true)
      expect(pulled).toBeLessThanOrEqual((kind === "tree" ? 2097152 : 131072) / 32768 + 2)
      expect(env.fetch).toHaveBeenCalledTimes(kind === "tree" ? 2 : 1)
      env.clean()
    },
  )

  test.each(["commit", "tree", "blob"])(
    "accepts exactly the %s JSON byte ceiling without trusting Content-Length",
    async (kind) => {
      const env = environment()
      const limit = kind === "tree" ? 2097152 : 131072
      const value = JSON.stringify(kind === "commit" ? commit() : kind === "tree" ? tree() : blob())
      if (kind === "tree") env.fetch.mockResolvedValueOnce(json(commit()))
      env.fetch.mockResolvedValueOnce(
        new Response(value + " ".repeat(limit - new TextEncoder().encode(value).length), {
          headers: { "Content-Length": String(limit + 1) },
        }),
      )
      if (kind === "commit") env.fetch.mockResolvedValueOnce(json(tree()))
      if (kind === "blob")
        expect(await readGitHubSkill(listing, candidate, signal())).toEqual(bytes)
      else expect(await listGitHubSkills("example/skills", signal())).toEqual(listing)
      env.clean()
    },
  )

  test.each(["not JSON: server-secret", new Uint8Array([0xff]), "null"])(
    "rejects malformed JSON/UTF-8 without server text",
    async (body) => {
      const env = environment()
      env.fetch.mockResolvedValueOnce(new Response(body))
      await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
        "Invalid GitHub response",
      )
      env.clean()
    },
  )

  test.each([301, 302, 307, 401, 403, 404, 429, 500])(
    "rejects HTTP %s with local errors, no redirect, retry, or token request",
    async (status) => {
      const env = environment()
      env.fetch.mockResolvedValueOnce(
        new Response("server-secret <script>text</script>", {
          status,
          headers: {
            location: "https://evil.example/redirect",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000",
          },
        }),
      )
      const error = await listGitHubSkills("example/skills", signal()).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(SkillError)
      expect((error as Error).message).not.toMatch(/server-secret|evil|script/)
      expect((error as Error).message).toContain(
        "Rate limit remaining: 0. Rate limit reset: 2023-11-14T22:13:20.000Z.",
      )
      expect(env.fetch).toHaveBeenCalledTimes(1)
      env.clean()
    },
  )

  test.each(["secret", "-1", "1.5", "Infinity", "999999999999999999999999", "<script>"])(
    "does not echo malformed rate headers %s",
    async (value) => {
      const env = environment()
      env.fetch.mockResolvedValueOnce(
        new Response("server-secret", {
          status: 429,
          headers: { "x-ratelimit-remaining": value, "x-ratelimit-reset": value },
        }),
      )
      await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
        /^GitHub API access was denied or rate limited$/,
      )
      env.clean()
    },
  )

  test.each([new Error("network-secret"), new SkillError("network-secret")])(
    "does not echo raw browser/network exceptions",
    async (error) => {
      const env = environment()
      env.fetch.mockRejectedValueOnce(error)
      await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
        /^GitHub request failed; check the canonical repository and host access. Redirects are not allowed$/,
      )
      expect(env.fetch).toHaveBeenCalledTimes(1)
      env.clean()
    },
  )

  test("does not echo stream errors, even if they use the shared error class", async () => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new SkillError("stream-secret"))
          },
        }),
      ),
    )
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      /^GitHub request failed; check the canonical repository and host access. Redirects are not allowed$/,
    )
    env.clean()
  })

  test("rejects empty successful responses", async () => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(new Response(null))
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "Invalid GitHub response",
    )
    env.clean()
  })

  test("measures received bytes, not UTF-16 units", async () => {
    const env = environment()
    const payload = JSON.stringify({ untrusted: "漢".repeat(50000) })
    expect(payload.length).toBeLessThan(131072)
    env.fetch.mockResolvedValueOnce(new Response(payload))
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "received-byte limit",
    )
    env.clean()
  })

  test("rejects already-followed redirect responses defensively", async () => {
    const env = environment()
    const response = json(commit())
    Object.defineProperty(response, "redirected", { value: true })
    env.fetch.mockResolvedValueOnce(response)
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "GitHub redirected the request",
    )
    expect(env.fetch).toHaveBeenCalledTimes(1)
    env.clean()
  })
})

describe("GitHub permission and operation lifecycle", () => {
  test.each(["native", "approved"] as const)(
    "requires %s approval without migrating a broad screenshot grant",
    async (key) => {
      const env = environment()
      env.state[key] = false
      await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
        "GitHub API host approval is required",
      )
      await expect(readGitHubSkill(listing, candidate, signal())).rejects.toThrow(
        "GitHub API host approval is required",
      )
      expect(env.fetch).not.toHaveBeenCalled()
      env.clean()
    },
  )

  test.each([2, 3])("rechecks permission at listing checkpoint %s", async (checkpoint) => {
    const env = environment()
    env.list()
    env.contains.mockImplementation(async () => env.contains.mock.calls.length !== checkpoint)
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "GitHub API host approval is required",
    )
    expect(env.fetch).toHaveBeenCalledTimes(checkpoint === 2 ? 1 : 2)
    env.clean()
  })

  test("rechecks permission before delivering selected source bytes", async () => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(blob()))
    env.contains.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(readGitHubSkill(listing, candidate, signal())).rejects.toThrow(
      "GitHub API host approval is required",
    )
    expect(env.fetch).toHaveBeenCalledTimes(1)
    env.clean()
  })

  test("fails closed when a permission check rejects", async () => {
    const env = environment()
    env.contains.mockRejectedValueOnce(new Error("permission-secret"))
    await expect(listGitHubSkills("example/skills", signal())).rejects.toThrow(
      "GitHub API host approval is required",
    )
    expect(env.fetch).not.toHaveBeenCalled()
    env.clean()
  })

  test("pre-aborted callers issue no requests and discard caller error text", async () => {
    const env = environment()
    const caller = new AbortController()
    caller.abort(new Error("caller-secret"))
    await expect(listGitHubSkills("example/skills", caller.signal)).rejects.toThrow(
      /^GitHub read cancelled$/,
    )
    await expect(readGitHubSkill(listing, candidate, caller.signal)).rejects.toThrow(
      /^GitHub read cancelled$/,
    )
    expect(env.fetch).not.toHaveBeenCalled()
    env.clean()
  })

  test.each(["caller", "timeout", "revocation"])(
    "aborts a pending fetch on %s even if fetch ignores abort",
    async (action) => {
      const env = environment()
      const caller = new AbortController()
      let finish: (response: Response) => void = () => {}
      env.fetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
      const pending = listGitHubSkills("example/skills", caller.signal)
      const rejected = expect(pending).rejects.toThrow(
        action === "caller"
          ? "GitHub read cancelled"
          : action === "timeout"
            ? "GitHub read timed out after 30 seconds"
            : "GitHub API host approval is required",
      )
      await drain()
      expect(env.fetch).toHaveBeenCalledTimes(1)
      const ownSignal = env.fetch.mock.calls[0]?.[1]?.signal
      expect(ownSignal).not.toBe(caller.signal)
      if (action === "caller") caller.abort(new Error("caller-secret"))
      else if (action === "timeout") await vi.advanceTimersByTimeAsync(30000)
      else {
        env.state.native = false
        env.removed()
      }
      await rejected
      expect(ownSignal?.aborted).toBe(true)
      let lateBodyCancelled = false
      finish(
        new Response(
          new ReadableStream({
            cancel() {
              lateBodyCancelled = true
            },
          }),
        ),
      )
      await drain()
      expect(lateBodyCancelled).toBe(true)
      expect(env.fetch).toHaveBeenCalledTimes(1)
      env.clean()
    },
  )

  test("removing unrelated permissions or a redundant grant does not abort approved API access", async () => {
    const env = environment()
    let finish: (response: Response) => void = () => {}
    env.fetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValueOnce(json(tree()))
    const pending = listGitHubSkills("example/skills", signal())
    await drain()
    env.removed()
    await drain()
    expect(env.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    finish(json(commit()))
    expect(await pending).toEqual(listing)
    env.clean()
  })

  test.each(["caller", "timeout", "revocation"])(
    "cancels a pending body stream on %s",
    async (action) => {
      const env = environment()
      let cancelled = false
      env.fetch.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
      )
      const caller = new AbortController()
      const pending = readGitHubSkill(listing, candidate, caller.signal)
      const rejected = expect(pending).rejects.toThrow(SkillError)
      await drain()
      if (action === "caller") caller.abort()
      else if (action === "timeout") await vi.advanceTimersByTimeAsync(30000)
      else {
        env.state.approved = false
        env.removed()
      }
      await rejected
      await drain()
      expect(cancelled).toBe(true)
      expect(env.fetch).toHaveBeenCalledTimes(1)
      env.clean()
    },
  )

  test("uses one 30-second listing deadline across commit and tree reads", async () => {
    const env = environment()
    let finishCommit: (response: Response) => void = () => {}
    env.fetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishCommit = resolve
          }),
      )
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
    const pending = listGitHubSkills("example/skills", signal())
    const rejected = expect(pending).rejects.toThrow("GitHub read timed out after 30 seconds")
    await drain()
    await vi.advanceTimersByTimeAsync(20000)
    finishCommit(json(commit()))
    await drain()
    expect(env.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
    env.clean()
  })

  test("cancellation during permission lookup cannot deliver a stale result or dispatch a request", async () => {
    const env = environment()
    let finish: (allowed: boolean) => void = () => {}
    env.contains.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const caller = new AbortController()
    const pending = listGitHubSkills("example/skills", caller.signal)
    const rejected = expect(pending).rejects.toThrow("GitHub read cancelled")
    caller.abort()
    await rejected
    finish(true)
    await drain()
    expect(env.fetch).not.toHaveBeenCalled()
    env.clean()
  })

  test("cancellation during the final approval check cannot deliver stale bytes", async () => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(blob()))
    let finish: (allowed: boolean) => void = () => {}
    env.contains.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const caller = new AbortController()
    const pending = readGitHubSkill(listing, candidate, caller.signal)
    const rejected = expect(pending).rejects.toThrow("GitHub read cancelled")
    await drain()
    expect(env.contains).toHaveBeenCalledTimes(2)
    caller.abort()
    await rejected
    finish(true)
    await drain()
    env.clean()
  })

  test("waits for a permission removal that occurs during final approval", async () => {
    const env = environment()
    env.fetch.mockResolvedValueOnce(json(blob()))
    let finishFinal: (allowed: boolean) => void = () => {}
    let finishRemoval: (allowed: boolean) => void = () => {}
    env.contains
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishFinal = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishRemoval = resolve
          }),
      )
    const pending = readGitHubSkill(listing, candidate, signal())
    const rejected = expect(pending).rejects.toThrow("GitHub API host approval is required")
    await drain()
    expect(env.contains).toHaveBeenCalledTimes(2)
    env.removed()
    finishFinal(true)
    await drain()
    expect(env.contains).toHaveBeenCalledTimes(3)
    expect(env.listeners.size).toBe(1)
    finishRemoval(false)
    await rejected
    env.clean()
  })

  test("cleans up caller abort listeners and starts no work after success", async () => {
    const env = environment()
    env.list()
    const caller = new AbortController()
    const addListener = vi.spyOn(caller.signal, "addEventListener")
    const removeListener = vi.spyOn(caller.signal, "removeEventListener")
    await listGitHubSkills("example/skills", caller.signal)
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1])
    caller.abort()
    env.removed()
    await vi.advanceTimersByTimeAsync(60000)
    expect(env.fetch).toHaveBeenCalledTimes(2)
    env.clean()
  })

  test("operations own separate cancellation and deadline state", async () => {
    const env = environment()
    env.fetch
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(json(blob()))
    const caller = new AbortController()
    const old = listGitHubSkills("example/skills", caller.signal)
    const rejected = expect(old).rejects.toThrow("GitHub read cancelled")
    await drain()
    expect(await readGitHubSkill(listing, candidate, signal())).toEqual(bytes)
    expect(env.listeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    caller.abort()
    await rejected
    env.clean()
  })
})
