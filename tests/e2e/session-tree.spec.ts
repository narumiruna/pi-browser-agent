import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { SessionRecord } from "../../src/browser/sessions/session-store.js"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse } from "./support/mock-codex.js"

test.setTimeout(90_000)

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
const ORIGINAL = [user("Original request"), assistant("Original answer")]

type ProbeWindow = Window & {
  treePermissions: chrome.permissions.Permissions[]
  treeMethods: string[]
  treePutCount: number
  treePutGate?: { entered: boolean; release: () => void }
  restoreTreePut?: () => void
}

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp }
}

function assistant(text: string, timestamp = 2): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("#prompt").fill(text)
  // Enter can accept a slash completion instead of submitting it.
  await page.locator("#send").click()
}

async function saved(page: Page): Promise<{ version: number; record: SessionRecord }> {
  const id = await page.locator("#sessions").inputValue()
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-browser-agent-sessions", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const record = await new Promise<SessionRecord>((resolve, reject) => {
        const request = database.transaction("sessions").objectStore("sessions").get(id)
        request.onsuccess = () => resolve(request.result as SessionRecord)
        request.onerror = () => reject(request.error)
      })
      return { version: database.version, record }
    } finally {
      database.close()
    }
  }, id)
}

async function seedLegacy(harness: ExtensionHarness, messages = ORIGINAL): Promise<string> {
  const { record } = await saved(harness.controller)
  // Use a separate record. The old panel's pagehide save must not overwrite the fixture.
  const id = await harness.controller.evaluate(async (payload) => {
    const { record, messages } = JSON.parse(payload) as {
      record: SessionRecord
      messages: AgentMessage[]
    }
    const id = crypto.randomUUID()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-browser-agent-sessions", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("sessions", "readwrite")
        transaction.objectStore("sessions").put({
          ...record,
          id,
          title: "Seeded tree history",
          status: "idle",
          messages,
        })
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      })
      await chrome.storage.local.set({ piBrowserAgentActiveSessionId: id })
      return id
    } finally {
      database.close()
    }
  }, JSON.stringify({ record, messages }))
  await harness.controller.reload({ waitUntil: "domcontentloaded" })
  await waitForConversationReady(harness.controller)
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator("#sessions")).toHaveValue(id)
  return id
}

async function mockProvider(harness: ExtensionHarness) {
  const requests: unknown[] = []
  const unexpected: string[] = []
  // Never allow an unmocked provider, auth, or MCP request to leave the browser.
  await harness.context.route("https://**/*", async (route) => {
    if (route.request().url() !== CODEX_RESPONSES_URL) {
      unexpected.push(route.request().url())
      await route.abort()
      return
    }
    requests.push(route.request().postDataJSON())
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: finalTextResponse(requests.length, `Mock answer ${requests.length}`),
    })
  })
  return { requests, unexpected }
}

async function probeNavigation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as ProbeWindow
    state.treePermissions = []
    state.treeMethods = []
    const permission = chrome.permissions.request.bind(chrome.permissions)
    chrome.permissions.request = (async (permissions) => {
      state.treePermissions.push(permissions)
      return permission(permissions)
    }) as typeof chrome.permissions.request
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = ((message: { method?: string }) => {
      if (message.method) state.treeMethods.push(message.method)
      return sendMessage(message)
    }) as typeof chrome.runtime.sendMessage
  })
}

async function expectNoReplay(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const state = window as unknown as ProbeWindow
      return {
        permissions: state.treePermissions,
        tools: state.treeMethods.filter((method) =>
          /^(page\.|browser\.|webmcp\.|mcp\.)/.test(method),
        ),
      }
    }),
  ).toEqual({ permissions: [], tools: [] })
  await expect(page.locator("#confirm-dialog")).not.toBeVisible()
}

function dialog(page: Page): Locator {
  return page.locator("#session-tree-dialog")
}

function row(page: Page, role: string, text: string): Locator {
  const label = page.locator(".session-tree-label").filter({
    hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  })
  return dialog(page).locator(`[role=treeitem][data-role="${role}"]`).filter({ has: label })
}

