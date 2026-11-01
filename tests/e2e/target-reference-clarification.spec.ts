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
const PICKER_HOST = "[data-pi-browser-agent-element-picker]"
type PairProbe = Window & {
  pairedPreparationEntered?: boolean
  releasePairedPreparation?: () => void
}
async function pairFixture(h: ExtensionHarness) {
  await h.fixturePage.evaluate(() => {
    for (let number = 1; number <= 3; number++) {
      const button = document.createElement("button")
      button.id = `pair-element-${number}`
      button.textContent = `Pair target ${number}`
      button.style.cssText = `position:fixed;left:${100 + number * 110}px;top:240px;width:90px;height:50px`
      button.addEventListener("click", () => {
        document.body.dataset.pairActivated = "yes"
      })
      document.body.append(button)
    }
  })
  await h.worker.evaluate(() => {
    const state = globalThis as typeof globalThis & { pairCaptures?: number; pairReads?: number }
    state.pairCaptures = 0
    state.pairReads = 0
    const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
      state.pairCaptures = (state.pairCaptures ?? 0) + 1
      return Reflect.apply(capture, chrome.tabs, args)
    }) as typeof chrome.tabs.captureVisibleTab
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (async (...args: unknown[]) => {
      const injection = args[0] as { args?: unknown[] }
      if (injection.args?.[0] === "getVisibleText" || injection.args?.[0] === "getSelection")
        state.pairReads = (state.pairReads ?? 0) + 1
      return Reflect.apply(execute, chrome.scripting, args)
    }) as typeof chrome.scripting.executeScript
  })
}
const pairCaptures = (h: ExtensionHarness) =>
  h.worker.evaluate(
    () => (globalThis as typeof globalThis & { pairCaptures?: number }).pairCaptures,
  )
const pairReads = (h: ExtensionHarness) =>
  h.worker.evaluate(() => (globalThis as typeof globalThis & { pairReads?: number }).pairReads)
