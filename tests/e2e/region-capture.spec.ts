import { expect, type Page, test } from "@playwright/test"
import type { RegionRectangle } from "../../src/browser/runtime/region-capture.js"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, type CodexRequest, finalTextResponse } from "./support/mock-codex.js"

const HOST = "[data-pi-browser-agent-region-capture]"
type Probe = typeof globalThis & {
  regionCaptures?: number
  regionCleanupAttempts?: number
  regionSourceDimensions?: number[]
  regionEntered?: boolean
  regionSettled?: boolean
  releaseRegion?: () => void
  restoreRegionCleanup?: () => void
  regionMethods?: string[]
  regionPermissionEntered?: boolean
  regionRectangles?: (RegionRectangle | null)[]
  regionReplies?: number
  releaseRegionRequest?: () => void
}
let harness: ExtensionHarness
let requests: CodexRequest[]

test.beforeEach(async () => {
  const nativeDpr = test.info().title.match(/production region DPR ([\d.]+)/)?.[1]
  harness = await launchExtensionHarness({
    screenshots: !test.info().title.startsWith("screenshot permission"),
    browserArgs: nativeDpr ? [`--force-device-scale-factor=${nativeDpr}`] : [],
  })
  requests = []
  await harness.context.route("https://**/*", (route) => route.abort("blockedbyclient"))
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    requests.push(route.request().postDataJSON() as CodexRequest)
    expect(await harness.fixturePage.locator(HOST).count()).toBe(0)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: finalTextResponse(requests.length, "Cropped image received."),
    })
  })
  await configureMockCodex(harness)
  await harness.fixturePage.setViewportSize({ width: 1000, height: 700 })
  await harness.fixturePage.evaluate(() => {
    document.body.innerHTML =
      '<button id="outside" style="position:fixed;left:600px;top:500px" onclick="document.body.dataset.activated=\'true\'">Unrelated outside page text</button>'
    document.body.style.cssText = "margin:0;background:#ff00ff;min-height:2400px"
    const green = document.createElement("div")
    green.style.cssText =
      "position:fixed;left:100px;top:120px;width:200px;height:160px;background:#00ff00"
    const red = document.createElement("div")
    red.style.cssText =
      "position:absolute;left:90px;top:70px;width:20px;height:20px;background:#ff0000"
    green.append(red)
    document.body.append(green)
  })
  await harness.fixturePage.bringToFront()
  await harness.worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    ;(globalThis as Probe).regionCaptures = 0
    chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
      const probe = globalThis as Probe
      probe.regionCaptures = (probe.regionCaptures ?? 0) + 1
      const source = await Reflect.apply(original, chrome.tabs, args)
      const bytes = Uint8Array.from(atob(source.slice("data:image/png;base64,".length)), (c) =>
        c.charCodeAt(0),
      )
      const view = new DataView(bytes.buffer)
      // Retain only dimensions, never the original image outside the worker.
      probe.regionSourceDimensions = [view.getUint32(16), view.getUint32(20)]
      return source
    }) as typeof chrome.tabs.captureVisibleTab
  })
})
test.afterEach(async () => {
  await harness?.close()
})

