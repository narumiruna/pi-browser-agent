import { expect, type Page, test } from "@playwright/test"
import type { SessionRecord } from "../../src/browser/sessions/session-store.js"
import {
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import {
  CODEX_RESPONSES_URL,
  type CodexRequest,
  declaredToolNames,
  finalTextResponse,
  toolCallResponse,
} from "./support/mock-codex.js"

test.setTimeout(120_000)

const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
const PROMPT = "A red square on a transparent background."
// One valid 1 x 1 RGBA PNG, including compressed raster data and chunk CRCs.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
const ACCOUNT_ID = "e2e-imagegen-account"
const ACCESS_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
  ).toString("base64url"),
  Buffer.from("e2e-imagegen-signature").toString("base64url"),
].join(".")

type PermissionProbe = Window & { imagegenRequestedOrigins?: Array<string[] | undefined> }

async function configure(harness: ExtensionHarness): Promise<void> {
  await harness.controller.evaluate(async (access) => {
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    await chrome.storage.local.set({
      piBrowserAgentApprovedHostPermissions: ["https://auth.openai.com/*", "https://chatgpt.com/*"],
      piBrowserAgentCredentialsV1: {
        "openai-codex": {
          type: "oauth",
          access,
          refresh: "e2e-imagegen-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "e2e-imagegen-account",
        },
      },
      piBrowserAgentSettings: {
        ...(stored.piBrowserAgentSettings as Record<string, unknown>),
        confirmationMode: "convenient",
      },
    })
  }, ACCESS_TOKEN)
  await harness.fixturePage.goto("about:blank")
  await harness.controller.reload({ waitUntil: "domcontentloaded" })
  await harness.fixturePage.bringToFront()
  await waitForConversationReady(harness.controller)
  await expect(harness.controller.locator("#auth-status")).toHaveAttribute("data-logged-in", "true")
  await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
  await harness.controller.evaluate(() => {
    const original = chrome.permissions.request.bind(chrome.permissions)
    const probe = window as PermissionProbe
    probe.imagegenRequestedOrigins = []
    chrome.permissions.request = (async (permissions) => {
      probe.imagegenRequestedOrigins?.push(permissions.origins)
      return original(permissions)
    }) as typeof chrome.permissions.request
  })
}

async function mockRequests(harness: ExtensionHarness, transparentBackground?: boolean) {
  const model: CodexRequest[] = []
  const images: { method: string; body: unknown; headers: Record<string, string> }[] = []
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    model.push(route.request().postDataJSON() as CodexRequest)
    const index = model.length
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        index % 2
          ? toolCallResponse(index, "codex_imagegen", {
              prompt: PROMPT,
              ...(transparentBackground === undefined ? {} : { transparentBackground }),
            })
          : finalTextResponse(index, `Image turn ${index / 2} complete`),
    })
  })
  await harness.context.route(IMAGE_ENDPOINT, async (route) => {
    const request = route.request()
    images.push({
      method: request.method(),
      body: request.postDataJSON(),
      headers: await request.allHeaders(),
    })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-codex-imagegen-request-id": "e2e-image-request" },
      body: JSON.stringify({ data: [{ b64_json: PNG }] }),
    })
  })
  return { model, images }
}

async function requestImage(page: Page, transparentBackground: boolean): Promise<void> {
  await page.locator("#prompt").fill("Generate the requested image")
  await page.locator("#send").click()
  await expect(page.locator("#confirm-dialog")).toBeVisible()
  await expect(page.locator("#confirm-message")).toContainText("Every call requires confirmation")
  await expect(page.locator("#confirm-message")).toContainText(IMAGE_ENDPOINT)
  await expect(page.locator("#confirm-message")).toContainText(PROMPT)
  await expect(page.locator("#confirm-message")).toContainText(
    `"transparentBackground": ${transparentBackground}`,
  )
  // Send already approves the chat endpoint. Count only requests made by this confirmation.
  await page.evaluate(() => {
    ;(window as PermissionProbe).imagegenRequestedOrigins = []
  })
}

async function expectFinished(page: Page, turn: number): Promise<void> {
  await expect(page.locator("#transcript .message.assistant").last()).toContainText(
    `Image turn ${turn} complete`,
  )
  await expect(page.locator("#confirm-dialog")).toBeHidden()
  await expect(page.locator("#abort")).toBeHidden()
  await expect(page.locator("#error")).toBeEmpty()
}