function root(page: Page): Locator {
  return dialog(page).locator('[role=treeitem][data-role=root][data-node-id=""]')
}

async function openTree(page: Page): Promise<void> {
  await send(page, "/tree")
  await expect(dialog(page)).toBeVisible()
  await expect(page.locator("#prompt")).toHaveValue("")
}

async function select(target: Locator): Promise<void> {
  await target.click()
  await expect(target.page().locator("#session-tree-dialog")).not.toBeVisible()
  await expect(target.page().locator("#send")).toBeEnabled()
}

async function answer(page: Page, text: string, index: number): Promise<void> {
  await send(page, text)
  await expect(page.locator("#transcript")).toContainText(`Mock answer ${index}`)
  await expect(page.locator("#abort")).not.toBeVisible()
  await expect(page.locator("#prompt")).toHaveValue("")
}

function projection(record: SessionRecord): AgentMessage[] {
  return record.messages.filter((message) => message.role !== "system")
}

async function setModalDraft(page: Page, text: string): Promise<void> {
  // Browser events can update the composer while a modal is open (for example, selection input).
  await page.locator("#prompt").evaluate((element, text) => {
    const input = element as HTMLTextAreaElement
    input.value = text
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }, text)
}

async function pastePng(page: Page): Promise<void> {
  await page.locator("#prompt").evaluate((element, png) => {
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], "tree.png", { type: "image/png" }))
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    )
  }, PNG)
  await expect(page.locator("#pasted-images img")).toHaveCount(1)
}