const captures = () => harness.worker.evaluate(() => (globalThis as Probe).regionCaptures)
function imageUrls(request: CodexRequest | undefined): string[] {
  return (request?.input ?? []).flatMap((item) =>
    Array.isArray(item.content)
      ? item.content.flatMap((part: { type?: string; image_url?: string }) =>
          part.type === "input_image" && part.image_url ? [part.image_url] : [],
        )
      : [],
  )
}
async function start() {
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator("#region-capture")).toBeEnabled()
  await harness.controller.locator("#region-capture").click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#region-x")).toBeEnabled()
  await expect(harness.controller.locator("#send")).toBeDisabled()
}
async function select() {
  const page = harness.fixturePage
  await page.mouse.move(100, 120)
  await page.mouse.down()
  await page.mouse.move(300, 280, { steps: 4 })
  await page.mouse.up()
  await expect(harness.controller.locator("#region-x")).toHaveValue("100")
  await expect(harness.controller.locator("#region-y")).toHaveValue("120")
  await expect(harness.controller.locator("#region-width")).toHaveValue("200")
  await expect(harness.controller.locator("#region-height")).toHaveValue("160")
  await expect(harness.controller.locator("#region-preview-action")).toBeEnabled()
}
async function preview() {
  await harness.controller.locator("#region-preview-action").click()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeVisible()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.controller.locator("#region-attach")).toBeFocused()
}
async function attach() {
  await harness.controller.locator("#region-attach").click()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeHidden()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
  await expect(harness.controller.locator("#prompt")).toBeFocused()
}
async function stopped() {
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.controller.locator("#region-capture")).toHaveAttribute(
    "aria-pressed",
    "false",
  )
}
async function pixels(source: string) {
  return harness.controller.evaluate(async (source) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const paint = canvas.getContext("2d")
    if (!paint) throw new Error("Missing PNG decoder")
    paint.drawImage(image, 0, 0)
    const bytes = paint.getImageData(0, 0, image.width, image.height).data
    let outside = 0
    let outline = 0
    let green = 0
    let red = 0
    for (let i = 0; i < bytes.length; i += 4) {
      if ((bytes[i] ?? 0) > 200 && (bytes[i + 2] ?? 0) > 200) outside++
      if ((bytes[i + 2] ?? 0) > 150 && (bytes[i] ?? 0) < 100) outline++
      if (bytes[i] === 0 && bytes[i + 1] === 252 && bytes[i + 2] === 0) green++
      if (bytes[i] === 252 && bytes[i + 1] === 0 && bytes[i + 2] === 0) red++
    }
    return { width: image.width, height: image.height, outside, outline, green, red }
  }, source)
}
async function gateCapture() {
  await harness.controller.evaluate(() => {
    const probe = globalThis as Probe
    probe.regionEntered = false
    probe.regionSettled = false
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    const gate = new Promise<void>((resolve) => {
      probe.releaseRegion = resolve
    })
    chrome.runtime.sendMessage = (async (message: { method?: string }) => {
      if (message.method !== "regionCapture.capture") return original(message)
      chrome.runtime.sendMessage = original
      const response = await original(message)
      probe.regionEntered = true
      await gate
      probe.regionSettled = true
      return response
    }) as typeof chrome.runtime.sendMessage
  })
}
const waitCapture = () =>
  expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionEntered))
    .toBe(true)
async function releaseCapture() {
  await harness.controller.evaluate(() => (globalThis as Probe).releaseRegion?.())
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionSettled))
    .toBe(true)
}
async function gateRegionRequests(method: "regionCapture.update" | "regionCapture.start") {
  await harness.controller.evaluate((method) => {
    const probe = globalThis as Probe
    probe.regionRectangles = []
    probe.regionReplies = 0
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: {
      method?: string
      params?: { rectangle?: RegionRectangle }
    }) => {
      if (message.method !== method) return original(message)
      // Delay update dispatch, but let start install the real surface before delaying its reply.
      const response = method === "regionCapture.start" ? await original(message) : undefined
      const gate = new Promise<void>((resolve) => {
        probe.releaseRegionRequest = resolve
      })
      probe.regionRectangles?.push(message.params?.rectangle ?? null)
      await gate
      const result = method === "regionCapture.start" ? response : await original(message)
      probe.regionReplies = (probe.regionReplies ?? 0) + 1
      return result
    }) as typeof chrome.runtime.sendMessage
  }, method)
}
const rectangles = () =>
  harness.controller.evaluate(() => (globalThis as Probe).regionRectangles ?? [])
async function releaseRegionRequest(replies: number) {
  await harness.controller.evaluate(() => (globalThis as Probe).releaseRegionRequest?.())
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionReplies))
    .toBe(replies)
}
async function typeNumber(value: string) {
  await harness.controller.keyboard.press("ControlOrMeta+A")
  await harness.controller.keyboard.press("Backspace")
  await harness.controller.keyboard.type(value)
}
async function setLanguage(page: Page, language: string) {
  await page.evaluate(async (language) => {
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    const settings = stored.piBrowserAgentSettings as Record<string, unknown> | undefined
    await chrome.storage.local.set({
      piBrowserAgentSettings: { ...settings, language },
    })
  }, language)
}