async function selectElement(h: ExtensionHarness, selector: string, count: number) {
  await h.fixturePage.bringToFront()
  await h.controller.locator("#element-picker").click()
  await expect(h.fixturePage.locator(PICKER_HOST)).toHaveCount(1)
  const box = await h.fixturePage.locator(selector).boundingBox()
  if (!box) throw new Error("Missing pair target")
  await h.fixturePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(h.controller.locator(".selected-element-chip")).toHaveCount(count)
  await expect(h.fixturePage.locator(PICKER_HOST)).toHaveCount(0)
}
async function preparationGate(page: Page, fail = false) {
  await page.evaluate((fail) => {
    const state = window as PairProbe
    const get = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = (async (...args: unknown[]) => {
      if (args[0] === "piBrowserAgentSkillsV1" && !state.pairedPreparationEntered) {
        state.pairedPreparationEntered = true
        await new Promise<void>((resolve) => {
          state.releasePairedPreparation = resolve
        })
        if (fail) throw new Error("Mock paired preparation failed")
      }
      return Reflect.apply(get, chrome.storage.local, args)
    }) as typeof chrome.storage.local.get
  }, fail)
}
async function releasePreparation(page: Page) {
  await page.evaluate(() => (window as PairProbe).releasePairedPreparation?.())
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

test("a cropped reference and non-last selected element keep explicit roles and newer drafts", async () => {
  const h = await launchExtensionHarness({ screenshots: true })
  try {
    const requests: CodexRequest[] = []
    let submitted: UserContextManifest | undefined
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON() as CodexRequest)
      expect(await h.fixturePage.locator(PICKER_HOST).count()).toBe(0)
      if (requests.length === 1) submitted = manifest(requests[0] as CodexRequest)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          requests.length === 1
            ? toolCallResponse(1, "request_user_input", {
                question: "Which submitted target?",
                options: [
                  { label: "Selected element", attachmentId: submitted?.pair?.targetId },
                  { label: "Cropped reference", attachmentId: submitted?.pair?.referenceId },
                ],
              })
            : finalTextResponse(requests.length, "Element and crop understood"),
      })
    })
    await configureMockCodex(h)
    await pairFixture(h)
    const page = h.controller
    await expect(page.locator("#point-comments,#point-comment-cards")).toHaveCount(0)
    await page.locator("#region-capture").click()
    await expect(page.locator("#element-picker")).toBeDisabled()
    await expect(page.locator("#page-pen")).toBeDisabled()
    await expect(page.locator("#send")).toBeDisabled()
    await h.fixturePage.mouse.move(100, 110)
    await h.fixturePage.mouse.down()
    await h.fixturePage.mouse.move(260, 220, { steps: 4 })
    await h.fixturePage.mouse.up()
    await expect(page.locator("#region-preview-action")).toBeEnabled()
    await page.locator("#region-preview-action").click()
    await expect(page.locator("#region-preview-dialog")).toBeVisible()
    await page.locator("#region-attach").click()
    const image = page.locator("#pasted-images img")
    await expect(image).toHaveCount(1)
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(160)
    expect(await image.evaluate((node) => (node as HTMLImageElement).naturalHeight)).toBe(110)
    expect(requests).toHaveLength(0)
    expect(await pairCaptures(h)).toBe(1)
    const imageId = await page.locator(".pasted-image").getAttribute("data-attachment-id")
    for (let number = 1; number <= 3; number++)
      await selectElement(h, `#pair-element-${number}`, number)
    const first = page.locator(".selected-element-chip").nth(0)
    const elementId = await first.getAttribute("data-attachment-id")
    await first.getByRole("button", { name: "Use as target", exact: true }).click()
    await expect(
      first.getByRole("button", { name: "Use as reference", exact: true }),
    ).toBeDisabled()
    await page
      .locator(".pasted-image")
      .getByRole("button", { name: "Use as reference", exact: true })
      .click()
    await preparationGate(page)
    await submit(page, "Match this target to the cropped reference")
    await expect
      .poll(() => page.evaluate(() => (window as PairProbe).pairedPreparationEntered))
      .toBe(true)
    await expect(page.locator(".selected-element-chip")).toHaveCount(3)
    await expect(page.locator("#target-reference-pair")).toContainText("pair-element-1")
    await expect(page.locator("#target-reference-pair")).not.toContainText("Not selected")
    expect(requests).toHaveLength(0)
    await page.locator("#prompt").fill("Newer unsubmitted draft")
    await releasePreparation(page)
    await expect(page.locator("#clarification-card")).toBeVisible()
    expect(submitted?.pair).toEqual({ targetId: elementId, referenceId: imageId })
    expect(submitted?.attachments.find((attachment) => attachment.id === elementId)).toMatchObject({
      kind: "element",
      untrustedPageContext: { id: "pair-element-1" },
    })
    expect(
      submitted?.attachments.filter((attachment) => attachment.kind === "element"),
    ).toHaveLength(3)
    expect(submitted?.attachments.find((attachment) => attachment.id === imageId)).toEqual({
      id: imageId,
      kind: "image",
      imagePosition: 1,
    })
    expect(JSON.stringify(requests[0]?.input)).not.toContain("Newer unsubmitted draft")
    expect(JSON.stringify(submitted)).not.toMatch(/userNote|"kind":"pin"/)
    await expect(page.locator(".selected-element-chip")).toHaveCount(0)
    await expect(page.locator("#target-reference-pair")).toBeHidden()
    for (const id of ["region-capture", "element-picker", "page-pen"])
      await expect(page.locator(`#${id}`)).toBeDisabled()
    await page
      .locator("#clarification-card")
      .getByRole("radio", { name: /Selected element/ })
      .check()
    await page.locator("#clarification-answer").click()
    await finished(page, "Element and crop understood")
    expect(requests).toHaveLength(2)
    expect(await pairCaptures(h)).toBe(1)
    await expect(page.locator("#prompt")).toHaveValue("Newer unsubmitted draft")
    await expect(h.fixturePage.locator("body")).not.toHaveAttribute("data-pair-activated", "yes")
    await page.reload()
    await h.fixturePage.bringToFront()
    await waitForConversationReady(page)
    await expect(page.locator("#transcript")).toContainText("pair-element-1")
    await expect(page.locator("#transcript .message.user img")).toHaveCount(1)
    await expect(page.locator(".selected-element-chip")).toHaveCount(0)
    await expect(page.locator("#clarification-card")).toBeHidden()
    await expect(page.locator("#target-reference-pair")).toBeHidden()
    expect(requests).toHaveLength(2)
    expect(await pairCaptures(h)).toBe(1)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("a page-context change cancels an element-linked question without continuation", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      const data = manifest(route.request().postDataJSON() as CodexRequest)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: toolCallResponse(requests, "request_user_input", {
          question: "Keep this page target?",
          options: [
            { label: "Selected element", attachmentId: data.pair?.targetId },
            { label: "Other result" },
          ],
        }),
      })
    })
    await configureMockCodex(h)
    await pairFixture(h)
    await paste(h.controller)
    await selectElement(h, "#pair-element-1", 1)
    await h.controller
      .locator(".selected-element-chip")
      .getByRole("button", { name: "Use as target", exact: true })
      .click()
    await h.controller
      .locator(".pasted-image")
      .getByRole("button", { name: "Use as reference", exact: true })
      .click()
    await submit(h.controller)
    await expect(h.controller.locator("#clarification-card")).toBeVisible()
    await h.controller.locator("#prompt").fill("Retain this newer draft")
    await h.fixturePage.goto(`${h.fixtureUrl}?new-context=1`)
    await h.fixturePage.bringToFront()
    await expect(h.controller.locator("#clarification-card")).toBeHidden()
    await expect(h.controller.locator("#abort")).toBeHidden()
    await expect(h.controller.locator("#prompt")).toHaveValue("Retain this newer draft")
    expect(requests).toBe(1)
    expect(await pairCaptures(h)).toBe(0)
    await expect(h.fixturePage.locator(PICKER_HOST)).toHaveCount(0)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("failed element-pair preparation keeps IDs, images, and a newer draft for manual retry", async () => {
  const h = await launchExtensionHarness()
  try {
    const requests: CodexRequest[] = []
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON() as CodexRequest)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(requests.length, "Element retry accepted"),
      })
    })
    await configureMockCodex(h)
    await pairFixture(h)
    await paste(h.controller)
    await selectElement(h, "#pair-element-1", 1)
    const chip = h.controller.locator(".selected-element-chip")
    const elementId = await chip.getAttribute("data-attachment-id")
    const imageId = await h.controller.locator(".pasted-image").getAttribute("data-attachment-id")
    await chip.getByRole("button", { name: "Use as target", exact: true }).click()
    await h.controller
      .locator(".pasted-image")
      .getByRole("button", { name: "Use as reference", exact: true })
      .click()
    await preparationGate(h.controller, true)
    await submit(h.controller, "Compare this target with the reference")
    await expect
      .poll(() => h.controller.evaluate(() => (window as PairProbe).pairedPreparationEntered))
      .toBe(true)
    await h.controller.locator("#prompt").fill("Newer draft after snapshot")
    await releasePreparation(h.controller)
    await expect(h.controller.locator("#error")).toContainText("Mock paired preparation failed")
    expect(requests).toHaveLength(0)
    await expect(chip).toHaveAttribute("data-attachment-id", elementId as string)
    await expect(h.controller.locator(".pasted-image")).toHaveAttribute(
      "data-attachment-id",
      imageId as string,
    )
    await expect(h.controller.locator("#target-reference-pair")).not.toContainText("Not selected")
    await expect(h.controller.locator("#prompt")).toHaveValue("Newer draft after snapshot")
    await expect(h.controller.locator("#send")).toBeEnabled()
    await h.controller.locator("#send").click()
    await finished(h.controller, "Element retry accepted")
    expect(manifest(requests[0] as CodexRequest).pair).toEqual({
      targetId: elementId,
      referenceId: imageId,
    })
    expect(JSON.stringify(requests[0]?.input)).toContain("Newer draft after snapshot")
    expect(requests).toHaveLength(1)
    expect(await pairCaptures(h)).toBe(0)
    await expect(h.fixturePage.locator("body")).not.toHaveAttribute("data-pair-activated", "yes")
    await expect(h.controller.locator(".selected-element-chip")).toHaveCount(0)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("ordinary selected-element and image cards form a pair without activating or capturing", async () => {
  const h = await launchExtensionHarness()
  try {
    const requests: CodexRequest[] = []
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON() as CodexRequest)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(requests.length, "Element pair accepted"),
      })
    })
    await configureMockCodex(h)
    await pairFixture(h)
    await paste(h.controller)
    await h.controller.locator("#element-picker").click()
    const box = await h.fixturePage.locator("#complete").boundingBox()
    if (!box) throw new Error("Missing element target")
    await h.fixturePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const chip = h.controller.locator(".selected-element-chip")
    await expect(chip).toBeVisible()
    const id = await chip.getAttribute("data-attachment-id")
    await chip.getByRole("button", { name: "Use as target", exact: true }).click()
    await h.controller
      .locator(".pasted-image")
      .getByRole("button", { name: "Use as reference", exact: true })
      .click()
    await submit(h.controller)
    await finished(h.controller, "Element pair accepted")
    const data = manifest(requests[0] as CodexRequest)
    expect(data.pair?.targetId).toBe(id)
    expect(data.attachments.find((attachment) => attachment.id === id)).toMatchObject({
      kind: "element",
      untrustedPageContext: { id: "complete" },
    })
    await expect(h.fixturePage.locator("#result")).toHaveText("idle")
    expect(await pairCaptures(h)).toBe(0)
    expect(await pairReads(h)).toBe(0)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