test("restores literal slash prompts without turning them into local commands", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    await configureMockCodex(harness)
    const page = harness.controller
    await seedLegacy(harness, [user("/logout"), assistant("Literal answer")])
    await probeNavigation(page)
    await openTree(page)
    await select(row(page, "user", "/logout"))
    await expect(page.locator("#prompt")).toHaveValue("//logout")
    await expectNoReplay(page)
    expect(mock.requests).toHaveLength(0)
    await answer(page, await page.locator("#prompt").inputValue(), 1)
    expect(JSON.stringify(mock.requests[0])).toContain("/logout")
    expect(JSON.stringify(mock.requests[0])).not.toContain("//logout")
    await expect(page.locator("#auth-status")).toHaveAttribute("data-logged-in", "true")
    await expect(page.locator("#error")).toBeEmpty()
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("edits the same user into branches A and B and continues from the original assistant", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    await configureMockCodex(harness)
    const page = harness.controller
    await seedLegacy(harness)
    await probeNavigation(page)
    await openTree(page)
    const originalUser = await row(page, "user", "Original request").getAttribute("data-node-id")
    const originalAssistant = await row(page, "assistant", "Original answer").getAttribute(
      "data-node-id",
    )
    await select(row(page, "user", "Original request"))
    await expect(page.locator("#prompt")).toHaveValue("Original request")
    await expect(page.locator("#transcript .message")).toHaveCount(0)
    expect(mock.requests).toHaveLength(0)
    await expectNoReplay(page)
    await answer(page, "Branch A private request", 1)
    expect(JSON.stringify(mock.requests[0])).not.toContain("Original request")
    expect(JSON.stringify(mock.requests[0])).not.toContain("Original answer")

    await probeNavigation(page)
    await openTree(page)
    await expect(dialog(page).getByRole("treeitem")).toHaveCount(5)
    await expect(row(page, "user", "Original request")).toHaveAttribute(
      "data-node-id",
      originalUser ?? "",
    )
    await select(row(page, "user", "Original request"))
    expect(mock.requests).toHaveLength(1)
    await expectNoReplay(page)
    await answer(page, "Branch B private request", 2)
    expect(JSON.stringify(mock.requests[1])).toContain("Branch B private request")
    expect(JSON.stringify(mock.requests[1])).not.toContain("Branch A private request")
    expect(JSON.stringify(mock.requests[1])).not.toContain("Mock answer 1")

    await probeNavigation(page)
    await openTree(page)
    await expect(dialog(page).getByRole("treeitem")).toHaveCount(7)
    await expect(row(page, "assistant", "Original answer")).toHaveAttribute(
      "data-node-id",
      originalAssistant ?? "",
    )
    await expect(row(page, "assistant", "Original answer")).toHaveAttribute(
      "data-on-active-path",
      "false",
    )
    await select(row(page, "assistant", "Original answer"))
    await expect(page.locator("#prompt")).toHaveValue("")
    await expect(page.locator("#transcript")).toContainText("Original answer")
    await expect(page.locator("#transcript")).not.toContainText("Branch B private request")
    expect(mock.requests).toHaveLength(2)
    await expectNoReplay(page)
    await answer(page, "Continue original only", 3)
    const payload = JSON.stringify(mock.requests[2])
    for (const text of ["Original request", "Original answer", "Continue original only"])
      expect(payload).toContain(text)
    for (const text of [
      "Branch A private request",
      "Branch B private request",
      "Mock answer 1",
      "Mock answer 2",
    ])
      expect(payload).not.toContain(text)
    const { record } = await saved(page)
    expect(record.tree?.nodes).toHaveLength(8)
    expect(projection(record)).toHaveLength(4)
    expect(JSON.stringify(record.tree)).toContain("Branch A private request")
    expect(JSON.stringify(record.tree)).toContain("Branch B private request")
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("nested user edits start at their parent and root branching retains every old descendant", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    await configureMockCodex(harness)
    const page = harness.controller
    const history = [
      ...ORIGINAL,
      user("Second original request", 3),
      assistant("Second original answer", 4),
    ]
    await seedLegacy(harness, history)
    await openTree(page)
    const parentId = await row(page, "assistant", "Original answer").getAttribute("data-node-id")
    await select(row(page, "user", "Second original request"))
    await expect(page.locator("#prompt")).toHaveValue("Second original request")
    const before = (await saved(page)).record
    expect(before.tree?.activeLeafId).toBe(parentId)
    expect(projection(before)).toEqual(ORIGINAL)
    const originalNodes = before.tree?.nodes
    await answer(page, "Nested edited request", 1)
    const nested = (await saved(page)).record.tree
    expect(nested?.nodes.slice(0, 4)).toEqual(originalNodes)
    expect(nested?.nodes[4]?.parentId).toBe(parentId)
    const nestedPayload = JSON.stringify(mock.requests[0])
    expect(nestedPayload).toContain("Original answer")
    expect(nestedPayload).not.toContain("Second original request")
    expect(nestedPayload).not.toContain("Second original answer")

    await openTree(page)
    await select(root(page))
    await expect(page.locator("#transcript .message")).toHaveCount(0)
    const empty = (await saved(page)).record
    expect(projection(empty)).toEqual([])
    expect(empty.tree?.activeLeafId).toBeNull()
    expect(empty.tree?.nodes).toEqual(nested?.nodes)
    expect(mock.requests).toHaveLength(1)
    await answer(page, "Independent root request", 2)
    expect(JSON.stringify(mock.requests[1])).not.toContain("Original")
    expect(JSON.stringify(mock.requests[1])).not.toContain("Nested edited request")
    await openTree(page)
    await expect(dialog(page).getByRole("treeitem")).toHaveCount(9)
    await select(row(page, "assistant", "Second original answer"))
    expect(projection((await saved(page)).record)).toEqual(history)
    expect((await saved(page)).record.tree?.nodes).toHaveLength(8)
    expect(mock.requests).toHaveLength(2)
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("opening and canceling a legacy tree leaves database v1 and the complete record unchanged", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    const page = harness.controller
    await seedLegacy(harness)
    await probeNavigation(page)
    const before = await saved(page)
    expect(before.version).toBe(1)
    expect(before.record.tree).toBeUndefined()
    const transcript = await page.locator("#transcript").textContent()
    for (const cancel of ["escape", "button"]) {
      await openTree(page)
      await expect(row(page, "assistant", "Original answer")).toBeFocused()
      await expect(row(page, "assistant", "Original answer")).toHaveAttribute(
        "aria-current",
        "location",
      )
      if (cancel === "escape") await dialog(page).press("Escape")
      else await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(dialog(page)).not.toBeVisible()
      await expect(page.locator("#send")).toBeFocused()
      expect(await saved(page)).toEqual(before)
      expect(await page.locator("#transcript").textContent()).toBe(transcript)
    }
    await expectNoReplay(page)
    expect(mock.requests).toEqual([])
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("restores a user image preview and untrusted saved text without sending until explicit Send", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    await configureMockCodex(harness)
    const page = harness.controller
    const text = "Inspect image\n\n[Untrusted selected element context]\nbutton#old-reference"
    const image = { type: "image" as const, mimeType: "image/png", data: PNG }
    await seedLegacy(harness, [
      { role: "user", timestamp: 1, content: [{ type: "text", text }, image] },
      assistant("Image original answer"),
    ])
    await probeNavigation(page)
    await openTree(page)
    await select(row(page, "user", "Inspect image"))
    await expect(page.locator("#prompt")).toHaveValue(text)
    await expect(page.locator("#pasted-images img")).toHaveAttribute(
      "src",
      `data:image/png;base64,${PNG}`,
    )
    expect(
      await page
        .locator("#pasted-images img")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBe(1)
    await expect(page.locator(".selected-element-chip")).toHaveCount(0)
    await expect(page.locator("#transcript .message")).toHaveCount(0)
    expect(mock.requests).toHaveLength(0)
    await expectNoReplay(page)
    await answer(page, "Edited image request", 1)
    const payload = JSON.stringify(mock.requests[0])
    expect(payload).toContain("Edited image request")
    expect(payload).toContain(`data:image/png;base64,${PNG}`)
    expect(payload).not.toContain("Image original answer")
    await expect(page.locator("#pasted-images img")).toHaveCount(0)
    await openTree(page)
    await expect(row(page, "assistant", "Image original answer")).toHaveCount(1)
    await expect(row(page, "user", "Edited image request")).toHaveCount(1)
    await dialog(page).press("Escape")
    expect(mock.requests).toHaveLength(1)
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("parallel tool history disables incomplete boundaries and never replays reads or mutations", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    await configureMockCodex(harness)
    const page = harness.controller
    const call: AssistantMessage = {
      ...assistant("", 2),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "read-fixture", name: "browser_read_page", arguments: {} },
        {
          type: "toolCall",
          id: "mutate-fixture",
          name: "browser_type",
          arguments: { selector: "#note", text: "Already changed" },
        },
      ],
    }
    const history: AgentMessage[] = [
      user("Read and change the fixture"),
      call,
      {
        role: "toolResult",
        toolCallId: "read-fixture",
        toolName: "browser_read_page",
        content: [{ type: "text", text: "Fixture read result" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "mutate-fixture",
        toolName: "browser_type",
        content: [{ type: "text", text: "Fixture mutation result" }],
        details: { previousAction: "kept" },
        isError: false,
        timestamp: 4,
      },
      assistant("Tools completed", 5),
    ]
    await seedLegacy(harness, history)
    await harness.fixturePage.locator("#note").fill("Newer page value")
    await probeNavigation(page)
    const before = await saved(page)
    await openTree(page)
    const toolCall = row(page, "assistant", "Tool: browser_read_page")
    const intermediate = row(page, "toolResult", "Fixture read result")
    for (const target of [toolCall, intermediate]) {
      await expect(target).toHaveAttribute("aria-disabled", "true")
      // Dispatch pointer and keyboard input even though the boundary is disabled.
      await target.dispatchEvent("click")
      await target.focus()
      await target.press("Enter")
      await expect(dialog(page)).toBeVisible()
      expect(await saved(page)).toEqual(before)
    }
    const completed = row(page, "toolResult", "Fixture mutation result")
    await expect(completed).toHaveAttribute("aria-disabled", "false")
    await select(completed)
    expect(projection((await saved(page)).record)).toEqual(history.slice(0, 4))
    await expect(harness.fixturePage.locator("#note")).toHaveValue("Newer page value")
    await expectNoReplay(page)
    expect(mock.requests).toHaveLength(0)
    await answer(page, "Continue after completed tools", 1)
    const payload = JSON.stringify(mock.requests[0])
    for (const text of [
      "read-fixture",
      "mutate-fixture",
      "Fixture read result",
      "Fixture mutation result",
    ])
      expect(payload).toContain(text)
    expect(payload).not.toContain("Tools completed")
    await expect(harness.fixturePage.locator("#note")).toHaveValue("Newer page value")
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("reload and full Chrome restart preserve inactive branches and the selected root position", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    await configureMockCodex(harness)
    const page = harness.controller
    const id = await seedLegacy(harness)
    await openTree(page)
    await select(row(page, "user", "Original request"))
    await answer(page, "Restart branch request", 1)
    await openTree(page)
    await select(root(page))
    const before = (await saved(page)).record
    expect(before.tree?.nodes).toHaveLength(4)
    expect(before.tree?.activeLeafId).toBeNull()
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForConversationReady(page)
    expect((await saved(page)).record.tree).toEqual(before.tree)
    await expect(page.locator("#transcript .message")).toHaveCount(0)
    await openTree(page)
    await expect(root(page)).toBeFocused()
    await expect(root(page)).toHaveAttribute("aria-current", "location")
    await expect(dialog(page).getByRole("treeitem")).toHaveCount(5)
    await dialog(page).press("Escape")
    expect(mock.requests).toHaveLength(1)
    expect(mock.unexpected).toEqual([])

    await harness.restart()
    const restartedMock = await mockProvider(harness)
    const restarted = harness.controller
    await expect(restarted.locator("#sessions")).toHaveValue(id)
    expect((await saved(restarted)).record.tree).toEqual(before.tree)
    await expect(restarted.locator("#transcript .message")).toHaveCount(0)
    await probeNavigation(restarted)
    await openTree(restarted)
    await expect(root(restarted)).toBeFocused()
    await expect(row(restarted, "assistant", "Original answer")).toBeVisible()
    await expect(row(restarted, "assistant", "Mock answer 1")).toBeVisible()
    await select(row(restarted, "assistant", "Original answer"))
    expect(projection((await saved(restarted)).record)).toEqual(ORIGINAL)
    await expectNoReplay(restarted)
    expect(restartedMock.requests).toEqual([])
    expect(restartedMock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("rechecks newer drafts, attachments, and session changes before accepting a stale dialog", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    const page = harness.controller
    await seedLegacy(harness)
    await probeNavigation(page)
    const before = await saved(page)
    await openTree(page)
    await setModalDraft(page, "Keep this newer draft")
    await row(page, "user", "Original request").click()
    await expect(page.locator("#session-tree-error")).toContainText("unsent draft")
    await expect(page.locator("#prompt")).toHaveValue("Keep this newer draft")
    expect(await saved(page)).toEqual(before)
    await setModalDraft(page, "")
    await pastePng(page)
    await row(page, "user", "Original request").click()
    await expect(page.locator("#session-tree-error")).toContainText("Remove images")
    await expect(page.locator("#pasted-images img")).toHaveCount(1)
    expect(await saved(page)).toEqual(before)
    await dialog(page).press("Escape")
    await page.locator("#pasted-images .remove-pasted-image").click()

    await openTree(page)
    // A session change can arrive from another UI event while this modal is open.
    await page.locator("#new-session").evaluate((button) => (button as HTMLButtonElement).click())
    await expect(page.locator("#sessions")).not.toHaveValue(before.record.id)
    const replacement = await saved(page)
    await row(page, "assistant", "Original answer").click()
    await expect(page.locator("#session-tree-error")).toContainText("conversation changed")
    expect(await saved(page)).toEqual(replacement)
    await expect(page.locator("#transcript .message")).toHaveCount(0)
    await dialog(page).press("Escape")
    await expectNoReplay(page)
    expect(mock.requests).toEqual([])
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("a failed first-navigation write retains legacy history and retries atomically in database v1", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    const page = harness.controller
    await seedLegacy(harness)
    await probeNavigation(page)
    const before = await saved(page)
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put
      const state = window as unknown as ProbeWindow
      state.treePutCount = 0
      state.restoreTreePut = () => {
        IDBObjectStore.prototype.put = original
      }
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === "sessions" && (value as SessionRecord).tree) {
          state.treePutCount += 1
          throw new DOMException("Tree fixture quota exhausted", "QuotaExceededError")
        }
        return key === undefined ? original.call(this, value) : original.call(this, value, key)
      }
    })
    await openTree(page)
    await row(page, "user", "Original request").click()
    await expect(page.locator("#session-tree-error")).toContainText("Tree fixture quota exhausted")
    await expect(dialog(page)).toHaveAttribute("aria-busy", "false")
    await expect(page.locator("#session-tree-cancel")).toBeEnabled()
    await expect(row(page, "user", "Original request")).toBeFocused()
    await expect(page.locator("#prompt")).toHaveValue("")
    await expect(page.locator("#transcript")).toContainText("Original answer")
    expect(await saved(page)).toEqual(before)
    expect(await page.evaluate(() => (window as unknown as ProbeWindow).treePutCount)).toBe(1)
    await page.evaluate(() => (window as unknown as ProbeWindow).restoreTreePut?.())
    await select(row(page, "user", "Original request"))
    await expect(page.locator("#prompt")).toHaveValue("Original request")
    const after = await saved(page)
    expect(after.version).toBe(1)
    expect(after.record.schemaVersion).toBe(1)
    expect(after.record.id).toBe(before.record.id)
    expect(after.record.tree?.nodes.map((node) => node.message)).toEqual(ORIGINAL)
    expect(after.record.tree?.activeLeafId).toBeNull()
    expect(projection(after.record)).toEqual([])
    await expectNoReplay(page)
    expect(mock.requests).toEqual([])
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.controller
      .evaluate(() => (window as unknown as ProbeWindow).restoreTreePut?.())
      .catch(() => undefined)
    await harness.close()
  }
})

test("pending navigation blocks duplicate selection and cancellation and retains a newer draft", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    const page = harness.controller
    await seedLegacy(harness)
    await probeNavigation(page)
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put
      const state = window as unknown as ProbeWindow
      state.treePutCount = 0
      let released = false
      state.treePutGate = {
        entered: false,
        release: () => {
          released = true
        },
      }
      state.restoreTreePut = () => {
        released = true
        IDBObjectStore.prototype.put = original
      }
      IDBObjectStore.prototype.put = function (value, key) {
        const request =
          key === undefined ? original.call(this, value) : original.call(this, value, key)
        if (this.name === "sessions" && (value as SessionRecord).tree) {
          state.treePutCount += 1
          if (state.treePutGate) state.treePutGate.entered = true
          // Keep the real transaction active, but do not let it commit until released.
          const keepAlive = (): void => {
            if (released) return
            const read = this.get("tree-fixture-keepalive")
            read.onsuccess = keepAlive
          }
          keepAlive()
        }
        return request
      }
    })
    await openTree(page)
    await row(page, "user", "Original request").click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ProbeWindow).treePutGate?.entered))
      .toBe(true)
    await expect(dialog(page)).toHaveAttribute("aria-busy", "true")
    await expect(page.locator("#session-tree-cancel")).toBeDisabled()
    await expect(page.locator("#new-session")).toBeDisabled()
    await expect(page.locator("#send")).toBeDisabled()
    await expect(page.locator("#transcript")).toContainText("Original answer")
    await row(page, "assistant", "Original answer").dispatchEvent("click")
    await row(page, "user", "Original request").press("Enter")
    await dialog(page).press("Escape")
    await page.locator("#session-tree-cancel").dispatchEvent("click")
    await expect(dialog(page)).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as ProbeWindow).treePutCount)).toBe(1)
    await setModalDraft(page, "Typed while the tree write was pending")
    await page.evaluate(() => (window as unknown as ProbeWindow).treePutGate?.release())
    await expect(dialog(page)).not.toBeVisible()
    await expect(page.locator("#send")).toBeEnabled()
    await expect(page.locator("#prompt")).toHaveValue("Typed while the tree write was pending")
    await expect(page.locator("#error")).toContainText("newer draft and attachments were retained")
    expect(projection((await saved(page)).record)).toEqual([])
    expect((await saved(page)).record.tree?.nodes).toHaveLength(2)
    await expectNoReplay(page)
    expect(mock.requests).toEqual([])
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.controller
      .evaluate(() => (window as unknown as ProbeWindow).restoreTreePut?.())
      .catch(() => undefined)
    await harness.close()
  }
})