test("only exact crop pixels reach one provider request after explicit Send and persist as that same crop", async () => {
  await harness.controller
    .locator("#prompt")
    .fill("User explicitly includes outside text; crop is not all context.")
  await start()
  await select()
  await harness.fixturePage.mouse.click(650, 510)
  await harness.fixturePage.mouse.wheel(0, 250)
  expect(
    await harness.fixturePage.evaluate(() => ({
      activated: document.body.dataset.activated,
      scroll: scrollY,
    })),
  ).toEqual({ activated: undefined, scroll: 0 })
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  // An intercepted click is also a fresh rectangle gesture; select again.
  await select()
  await preview()
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  const local = await harness.controller.locator("#region-preview-image").getAttribute("src")
  expect(local).toMatch(/^blob:/)
  await attach()
  expect(requests).toHaveLength(0)
  const crop = (await harness.controller
    .locator("#pasted-images img")
    .getAttribute("src")) as string
  expect(await pixels(crop)).toEqual({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
    green: 31_600,
    red: 400,
  })
  expect(await harness.worker.evaluate(() => (globalThis as Probe).regionSourceDimensions)).toEqual(
    [1000, 700],
  )
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#transcript")).toContainText("Cropped image received.")
  expect(requests).toHaveLength(1)
  expect(imageUrls(requests[0])).toEqual([crop])
  expect(JSON.stringify(requests[0])).toContain("User explicitly includes outside text")
  expect(requests[0]?.input.some((item) => item.type === "function_call_output")).toBe(false)
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  await harness.controller.reload()
  await waitForConversationReady(harness.controller)
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator('#transcript img[alt="Pasted image"]')).toHaveAttribute(
    "src",
    crop,
  )
  await stopped()
  // A later text-only request resends ordinary history, including the same crop.
  await harness.controller.locator("#prompt").fill("Follow-up without recapture")
  await harness.controller.locator("#send").click()
  await expect.poll(() => requests.length).toBe(2)
  expect(JSON.stringify(requests[1])).toContain("User explicitly includes outside text")
  expect(imageUrls(requests[1])).toEqual([crop])
  expect(await captures()).toBe(1)
  expect(harness.pageErrors).toEqual([])
})

test("numeric-only selection, Cancel, and explicit Retake never submit automatically", async () => {
  await start()
  await expect(harness.controller.locator("#region-x")).toBeFocused()
  for (const [key, value] of [
    ["x", "100"],
    ["y", "120"],
    ["width", "200"],
    ["height", "160"],
  ]) {
    const input = harness.controller.locator(`#region-${key}`)
    await input.fill(value as string)
    await input.press("Tab")
    await expect(input).toBeEnabled()
  }
  expect(await captures()).toBe(0)
  await preview()
  await harness.controller.locator("#region-retake").click()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeHidden()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  expect(await captures()).toBe(1)
  await select()
  await preview()
  expect(await captures()).toBe(2)
  await harness.controller.locator("#region-preview-cancel").click()
  await stopped()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  expect(requests).toHaveLength(0)
})

test("numeric keyboard focus and latest draft survive delayed updates before exact ROI capture", async () => {
  await start()
  await gateRegionRequests("regionCapture.update")
  const page = harness.controller
  const x = page.locator("#region-x")
  const y = page.locator("#region-y")
  const width = page.locator("#region-width")
  const height = page.locator("#region-height")
  const action = page.locator("#region-preview-action")
  await expect(x).toBeFocused()
  await typeNumber("100")
  await page.keyboard.press("Tab")
  await expect.poll(rectangles).toHaveLength(1)
  // This is native Tab, not a focus() call or a synthetic change event.
  await expect(y).toBeFocused()
  for (const field of [x, y, width, height]) await expect(field).toBeEnabled()
  await expect(action).toBeDisabled()
  await typeNumber("120")
  await page.keyboard.press("Tab")
  await expect(width).toBeFocused()
  await typeNumber("210")
  await page.keyboard.press("Tab")
  await expect(height).toBeFocused()
  await typeNumber("160")
  await page.keyboard.press("Shift+Tab")
  await expect(width).toBeFocused()
  await typeNumber("200")
  await height.click()
  await expect(height).toBeFocused()
  await typeNumber("")
  await expect(height).toHaveAttribute("aria-invalid", "true")
  expect(await rectangles()).toHaveLength(1)
  await releaseRegionRequest(1)
  // An old notification and reply must not replace a newer invalid draft.
  await expect(x).toHaveValue("100")
  await expect(y).toHaveValue("120")
  await expect(width).toHaveValue("200")
  await expect(height).toHaveValue("")
  await expect(height).toBeFocused()
  await expect(action).toBeDisabled()
  expect(await rectangles()).toHaveLength(1)
  await typeNumber("160")
  await page.keyboard.press("Shift+Tab")
  await expect(width).toBeFocused()
  await expect.poll(rectangles).toHaveLength(2)
  expect((await rectangles())[1]).toEqual({ x: 100, y: 120, width: 200, height: 160 })
  await expect(action).toBeDisabled()
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await releaseRegionRequest(2)
  await expect(width).toBeFocused()
  await expect(action).toBeEnabled()
  await page.keyboard.press("Shift+Tab")
  await expect(y).toBeFocused()
  for (const next of [width, height, action]) {
    await page.keyboard.press("Tab")
    await expect(next).toBeFocused()
  }
  await page.keyboard.press("Enter")
  await expect(page.locator("#region-preview-dialog")).toBeVisible()
  await attach()
  const crop = (await page.locator("#pasted-images img").getAttribute("src")) as string
  expect(await pixels(crop)).toEqual({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
    green: 31_600,
    red: 400,
  })
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  expect(harness.pageErrors).toEqual([])
})

