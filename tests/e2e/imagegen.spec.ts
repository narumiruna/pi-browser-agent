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

async function mockRequests(
  harness: ExtensionHarness,
  transparentBackground?: boolean,
  size?: string,
  imageBase64 = PNG,
) {
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
              ...(size === undefined ? {} : { size }),
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
      body: JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
    })
  })
  return { model, images }
}

async function requestImage(
  page: Page,
  transparentBackground: boolean,
  size = "auto",
): Promise<void> {
  await page.locator("#prompt").fill("Generate the requested image")
  await page.locator("#send").click()
  await expect(page.locator("#confirm-dialog")).toBeVisible()
  await expect(page.locator("#confirm-message")).toContainText("Every call requires confirmation")
  await expect(page.locator("#confirm-message")).toContainText(IMAGE_ENDPOINT)
  await expect(page.locator("#confirm-message")).toContainText(PROMPT)
  await expect(page.locator("#confirm-message")).toContainText(
    `"transparentBackground": ${transparentBackground}`,
  )
  await expect(page.locator("#confirm-message")).toContainText(`"size": "${size}"`)
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

async function expectPreview(
  page: Page,
  image = { base64: PNG, mimeType: "image/png", width: 1, height: 1 },
): Promise<void> {
  const preview = page.locator("#transcript .message.toolResult img.message-image")
  await expect(preview).toHaveCount(1)
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute("src", `data:${image.mimeType};base64,${image.base64}`)
  await expect
    .poll(() =>
      preview.evaluate((image) => {
        const raster = image as HTMLImageElement
        return [raster.complete, raster.naturalWidth, raster.naturalHeight]
      }),
    )
    .toEqual([true, image.width, image.height])
}

async function orientedJpeg(page: Page, orientation: number): Promise<string> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 2
    canvas.height = 3
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas context unavailable")
    context.fillStyle = "red"
    context.fillRect(0, 0, 2, 3)
    context.fillStyle = "blue"
    context.fillRect(0, 0, 1, 1)
    return canvas.toDataURL("image/jpeg").split(",")[1] as string
  })
  const jpeg = Buffer.from(base64, "base64")
  expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8])

  // Little-endian TIFF with one SHORT Orientation entry in IFD0 and no next IFD.
  const tiff = Buffer.alloc(26)
  tiff.write("II", 0, "ascii")
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff])
  const app1 = Buffer.from([0xff, 0xe1, 0, 0])
  app1.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]).toString("base64")
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

test("confirms image generation size without page context and restores the saved raster without replay", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests = await mockRequests(harness, true, "512x512")
    await configure(harness)
    await requestImage(harness.controller, true, "512x512")
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
        size: "512x512",
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
    await requestImage(harness.controller, true, "512x512")
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

for (const orientation of [5, 6, 7, 8]) {
  test(`accepts a real JPEG with EXIF orientation ${orientation} and saves preview dimensions`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const base64 = await orientedJpeg(harness.controller, orientation)
      const image = { base64, mimeType: "image/jpeg", width: 3, height: 2 }
      const requests = await mockRequests(harness, false, undefined, base64)
      await configure(harness)
      await requestImage(harness.controller, false)
      expect(requests.images).toHaveLength(0)
      await harness.controller.locator("#confirm-action").click()
      await expectFinished(harness.controller, 1)
      await expectPreview(harness.controller, image)
      expect(requests.images).toHaveLength(1)
      expect(requests.model).toHaveLength(2)
      expect(JSON.stringify(requests.model[1])).toContain(base64)
      await expect
        .poll(async () =>
          (await savedSessions(harness.controller)).flatMap((session) => session.messages),
        )
        .toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            toolName: "codex_imagegen",
            isError: false,
            content: expect.arrayContaining([
              { type: "image", mimeType: "image/jpeg", data: base64 },
            ]),
            details: expect.objectContaining({ width: 3, height: 2 }),
          }),
        )

      await harness.controller.reload({ waitUntil: "domcontentloaded" })
      await waitForConversationReady(harness.controller)
      await expectFinished(harness.controller, 1)
      await expectPreview(harness.controller, image)
      expect(requests.images).toHaveLength(1)
      expect(requests.model).toHaveLength(2)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

for (const sameAccount of [false, true]) {
  test(`${sameAccount ? "permits same-account refresh" : "cancels account replacement"} from Settings during image confirmation`, async () => {
    const harness = await launchExtensionHarness()
    try {
      const requests = await mockRequests(harness)
      await configure(harness)
      await requestImage(harness.controller, false)
      const accountId = sameAccount ? ACCOUNT_ID : "replacement-imagegen-account"
      const access = [
        Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
        Buffer.from(
          JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
        ).toString("base64url"),
        Buffer.from("rotated-imagegen-signature").toString("base64url"),
      ].join(".")
      const settings = await harness.context.newPage()
      await settings.goto(`${harness.controller.url()}?view=settings`)
      await settings.evaluate(
        async ({ access, accountId }) => {
          await chrome.storage.local.set({
            piBrowserAgentCredentialsV1: {
              "openai-codex": {
                type: "oauth",
                access,
                accountId,
                refresh: "replacement-imagegen-refresh",
                expires: Date.now() + 3_600_000,
              },
            },
          })
        },
        { access, accountId },
      )
      if (sameAccount) {
        await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
        await harness.controller.locator("#confirm-action").click()
      }
      await expectFinished(harness.controller, 1)
      if (sameAccount) {
        expect(requests.images).toHaveLength(1)
        expect(requests.images[0]?.headers).toMatchObject({
          authorization: `Bearer ${access}`,
          "chatgpt-account-id": ACCOUNT_ID,
        })
        await expectPreview(harness.controller)
      } else {
        expect(requests.images).toHaveLength(0)
        expect(JSON.stringify(requests.model[1])).toContain("cancelled before confirmation")
        await expect(harness.controller.locator("#transcript img.message-image")).toHaveCount(0)
      }
      const count = requests.images.length
      await harness.controller.reload({ waitUntil: "domcontentloaded" })
      await waitForConversationReady(harness.controller)
      await expectFinished(harness.controller, 1)
      expect(requests.images).toHaveLength(count)
      expect(requests.model).toHaveLength(2)
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

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