test("tree keyboard navigation and hostile plain-text labels fit 320px at font 24 in both themes", async () => {
  const harness = await launchExtensionHarness()
  try {
    const mock = await mockProvider(harness)
    const page = harness.controller
    const hostile =
      '<img src=x onerror="window.treeInjected=true"> <script>window.treeInjected=true</script>'
    const history = [user(`${hostile}\u202e${"unbroken".repeat(30)}`), assistant("Safe answer")]
    for (let index = 0; index < 12; index += 1)
      history.push(
        user(`Deep request ${index}`, 3 + index * 2),
        assistant(`Deep answer ${index}`, 4 + index * 2),
      )
    await seedLegacy(harness, history)
    await probeNavigation(page)
    await page.setViewportSize({ width: 320, height: 720 })
    await page.evaluate(() => document.documentElement.style.setProperty("--app-font-size", "24px"))
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await openTree(page)
      const current = row(page, "assistant", "Deep answer 11")
      await expect(current).toBeFocused()
      await expect(current).toHaveAttribute("aria-current", "location")
      await expect(current).toHaveAttribute("data-on-active-path", "true")
      await expect(dialog(page).getByRole("treeitem")).toHaveCount(history.length + 1)
      const label = row(page, "user", "<img src=x")
      await expect(label.locator(".session-tree-label")).toContainText(hostile)
      expect(
        (await label.locator(".session-tree-label").textContent())?.length,
      ).toBeLessThanOrEqual(160)
      expect(await label.textContent()).not.toContain("\u202e")
      await expect(dialog(page).locator("img, script, iframe")).toHaveCount(0)
      expect(
        await page.evaluate(() => (window as Window & { treeInjected?: boolean }).treeInjected),
      ).toBeUndefined()
      await current.press("Home")
      await expect(root(page)).toBeFocused()
      await root(page).press("ArrowDown")
      await expect(label).toBeFocused()
      await label.press("ArrowRight")
      await expect(row(page, "assistant", "Safe answer")).toBeFocused()
      await row(page, "assistant", "Safe answer").press("ArrowLeft")
      await expect(label).toBeFocused()
      await label.press("End")
      await expect(current).toBeFocused()
      await current.press("ArrowUp")
      await expect(row(page, "user", "Deep request 11")).toBeFocused()
      const layout = await dialog(page).evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const list = element.querySelector<HTMLElement>("[role=tree]")
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: innerWidth,
          height: innerHeight,
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          listOverflow: list ? list.scrollWidth > list.clientWidth : true,
        }
      })
      expect(layout.left).toBeGreaterThanOrEqual(0)
      expect(layout.right).toBeLessThanOrEqual(layout.width)
      expect(layout.top).toBeGreaterThanOrEqual(0)
      expect(layout.bottom).toBeLessThanOrEqual(layout.height)
      expect(layout.pageOverflow).toBe(false)
      expect(layout.listOverflow).toBe(false)
      await dialog(page).press("Escape")
      await expect(page.locator("#send")).toBeFocused()
    }
    await openTree(page)
    await row(page, "assistant", "Deep answer 11").press("Home")
    await root(page).press("Enter")
    await expect(dialog(page)).not.toBeVisible()
    await expect(page.locator("#transcript .message")).toHaveCount(0)
    expect((await saved(page)).record.tree?.nodes).toHaveLength(history.length)
    await expectNoReplay(page)
    expect(mock.requests).toEqual([])
    expect(mock.unexpected).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