test("a completed drag before a delayed start reply keeps displayed values equal to captured ROI", async () => {
  await gateRegionRequests("regionCapture.start")
  await harness.controller.locator("#region-capture").click()
  await expect.poll(rectangles).toHaveLength(1)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  const page = harness.fixturePage
  await page.mouse.move(100, 120)
  await page.mouse.down()
  await page.mouse.move(300, 280, { steps: 4 })
  await page.mouse.up()
  await expect(harness.controller.locator("#region-height")).toHaveValue("160")
  await releaseRegionRequest(1)
  for (const [key, value] of [
    ["x", "100"],
    ["y", "120"],
    ["width", "200"],
    ["height", "160"],
  ]) {
    await expect(harness.controller.locator(`#region-${key}`)).toBeEnabled()
    await expect(harness.controller.locator(`#region-${key}`)).toHaveValue(value as string)
  }
  await preview()
  await attach()
  const crop = (await harness.controller
    .locator("#pasted-images img")
    .getAttribute("src")) as string
  expect(await pixels(crop)).toEqual({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
    green: 31_600,
    red: 400,
  })
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
})

test("duplicate Preview/Attach clicks create one capture and one image; manual submission retry reuses it", async () => {
  await harness.controller.locator("#prompt").fill("Keep this crop on failure")
  await start()
  await select()
  await harness.controller.locator("#region-preview-action").evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(harness.controller.locator("#region-preview-dialog")).toBeVisible()
  await harness.controller.locator("#region-attach").evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
  const crop = await harness.controller.locator("#pasted-images img").getAttribute("src")
  await harness.controller.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = (async (keys: unknown) => {
      if (keys === "piBrowserAgentSkillsV1") {
        chrome.storage.local.get = original
        throw new Error("Fixture region preparation failure")
      }
      return Reflect.apply(original, chrome.storage.local, [keys])
    }) as typeof chrome.storage.local.get
  })
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#error")).toContainText(
    "Fixture region preparation failure",
  )
  await expect(harness.controller.locator("#prompt")).toHaveValue("Keep this crop on failure")
  await expect(harness.controller.locator("#pasted-images img")).toHaveAttribute(
    "src",
    crop as string,
  )
  expect(requests).toHaveLength(0)
  expect(await captures()).toBe(1)
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#transcript")).toContainText("Cropped image received.")
  expect(imageUrls(requests[0])).toEqual([crop])
  expect(requests).toHaveLength(1)
  expect(await captures()).toBe(1)
})

test("Escape rejects a delayed capture reply without preview, attachment, or provider call", async () => {
  await start()
  await select()
  await gateCapture()
  await harness.controller.locator("#region-preview-action").click()
  await waitCapture()
  await harness.controller.keyboard.press("Escape")
  await stopped()
  await releaseCapture()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeHidden()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  expect(requests).toHaveLength(0)
  expect(await captures()).toBe(1)
})