test("a paired element context change during preparation sends nothing and preserves a newer draft", async () => {
  const h = await launchExtensionHarness()
  try {
    let requests = 0
    await h.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests++
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: finalTextResponse(requests, "Must not dispatch"),
      })
    })
    await configureMockCodex(h)
    await paste(h.controller)
    await h.controller.locator("#element-picker").click()
    const box = await h.fixturePage.locator("#complete").boundingBox()
    if (!box) throw new Error("Missing element target")
    await h.fixturePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await h.controller
      .locator(".selected-element-chip")
      .getByRole("button", { name: "Use as target", exact: true })
      .click()
    await h.controller
      .locator(".pasted-image")
      .getByRole("button", { name: "Use as reference", exact: true })
      .click()
    await preparationGate(h.controller)
    await submit(h.controller)
    await expect
      .poll(() => h.controller.evaluate(() => (window as PairProbe).pairedPreparationEntered))
      .toBe(true)
    await h.controller.locator("#prompt").fill("Newer draft must remain")
    await h.fixturePage.goto(`${h.fixtureUrl}?context-before-dispatch=1`)
    await h.fixturePage.bringToFront()
    await expect(h.controller.locator(".selected-element-chip")).toHaveCount(0)
    await releasePreparation(h.controller)
    await expect(h.controller.locator("#abort")).toBeHidden()
    await expect(h.controller.locator("#prompt")).toHaveValue("Newer draft must remain")
    await expect(h.controller.locator("#pasted-images img")).toHaveCount(1)
    await expect(h.controller.locator("#send")).toBeDisabled()
    expect(requests).toBe(0)
    expect(h.pageErrors).toEqual([])
  } finally {
    await h.close()
  }
})

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
    await pairFixture(h)
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
    await expect(page.locator("#point-comments,#point-comment-cards")).toHaveCount(0)
    await expect(page.locator("#region-capture")).toBeDisabled()
    await expect(page.locator("#element-picker")).toBeDisabled()
    await expect(page.locator("#page-pen")).toBeDisabled()
    await expect(card.locator("#clarification-answer")).toBeDisabled()
    await page.evaluate(() => {
      const state = window as Window & { pairTabChangeSeen?: boolean }
      chrome.runtime.onMessage.addListener((message) => {
        if (
          message?.name === "tab.changed" &&
          message.tabContext?.url.includes("image-question-context")
        )
          state.pairTabChangeSeen = true
      })
    })
    await h.fixturePage.goto(`${h.fixtureUrl}?image-question-context=1`)
    await h.fixturePage.bringToFront()
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { pairTabChangeSeen?: boolean }).pairTabChangeSeen),
      )
      .toBe(true)
    await expect(card).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(await pairCaptures(h)).toBe(0)
    expect(await pairReads(h)).toBe(0)
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