async function expectPreview(page: Page): Promise<void> {
  const preview = page.locator("#transcript .message.toolResult img.message-image")
  await expect(preview).toHaveCount(1)
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute("src", `data:image/png;base64,${PNG}`)
  await expect
    .poll(() =>
      preview.evaluate((image) => {
        const raster = image as HTMLImageElement
        return [raster.complete, raster.naturalWidth, raster.naturalHeight]
      }),
    )
    .toEqual([true, 1, 1])
}

async function savedSessions(page: Page): Promise<SessionRecord[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-browser-agent-sessions", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<SessionRecord[]>((resolve, reject) => {
        const request = database
          .transaction("sessions", "readonly")
          .objectStore("sessions")
          .getAll()
        request.onsuccess = () => resolve(request.result as SessionRecord[])
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  })
}

test("confirms image generation without page context and restores the saved raster without replay", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests = await mockRequests(harness, true)
    await configure(harness)
    await requestImage(harness.controller, true)
    expect(declaredToolNames(requests.model[0])).toContain("codex_imagegen")
    await expect(harness.controller.locator("#element-picker")).toBeDisabled()
    expect(requests.model).toHaveLength(1)
    expect(requests.images).toHaveLength(0)
    expect(
      await harness.controller.evaluate(() => (window as PermissionProbe).imagegenRequestedOrigins),
    ).toEqual([])

    await harness.controller.locator("#confirm-action").click()
    await expectFinished(harness.controller, 1)
    expect(requests.images).toHaveLength(1)
    expect(requests.images[0]).toMatchObject({
      method: "POST",
      body: {
        prompt: PROMPT,
        background: "transparent",
        model: "gpt-image-2",
        quality: "auto",
        size: "auto",
      },
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "chatgpt-account-id": ACCOUNT_ID,
        "content-type": "application/json",
        originator: "pi-browser-agent",
      },
    })
    expect(requests.images[0]?.headers.cookie).toBeUndefined()
    expect(
      await harness.controller.evaluate(() => (window as PermissionProbe).imagegenRequestedOrigins),
    ).toEqual([["https://chatgpt.com/*"]])
    await expectPreview(harness.controller)
    expect(requests.model).toHaveLength(2)
    expect(JSON.stringify(requests.model[1])).toContain(PNG)
    expect(JSON.stringify(requests.model)).not.toContain(ACCESS_TOKEN)
    await expect
      .poll(async () =>
        (await savedSessions(harness.controller)).flatMap((session) => session.messages),
      )
      .toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "codex_imagegen",
          isError: false,
          content: expect.arrayContaining([{ type: "image", mimeType: "image/png", data: PNG }]),
          details: expect.objectContaining({ width: 1, height: 1, requestId: "e2e-image-request" }),
        }),
      )
    expect(JSON.stringify(await savedSessions(harness.controller))).not.toContain(ACCESS_TOKEN)

    await harness.controller.reload({ waitUntil: "domcontentloaded" })
    await waitForConversationReady(harness.controller)
    await expectFinished(harness.controller, 1)
    await expectPreview(harness.controller)
    expect(requests.images).toHaveLength(1)
    expect(requests.model).toHaveLength(2)

    // An identical call still needs fresh confirmation, even in convenient mode.
    await harness.fixturePage.bringToFront()
    await requestImage(harness.controller, true)
    expect(requests.images).toHaveLength(1)
    await harness.controller.locator('#confirm-dialog button[value="cancel"]').click()
    await expectFinished(harness.controller, 2)
    expect(requests.images).toHaveLength(1)
    expect(JSON.stringify(requests.model[3])).toContain("Image generation was declined")
    await expectPreview(harness.controller)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("declining image generation in convenient mode sends no image request", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests = await mockRequests(harness)
    await configure(harness)
    await requestImage(harness.controller, false)
    expect(declaredToolNames(requests.model[0])).toContain("codex_imagegen")
    expect(requests.images).toHaveLength(0)
    await harness.controller.locator('#confirm-dialog button[value="cancel"]').click()
    await expectFinished(harness.controller, 1)
    expect(requests.model).toHaveLength(2)
    expect(JSON.stringify(requests.model[1])).toContain("Image generation was declined")
    expect(requests.images).toHaveLength(0)
    await expect(harness.controller.locator("#transcript img.message-image")).toHaveCount(0)
    expect(
      await harness.controller.evaluate(() => (window as PermissionProbe).imagegenRequestedOrigins),
    ).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