test("failed actual surface cleanup blocks Attach and Send until removal is confirmed, without recapture", async () => {
  await start()
  await select()
  await harness.worker.evaluate(() => {
    const script = chrome.scripting.executeScript.bind(chrome.scripting)
    const send = chrome.tabs.sendMessage.bind(chrome.tabs)
    ;(globalThis as Probe).restoreRegionCleanup = () => {
      chrome.scripting.executeScript = script
      chrome.tabs.sendMessage = send
    }
    chrome.scripting.executeScript = (async (options: {
      func?: () => unknown
      args?: unknown[]
    }) => {
      if (
        (options.args?.length ?? 0) <= 1 &&
        options.func?.toString().includes("__piBrowserAgentRegionCapture")
      ) {
        const probe = globalThis as Probe
        probe.regionCleanupAttempts = (probe.regionCleanupAttempts ?? 0) + 1
        throw new Error("Fixture blocked region cleanup")
      }
      return Reflect.apply(script, chrome.scripting, [options])
    }) as typeof chrome.scripting.executeScript
    chrome.tabs.sendMessage = (async (...args: unknown[]) => {
      if ((args[1] as { kind?: string })?.kind === "region-capture-stop")
        throw new Error("Fixture blocked stop acknowledgement")
      return Reflect.apply(send, chrome.tabs, args)
    }) as typeof chrome.tabs.sendMessage
  })
  await harness.controller.locator("#region-preview-action").click()
  await expect(harness.controller.locator("#error")).toContainText(
    "Could not confirm region cleanup",
  )
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#region-preview-dialog")).toBeHidden()
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await expect(harness.controller.locator("#region-attach")).toBeDisabled()
  expect(requests).toHaveLength(0)
  await expect
    .poll(() => harness.worker.evaluate(() => (globalThis as Probe).regionCleanupAttempts))
    .toBe(1)
  await harness.controller.locator("#region-preview-action").click()
  await expect
    .poll(() => harness.worker.evaluate(() => (globalThis as Probe).regionCleanupAttempts))
    .toBe(2)
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeHidden()
  await harness.worker.evaluate(() => (globalThis as Probe).restoreRegionCleanup?.())
  await preview()
  expect(await captures()).toBe(1)
  await attach()
  expect(requests).toHaveLength(0)
})

test("site denial before dispatch and cancellation while permission waits do not create false cleanup blockers", async () => {
  await harness.controller.evaluate(() => {
    const originalContains = chrome.permissions.contains.bind(chrome.permissions)
    chrome.permissions.contains = (async (permission: chrome.permissions.Permissions) =>
      permission.origins?.some((origin) => origin.startsWith("http://127.0.0.1"))
        ? false
        : originalContains(permission)) as typeof chrome.permissions.contains
    chrome.permissions.request = async () => false
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    ;(globalThis as Probe).regionMethods = []
    chrome.runtime.sendMessage = (async (message: { method?: string }) => {
      if (message.method?.startsWith("regionCapture."))
        (globalThis as Probe).regionMethods?.push(message.method)
      return original(message)
    }) as typeof chrome.runtime.sendMessage
  })
  await harness.controller.locator("#region-capture").click()
  await expect(harness.controller.locator("#error")).toContainText("Region capture is unavailable")
  await stopped()
  expect(await harness.controller.evaluate(() => (globalThis as Probe).regionMethods)).toEqual([])
  await harness.controller.evaluate(() => {
    const probe = globalThis as Probe
    chrome.permissions.request = async () => {
      probe.regionPermissionEntered = true
      await new Promise<void>((resolve) => {
        probe.releaseRegion = resolve
      })
      return true
    }
  })
  await harness.controller.locator("#region-capture").click()
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionPermissionEntered))
    .toBe(true)
  await harness.controller.keyboard.press("Escape")
  await harness.controller.evaluate(() => (globalThis as Probe).releaseRegion?.())
  await stopped()
  expect(await harness.controller.evaluate(() => (globalThis as Probe).regionMethods)).toEqual([])
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.controller
    .locator("#prompt")
    .fill("Ordinary chat is not blocked by a nonexistent surface")
  await expect(harness.controller.locator("#send")).toBeEnabled()
  await harness.controller.locator("#account-menu-trigger").click()
  await expect(harness.controller.locator("#new-session")).toBeEnabled()
})

