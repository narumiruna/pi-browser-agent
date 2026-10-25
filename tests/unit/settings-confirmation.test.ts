import { JSDOM } from "jsdom"
import { afterEach, describe, expect, test, vi } from "vitest"
import { initializeSettingsConfirmation } from "../../src/browser/sidepanel/settings-confirmation.js"

const environments: JSDOM[] = []
afterEach(() => {
  for (const dom of environments.splice(0)) dom.window.close()
  vi.unstubAllGlobals()
})

function setup() {
  const dom = new JSDOM(`
    <button id="opener">Leave Settings</button>
    <dialog id="settings-confirm-dialog" aria-labelledby="settings-confirm-title" aria-describedby="settings-confirm-message">
      <h2 id="settings-confirm-title"></h2>
      <p id="settings-confirm-message"></p>
      <button id="settings-confirm-cancel">Cancel</button>
      <button id="settings-confirm-action"></button>
    </dialog>
  `)
  environments.push(dom)
  const document = dom.window.document
  function get<T extends HTMLElement>(id: string): T {
    const result = document.getElementById(id)
    if (!result) throw new Error(`Missing test element: ${id}`)
    return result as T
  }
  const dialog = get<HTMLDialogElement>("settings-confirm-dialog")
  dialog.showModal = () => dialog.setAttribute("open", "")
  dialog.close = () => {
    dialog.removeAttribute("open")
    dialog.dispatchEvent(new dom.window.Event("close"))
  }
  vi.stubGlobal("document", document)
  vi.stubGlobal("window", dom.window)
  const confirm = initializeSettingsConfirmation()
  const opener = get<HTMLButtonElement>("opener")
  const cancel = get<HTMLButtonElement>("settings-confirm-cancel")
  const action = get<HTMLButtonElement>("settings-confirm-action")
  opener.focus()
  return { dom, document, get, dialog, opener, cancel, action, confirm }
}

const request = {
  title: "Discard unsaved changes?",
  message: "Saved server data will remain.",
  confirmLabel: "Discard changes",
}

describe("Settings confirmation", () => {
  test("shows named plain-text content and defaults to Cancel", async () => {
    const env = setup()
    const pending = env.confirm({ ...request, message: "<script>untrusted</script>" })
    expect(env.dialog.open).toBe(true)
    expect(env.get("settings-confirm-title").textContent).toBe(request.title)
    expect(env.get("settings-confirm-message").textContent).toBe("<script>untrusted</script>")
    expect(env.dialog.querySelector("script")).toBeNull()
    expect(env.action.textContent).toBe(request.confirmLabel)
    expect(env.document.activeElement).toBe(env.cancel)
    env.cancel.click()
    await expect(pending).resolves.toBe(false)
    expect(env.document.activeElement).toBe(env.opener)
  })

  test("approves only the explicit affirmative action", async () => {
    const env = setup()
    const pending = env.confirm(request)
    env.action.click()
    await expect(pending).resolves.toBe(true)
    expect(env.dialog.open).toBe(false)
    expect(env.document.activeElement).toBe(env.opener)
  })

  test("Escape cancels without propagating the close request", async () => {
    const env = setup()
    const bubbled = vi.fn()
    env.document.addEventListener("cancel", bubbled)
    const pending = env.confirm(request)
    const event = new env.dom.window.Event("cancel", { bubbles: true, cancelable: true })
    env.dialog.dispatchEvent(event)
    await expect(pending).resolves.toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).not.toHaveBeenCalled()
    expect(env.document.activeElement).toBe(env.opener)
  })

  test("rejects an overlapping request without replacing the active dialog", async () => {
    const env = setup()
    const first = env.confirm(request)
    await expect(env.confirm({ ...request, title: "Second request" })).resolves.toBe(false)
    expect(env.get("settings-confirm-title").textContent).toBe(request.title)
    env.cancel.click()
    await expect(first).resolves.toBe(false)
  })

  test("closing externally cancels and permits a later confirmation", async () => {
    const env = setup()
    const first = env.confirm(request)
    env.dialog.close()
    await expect(first).resolves.toBe(false)
    const second = env.confirm(request)
    env.action.click()
    await expect(second).resolves.toBe(true)
  })

  test("page shutdown cancels a pending decision", async () => {
    const env = setup()
    const pending = env.confirm(request)
    env.dom.window.dispatchEvent(new env.dom.window.Event("pagehide"))
    await expect(pending).resolves.toBe(false)
    expect(env.dialog.open).toBe(false)
  })
})
