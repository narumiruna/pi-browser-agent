import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core"
import { describe, expect, test, vi } from "vitest"
import {
  ClarificationRun,
  type PendingClarification,
  parseClarification,
} from "../../src/browser/agent/clarification.js"
import { required } from "../support/target-context.js"

const request = {
  question: "Which <script>target</script>?",
  options: [{ label: "First", attachmentId: "known" }, { label: "Second" }],
}
const key = { sessionId: "session", generation: 1, toolCallId: "question" }
function setup(element = false) {
  let card: PendingClarification | undefined
  const changed = vi.fn((value?: PendingClarification) => {
    card = value
  })
  const run = new ClarificationRun(
    "session",
    1,
    [{ id: "known", summary: "Local target", element }],
    changed,
  )
  return { run, changed, card: () => card }
}
function batch(names: string[]) {
  const content = names.map((name, i) => ({
    type: "toolCall",
    id: `${i}`,
    name,
    arguments: request,
  }))
  const assistantMessage = { role: "assistant", content }
  return content.map(
    (toolCall) => ({ toolCall, assistantMessage }) as unknown as BeforeToolCallContext,
  )
}

describe("clarification contracts and callback ownership", () => {
  test("uses code points, exact keys, bounded labels, and only submitted IDs", () => {
    const valid = {
      question: "😀".repeat(512),
      options: [{ label: "😀".repeat(128) }, { label: "Other target" }],
    }
    expect(parseClarification(valid, new Set())).toEqual(valid)
    for (const value of [
      { ...valid, question: `${valid.question}x` },
      { ...valid, question: " " },
      { ...valid, extra: true },
      { ...valid, options: [] },
      { ...valid, options: [{ label: "x", url: "https://evil.test" }, { label: "y" }] },
      { ...valid, options: [{ label: "x", attachmentId: "unknown" }, { label: "y" }] },
      { ...valid, options: [{ label: "x" }, { label: "x" }] },
      { ...valid, options: [{ label: "😀".repeat(129) }, { label: "y" }] },
    ])
      expect(() => parseClarification(value, new Set())).toThrow()
    expect(parseClarification(request, new Set(["known"]))).toEqual(request)
  })

  test("never selects automatically; one current answer settles exactly once", async () => {
    const s = setup()
    const result = s.run.tool().execute(key.toolCallId, request)
    expect(s.card()?.options.map((option) => option.id)).toEqual(["option-1", "option-2"])
    expect(s.run.waiting).toBe(true)
    expect(s.run.answer({ ...key, generation: 0 }, { optionId: "option-1" })).toBe(false)
    for (const answer of [
      {},
      { optionId: "unknown" },
      { other: " " },
      { other: "😀".repeat(2049) },
      { other: "fine", actionApproval: true },
    ])
      expect(() => s.run.answer(key, answer)).toThrow()
    expect(s.run.waiting).toBe(true)
    expect(s.run.answer(key, { optionId: "option-1" })).toBe(true)
    expect(s.run.answer(key, { optionId: "option-2" })).toBe(false)
    expect(JSON.stringify(await result)).toContain('"actionApproval\\":false')
    expect(s.card()).toBeUndefined()
    expect(s.changed).toHaveBeenCalledTimes(2)
  })

  test("accepts a bounded typed answer and removes its abort callback", async () => {
    const s = setup()
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, "removeEventListener")
    const result = s.run.tool().execute("question", request, abort.signal)
    expect(s.run.answer(key, { other: "😀".repeat(2048) })).toBe(true)
    expect((await result).isError).not.toBe(true)
    expect(remove).toHaveBeenCalledOnce()
    abort.abort()
    expect(s.changed).toHaveBeenCalledTimes(2)
  })

  test.each(["signal", "run", "context"])(
    "cancels %s without an answer or retained callback",
    async (reason) => {
      const s = setup(true)
      const abort = new AbortController()
      const result = s.run.tool().execute("question", request, abort.signal)
      if (reason === "signal") abort.abort()
      if (reason === "run") s.run.abort()
      if (reason === "context") s.run.invalidateElements()
      expect(await result).toMatchObject({ isError: true, terminate: true })
      expect(s.run.answer(key, { optionId: "option-1" })).toBe(false)
      expect(s.run.waiting).toBe(false)
    },
  )

  test("image-only questions survive target-context invalidation in the same run", async () => {
    const s = setup()
    const result = s.run.tool().execute("question", request)
    s.run.invalidateElements()
    expect(s.run.waiting).toBe(true)
    s.run.answer(key, { optionId: "option-1" })
    expect((await result).isError).not.toBe(true)
  })

  test("guards all siblings, rejects duplicate batches, and allows at most three calls", () => {
    const { run } = setup()
    const calls = batch(["browser_click", "request_user_input", "mcp_call"])
    expect(calls.map((context) => run.beforeToolCall(context)?.block)).toEqual([
      true,
      undefined,
      true,
    ])
    for (let i = 0; i < 2; i++) {
      const next = required(batch(["request_user_input"])[0])
      run.inspect(next.assistantMessage)
      expect(run.beforeToolCall(next)).toBeUndefined()
    }
    expect(run.beforeToolCall(required(batch(["request_user_input"])[0]))?.block).toBe(true)
    const duplicate = setup().run
    for (const context of batch(["request_user_input", "mcp_call", "request_user_input"]))
      expect(duplicate.beforeToolCall(context)?.block).toBe(true)
  })

  test("a failed presenter cancels rather than leaving a deadlocked run", async () => {
    const run = new ClarificationRun("session", 1, [], () => {
      throw new Error("Disposed view")
    })
    await expect(
      run
        .tool()
        .execute("question", { question: "Which?", options: [{ label: "One" }, { label: "Two" }] }),
    ).resolves.toMatchObject({ isError: true, terminate: true })
    expect(run.waiting).toBe(false)
  })
})