test("screenshot permission denial retains selection and actual revocation removes a frozen pending capture", async () => {
  await start()
  await select()
  await harness.controller.locator("#region-preview-action").click()
  await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
  await harness.controller.locator('#confirm-dialog button[value="cancel"]').click()
  await expect(harness.controller.locator("#region-preview-action")).toBeEnabled()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  expect(await captures()).toBe(0)
  await harness.controller.locator("#region-cancel").click()
  await stopped()
  // Grant only the copied test extension's optional host permission, without native UI.
  const permissions = await harness.context.newPage()
  await permissions.goto("chrome://extensions/")
  await permissions.evaluate(async (id) => {
    const api = chrome as unknown as {
      developerPrivate: { addHostPermission(id: string, origin: string): Promise<void> }
    }
    await api.developerPrivate.addHostPermission(id, "<all_urls>")
  }, harness.extensionId)
  await permissions.close()
  expect(
    await harness.controller.evaluate(() =>
      chrome.permissions.request({ origins: ["<all_urls>"] }),
    ),
  ).toBe(true)
  await start()
  await select()
  await gateCapture()
  await harness.controller.locator("#region-preview-action").click()
  await waitCapture()
  expect(
    await harness.controller.evaluate(() => chrome.permissions.remove({ origins: ["<all_urls>"] })),
  ).toBe(true)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await releaseCapture()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeHidden()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  expect(requests).toHaveLength(0)
})

test("language changes wait through selection, capture, and static preview without changing drafts", async () => {
  await harness.controller.locator("#prompt").fill("Keep the region draft")
  await start()
  await select()
  await setLanguage(harness.controller, "zh-TW")
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await gateCapture()
  await harness.controller.locator("#region-preview-action").click()
  await waitCapture()
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await releaseCapture()
  await expect(harness.controller.locator("#region-preview-dialog")).toBeVisible()
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await harness.controller.locator("#region-preview-cancel").click()
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "zh-TW")
  await expect(harness.controller.locator("#prompt")).toHaveValue("Keep the region draft")
  await setLanguage(harness.controller, "en")
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await start()
  await select()
  await preview()
  await setLanguage(harness.controller, "zh-TW")
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await attach()
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "zh-TW")
  await expect(harness.controller.locator("#prompt")).toHaveValue("Keep the region draft")
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(1)
  expect(requests).toHaveLength(0)
})

test("static preview survives a tab change; selection cancels on scroll, zoom, reload and panel replacement", async () => {
  await start()
  await select()
  await preview()
  const other = await harness.context.newPage()
  await other.goto(harness.fixtureUrl)
  await other.bringToFront()
  await expect(harness.controller.locator("#region-attach")).toBeEnabled()
  await attach()
  await harness.controller.locator(".remove-pasted-image").click()
  await other.close()
  for (const change of ["scroll", "zoom", "reload", "panel"] as const) {
    await start()
    await select()
    if (change === "scroll") await harness.fixturePage.evaluate(() => scrollTo(0, 50))
    if (change === "zoom")
      await harness.fixturePage.evaluate(() => {
        document.documentElement.style.zoom = "0.9"
      })
    if (change === "reload") await harness.fixturePage.reload()
    if (change === "panel") {
      await harness.controller.reload()
      await waitForConversationReady(harness.controller)
    }
    await stopped()
    await harness.fixturePage.evaluate(() => {
      document.documentElement.style.zoom = "1"
      scrollTo(0, 0)
    })
  }
  expect(requests).toHaveLength(0)
  expect(await captures()).toBe(1)
})

test("cleans the original region after actual MV3 restart and window change without restoring capability", async () => {
  const [otherPage, otherWindow] = await Promise.all([
    harness.context.waitForEvent("page"),
    harness.controller.evaluate(
      (url) => chrome.windows.create({ url, focused: false }),
      harness.fixtureUrl,
    ),
  ])
  await otherPage.waitForLoadState("domcontentloaded")
  const windowId = otherWindow?.id
  if (windowId === undefined) throw new Error("Missing second window")
  await start()
  await select()
  const cdp = await harness.context.browser()?.newBrowserCDPSession()
  if (!cdp) throw new Error("Missing browser CDP session")
  try {
    const { targetInfos } = await cdp.send("Target.getTargets")
    const target = targetInfos.find(
      (target) => target.type === "service_worker" && target.url === harness.worker.url(),
    )
    if (!target) throw new Error("Missing worker")
    await cdp.send("Target.closeTarget", { targetId: target.targetId })
    await harness.controller.evaluate(async (id) => {
      await chrome.windows.update(id, { focused: true })
      await chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "app.getState",
        params: {},
      })
    }, windowId)
    await stopped()
    await expect(otherPage.locator(HOST)).toHaveCount(0)
    await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
    expect(requests).toHaveLength(0)
    await otherPage.close()
    await start()
    await select()
    await harness.controller.locator("#region-cancel").click()
    await stopped()
  } finally {
    await otherPage.close().catch(() => undefined)
    await cdp.detach()
  }
})

