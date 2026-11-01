import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PendingClarification } from "../../src/browser/agent/clarification.js"
import { setLanguagePreference } from "../../src/browser/i18n/index.js"
import { ClarificationCard } from "../../src/browser/sidepanel/clarification-card.js"
import { TargetReferenceComposer } from "../../src/browser/sidepanel/target-reference.js"
import { required } from "../support/target-context.js"

const card: PendingClarification = {
  sessionId: "session",
  generation: 1,
  toolCallId: "question",
  questionSequence: 1,
  question: "<img src=https://evil.test> Which?",
  options: [
    { id: "option-1", label: "<script>First</script>", attachmentId: "image" },
    { id: "option-2", label: "[Second](https://evil.test)" },
  ],
  targets: [
    {
      id: "image",
      summary: "Known image",
      element: false,
      image: { type: "image", data: "YQ==", mimeType: "image/png" },
    },
  ],
}
function setup() {
  const dom = new JSDOM(
    '<textarea id="draft">Keep this draft</textarea><section id="card" hidden></section><div id="pair"></div><div id="controls"></div>',
  )
  const document = dom.window.document
  const root = required(document.querySelector<HTMLElement>("#card"))
  const draft = required(document.querySelector<HTMLTextAreaElement>("#draft"))
  const answer = vi.fn(() => true)
  const controller = new ClarificationCard(root, answer)
  draft.focus()
  const select = (index: number) => {
    const radio = required(root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index])
    radio.checked = true
    radio.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  }
  return {
    dom,
    document,
    root,
    draft,
    answer,
    controller,
    select,
    submit: () => required(root.querySelector<HTMLButtonElement>("button")),
    other: () => required(root.querySelector<HTMLTextAreaElement>("textarea")),
  }
}
afterEach(() => setLanguagePreference("en"))

describe("local question card", () => {
  test("renders plain text and local previews without a selected answer or remote resources", () => {
    const s = setup()
    s.controller.show(card)
    expect(s.root.textContent).toContain(card.question)
    expect(s.root.textContent).toContain(required(card.options[0]).label)
    expect(s.root.querySelectorAll("script,a,iframe")).toHaveLength(0)
    expect(s.root.querySelectorAll("input:checked")).toHaveLength(0)
    expect(s.root.querySelectorAll("img")).toHaveLength(1)
    expect(s.root.querySelector("img")?.src).toBe("data:image/png;base64,YQ==")
    expect(s.submit().disabled).toBe(true)
    expect(s.other().disabled).toBe(true)
    expect(s.document.activeElement?.tagName).toBe("LEGEND")
    expect(s.draft.value).toBe("Keep this draft")
  })

  test("explicit Answer settles once, never on selection, and restores only owned focus", () => {
    const s = setup()
    s.controller.show(card)
    s.select(1)
    expect(s.answer).not.toHaveBeenCalled()
    const button = s.submit()
    button.focus()
    button.click()
    button.click()
    expect(s.answer).toHaveBeenCalledExactlyOnceWith(card, { optionId: "option-2" })
    s.controller.show(undefined)
    expect(s.root.hidden).toBe(true)
    expect(s.document.activeElement).toBe(s.draft)
    button.click()
    expect(s.answer).toHaveBeenCalledOnce()
    expect(s.draft.value).toBe("Keep this draft")
    s.controller.show({ ...card, generation: 2 })
    s.draft.focus()
    s.controller.show(undefined)
    expect(s.document.activeElement).toBe(s.draft)
  })

  test("validates Other by code points and retains choices across same-card updates", () => {
    const s = setup()
    s.controller.show(card)
    s.select(2)
    const other = s.other()
    for (const [value, disabled] of [
      [" ", true],
      ["😀".repeat(2049), true],
      ["😀".repeat(2048), false],
    ] as const) {
      other.value = value
      other.dispatchEvent(new s.dom.window.Event("input"))
      expect(s.submit().disabled).toBe(disabled)
    }
    s.controller.show(structuredClone(card))
    expect(s.other()).toBe(other)
    s.submit().click()
    expect(s.answer).toHaveBeenCalledExactlyOnceWith(card, { other: "😀".repeat(2048) })
  })

  test("late controls cannot answer a replacement question; labels use the current catalog", () => {
    const s = setup()
    setLanguagePreference("ja")
    s.controller.show(card)
    s.select(0)
    const old = s.submit()
    expect(old.textContent).toBe("回答する")
    s.controller.show({ ...card, questionSequence: 2 })
    old.click()
    expect(s.answer).not.toHaveBeenCalled()
  })
})

describe("pair composer", () => {
  test("keeps IDs stable through reorder/deletion and never selects a replacement", () => {
    const s = setup()
    let blocked = false
    const root = required(s.document.querySelector<HTMLElement>("#pair"))
    const controls = required(s.document.querySelector<HTMLElement>("#controls"))
    const items = [
      { id: "a", label: "First", active: true },
      { id: "b", label: "Second", active: true },
      { id: "c", label: "New", active: true },
    ]
    const refresh = () => {
      pair.refresh(items)
      controls.replaceChildren(...items.map((item) => pair.controls(item.id)))
    }
    const pair = new TargetReferenceComposer(root, refresh, () => blocked)
    refresh()
    const click = (id: string, role: string) =>
      required(
        controls.querySelector<HTMLButtonElement>(
          `button[data-attachment-id="${id}"][data-pair-role="${role}"]`,
        ),
      ).click()
    click("a", "targetId")
    expect(pair.complete).toBe(false)
    expect(() => pair.snapshot()).toThrow()
    click("b", "referenceId")
    expect(pair.snapshot()).toEqual({ targetId: "a", referenceId: "b" })
    items.reverse()
    refresh()
    expect(pair.snapshot()).toEqual({ targetId: "a", referenceId: "b" })
    items.splice(
      items.findIndex((item) => item.id === "a"),
      1,
    )
    refresh()
    expect(pair.complete).toBe(false)
    expect(root.textContent).toContain("Not selected")
    click("c", "targetId")
    expect(pair.snapshot()).toEqual({ targetId: "c", referenceId: "b" })
    blocked = true
    refresh()
    click("b", "targetId")
    expect(pair.snapshot()).toEqual({ targetId: "c", referenceId: "b" })
    blocked = false
    refresh()
    required(root.querySelector<HTMLButtonElement>("button")).click()
    expect(pair.snapshot()).toBeUndefined()
    expect(pair.active).toBe(false)
  })
})
