import { expect, type Page, test } from "@playwright/test"
import type { UserContextManifest } from "../../src/browser/runtime/target-reference.js"
import { USER_CONTEXT_HEADER } from "../../src/browser/runtime/target-reference.js"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { startMcpFixture } from "./support/mcp-fixture.js"
import {
  CODEX_RESPONSES_URL,
  type CodexRequest,
  finalTextResponse,
  toolCallResponse,
} from "./support/mock-codex.js"

test.setTimeout(120_000)
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII="
async function paste(page: Page, count = 1) {
  const previous = await page.locator("#pasted-images img").count()
  await page.evaluate(
    ({ png, count }) => {
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
      const clipboard = new DataTransfer()
      for (let index = 0; index < count; index++)
        clipboard.items.add(new File([bytes], `fixture-${index}.png`, { type: "image/png" }))
      document.querySelector("#prompt")?.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      )
    },
    { png: PNG, count },
  )
  await expect(page.locator("#pasted-images img")).toHaveCount(previous + count)
}
function manifest(request: CodexRequest): UserContextManifest {
  const text = JSON.stringify(request.input)
  expect(text).toContain("User attachment context v1")
  const user = request.input.filter((item) => item.role === "user").at(-1)
  const blocks = user?.content as { type: string; text?: string }[]
  const context = blocks.find((part) => part.text?.includes(USER_CONTEXT_HEADER))?.text
  if (!context) throw new Error("Missing submitted context")
  return JSON.parse(context.split(`${USER_CONTEXT_HEADER}\n`)[1] ?? "") as UserContextManifest
}
function batchResponse(index: number, calls: { name: string; args: Record<string, unknown> }[]) {
  const output = calls.map((call, i) => ({
    type: "function_call",
    id: `fc_${index}_${i}`,
    call_id: `call_${index}_${i}`,
    name: call.name,
    arguments: JSON.stringify(call.args),
  }))
  const events = output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    { type: "response.output_item.done", output_index, item },
  ])
  return [
    ...events,
    {
      type: "response.completed",
      response: {
        id: `response-${index}`,
        status: "completed",
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
}
const question = {
  question: "Which target? <script>bad()</script>",
  options: [{ label: "First target" }, { label: "Second target" }],
}
async function submit(page: Page, text = "Review the intended result") {
  await page.locator("#prompt").fill(text)
  await page.locator("#send").click()
}
async function finished(page: Page, text: string) {
  await expect(page.locator("#transcript .message.assistant").last()).toContainText(text)
  await expect(page.locator("#abort")).toBeHidden()
}

test("image pair IDs reach the provider; explicit selection resumes once and history stays inactive", async () => {
  const h = await launchExtensionHarness()
  try {
    const requests: CodexRequest[] = []
    let submitted: UserContextManifest | undefined
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      const request = route.request().postDataJSON() as CodexRequest
      requests.push(request)
      if (requests.length === 1) submitted = manifest(request)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          requests.length === 1
            ? toolCallResponse(1, "request_user_input", {
                ...question,
                options: [
                  { label: "Target image", attachmentId: submitted?.pair?.targetId },
                  { label: "Reference image", attachmentId: submitted?.pair?.referenceId },
                ],
              })
            : finalTextResponse(requests.length, "Pair understood"),
      })
    })
    await configureMockCodex(h)
    const page = h.controller
    await paste(page, 2)
    const cards = page.locator("#pasted-images .pasted-image")
    const firstId = await cards.nth(0).getAttribute("data-attachment-id")
    const secondId = await cards.nth(1).getAttribute("data-attachment-id")
    await cards.nth(0).getByRole("button", { name: "Use as target", exact: true }).click()
    await cards.nth(1).getByRole("button", { name: "Use as reference", exact: true }).click()
    await expect(page.locator("#send")).toBeDisabled()
    await submit(page, "Match the target to this reference")
    const card = page.locator("#clarification-card")
    await expect(card).toBeVisible()
    expect(submitted?.pair).toEqual({ targetId: firstId, referenceId: secondId })
    expect(submitted?.attachments).toEqual([
      { id: firstId, kind: "image", imagePosition: 1 },
      { id: secondId, kind: "image", imagePosition: 2 },
    ])
    expect(requests[0]?.instructions).not.toContain("targetId")
    await expect(card.locator("img")).toHaveCount(2)
    await expect(card.locator("script,a")).toHaveCount(0)
    await expect(card.locator("input:checked")).toHaveCount(0)
    await expect(page.locator("#send")).toBeDisabled()
    await expect(page.locator("#new-session")).toBeDisabled()
    await expect(page.locator("#queue-instruction")).toBeDisabled()
    await expect(page.locator("#element-picker")).toBeDisabled()
    await expect(page.locator("#page-pen")).toBeDisabled()
    await expect(card.locator("#clarification-answer")).toBeDisabled()
    await page.locator("#prompt").fill("Keep my next draft")
    await page.evaluate(async () => {
      const key = "piBrowserAgentSettings"
      const current = (await chrome.storage.local.get(key))[key] as Record<string, unknown>
      await chrome.storage.local.set({ [key]: { ...current, language: "ja" } })
    })
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await expect(card.getByRole("heading", { name: "Question from Pi", exact: true })).toBeVisible()
    const radio = card.getByRole("radio", { name: /Reference image/ })
    await radio.focus()
    await radio.press("Space")
    expect(requests).toHaveLength(1)
    await card.locator("#clarification-answer").focus()
    await card.locator("#clarification-answer").press("Enter")
    await finished(page, "Pair understood")
    await expect(page.locator("html")).toHaveAttribute("lang", "ja")
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]?.input)).toContain("option-2")
    expect(JSON.stringify(requests[1]?.input)).toContain("actionApproval")
    await expect(page.locator("#prompt")).toHaveValue("Keep my next draft")
    await expect(page.locator("#prompt")).toBeFocused()
    await expect(page.locator("#target-reference-pair")).toBeHidden()
    await expect(page.locator("#transcript")).toContainText(question.question)
    await page.reload()
    await h.fixturePage.bringToFront()
    await waitForConversationReady(page)
    await expect(page.locator("#clarification-card")).toBeHidden()
    await expect(page.locator("#transcript")).toContainText(question.question)
    await expect(
      page.locator("#transcript input,#transcript textarea,#transcript #clarification-answer"),
    ).toHaveCount(0)
    await expect(page.locator("#transcript .message.user img")).toHaveCount(2)
    expect(requests).toHaveLength(2)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("typed answers require explicit keyboard submission at narrow size in both themes and forced colors", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          requests % 2
            ? toolCallResponse(requests, "request_user_input", question)
            : finalTextResponse(requests, `Typed answer ${requests}`),
      })
    })
    await configureMockCodex(h)
    const page = h.controller
    await page.setViewportSize({ width: 320, height: 720 })
    for (const [index, colorScheme] of (["light", "dark"] as const).entries()) {
      await page.emulateMedia({ colorScheme, forcedColors: index ? "active" : "none" })
      await submit(page)
      const card = page.locator("#clarification-card")
      await expect(card).toBeVisible()
      await card.getByRole("radio", { name: "Other answer", exact: true }).focus()
      await card.getByRole("radio", { name: "Other answer", exact: true }).press("Space")
      await expect(card.locator("#clarification-answer")).toBeDisabled()
      await card.locator("#clarification-other").fill("😀".repeat(2049))
      await expect(card.locator("#clarification-answer")).toBeDisabled()
      await card.locator("#clarification-other").fill(`Use the compact result ${index}`)
      expect(requests).toBe(index * 2 + 1)
      expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      await card.locator("#clarification-answer").focus()
      await card.locator("#clarification-answer").press("Enter")
      await finished(page, `Typed answer ${(index + 1) * 2}`)
    }
    expect(requests).toBe(4)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("an application-owned question sequence allows a reused model call ID without reviving old controls", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          requests <= 2
            ? toolCallResponse(1, "request_user_input", {
                ...question,
                question: requests === 1 ? "First question" : "Second question",
              })
            : finalTextResponse(requests, "Question IDs safely reused"),
      })
    })
    await configureMockCodex(h)
    const page = h.controller
    await submit(page)
    const card = page.locator("#clarification-card")
    await expect(card).toContainText("First question")
    await card.getByRole("radio", { name: "First target", exact: true }).check()
    await page.evaluate(() => {
      ;(window as Window & { staleQuestionButton?: HTMLButtonElement }).staleQuestionButton =
        document.querySelector<HTMLButtonElement>("#clarification-answer") ?? undefined
    })
    await card.locator("#clarification-answer").click()
    await expect(card).toContainText("Second question")
    await expect(card.locator("input:checked")).toHaveCount(0)
    await page.evaluate(() =>
      (window as Window & { staleQuestionButton?: HTMLButtonElement }).staleQuestionButton?.click(),
    )
    expect(requests).toBe(2)
    await expect(card.locator("#clarification-answer")).toBeDisabled()
    await card.getByRole("radio", { name: "Second target", exact: true }).check()
    await card.locator("#clarification-answer").click()
    await finished(page, "Question IDs safely reused")
    expect(requests).toBe(3)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("invalid IDs and duplicate questions cannot create controls or dispatch sibling browser actions", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      const invalid =
        requests === 1
          ? [
              {
                name: "request_user_input",
                args: {
                  ...question,
                  options: [
                    { label: "Unknown", attachmentId: "https://evil.test/target" },
                    { label: "Other" },
                  ],
                },
              },
            ]
          : [
              { name: "request_user_input", args: question },
              { name: "request_user_input", args: question },
            ]
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          requests % 2
            ? batchResponse(requests, [
                { name: "browser_click", args: { selector: "#complete" } },
                ...invalid,
                { name: "browser_type", args: { selector: "#note", text: "must-not-type" } },
              ])
            : finalTextResponse(requests, `Rejected question ${requests}`),
      })
    })
    await configureMockCodex(h)
    for (let i = 0; i < 2; i++) {
      await submit(h.controller)
      await finished(h.controller, `Rejected question ${(i + 1) * 2}`)
      await expect(h.controller.locator("#clarification-card")).toBeHidden()
      await expect(h.controller.locator("#confirm-dialog")).toBeHidden()
      await expect(h.fixturePage.locator("#result")).toHaveText("idle")
      await expect(h.fixturePage.locator("#note")).toHaveValue("")
    }
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("Stop and panel restart cannot revive a pending question or send a late answer", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    const mock = async () =>
      h.context.route(CODEX_RESPONSES_URL, async (route) => {
        requests++
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: toolCallResponse(requests, "request_user_input", question),
        })
      })
    await mock()
    await configureMockCodex(h)
    await submit(h.controller)
    await expect(h.controller.locator("#clarification-card")).toBeVisible()
    await h.controller.locator("#abort").click()
    await expect(h.controller.locator("#abort")).toBeHidden()
    await expect(h.controller.locator("#clarification-card")).toBeHidden()
    expect(requests).toBe(1)
    await submit(h.controller, "Ask another independent question")
    await expect(h.controller.locator("#clarification-card")).toBeVisible()
    await h.restart()
    await mock()
    await expect(h.controller.locator("#clarification-card")).toBeHidden()
    await expect(h.controller.locator("#transcript")).toContainText(question.question)
    expect(requests).toBe(2)
    await expect(h.controller.locator("#send")).toBeEnabled()
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("credential removal in another conversation cancels the pending question without continuation", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: toolCallResponse(requests, "request_user_input", question),
      })
    })
    await configureMockCodex(h)
    const sessionId = await h.controller.locator("#sessions").inputValue()
    await submit(h.controller)
    await expect(h.controller.locator("#clarification-card")).toBeVisible()
    const other = await h.context.newPage()
    await other.goto(h.controller.url())
    await waitForConversationReady(other)
    expect(await other.locator("#sessions").inputValue()).not.toBe(sessionId)
    await expect(other.locator("#auth-status")).toHaveAttribute("data-logged-in", "true")
    await other.locator("#account-menu-trigger").click()
    await other.locator("#logout").click()
    await expect(h.controller.locator("#clarification-card")).toBeHidden()
    await expect(h.controller.locator("#abort")).toBeHidden()
    await expect(h.controller.locator("#auth-status")).toHaveAttribute("data-logged-in", "false")
    await expect(h.controller.locator("#transcript")).toContainText(question.question)
    const saved = await h.controller.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("pi-browser-agent-sessions", 1)
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      try {
        return await new Promise<{ messages: { role: string; isError?: boolean }[] }>(
          (resolve, reject) => {
            const get = db.transaction("sessions").objectStore("sessions").get(id)
            get.onsuccess = () => resolve(get.result)
            get.onerror = () => reject(get.error)
          },
        )
      } finally {
        db.close()
      }
    }, sessionId)
    expect(saved.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(
      true,
    )
    expect(requests).toBe(1)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("failed preparation preserves pair IDs and images for an explicit retry without recapture", async () => {
  const h = await launchExtensionHarness()
  try {
    const requests: CodexRequest[] = []
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON() as CodexRequest)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(requests.length, "Manual retry accepted"),
      })
    })
    await configureMockCodex(h)
    const page = h.controller
    await paste(page, 2)
    await page
      .locator("#pasted-images .pasted-image")
      .nth(0)
      .getByRole("button", { name: "Use as target", exact: true })
      .click()
    await page
      .locator("#pasted-images .pasted-image")
      .nth(1)
      .getByRole("button", { name: "Use as reference", exact: true })
      .click()
    const ids = await page
      .locator("#pasted-images .pasted-image")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.attachmentId))
    const credentials = await page.evaluate(async () => {
      const key = "piBrowserAgentCredentialsV1"
      const value = (await chrome.storage.local.get(key))[key]
      await chrome.storage.local.remove(key)
      return value
    })
    await submit(page, "Compare the two images")
    await expect(page.locator("#error")).toContainText("Configure")
    expect(requests).toHaveLength(0)
    await expect(page.locator("#pasted-images img")).toHaveCount(2)
    await expect(page.locator("#prompt")).toHaveValue("Compare the two images")
    await page.evaluate(
      async (value) => chrome.storage.local.set({ piBrowserAgentCredentialsV1: value }),
      credentials,
    )
    await page.locator("#send").click()
    await finished(page, "Manual retry accepted")
    expect(manifest(requests[0] as CodexRequest).pair).toEqual({
      targetId: ids[0],
      referenceId: ids[1],
    })
    await expect(page.locator("#pasted-images img")).toHaveCount(0)
    expect(requests).toHaveLength(1)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("a clarification batch suppresses remote MCP and browser calls; later remote calls still require fresh approval", async () => {
  const fixture = await startMcpFixture()
  const h: ExtensionHarness = await launchExtensionHarness({
    hostPatterns: ["https://mcp.e2e.example.com/*"],
    browserArgs: fixture.browserArgs,
  })
  try {
    await configureMockCodex(h)
    const settings = await h.context.newPage()
    await settings.goto(`${h.controller.url()}?view=settings`)
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    await settings.locator("#mcp-name").fill("Clarification fixture")
    await settings.locator("#mcp-endpoint").fill(fixture.endpoint)
    await settings.locator("#mcp-save").click()
    await settings.getByRole("button", { name: "Test and enable", exact: true }).click()
    await expect(settings.locator("#mcp-status")).toContainText("Enabled for new runs")
    await settings.close()
    await h.fixturePage.bringToFront()
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      const name = route
        .request()
        .postData()
        ?.match(/mcp_[a-f0-9]{32}_[a-f0-9]{20}/)?.[0]
      if (!name) throw new Error("Missing remote declaration")
      const remote = { name, args: { text: "No implicit approval" } }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          requests === 1
            ? batchResponse(1, [
                remote,
                { name: "request_user_input", args: question },
                { name: "browser_click", args: { selector: "#complete" } },
              ])
            : requests === 2
              ? toolCallResponse(2, name, remote.args)
              : finalTextResponse(requests, "Approval remains separate"),
      })
    })
    await submit(h.controller)
    await expect(h.controller.locator("#clarification-card")).toBeVisible()
    expect(
      fixture.requests.filter((request) => request.message?.method === "tools/call"),
    ).toHaveLength(0)
    await expect(h.controller.locator("#confirm-dialog")).toBeHidden()
    await expect(h.fixturePage.locator("#result")).toHaveText("idle")
    await h.controller
      .locator("#clarification-card")
      .getByRole("radio", { name: "First target", exact: true })
      .check()
    await h.controller.locator("#clarification-answer").click()
    await expect(h.controller.locator("#confirm-dialog")).toBeVisible()
    expect(
      fixture.requests.filter((request) => request.message?.method === "tools/call"),
    ).toHaveLength(0)
    await h.controller.locator('#confirm-dialog button[value="cancel"]').click()
    await finished(h.controller, "Approval remains separate")
    expect(
      fixture.requests.filter((request) => request.message?.method === "tools/call"),
    ).toHaveLength(0)
    expect(requests).toBe(3)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
    await fixture.close()
  }
})