test("rejects an already pinch-zoomed visual viewport before any capture or attachment", async () => {
  const cdp = await harness.context.newCDPSession(harness.fixturePage)
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
  expect(await harness.fixturePage.evaluate(() => visualViewport?.scale)).toBe(2)
  // The fixture retains its outside magenta sentinel; no ambiguous crop may leave the worker.
  await harness.controller.locator("#region-capture").click()
  await expect(harness.controller.locator("#error")).toContainText("Reset page pinch zoom")
  await stopped()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 })
  await harness.controller.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined) throw new Error("Missing zoom target")
    await chrome.tabs.setZoom(tab.id, 1.25)
  })
  await start()
  await select()
  await preview()
  await attach()
  const source = (await harness.controller
    .locator("#pasted-images img")
    .getAttribute("src")) as string
  expect(await pixels(source)).toMatchObject({ outside: 0, outline: 0, width: 250, height: 200 })
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  await cdp.detach()
})

for (const dpr of [1, 1.5]) {
  test(`production region DPR ${dpr} crops fractional modal/zoom pixels inward without outline`, async () => {
    const cdp = await harness.context.newCDPSession(harness.fixturePage)
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 700,
      deviceScaleFactor: dpr,
      mobile: false,
    })
    const rectangle = { x: 100.2, y: 120.4, width: 200.6, height: 160.2 }
    await harness.fixturePage.evaluate(
      ({ rectangle, dpr }) => {
        document.body.innerHTML = ""
        document.documentElement.style.zoom = "0.9"
        const modal = document.createElement("dialog")
        modal.style.cssText = "width:600px;height:350px;zoom:1.25;background:white"
        document.body.append(modal)
        modal.showModal()
        const canvas = document.createElement("canvas")
        canvas.width = 1000 * dpr
        canvas.height = 700 * dpr
        canvas.style.cssText = `position:fixed;inset:0;width:1000px;height:700px;zoom:${1 / (0.9 * 1.25)};pointer-events:none`
        const paint = canvas.getContext("2d")
        if (!paint) throw new Error("Missing fixture raster")
        paint.scale(dpr, dpr)
        paint.fillStyle = "#ff00ff"
        paint.fillRect(0, 0, 1000, 700)
        paint.fillStyle = "#00ff00"
        paint.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
        paint.fillStyle = "#ff0000"
        paint.fillRect(190, 190, 20, 20)
        modal.append(canvas)
      },
      { rectangle, dpr },
    )
    expect(await harness.fixturePage.evaluate(() => devicePixelRatio)).toBe(dpr)
    await start()
    for (const [key, value] of Object.entries(rectangle)) {
      const field = harness.controller.locator(`#region-${key}`)
      await field.fill(String(value))
      await field.press("Tab")
      await expect(field).toBeEnabled()
    }
    await preview()
    await attach()
    const source = (await harness.controller
      .locator("#pasted-images img")
      .getAttribute("src")) as string
    const sample = await pixels(source)
    expect(sample).toMatchObject({
      width: dpr === 1 ? 199 : 300,
      height: dpr === 1 ? 159 : 239,
      outside: 0,
      outline: 0,
    })
    expect(sample.red).toBeGreaterThanOrEqual(400)
    expect(
      await harness.worker.evaluate(() => (globalThis as Probe).regionSourceDimensions),
    ).toEqual([1000 * dpr, 700 * dpr])
    expect(requests).toHaveLength(0)
    expect(await captures()).toBe(1)
    await cdp.detach()
  })
}

