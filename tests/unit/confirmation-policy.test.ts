import { webcrypto } from "node:crypto"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  type ApprovalScope,
  ConfirmationPolicy,
  clearConfirmationApprovals,
  stableJson,
} from "../../src/browser/agent/confirmation-policy.js"
import type { ConfirmationMode } from "../../src/browser/storage.js"

function stubChrome() {
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items)
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key]
    }),
  })
  let permission = true
  vi.stubGlobal("crypto", webcrypto)
  vi.stubGlobal("chrome", {
    storage: { local: area(local), session: area(session) },
    permissions: {
      contains: vi.fn(async () => permission),
      getAll: vi.fn(async () => ({ origins: [] })),
    },
  })
  return {
    local,
    session,
    revoke: () => {
      permission = false
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

const scope: ApprovalScope = {
  operation: "webmcp.callTool",
  identity: ["https://example.test/", "lookup", '{"id":1}'],
}

describe("confirmation policy", () => {
  test("strict and unidentified actions always require confirmation", async () => {
    stubChrome()
    const show = vi.fn().mockResolvedValue(true)
    const strict = new ConfirmationPolicy(() => "strict", show)
    await strict.confirm("Call tool?", {}, undefined, scope)
    await strict.confirm("Call tool?", {}, undefined, scope)
    const balanced = new ConfirmationPolicy(() => "balanced", show)
    await balanced.confirm("Submit?", {})
    await balanced.confirm("Submit?", {})
    expect(show).toHaveBeenCalledTimes(4)
  })

  test("Balanced survives Side Panel replacement, not a browser restart", async () => {
    const { session } = stubChrome()
    const show = vi.fn().mockResolvedValue(true)
    const first = new ConfirmationPolicy(() => "balanced", show)
    expect(await first.confirm("Call tool?", {}, undefined, scope)).toBe(true)
    const nextPanel = new ConfirmationPolicy(() => "balanced", show)
    expect(await nextPanel.confirm("Call tool?", {}, undefined, scope)).toBe(true)
    expect(show).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(session)).not.toContain("lookup")
    expect(JSON.stringify(session)).not.toContain("example.test")
    for (const key of Object.keys(session)) delete session[key] // Chrome clears storage.session on restart.
    expect(await nextPanel.confirm("Call tool?", {}, undefined, scope)).toBe(true)
    expect(show).toHaveBeenCalledTimes(2)
  })

  test("Convenient survives restart; changing tool, arguments, site, or operation asks again", async () => {
    const { local, session } = stubChrome()
    const show = vi.fn().mockResolvedValue(true)
    const policy = new ConfirmationPolicy(() => "convenient", show)
    await policy.confirm("Call tool?", {}, undefined, scope)
    for (const key of Object.keys(session)) delete session[key]
    const restored = new ConfirmationPolicy(() => "convenient", show)
    await restored.confirm("Call tool?", {}, undefined, scope)
    for (const changed of [
      { ...scope, identity: ["https://example.test/", "lookup", '{"id":2}'] },
      { ...scope, identity: ["https://example.test/", "delete", '{"id":1}'] },
      { ...scope, identity: ["https://other.test/", "lookup", '{"id":1}'] },
      { ...scope, operation: "webmcp.listTools" },
    ])
      await restored.confirm("Call tool?", {}, undefined, changed)
    expect(show).toHaveBeenCalledTimes(5)
    expect(JSON.stringify(local)).not.toContain("lookup")
    expect(JSON.stringify(local)).not.toContain("example.test")
    await clearConfirmationApprovals()
    await restored.confirm("Call tool?", {}, undefined, scope)
    expect(show).toHaveBeenCalledTimes(6)
  })

  test("denied, aborted, malformed, and failed storage cannot authorize reuse", async () => {
    const { session } = stubChrome()
    const controller = new AbortController()
    const show = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const policy = new ConfirmationPolicy(() => "balanced", show)
    expect(await policy.confirm("Call?", {}, undefined, scope)).toBe(false)
    expect(session).toEqual({})
    controller.abort()
    expect(await policy.confirm("Call?", {}, controller.signal, scope)).toBe(false)
    expect(show).toHaveBeenCalledOnce()
    await policy.confirm("Call?", {}, undefined, scope)
    session.piBrowserAgentConfirmationApprovalsV1 = { version: 2, keys: ["x"] }
    await policy.confirm("Call?", {}, undefined, scope)
    expect(show).toHaveBeenCalledTimes(3)
    vi.mocked(chrome.storage.session.get).mockRejectedValueOnce(new Error("storage failure"))
    await policy.confirm("Call?", {}, undefined, scope)
    expect(show).toHaveBeenCalledTimes(4)
  })

  test("revoked Chrome permission requires a fresh gesture, even with a cached match", async () => {
    const { local, revoke } = stubChrome()
    local.piBrowserAgentApprovedHostPermissions = ["https://example.test/*"]
    const show = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const policy = new ConfirmationPolicy(() => "convenient", show)
    const protectedScope = { ...scope, permissionUrl: "https://example.test/" }
    expect(await policy.confirm("Call?", {}, undefined, protectedScope)).toBe(true)
    revoke()
    expect(await policy.confirm("Call?", {}, undefined, protectedScope)).toBe(false)
    expect(show).toHaveBeenCalledTimes(2)
  })

  test("mode changes stop reuse and erase cached grants when Settings clears them", async () => {
    stubChrome()
    let mode: ConfirmationMode = "convenient"
    const show = vi.fn().mockResolvedValue(true)
    const policy = new ConfirmationPolicy(() => mode, show)
    await policy.confirm("Call?", {}, undefined, scope)
    mode = "strict"
    await policy.confirm("Call?", {}, undefined, scope)
    await clearConfirmationApprovals()
    mode = "convenient"
    await policy.confirm("Call?", {}, undefined, scope)
    expect(show).toHaveBeenCalledTimes(3)
  })

  test("serializes concurrent approval writes across panels", async () => {
    const { session } = stubChrome()
    vi.mocked(chrome.storage.session.set).mockImplementation(async (items) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      Object.assign(session, items)
    })
    const show = vi.fn().mockResolvedValue(true)
    const first = new ConfirmationPolicy(() => "balanced", show)
    const second = new ConfirmationPolicy(() => "balanced", show)
    await Promise.all([
      first.confirm("Call?", {}, undefined, scope),
      second.confirm("Call?", {}, undefined, { ...scope, identity: ["different"] }),
    ])
    expect((session.piBrowserAgentConfirmationApprovalsV1 as { keys: string[] }).keys).toHaveLength(
      2,
    )
    await first.confirm("Call?", {}, undefined, scope)
    await second.confirm("Call?", {}, undefined, { ...scope, identity: ["different"] })
    expect(show).toHaveBeenCalledTimes(2)
  })

  test("caps ledger size and does not cache oversized identities", async () => {
    const { local } = stubChrome()
    const show = vi.fn().mockResolvedValue(true)
    const policy = new ConfirmationPolicy(() => "convenient", show)
    for (let index = 0; index <= 256; index += 1)
      await policy.confirm("Call?", {}, undefined, { ...scope, identity: [String(index)] })
    expect((local.piBrowserAgentConfirmationApprovalsV1 as { keys: string[] }).keys).toHaveLength(
      256,
    )
    await policy.confirm("Call?", {}, undefined, { ...scope, identity: ["0"] })
    await policy.confirm("Call?", {}, undefined, { ...scope, identity: ["x".repeat(70_000)] })
    expect(show).toHaveBeenCalledTimes(259)
  })

  test("does not cache a gesture if the mode changes or storage writes fail", async () => {
    const { session } = stubChrome()
    let mode: ConfirmationMode = "balanced"
    const show = vi
      .fn()
      .mockImplementationOnce(async () => {
        mode = "strict"
        return true
      })
      .mockResolvedValue(true)
    const policy = new ConfirmationPolicy(() => mode, show)
    await policy.confirm("Call?", {}, undefined, scope)
    expect(session).toEqual({})
    mode = "balanced"
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error("Storage full"))
    await expect(policy.confirm("Call?", {}, undefined, scope)).rejects.toThrow("Storage full")
    expect(session).toEqual({})
  })

  test("canonical arguments match independent of property order", () => {
    expect(stableJson({ b: 2, a: { d: true, c: [1, 2] } })).toBe(
      stableJson({ a: { c: [1, 2], d: true }, b: 2 }),
    )
  })
})
