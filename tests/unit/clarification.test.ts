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
const key = { sessionId: "session", generation: 1, toolCallId: "question", questionSequence: 1 }
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
function batch(names: string[], generation = 0) {
  const content = names.map((name, i) => ({
    type: "toolCall",
    id: `${generation}-${i}`,
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

  test.each([true, false])(
    "fresh element IDs work after context changes without reviving an old ID (element alias=%s)",
    async (elementAlias) => {
      let card: PendingClarification | undefined
      const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" }
      const run = new ClarificationRun(
        "session",
        1,
        [
          { id: "old", summary: "Context A", element: true },
          { id: "image", summary: "Reference", element: false, image },
        ],
        (value) => {
          card = value
        },
      )
      run.invalidateElements()
      run.includeTargets([
        { id: "fresh", summary: "Context B", element: true },
        {
          id: "old",
          summary: "Do not rebind",
          element: elementAlias,
          ...(elementAlias ? {} : { image }),
        },
      ])
      const question = (id: string) => ({
        question: "Which target?",
        options: [
          { label: "Element", attachmentId: id },
          { label: "Image", attachmentId: "image" },
        ],
      })
      const rejectStale = async (id: string) => {
        const result = Promise.resolve(run.tool().execute(`stale-${id}`, question(id))).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        const presented = card !== undefined
        if (presented) run.abort()
        const settled = await result
        expect(presented).toBe(false)
        expect(settled).toHaveProperty("error.message", "The target context changed")
      }
      await rejectStale("old")
      const waiting = Promise.resolve(run.tool().execute("fresh-question", question("fresh"))).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      if (!card) expect(await waiting).not.toHaveProperty("error")
      expect(card?.targets.map((target) => target.id)).toEqual(["image", "fresh"])
      expect(card?.targets.find((target) => target.id === "fresh")?.summary).toBe("Context B")
      expect(run.answer(required(card), { optionId: "option-1" })).toBe(true)
      expect(await waiting).not.toHaveProperty("error")
      expect(await waiting).not.toMatchObject({ value: { isError: true } })
      run.invalidateElements()
      run.includeTargets([{ id: "fresh", summary: "Do not revive B", element: true }])
      await rejectStale("fresh")
      run.includeTargets([{ id: "newest", summary: "Context C", element: true }])
      const last = Promise.resolve(run.tool().execute("newest-question", question("newest"))).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      if (!card) expect(await last).not.toHaveProperty("error")
      expect(run.answer(required(card), { optionId: "option-2" })).toBe(true)
      expect(await last).not.toHaveProperty("error")
      expect(await last).not.toMatchObject({ value: { isError: true } })
    },
  )

  test("guards all siblings, rejects duplicate batches, and allows at most three calls", () => {
    const { run } = setup()
    const calls = batch(["browser_click", "request_user_input", "mcp_call"])
    expect(calls.map((context) => run.beforeToolCall(context)?.block)).toEqual([
      true,
      undefined,
      true,
    ])
    for (let i = 0; i < 2; i++) {
      const next = required(batch(["request_user_input"], i + 1)[0])
      run.inspect(next.assistantMessage)
      expect(run.beforeToolCall(next)).toBeUndefined()
    }
    expect(run.beforeToolCall(required(batch(["request_user_input"])[0]))?.block).toBe(true)
    const duplicate = setup().run
    for (const context of batch(["request_user_input", "mcp_call", "request_user_input"]))
      expect(duplicate.beforeToolCall(context)?.block).toBe(true)
  })

  test("an application sequence permits repeated model call IDs but rejects the old answer key", async () => {
    const s = setup()
    const first = required(batch(["request_user_input"])[0])
    first.toolCall.id = key.toolCallId
    expect(s.run.beforeToolCall(first)).toBeUndefined()
    const pending = s.run.tool().execute("question", request)
    s.run.answer(key, { optionId: "option-1" })
    await pending
    const repeated = required(batch(["request_user_input"])[0])
    repeated.toolCall.id = key.toolCallId
    expect(s.run.beforeToolCall(repeated)).toBeUndefined()
    const second = s.run.tool().execute("question", request)
    const current = required(s.card())
    expect(current.questionSequence).toBe(2)
    expect(s.run.answer(key, { optionId: "option-2" })).toBe(false)
    expect(s.run.answer(current, { optionId: "option-2" })).toBe(true)
    await second
  })

  test("a question ID that collides with a sibling rejects the whole batch", () => {
    const s = setup()
    const calls = batch(["browser_click", "request_user_input"])
    required(calls[0]).toolCall.id = required(calls[1]).toolCall.id
    for (const context of calls) expect(s.run.beforeToolCall(context)?.block).toBe(true)
    expect(s.run.waiting).toBe(false)
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