test("capacity and text-only model preflight preserve selection without capture or credential setup", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
  await harness.controller.evaluate((png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
    const clipboard = new DataTransfer()
    for (let i = 0; i < 4; i++)
      clipboard.items.add(new File([bytes], `fixture-${i}.png`, { type: "image/png" }))
    document
      .querySelector("#prompt")
      ?.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      )
  }, png)
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(4)
  await start()
  await select()
  await harness.controller.locator("#region-preview-action").click()
  await expect(harness.controller.locator("#error")).toContainText("Attach up to 4 images")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  expect(await captures()).toBe(0)
  await harness.controller.locator("#region-cancel").click()
  await stopped()
  await harness.controller.evaluate(async () => {
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    await chrome.storage.local.set({
      piBrowserAgentSettings: {
        ...(stored.piBrowserAgentSettings as Record<string, unknown> | undefined),
        modelProvider: "deepseek",
        modelId: "deepseek-v4-pro",
      },
    })
  })
  await harness.controller.reload()
  await waitForConversationReady(harness.controller)
  await harness.fixturePage.bringToFront()
  await harness.controller.locator("#account-menu-trigger").click()
  await harness.controller.locator("#new-session").click()
  await start()
  await select()
  await harness.controller.locator("#region-preview-action").click()
  await expect(harness.controller.locator("#error")).toContainText("does not support image input")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#auth-method-dialog")).toBeHidden()
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
})

test("point comments and region selection exclude each other in panel and worker without cyclic startup cleanup", async () => {
  const page = harness.controller
  await start()
  await expect(page.locator("#point-comments")).toBeDisabled()
  const pinOwner = { clientId: crypto.randomUUID(), capacity: 5, nextNumber: 1 }
  const deniedPin = await page.evaluate(
    (params) =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "pointComments.start",
        params,
      }),
    pinOwner,
  )
  expect(deniedPin.ok).toBe(false)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await page.locator("#region-cancel").click()
  await stopped()
  await page.locator("#point-comments").click()
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(1)
  await expect(page.locator("#region-capture")).toBeDisabled()
  const regionOwner = { clientId: crypto.randomUUID(), operationId: crypto.randomUUID() }
  const deniedRegion = await page.evaluate(
    (params) =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "regionCapture.start",
        params,
      }),
    regionOwner,
  )
  expect(deniedRegion.ok).toBe(false)
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(1)
  await page.locator("#point-comments").click()
  await expect(page.locator("#point-comments")).toHaveAttribute("aria-pressed", "false")
  const results = await page.evaluate(
    async ({ pinOwner, regionOwner }) => {
      const request = (method: string, params: object) =>
        chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method,
          params,
        })
      const results = await Promise.all([
        request("pointComments.start", pinOwner),
        request("regionCapture.start", regionOwner),
      ])
      await request("pointComments.stop", { clientId: pinOwner.clientId })
      await request("regionCapture.stop", regionOwner)
      return results
    },
    { pinOwner, regionOwner },
  )
  expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(1)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await start()
  await page.locator("#region-cancel").click()
  await stopped()
})

test("records reachable numeric selection and preview at 320/360 px, both themes, large text and forced colors", async () => {
  test.setTimeout(90_000)
  await start()
  await select()
  const page = harness.controller
  await expect(page.locator("#region-x")).toHaveAccessibleName("X")
  await expect(page.locator("#region-width")).toHaveAccessibleName("Width")
  await expect(page.locator("#element-picker")).toBeDisabled()
  await expect(page.locator("#page-pen")).toBeDisabled()
  await expect(page.locator("#voice-input")).toBeDisabled()
  for (const width of [320, 360]) {
    for (const fontSize of [12, 24]) {
      for (const colorScheme of ["light", "dark"] as const) {
        for (const forcedColors of ["none", "active"] as const) {
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme, forcedColors })
          await page.evaluate(
            (size) => document.documentElement.style.setProperty("--app-font-size", `${size}px`),
            fontSize,
          )
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true)
          for (const id of [
            "region-x",
            "region-y",
            "region-width",
            "region-height",
            "region-preview-action",
            "region-cancel",
          ]) {
            await page.locator(`#${id}`).scrollIntoViewIfNeeded()
            await expect(page.locator(`#${id}`)).toBeInViewport()
          }
        }
      }
    }
  }
  await preview()
  for (const width of [320, 360]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme, forcedColors: "none" })
      for (const id of ["region-attach", "region-retake", "region-preview-cancel"]) {
        await page.locator(`#${id}`).scrollIntoViewIfNeeded()
        await expect(page.locator(`#${id}`)).toBeInViewport()
      }
      expect(
        await page
          .locator("#region-preview-dialog")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true)
      await page.screenshot({
        path: test.info().outputPath(`region-${width}-24-${colorScheme}.png`),
      })
    }
  }
  await page.locator("#region-attach").press("Tab")
  await expect(page.locator("#region-retake")).toBeFocused()
  await page.keyboard.press("Escape")
  await stopped()
  expect(requests).toHaveLength(0)
})
