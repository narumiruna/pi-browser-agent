import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { setLanguagePreference, t } from "../../src/browser/i18n/index.js"
import type { SessionTreeItem } from "../../src/browser/sessions/session-tree.js"
import { SessionTreeDialog } from "../../src/browser/sidepanel/session-tree-dialog.js"

const items: readonly SessionTreeItem[] = [
  {
    id: "user",
    parentId: null,
    depth: 0,
    role: "user",
    label: "Question",
    selectable: true,
    active: false,
    onActivePath: true,
  },
  {
    id: "call",
    parentId: "user",
    depth: 1,
    role: "assistant",
    label: "Tool call",
    selectable: false,
    active: false,
    onActivePath: true,
  },
  {
    id: "result",
    parentId: "call",
    depth: 2,
    role: "toolResult",
    label: "Result",
    selectable: true,
    active: true,
    onActivePath: true,
  },
  {
    id: "branch",
    parentId: "user",
    depth: 1,
    role: "assistant",
    label: "Other answer",
    selectable: true,
    active: false,
    onActivePath: false,
  },
]

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value")
  return value
}

function setup(
  onSelect = vi.fn<(id: string | null) => Promise<void>>().mockResolvedValue(undefined),
) {
  const dom = new JSDOM(`
    <textarea id="composer"></textarea>
    <button id="trigger" type="button">Tree</button>
    <dialog id="session-tree-dialog" aria-labelledby="heading">
      <h2 id="heading">Conversation tree</h2>
      <p>Previously performed browser actions are not undone.</p>
      <div id="session-tree-list"></div>
      <p id="session-tree-error" role="alert"></p>
      <button type="button" data-tree-cancel>Cancel</button>
    </dialog>
  `)
  const document = dom.window.document
  const dialog = required(document.querySelector<HTMLDialogElement>("dialog"))
  const list = required(document.querySelector<HTMLElement>("#session-tree-list"))
  const error = required(document.querySelector<HTMLElement>("#session-tree-error"))
  const cancel = required(document.querySelector<HTMLButtonElement>("[data-tree-cancel]"))
  const trigger = required(document.querySelector<HTMLButtonElement>("#trigger"))
  const composer = required(document.querySelector<HTMLTextAreaElement>("#composer"))
  // JSDOM does not implement the native dialog methods or focus restoration.
  const showModal = vi.fn(() => {
    dialog.open = true
  })
  const nativeClose = vi.fn(() => {
    dialog.open = false
    dialog.dispatchEvent(new dom.window.Event("close"))
  })
  dialog.showModal = showModal
  dialog.close = nativeClose
  const controller = new SessionTreeDialog({ dialog, list, error, onSelect })
  const rows = () => [...list.querySelectorAll<HTMLElement>("[role='treeitem']")]
  const row = (index: number) => required(rows()[index])
  const key = (key: string, target: HTMLElement = document.activeElement as HTMLElement) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  const cancelEvent = () => {
    const event = new dom.window.Event("cancel", { cancelable: true })
    dialog.dispatchEvent(event)
    return event
  }
  trigger.focus()
  return {
    dom,
    document,
    dialog,
    list,
    error,
    cancel,
    trigger,
    composer,
    controller,
    rows,
    row,
    key,
    cancelEvent,
    onSelect,
    showModal,
    nativeClose,
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => setLanguagePreference("en"))

describe("SessionTreeDialog", () => {
  test("localizes fixed wrappers without translating historical excerpts or node identities", () => {
    setLanguagePreference("ja")
    const { controller, row, list } = setup()
    const historical = items.map((item) => ({ ...item, label: "Start of conversation" }))
    controller.open(historical, "result")
    expect(list.getAttribute("aria-label")).toBe(t("Conversation tree"))
    expect(row(0).querySelector(".session-tree-label")?.textContent).toBe(
      t("Start of conversation"),
    )
    expect(row(1).querySelector(".session-tree-label")?.textContent).toBe("Start of conversation")
    expect(row(1).querySelector(".session-tree-role")?.textContent).toBe(t("User"))
    expect(row(1).querySelector(".session-tree-role")?.textContent).not.toBe("User")
    expect(row(2).textContent).toContain(t("Unavailable boundary"))
    expect(row(3).textContent).toContain(t("Current position"))
    expect(row(3).dataset.role).toBe("toolResult")
    expect(row(3).dataset.nodeId).toBe("result")
    expect(historical.every((item) => item.label === "Start of conversation")).toBe(true)
    controller.setError(new Error("Browser diagnostic Bearer secret"))
    expect(list.ownerDocument.querySelector("#session-tree-error")?.textContent).toBe(
      "Browser diagnostic Bearer [REDACTED]",
    )
  })

  test("renders every boundary with tree semantics, roles, and current/path status", () => {
    const { controller, list, rows, row, document } = setup()
    controller.open(items, "result")
    expect(controller.isOpen).toBe(true)
    expect(list.getAttribute("role")).toBe("tree")
    expect(list.getAttribute("aria-label")).toBe("Conversation tree")
    expect(rows()).toHaveLength(5)
    expect(rows().map((element) => element.getAttribute("aria-level"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "3",
    ])
    expect(rows().map((element) => element.getAttribute("aria-expanded"))).toEqual([
      "true",
      "true",
      "true",
      null,
      null,
    ])
    expect(row(0).textContent).toContain("Start of conversation")
    expect(row(1).textContent).toContain("User")
    expect(row(2).textContent).toContain("Assistant")
    expect(row(2).textContent).toContain("Unavailable boundary")
    expect(row(2).getAttribute("aria-disabled")).toBe("true")
    expect(row(3).textContent).toContain("Tool result")
    expect(row(3).textContent).toContain("Current position")
    expect(row(3).getAttribute("aria-current")).toBe("location")
    expect(rows().filter((element) => element.hasAttribute("aria-current"))).toHaveLength(1)
    expect(row(1).textContent).toContain("Active path")
    expect(row(1).dataset.onActivePath).toBe("true")
    expect(row(4).dataset.onActivePath).toBe("false")
    expect(row(0).dataset.nodeId).toBe("")
    expect(row(0).dataset.role).toBe("root")
    expect(row(3).dataset.nodeId).toBe("result")
    expect(row(3).dataset.role).toBe("toolResult")
    expect(document.activeElement).toBe(row(3))
    expect(rows().map((element) => element.tabIndex)).toEqual([-1, -1, -1, 0, -1])
  })

  test("renders untrusted text without rich content and caps labels again", () => {
    const { controller, list } = setup()
    controller.open(
      [
        {
          ...required(items[0]),
          label: `<img src=x onerror="alert(1)"> [link](https://example.com)\u202e\n${"x".repeat(300)}`,
        },
      ],
      null,
    )
    const label = list.querySelectorAll(".session-tree-label").item(1)
    expect(label.textContent).toHaveLength(160)
    expect(label.textContent).toContain("<img")
    expect(label.textContent).not.toMatch(/[\u202e\n]/u)
    expect(list.querySelector("img, a, svg, script")).toBeNull()
  })

  test("opens an empty tree at the virtual root and clears old errors", () => {
    const { controller, row, error, document } = setup()
    controller.setError(new Error("Previous failure"))
    controller.open([], null)
    expect(error.textContent).toBe("")
    expect(document.activeElement).toBe(row(0))
    expect(row(0).getAttribute("aria-current")).toBe("location")
    expect(row(0).hasAttribute("aria-expanded")).toBe(false)
    expect(row(0).getAttribute("aria-disabled")).toBe("false")
  })

  test("caps visual indentation but preserves the actual accessible level", () => {
    const { controller, row } = setup()
    controller.open([{ ...required(items[0]), depth: 4999 }], null)
    expect(row(0).dataset.depth).toBe("0")
    expect(row(1).dataset.depth).toBe("20")
    expect(row(1).style.getPropertyValue("--tree-depth")).toBe("20")
    expect(row(1).getAttribute("aria-level")).toBe("5001")
  })

  test("scrolls the active row and keyboard targets into view when supported", () => {
    const { controller, dom, row, key } = setup()
    const scrollIntoView = vi.fn()
    dom.window.HTMLElement.prototype.scrollIntoView = scrollIntoView
    controller.open(items, "result")
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(row(3))
    key("Home")
    expect(scrollIntoView.mock.instances.at(-1)).toBe(row(0))
  })

  test("uses the root if the requested active row is absent", () => {
    const { controller, row, document } = setup()
    controller.open(items, "missing")
    expect(document.activeElement).toBe(row(0))
  })

  test("moves through all visible rows, including unsafe rows, without selecting", () => {
    const { controller, row, rows, key, document, onSelect } = setup()
    controller.open(items, null)
    const expectKey = (value: string, index: number) => {
      expect(key(value).defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(row(index))
      expect(rows().filter((element) => element.tabIndex === 0)).toEqual([row(index)])
    }
    expectKey("ArrowUp", 0)
    expectKey("ArrowDown", 1)
    expectKey("ArrowDown", 2)
    expectKey("ArrowDown", 3)
    expectKey("End", 4)
    expectKey("ArrowDown", 4)
    expectKey("Home", 0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test("moves right to the first child and left to the parent without collapsing", () => {
    const { controller, row, key, document } = setup()
    controller.open(items, null)
    for (const index of [1, 2, 3, 3]) {
      key("ArrowRight")
      expect(document.activeElement).toBe(row(index))
    }
    for (const index of [2, 1, 0, 0]) {
      key("ArrowLeft")
      expect(document.activeElement).toBe(row(index))
    }
    key("End")
    key("ArrowLeft")
    expect(document.activeElement).toBe(row(1))
    expect(row(1).getAttribute("aria-expanded")).toBe("true")
  })

  test.each(["Enter", " "])(
    "selects a safe row with %j and closes only after success",
    async (selectionKey) => {
      const pending = deferred()
      const onSelect = vi.fn(() => pending.promise)
      const { controller, key, trigger, document } = setup(onSelect)
      controller.open(items, "result")
      expect(key(selectionKey).defaultPrevented).toBe(true)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith("result")
      expect(controller.isOpen).toBe(true)
      pending.resolve()
      await settle()
      expect(controller.isOpen).toBe(false)
      expect(document.activeElement).toBe(trigger)
    },
  )

  test("selects the virtual root with null by pointer", async () => {
    const { controller, row, onSelect } = setup()
    controller.open(items, "result")
    required(row(0).querySelector<HTMLElement>(".session-tree-label")).click()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null)
    await settle()
    expect(controller.isOpen).toBe(false)
  })

  test("pointer selection of a user row passes its ID without changing the composer", async () => {
    const { controller, row, onSelect, composer } = setup()
    composer.value = "Unsent draft"
    controller.open(items, "result")
    row(1).click()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("user")
    await settle()
    expect(composer.value).toBe("Unsent draft")
  })

  test("unsafe boundaries remain focusable but cannot activate by keyboard or pointer", () => {
    const { controller, row, key, document, onSelect } = setup()
    controller.open(items, "result")
    row(2).click()
    expect(document.activeElement).toBe(row(2))
    key("Enter")
    key(" ")
    expect(onSelect).not.toHaveBeenCalled()
    expect(controller.isOpen).toBe(true)
  })

  test("blocks repeat selection, dismissal, and reopening while selection is pending", async () => {
    const pending = deferred()
    const { controller, dialog, list, row, rows, key, cancel, cancelEvent, onSelect, showModal } =
      setup(vi.fn(() => pending.promise))
    controller.open(items, "result")
    row(3).click()
    expect(dialog.getAttribute("aria-busy")).toBe("true")
    expect(list.getAttribute("aria-busy")).toBe("true")
    expect(rows().every((element) => element.getAttribute("aria-disabled") === "true")).toBe(true)
    expect(cancel.disabled).toBe(true)
    row(1).click()
    key("Enter")
    key(" ")
    key("Escape")
    expect(cancelEvent().defaultPrevented).toBe(true)
    cancel.click()
    controller.close()
    controller.open([], null)
    expect(controller.isOpen).toBe(true)
    expect(rows()).toHaveLength(5)
    expect(showModal).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledOnce()
    pending.resolve()
    await settle()
    expect(controller.isOpen).toBe(false)
    expect(cancel.disabled).toBe(false)
  })

  test("keeps errors safe and restores interaction after a rejected selection", async () => {
    const pending = deferred()
    const onSelect = vi
      .fn<(id: string | null) => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined)
    const { controller, dialog, row, error, cancel, document } = setup(onSelect)
    controller.open(items, "result")
    row(3).click()
    pending.reject(new Error("Failed <img src=x>: Bearer secret-token"))
    await settle()
    expect(controller.isOpen).toBe(true)
    expect(error.textContent).toBe("Failed <img src=x>: Bearer [REDACTED]")
    expect(error.querySelector("img")).toBeNull()
    expect(dialog.getAttribute("aria-busy")).toBe("false")
    expect(cancel.disabled).toBe(false)
    expect(row(3).getAttribute("aria-disabled")).toBe("false")
    expect(row(2).getAttribute("aria-disabled")).toBe("true")
    expect(document.activeElement).toBe(row(3))
    row(1).click()
    expect(error.textContent).toBe("")
    await settle()
    expect(controller.isOpen).toBe(false)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  test("handles synchronous callback errors and permits cancellation", async () => {
    const { controller, row, error, cancel, onSelect } = setup(
      vi.fn(() => {
        throw new Error("Not available")
      }),
    )
    controller.open(items, "result")
    row(3).click()
    await settle()
    expect(error.textContent).toBe("Not available")
    expect(controller.isOpen).toBe(true)
    cancel.click()
    expect(controller.isOpen).toBe(false)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  test.each(["Escape", "cancel", "button", "close"])(
    "dismisses with %s without selection and restores focus",
    (action) => {
      const { controller, key, cancel, cancelEvent, document, trigger, onSelect } = setup()
      controller.open(items, "result")
      if (action === "Escape") key("Escape")
      else if (action === "cancel") expect(cancelEvent().defaultPrevented).toBe(true)
      else if (action === "button") cancel.click()
      else controller.close()
      expect(controller.isOpen).toBe(false)
      expect(document.activeElement).toBe(trigger)
      expect(onSelect).not.toHaveBeenCalled()
    },
  )

  test("does not reopen or replace a dialog that is already open", () => {
    const { controller, row, rows, showModal, document } = setup()
    controller.open(items, "result")
    controller.open([], null)
    expect(showModal).toHaveBeenCalledOnce()
    expect(rows()).toHaveLength(5)
    expect(document.activeElement).toBe(row(3))
  })

  test("restores focus on native close and captures a new invoker on the next open", () => {
    const { controller, dialog, trigger, composer, document } = setup()
    controller.open(items, "result")
    dialog.close()
    expect(document.activeElement).toBe(trigger)
    composer.focus()
    controller.open(items, "result")
    controller.close()
    expect(document.activeElement).toBe(composer)
  })

  test.each(["removed", "disabled", "hidden", "inert"])("does not focus a %s invoker", (state) => {
    const { controller, trigger } = setup()
    controller.open(items, "result")
    const focus = vi.spyOn(trigger, "focus")
    if (state === "removed") trigger.remove()
    else trigger.setAttribute(state, "")
    controller.close()
    expect(focus).not.toHaveBeenCalled()
  })

  test("does not steal focus if the caller has moved it elsewhere", () => {
    const { controller, trigger, composer, document } = setup()
    controller.open(items, "result")
    const focus = vi.spyOn(trigger, "focus")
    composer.focus()
    controller.close()
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(composer)
  })

  test("setError uses text and redacts secrets, and can clear the error", () => {
    const { controller, error } = setup()
    controller.setError("<b>Bearer private-token</b>")
    expect(error.textContent).toBe("<b>Bearer [REDACTED]</b>")
    expect(error.children).toHaveLength(0)
    controller.setError()
    expect(error.textContent).toBe("")
  })

  test("retained rows do not activate while the dialog is closed", async () => {
    const { controller, row, key, onSelect } = setup()
    controller.open(items, "result")
    const previousRow = row(3)
    controller.close()
    previousRow.click()
    key("Enter", previousRow)
    await settle()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
