import { expect, type Page, test } from "@playwright/test"
import type {
  RegionCaptureState,
  RegionOwner,
  RegionRectangle,
} from "../../src/browser/runtime/region-capture.js"
import type { TabContext } from "../../src/browser/runtime/types.js"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, type CodexRequest, finalTextResponse } from "./support/mock-codex.js"

const HOST = "[data-pi-browser-agent-region-capture]"
const IMAGES = "#pasted-images img"
const REMOVED_UI =
  "#region-selection, #region-x, #region-y, #region-width, #region-height, #region-preview-action, #region-cancel, #region-preview-dialog, #region-preview-image, #region-attach, #region-retake, #region-preview-cancel"
const RECTANGLE = { x: 100, y: 120, width: 200, height: 160 }
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
type RegionRequest = {
  method: string
  params: RegionOwner & { maxBytes?: number; selectionRevision?: number }
  tabContext?: TabContext
}
type Probe = typeof globalThis & {
  regionCaptures?: number
  regionCleanupAttempts?: number
  regionSourceDimensions?: number[]
  regionRequests?: RegionRequest[]
  regionResponses?: { width: number; height: number; keys: string[] }[]
  regionStopResponses?: { ok: boolean; error?: { code: string; message: string } }[]
  regionCleanupTrace?: string[]
  regionEntered?: boolean
  regionSettled?: boolean
  regionReplies?: number
  regionPermissionRequests?: number
  regionPermissionEntered?: boolean
  regionAttachmentAttempts?: number
  regionAttachmentEntered?: boolean
  regionAttachmentSettled?: boolean
  regionPointerId?: number
  regionRepeat?: { isTrusted: boolean; repeat: boolean; sendDisabled: boolean }
  releaseRegion?: () => void
  releaseRegionStart?: () => void
  restoreRegionCleanup?: () => void
  restoreRegionClock?: () => void
}
let harness: ExtensionHarness
let requests: CodexRequest[]

test.beforeEach(async () => {
  harness = await launchExtensionHarness({
    screenshots: !test.info().title.startsWith("screenshot permission"),
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
      // Inspect dimensions only. The full viewport PNG stays in the worker.
      probe.regionSourceDimensions = [view.getUint32(16), view.getUint32(20)]
      return source
    }) as typeof chrome.tabs.captureVisibleTab
  })
  await observeRequests()
})
test.afterEach(async () => {
  await harness?.close()
})

async function observeRequests() {
  await harness.controller.evaluate(() => {
    const probe = globalThis as Probe
    probe.regionRequests = []
    probe.regionResponses = []
    probe.regionStopResponses = []
    probe.regionPermissionRequests = 0
    const requestPermission = chrome.permissions.request.bind(chrome.permissions)
    chrome.permissions.request = (async (permission: chrome.permissions.Permissions) => {
      if (permission.origins?.includes("<all_urls>"))
        probe.regionPermissionRequests = (probe.regionPermissionRequests ?? 0) + 1
      return requestPermission(permission)
    }) as typeof chrome.permissions.request
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: RegionRequest) => {
      if (message.method?.startsWith("regionCapture.")) probe.regionRequests?.push(message)
      const response = await original(message).catch((error) => {
        if (message.method === "regionCapture.stop")
          probe.regionStopResponses?.push({
            ok: false,
            error: { code: "TRANSPORT", message: String(error) },
          })
        throw error
      })
      if (message.method === "regionCapture.stop")
        probe.regionStopResponses?.push({ ok: response.ok, error: response.error })
      if (message.method === "regionCapture.capture" && response.ok)
        probe.regionResponses?.push({
          width: response.result.width,
          height: response.result.height,
          keys: Object.keys(response.result).sort(),
        })
      return response
    }) as typeof chrome.runtime.sendMessage
  })
}
const captures = () => harness.worker.evaluate(() => (globalThis as Probe).regionCaptures)
const regionRequests = (method: string) =>
  harness.controller.evaluate(
    (method) =>
      (globalThis as Probe).regionRequests?.filter((request) => request.method === method) ?? [],
    method,
  )
const permissionRequests = () =>
  harness.controller.evaluate(() => (globalThis as Probe).regionPermissionRequests)

async function grantFixtureChromeHost(origin: string) {
  // Test-profile setup only; this does not establish native permission-UI acceptance.
  const permissions = await harness.context.newPage()
  await permissions.goto("chrome://extensions/")
  await permissions.evaluate(
    async ({ id, origin }) => {
      const api = chrome as unknown as {
        developerPrivate: { addHostPermission(id: string, origin: string): Promise<void> }
      }
      await api.developerPrivate.addHostPermission(id, origin)
    },
    { id: harness.extensionId, origin },
  )
  await permissions.close()
  await harness.fixturePage.bringToFront()
}
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
  await expect(harness.fixturePage.locator(HOST)).toBeFocused()
  await expect(harness.controller.locator("#region-capture")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await expect(harness.controller.locator(REMOVED_UI)).toHaveCount(0)
}
async function dragRegion(rectangle: RegionRectangle = RECTANGLE, reverse = false) {
  const page = harness.fixturePage
  const from = { x: rectangle.x, y: rectangle.y }
  const to = { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height }
  await page.mouse.move(reverse ? to.x : from.x, reverse ? to.y : from.y)
  await page.mouse.down()
  await page.mouse.move(reverse ? from.x : to.x, reverse ? from.y : to.y, { steps: 4 })
  await page.mouse.up()
}
async function attached() {
  await expect(harness.controller.locator(IMAGES)).toHaveCount(1)
  await stopped()
  await expect(harness.controller.locator("#prompt")).toBeFocused()
  await expect(harness.controller.locator(REMOVED_UI)).toHaveCount(0)
}
async function drawRegion(rectangle: RegionRectangle = RECTANGLE, reverse = false) {
  await dragRegion(rectangle, reverse)
  await attached()
}
async function stopped() {
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.controller.locator("#region-capture")).toHaveAttribute(
    "aria-pressed",
    "false",
  )
}
async function cropSource() {
  const source = await harness.controller.locator(IMAGES).getAttribute("src")
  expect(source).toMatch(/^data:image\/png;base64,/)
  return source as string
}
async function surface() {
  const [request] = (await regionRequests("regionCapture.start")).slice(-1)
  if (!request?.tabContext) throw new Error("Missing region startup context")
  const [result] = await harness.worker.evaluate(async (tabId) => {
    return chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: async () => {
        const isolated = globalThis as typeof globalThis & {
          __piBrowserAgentRegionCapture?: {
            token: string
            control: (operation: "state") => Promise<{ result: RegionCaptureState }>
          }
        }
        const owned = isolated.__piBrowserAgentRegionCapture
        if (!owned) return null
        return { token: owned.token, state: (await owned.control("state")).result }
      },
    })
  }, request.tabContext.tabId)
  if (!result?.result) throw new Error("Missing owned region surface")
  return { ...result.result, request }
}
async function notify(request: RegionRequest, token: string, state: RegionCaptureState) {
  if (!request.tabContext) throw new Error("Missing notification context")
  const [result] = await harness.worker.evaluate(
    async ({ tabId, payload }): Promise<chrome.scripting.InjectionResult<{ ok: boolean }>[]> =>
      chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        args: [payload],
        func: (value): Promise<{ ok: boolean }> =>
          chrome.runtime.sendMessage({ kind: "region-capture-state", ...JSON.parse(value) }),
      }),
    {
      tabId: request.tabContext.tabId,
      payload: JSON.stringify({ token, state, tabContext: request.tabContext }),
    },
  )
  return result?.result
}
async function replayCapture(request: RegionRequest, selectionRevision: number) {
  return harness.controller.evaluate(
    (payload): Promise<{ ok: boolean; error?: { code: string } }> =>
      chrome.runtime.sendMessage({ ...JSON.parse(payload), requestId: crypto.randomUUID() }),
    JSON.stringify({
      kind: "request",
      method: "regionCapture.capture",
      params: {
        clientId: request.params.clientId,
        operationId: request.params.operationId,
        maxBytes: 3_000_000,
        selectionRevision,
      },
      tabContext: request.tabContext,
    }),
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
async function gateCaptureReply() {
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
const waitCaptureReply = () =>
  expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionEntered))
    .toBe(true)
async function releaseCaptureReply() {
  await harness.controller.evaluate(() => (globalThis as Probe).releaseRegion?.())
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionSettled))
    .toBe(true)
}
async function gateStartReply() {
  await harness.controller.evaluate(() => {
    const probe = globalThis as Probe
    probe.regionReplies = 0
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: { method?: string }) => {
      if (message.method !== "regionCapture.start") return original(message)
      const response = await original(message)
      await new Promise<void>((resolve) => {
        probe.releaseRegionStart = resolve
      })
      probe.regionReplies = (probe.regionReplies ?? 0) + 1
      return response
    }) as typeof chrome.runtime.sendMessage
  })
}
async function releaseStartReply() {
  await expect
    .poll(() => harness.controller.evaluate(() => !!(globalThis as Probe).releaseRegionStart))
    .toBe(true)
  await harness.controller.evaluate(() => (globalThis as Probe).releaseRegionStart?.())
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionReplies))
    .toBe(1)
}
async function gateNativeCapture() {
  await harness.worker.evaluate(() => {
    const probe = globalThis as Probe
    probe.regionEntered = false
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    const gate = new Promise<void>((resolve) => {
      probe.releaseRegion = resolve
    })
    chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
      chrome.tabs.captureVisibleTab = original
      probe.regionEntered = true
      await gate
      return Reflect.apply(original, chrome.tabs, args)
    }) as typeof chrome.tabs.captureVisibleTab
  })
}
const waitNativeCapture = () =>
  expect.poll(() => harness.worker.evaluate(() => (globalThis as Probe).regionEntered)).toBe(true)
const releaseNativeCapture = () =>
  harness.worker.evaluate(() => (globalThis as Probe).releaseRegion?.())
async function failCleanup() {
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
}
async function failAttachment(hold = false) {
  await harness.controller.evaluate((hold) => {
    const probe = globalThis as Probe
    const original = Blob.prototype.arrayBuffer
    const gate = new Promise<void>((resolve) => {
      probe.releaseRegion = resolve
    })
    probe.regionAttachmentAttempts = 0
    probe.regionAttachmentEntered = false
    probe.regionAttachmentSettled = false
    Blob.prototype.arrayBuffer = async function () {
      if (this.type !== "image/png") return original.call(this)
      probe.regionAttachmentAttempts = (probe.regionAttachmentAttempts ?? 0) + 1
      probe.regionAttachmentEntered = true
      if (hold) await gate
      Blob.prototype.arrayBuffer = original
      try {
        if (!hold) throw new Error("Fixture region attachment failure")
        return await original.call(this)
      } finally {
        probe.regionAttachmentSettled = true
      }
    }
  }, hold)
}
async function pasteImages(count: number, byteLength?: number) {
  await harness.controller.evaluate(
    ({ png, count, byteLength }) => {
      const source = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const bytes = new Uint8Array(byteLength ?? source.length)
      bytes.set(source)
      const clipboard = new DataTransfer()
      for (let i = 0; i < count; i++)
        clipboard.items.add(new File([bytes], `fixture-${i}.png`, { type: "image/png" }))
      document.querySelector("#prompt")?.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      )
    },
    { png: PNG, count, byteLength },
  )
  await expect(harness.controller.locator(IMAGES)).toHaveCount(count)
}
async function setLanguage(page: Page, language: string) {
  await page.evaluate(async (language) => {
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    const settings = stored.piBrowserAgentSettings as Record<string, unknown> | undefined
    await chrome.storage.local.set({ piBrowserAgentSettings: { ...settings, language } })
  }, language)
}

test("trusted reverse drag autoattaches only crop pixels; explicit Send alone shares and persists that crop", async () => {
  await harness.controller
    .locator("#prompt")
    .fill("User explicitly includes outside text; crop is not all context.")
  await start()
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
  await drawRegion(RECTANGLE, true)
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  const crop = await cropSource()
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
  expect(await harness.controller.evaluate(() => (globalThis as Probe).regionResponses)).toEqual([
    {
      width: 200,
      height: 160,
      keys: ["clientId", "dataUrl", "height", "mimeType", "operationId", "width"],
    },
  ])
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#transcript")).toContainText("Cropped image received.")
  expect(requests).toHaveLength(1)
  expect(imageUrls(requests[0])).toEqual([crop])
  expect(JSON.stringify(requests[0])).toContain("User explicitly includes outside text")
  expect(requests[0]?.input.some((item) => item.type === "function_call_output")).toBe(false)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  await harness.controller.reload()
  await waitForConversationReady(harness.controller)
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator('#transcript img[alt="Pasted image"]')).toHaveAttribute(
    "src",
    crop,
  )
  await stopped()
  await harness.controller.locator("#prompt").fill("Follow-up without recapture")
  await harness.controller.locator("#send").click()
  await expect.poll(() => requests.length).toBe(2)
  expect(JSON.stringify(requests[1])).toContain("User explicitly includes outside text")
  expect(imageUrls(requests[1])).toEqual([crop])
  expect(await captures()).toBe(1)
  expect(harness.pageErrors).toEqual([])
})

test("focused page keyboard moves, resizes and precisely adjusts a region; released Enter autoattaches it", async () => {
  await harness.fixturePage.locator("#outside").focus()
  await start()
  const page = harness.fixturePage
  await page.keyboard.down("Enter") // No keyboard selection exists yet.
  await page.keyboard.press("ArrowLeft")
  expect((await surface()).state).toMatchObject({
    rectangle: { x: 0, y: 0, width: 200, height: 150 },
    committedRevision: null,
  })
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight")
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Shift+ArrowDown")
  await page.keyboard.press("Alt+ArrowRight")
  expect((await surface()).state).toMatchObject({
    rectangle: { ...RECTANGLE, x: 101 },
    committedRevision: null,
  })
  await page.keyboard.press("Alt+ArrowLeft")
  await page.keyboard.press("Alt+Shift+ArrowRight")
  expect((await surface()).state).toMatchObject({
    rectangle: { ...RECTANGLE, width: 201 },
    committedRevision: null,
  })
  await page.keyboard.press("Alt+Shift+ArrowLeft")
  expect((await surface()).state).toMatchObject({ rectangle: RECTANGLE, committedRevision: null })
  await expect(page.locator(HOST)).toBeFocused()
  await page.keyboard.down("Enter") // A native repeated Enter cannot confirm the new rectangle.
  await page.keyboard.up("Enter")
  expect((await surface()).state).toMatchObject({ committedRevision: null })
  expect(await captures()).toBe(0)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  await gateNativeCapture()
  await page.keyboard.down("Enter")
  await page.keyboard.down("Enter") // Holding confirmation must not capture or show consent.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }))
  })
  expect((await surface()).state).toMatchObject({ committedRevision: null })
  expect(await captures()).toBe(0)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
  await page.keyboard.up("Enter")
  await waitNativeCapture()
  await releaseNativeCapture()
  await attached()
  expect(await pixels(await cropSource())).toEqual({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
    green: 31_600,
    red: 400,
  })
  expect(await captures()).toBe(1)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(1)
  expect(requests).toHaveLength(0)
  expect(await page.locator("body").getAttribute("data-activated")).toBeNull()
  await harness.controller.locator("#prompt").focus()
  await expect(harness.controller.locator("#send")).toBeEnabled()
  await harness.controller.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>("#send")
    if (!send) throw new Error("Missing Send button")
    // Registered after the application handler: read its synchronous submission guard.
    document.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener(
      "keydown",
      (event) => {
        ;(globalThis as Probe).regionRepeat = {
          isTrusted: event.isTrusted,
          repeat: event.repeat,
          sendDisabled: send.disabled,
        }
      },
      { once: true },
    )
  })
  const input = await harness.context.newCDPSession(harness.controller)
  await input.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    autoRepeat: true,
    text: "\r",
  })
  await input.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  })
  expect(await harness.controller.evaluate(() => (globalThis as Probe).regionRepeat)).toEqual({
    isTrusted: true,
    repeat: true,
    sendDisabled: false,
  })
  expect(requests).toHaveLength(0)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(1)
  await harness.controller.locator("#prompt").press("Enter")
  await expect.poll(() => requests.length).toBe(1)
  expect(imageUrls(requests[0])).toHaveLength(1)
  expect(await captures()).toBe(1)
  await input.detach()
})

test("native icon Enter starts only after release and ignores held-key repeats after cancellation", async () => {
  const icon = harness.controller.locator("#region-capture")
  await icon.focus()
  const input = await harness.context.newCDPSession(harness.controller)
  const enter = (type: "keyDown" | "keyUp", autoRepeat = false) =>
    input.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      autoRepeat,
    })
  await enter("keyDown")
  await enter("keyDown", true)
  await expect(icon).toHaveAttribute("aria-pressed", "false")
  expect(await regionRequests("regionCapture.start")).toHaveLength(0)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await enter("keyUp")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
  await icon.focus()
  await enter("keyDown", true)
  await enter("keyUp")
  await expect(icon).toHaveAttribute("aria-pressed", "false")
  expect(await regionRequests("regionCapture.start")).toHaveLength(1)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await enter("keyDown")
  await enter("keyUp")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await icon.focus()
  await enter("keyDown")
  await harness.controller.keyboard.press("Escape")
  await stopped()
  await enter("keyUp")
  await expect(icon).toHaveAttribute("aria-pressed", "false")
  expect(await regionRequests("regionCapture.start")).toHaveLength(2)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await input.detach()
})

test("held Enter cannot activate the prior page button after Escape or icon cleanup", async () => {
  for (const cancel of ["escape", "icon"]) {
    await harness.fixturePage.locator("#outside").focus()
    await start()
    await harness.fixturePage.keyboard.down("Enter")
    if (cancel === "escape") await harness.fixturePage.keyboard.press("Escape")
    else await harness.controller.locator("#region-capture").click()
    await stopped()
    await harness.fixturePage.keyboard.down("Enter")
    expect(await harness.fixturePage.locator("body").getAttribute("data-activated")).toBeNull()
    expect(
      await harness.fixturePage
        .locator("#outside")
        .evaluate((button) => document.activeElement === button),
    ).toBe(false)
    await harness.fixturePage.keyboard.up("Enter")
    expect(await captures()).toBe(0)
    expect(requests).toHaveLength(0)
  }
})

test("Escape and a native active-icon click cancel bounded keyboard selection without capture", async () => {
  await start()
  const page = harness.fixturePage
  await page.keyboard.press("ArrowLeft")
  for (let i = 0; i < 30; i++) await page.keyboard.press("Shift+ArrowLeft")
  for (let i = 0; i < 20; i++) await page.keyboard.press("Shift+ArrowUp")
  expect((await surface()).state).toMatchObject({
    rectangle: { x: 0, y: 0, width: 8, height: 8 },
    committedRevision: null,
  })
  await page.keyboard.press("Escape")
  await stopped()
  await start()
  await page.keyboard.press("ArrowRight")
  await harness.controller.locator("#region-capture").click()
  await stopped()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
})

test("synthetic pointer and keyboard events cannot edit, commit, cancel, capture or attach", async () => {
  await start()
  const initial = (await surface()).state
  await harness.fixturePage.evaluate((selector) => {
    const host = document.querySelector(selector)
    if (!host) throw new Error("Missing protected host")
    for (const [type, x, y] of [
      ["pointerdown", 100, 120],
      ["pointermove", 300, 280],
      ["pointerup", 300, 280],
    ] as const)
      host.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          isPrimary: true,
          clientX: x,
          clientY: y,
        }),
      )
    for (const key of ["ArrowRight", "ArrowDown", "Enter", "Escape"])
      host.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, repeat: false }),
      )
  }, HOST)
  expect((await surface()).state).toEqual(initial)
  await expect(harness.fixturePage.locator(HOST)).toBeFocused()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  expect(await captures()).toBe(0)
  expect(await permissionRequests()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
})

test("synthetic Enter and pointerup cannot commit genuine keyboard or in-progress pointer selections", async () => {
  await harness.fixturePage.evaluate(() => {
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) (globalThis as Probe).regionPointerId = event.pointerId
      },
      { capture: true },
    )
  })
  await start()
  await harness.fixturePage.keyboard.press("ArrowRight")
  const editing = (await surface()).state
  await harness.fixturePage.evaluate((selector) => {
    document.querySelector(selector)?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        repeat: false,
      }),
    )
  }, HOST)
  expect((await surface()).state).toEqual(editing)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
  await start()
  await harness.fixturePage.mouse.move(100, 120)
  await harness.fixturePage.mouse.down()
  await harness.fixturePage.mouse.move(300, 280, { steps: 4 })
  const dragging = (await surface()).state
  expect(dragging).toMatchObject({ rectangle: RECTANGLE, dragging: true, committedRevision: null })
  await harness.fixturePage.evaluate((selector) => {
    const pointerId = (globalThis as Probe).regionPointerId
    if (pointerId === undefined) throw new Error("Missing trusted pointer ID")
    document.querySelector(selector)?.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: 300,
        clientY: 280,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, HOST)
  expect((await surface()).state).toEqual(dragging)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  await harness.fixturePage.mouse.up()
  await attached()
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
})

test("screenshot permission waits for the trusted release of a held confirmation key", async () => {
  await start()
  await harness.fixturePage.keyboard.press("ArrowRight")
  await harness.fixturePage.keyboard.down("Enter")
  await harness.fixturePage.keyboard.down("Enter")
  expect((await surface()).state).toMatchObject({ committedRevision: null })
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  expect(await permissionRequests()).toBe(0)
  await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
  await harness.fixturePage.keyboard.up("Enter")
  await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
  expect(await captures()).toBe(0)
  expect(await permissionRequests()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.controller.locator('#confirm-dialog button[value="cancel"]').click()
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
})

test("screenshot permission is never requested for forged notification revisions without a genuine commit", async () => {
  await start()
  const live = await surface()
  if (!live.state.active) throw new Error("Missing active state")
  const forged: RegionCaptureState = {
    ...live.state,
    rectangle: RECTANGLE,
    revision: live.state.revision + 1,
    committedRevision: live.state.revision + 1,
  }
  const invalidSender = await harness.controller.evaluate(
    (payload): Promise<{ ok: boolean }> => chrome.runtime.sendMessage(JSON.parse(payload)),
    JSON.stringify({
      kind: "region-capture-state",
      token: live.token,
      tabContext: live.request.tabContext,
      state: forged,
    }),
  )
  expect(invalidSender.ok).toBe(false)
  expect((await notify(live.request, crypto.randomUUID(), forged))?.ok).toBe(false)
  expect((await notify(live.request, live.token, forged))?.ok).toBe(true)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  const rejection = await replayCapture(live.request, forged.committedRevision as number)
  expect(rejection).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
  expect((await surface()).state).toMatchObject({ rectangle: null, committedRevision: null })
  await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(await permissionRequests()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
})

test("an early completed drag survives a delayed startup reply and duplicate notifications attach once", async () => {
  await gateStartReply()
  await start()
  await dragRegion(RECTANGLE, true)
  const live = await surface()
  expect(live.state).toMatchObject({ rectangle: RECTANGLE, dragging: false })
  if (!live.state.active || live.state.committedRevision === null)
    throw new Error("Missing trusted commit")
  expect(live.state.committedRevision).toBe(live.state.revision)
  await notify(live.request, live.token, live.state)
  await notify(live.request, live.token, live.state)
  expect(await captures()).toBe(0)
  await releaseStartReply()
  await attached()
  expect(await captures()).toBe(1)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(1)
  expect(await pixels(await cropSource())).toMatchObject({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
  })
  expect(requests).toHaveLength(0)
})

test("Escape discards an early commit while the startup reply is delayed", async () => {
  await gateStartReply()
  await start()
  await dragRegion()
  await harness.fixturePage.keyboard.press("Escape")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await releaseStartReply()
  await stopped()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
})

test("a repeated committed revision cannot recapture; manual Send retry reuses the accepted image", async () => {
  await harness.controller.locator("#prompt").fill("Keep this crop on failure")
  await start()
  await gateNativeCapture()
  await dragRegion()
  await waitNativeCapture()
  const [capture] = await regionRequests("regionCapture.capture")
  if (!capture?.params.selectionRevision) throw new Error("Missing selection revision")
  const live = await surface()
  await notify(live.request, live.token, live.state)
  expect((await replayCapture(capture, capture.params.selectionRevision)).ok).toBe(false)
  await releaseNativeCapture()
  await attached()
  expect((await replayCapture(capture, capture.params.selectionRevision)).ok).toBe(false)
  expect(await captures()).toBe(1)
  const crop = await cropSource()
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
  await expect(harness.controller.locator(IMAGES)).toHaveAttribute("src", crop)
  expect(requests).toHaveLength(0)
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#transcript")).toContainText("Cropped image received.")
  expect(imageUrls(requests[0])).toEqual([crop])
  expect(requests).toHaveLength(1)
  expect(await captures()).toBe(1)
})

test("failed native capture consumes the commit; forged replay and the icon cannot automatically retry it", async () => {
  await start()
  const originalState = await surface()
  await harness.worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    chrome.tabs.captureVisibleTab = (async () => {
      chrome.tabs.captureVisibleTab = original
      const probe = globalThis as Probe
      probe.regionCaptures = (probe.regionCaptures ?? 0) + 1
      throw new Error("Fixture native capture failure")
    }) as typeof chrome.tabs.captureVisibleTab
  })
  await dragRegion()
  await expect(harness.controller.locator("#error")).not.toBeEmpty()
  await expect
    .poll(async () => (await surface()).state)
    .toMatchObject({ active: true, frozen: false, committedRevision: null })
  const [capture] = await regionRequests("regionCapture.capture")
  if (!capture?.params.selectionRevision) throw new Error("Missing consumed revision")
  expect((await replayCapture(capture, capture.params.selectionRevision)).ok).toBe(false)
  const live = await surface()
  if (!live.state.active) throw new Error("Missing resumed selection")
  await notify(originalState.request, originalState.token, {
    ...live.state,
    revision: capture.params.selectionRevision,
    committedRevision: capture.params.selectionRevision,
  })
  expect(await captures()).toBe(1)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(requests).toHaveLength(0)
  await harness.controller.locator("#region-capture").click()
  await stopped()
  expect(await captures()).toBe(1)
  await start()
  await drawRegion()
  expect(await captures()).toBe(2)
  expect(requests).toHaveLength(0)
})

test("Escape rejects a delayed crop response without attachment or provider dispatch", async () => {
  await start()
  await gateCaptureReply()
  await dragRegion()
  await waitCaptureReply()
  await harness.controller.keyboard.press("Escape")
  await stopped()
  await releaseCaptureReply()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  await expect(harness.controller.locator(REMOVED_UI)).toHaveCount(0)
  expect(requests).toHaveLength(0)
  expect(await captures()).toBe(1)
})

test("failed actual cleanup blocks attachment and Send; only the same icon retries the retained crop once", async () => {
  await harness.controller.locator("#prompt").fill("Do not send before cleanup")
  await start()
  await failCleanup()
  await dragRegion()
  await expect(harness.controller.locator("#error")).toContainText(
    "Could not confirm region cleanup",
  )
  const icon = harness.controller.locator("#region-capture")
  await expect(icon).toHaveAccessibleName("Retry region cleanup")
  await expect(icon).toHaveAttribute("title", /^Retry region cleanup\n.+/)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await expect(harness.controller.locator(REMOVED_UI)).toHaveCount(0)
  await expect
    .poll(() => harness.worker.evaluate(() => (globalThis as Probe).regionCleanupAttempts))
    .toBe(1)
  await icon.click()
  await expect
    .poll(() => harness.worker.evaluate(() => (globalThis as Probe).regionCleanupAttempts))
    .toBe(2)
  await expect(harness.controller.locator("#send")).toBeDisabled()
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  await harness.worker.evaluate(() => (globalThis as Probe).restoreRegionCleanup?.())
  await icon.click()
  await attached()
  await expect(harness.controller.locator("#send")).toBeEnabled()
  expect(await captures()).toBe(1)
  expect(await regionRequests("regionCapture.capture")).toHaveLength(1)
  expect(await pixels(await cropSource())).toMatchObject({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
  })
  expect(requests).toHaveLength(0)
})

test("attachment failure retains one local crop and session guard for explicit same-icon retry", async () => {
  await harness.controller.locator("#prompt").fill("Keep the local attachment draft")
  await start()
  await failAttachment()
  await dragRegion()
  await expect(harness.controller.locator("#error")).toContainText(
    "Fixture region attachment failure",
  )
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  const icon = harness.controller.locator("#region-capture")
  await expect(icon).toHaveAccessibleName("Retry region attachment")
  await expect(icon).toHaveAttribute("title", /^Retry region attachment\n.+/)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await harness.controller.locator("#account-menu-trigger").click()
  await expect(harness.controller.locator("#new-session")).toBeDisabled()
  await expect(harness.controller.locator("#sessions")).toBeDisabled()
  await harness.controller.locator("#account-menu-trigger").click()
  await expect(icon).toHaveAccessibleName("Retry region attachment")
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  await icon.click()
  await attached()
  await expect(harness.controller.locator("#prompt")).toHaveValue("Keep the local attachment draft")
  expect(await captures()).toBe(1)
  expect(await pixels(await cropSource())).toMatchObject({
    width: 200,
    height: 160,
    outside: 0,
    outline: 0,
  })
  expect(
    await harness.controller.evaluate(() => (globalThis as Probe).regionAttachmentAttempts),
  ).toBe(1)
  expect(requests).toHaveLength(0)
})

test("Escape discards a retained attachment failure and rejects attachment that finishes after cancellation", async () => {
  await start()
  await failAttachment()
  await dragRegion()
  await expect(harness.controller.locator("#region-capture")).toHaveAccessibleName(
    "Retry region attachment",
  )
  await harness.controller.keyboard.press("Escape")
  await stopped()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  await start()
  await failAttachment(true)
  await dragRegion()
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionAttachmentEntered))
    .toBe(true)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await harness.controller.keyboard.press("Escape")
  await stopped()
  await harness.controller.evaluate(() => (globalThis as Probe).releaseRegion?.())
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).regionAttachmentSettled))
    .toBe(true)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(2)
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
  })
  await harness.controller.locator("#region-capture").click()
  await expect(harness.controller.locator("#error")).toContainText("Region capture is unavailable")
  await stopped()
  expect(await regionRequests("regionCapture.start")).toHaveLength(0)
  expect(await regionRequests("regionCapture.stop")).toHaveLength(0)
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
  expect(await regionRequests("regionCapture.start")).toHaveLength(0)
  expect(await regionRequests("regionCapture.stop")).toHaveLength(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.controller
    .locator("#prompt")
    .fill("Ordinary chat is not blocked by a nonexistent surface")
  await expect(harness.controller.locator("#send")).toBeEnabled()
  await harness.controller.locator("#account-menu-trigger").click()
  await expect(harness.controller.locator("#new-session")).toBeEnabled()
})

test("screenshot permission denial retains editable selection; revocation discards a frozen pending capture", async () => {
  await start()
  expect(await captures()).toBe(0)
  await dragRegion()
  await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
  expect(await permissionRequests()).toBe(0)
  expect(await captures()).toBe(0)
  await harness.controller.evaluate(() => {
    const original = chrome.permissions.request.bind(chrome.permissions)
    chrome.permissions.request = (async () => {
      chrome.permissions.request = original
      const probe = globalThis as Probe
      probe.regionPermissionRequests = (probe.regionPermissionRequests ?? 0) + 1
      return false
    }) as typeof chrome.permissions.request
  })
  await harness.controller.locator('#confirm-dialog button[value="confirm"]').click()
  await expect(harness.controller.locator("#confirm-dialog")).toContainText(
    "All-sites access is required",
  )
  await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
  expect(await permissionRequests()).toBe(1)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.controller.locator('#confirm-dialog button[value="cancel"]').click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(requests).toHaveLength(0)
  await harness.controller.locator("#region-capture").click()
  await stopped()
  // Grant only the copied test extension's optional host permission, without native UI.
  await grantFixtureChromeHost("<all_urls>")
  expect(
    await harness.controller.evaluate(() =>
      chrome.permissions.request({ origins: ["<all_urls>"] }),
    ),
  ).toBe(true)
  await start()
  await gateCaptureReply()
  await dragRegion()
  await waitCaptureReply()
  await harness.worker.evaluate(() => {
    const probe = globalThis as Probe
    probe.regionCleanupTrace = []
    const send = chrome.tabs.sendMessage.bind(chrome.tabs)
    chrome.tabs.sendMessage = (async (...args: unknown[]) => {
      const stop = (args[1] as { kind?: string })?.kind === "region-capture-stop"
      if (stop) probe.regionCleanupTrace?.push("message:start")
      try {
        const value = await Reflect.apply(send, chrome.tabs, args)
        if (stop) probe.regionCleanupTrace?.push(`message:done:${value?.active}`)
        return value
      } catch (error) {
        if (stop) probe.regionCleanupTrace?.push(`message:error:${String(error)}`)
        throw error
      }
    }) as typeof chrome.tabs.sendMessage
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (async (details: { func?: unknown; args?: unknown[] }) => {
      const stop =
        String(details.func).includes("__piBrowserAgentRegionCapture") &&
        (!details.args?.length ||
          !["start", "state", "freeze", "resume"].includes(String(details.args[0])))
      if (stop) probe.regionCleanupTrace?.push("injection:start")
      try {
        const value = await Reflect.apply(execute, chrome.scripting, [details])
        if (stop) probe.regionCleanupTrace?.push("injection:done")
        return value
      } catch (error) {
        if (stop) probe.regionCleanupTrace?.push(`injection:error:${String(error)}`)
        throw error
      }
    }) as typeof chrome.scripting.executeScript
  })
  expect(
    await harness.controller.evaluate(() => chrome.permissions.remove({ origins: ["<all_urls>"] })),
  ).toBe(true)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await releaseCaptureReply()
  await stopped()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  const cleanup = await harness.worker.evaluate(
    () => (globalThis as Probe).regionCleanupTrace ?? [],
  )
  expect(cleanup).toContain("message:done:false")
  expect(cleanup).not.toContain("injection:start")
  const replies = await harness.controller.evaluate(
    () => (globalThis as Probe).regionStopResponses ?? [],
  )
  expect(replies).toHaveLength(2)
  expect(replies.every((response) => response.ok)).toBe(true)
})

test("language changes wait through selection and capture, then apply to ordinary composer previews", async () => {
  await harness.controller.locator("#prompt").fill("Keep the region draft")
  await start()
  await harness.fixturePage.keyboard.press("ArrowRight")
  await setLanguage(harness.controller, "zh-TW")
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await gateCaptureReply()
  await dragRegion()
  await waitCaptureReply()
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await releaseCaptureReply()
  await attached()
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "zh-TW")
  await expect(harness.controller.locator("#prompt")).toHaveValue("Keep the region draft")
  const crop = await cropSource()
  await setLanguage(harness.controller, "en")
  await expect(harness.controller.locator("html")).toHaveAttribute("lang", "en")
  await expect(harness.controller.locator(IMAGES)).toHaveAttribute("src", crop)
  expect(requests).toHaveLength(0)
})

test("ordinary attached crop survives a tab change; live selection cancels on context and geometry changes", async () => {
  await start()
  await drawRegion()
  const crop = await cropSource()
  const other = await harness.context.newPage()
  await other.goto(harness.fixtureUrl)
  await other.bringToFront()
  await expect(harness.controller.locator(IMAGES)).toHaveAttribute("src", crop)
  await expect(harness.controller.locator("#send")).toBeEnabled()
  await harness.controller.locator(".remove-pasted-image").click()
  await other.close()
  for (const change of ["scroll", "zoom", "reload", "panel", "tab"] as const) {
    await start()
    await harness.fixturePage.keyboard.press("ArrowRight")
    if (change === "scroll") await harness.fixturePage.evaluate(() => scrollTo(0, 50))
    if (change === "zoom")
      await harness.fixturePage.evaluate(() => {
        document.documentElement.style.zoom = "0.9"
      })
    if (change === "reload") await harness.fixturePage.reload()
    if (change === "panel") {
      await harness.controller.reload()
      await waitForConversationReady(harness.controller)
      await observeRequests()
    }
    if (change === "tab") {
      const tab = await harness.context.newPage()
      await tab.goto(harness.fixtureUrl)
      await tab.bringToFront()
      await stopped()
      await tab.close()
    }
    await stopped()
    await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
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
  await harness.fixturePage.keyboard.press("ArrowRight")
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
    await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
    expect(requests).toHaveLength(0)
    await otherPage.close()
    await start()
    await harness.fixturePage.keyboard.press("Escape")
    await stopped()
  } finally {
    await otherPage.close().catch(() => undefined)
    await cdp.detach()
  }
})

test("rejects an already pinch-zoomed viewport; normal browser zoom still autoattaches an inward crop", async () => {
  const cdp = await harness.context.newCDPSession(harness.fixturePage)
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
  expect(await harness.fixturePage.evaluate(() => visualViewport?.scale)).toBe(2)
  await harness.controller.locator("#region-capture").click()
  await expect(harness.controller.locator("#error")).toContainText("Reset page pinch zoom")
  await stopped()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 })
  await harness.controller.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined) throw new Error("Missing zoom target")
    await chrome.tabs.setZoom(tab.id, 1.25)
  })
  await start()
  await drawRegion()
  expect(await pixels(await cropSource())).toMatchObject({
    outside: 0,
    outline: 0,
    width: 250,
    height: 200,
  })
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  await cdp.detach()
})

for (const limit of ["count", "bytes"] as const) {
  test(`composer ${limit} preflight blocks auto-capture before consent or provider access`, async () => {
    await pasteImages(limit === "count" ? 4 : 1, limit === "bytes" ? 3_000_000 : undefined)
    await start()
    await dragRegion()
    await expect(harness.controller.locator("#error")).toContainText(
      limit === "count" ? "Attach up to 4 images" : "Composer images must use 3 MB or less",
    )
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
    await expect(harness.controller.locator(IMAGES)).toHaveCount(limit === "count" ? 4 : 1)
    await expect(harness.controller.locator("#confirm-dialog")).toBeHidden()
    await expect(harness.controller.locator("#auth-method-dialog")).toBeHidden()
    expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
    expect(await captures()).toBe(0)
    expect(await permissionRequests()).toBe(0)
    expect(requests).toHaveLength(0)
    await harness.fixturePage.keyboard.press("Escape")
    await stopped()
  })
}

test("text-only model preflight preserves selection without capture or credential setup", async () => {
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
  await observeRequests()
  await harness.fixturePage.bringToFront()
  await harness.controller.locator("#account-menu-trigger").click()
  await harness.controller.locator("#new-session").click()
  await start()
  await dragRegion()
  await expect(harness.controller.locator("#error")).toContainText("does not support image input")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#auth-method-dialog")).toBeHidden()
  expect(await regionRequests("regionCapture.capture")).toHaveLength(0)
  expect(await captures()).toBe(0)
  expect(await permissionRequests()).toBe(0)
  expect(requests).toHaveLength(0)
})

test("expiry during native capture discards pixels without restoring a capture capability", async () => {
  await start()
  await gateNativeCapture()
  await dragRegion()
  await waitNativeCapture()
  await harness.worker.evaluate(() => {
    const now = Date.now
    ;(globalThis as Probe).restoreRegionClock = () => {
      Date.now = now
    }
    Date.now = () => now() + 300_001
  })
  await releaseNativeCapture()
  await stopped()
  await harness.worker.evaluate(() => (globalThis as Probe).restoreRegionClock?.())
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
})

test("stale notification, owner and cleanup token cannot remove or capture a replacement surface", async () => {
  await start()
  const old = await surface()
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
  await start()
  const current = await surface()
  expect(current.token).not.toBe(old.token)
  expect((await notify(old.request, old.token, old.state))?.ok).toBe(false)
  const stop = await harness.controller.evaluate(
    (payload): Promise<{ ok: boolean; error?: { code: string } }> =>
      chrome.runtime.sendMessage({ ...JSON.parse(payload), requestId: crypto.randomUUID() }),
    JSON.stringify({
      kind: "request",
      method: "regionCapture.stop",
      params: old.request.params,
      tabContext: old.request.tabContext,
    }),
  )
  expect(stop.ok).toBe(false)
  await harness.worker.evaluate(
    async ({ token, tabId }) => {
      await chrome.tabs.sendMessage(tabId, { kind: "region-capture-stop", token }, { frameId: 0 })
    },
    { token: old.token, tabId: current.request.tabContext?.tabId as number },
  )
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  expect((await surface()).token).toBe(current.token)
  expect((await replayCapture(old.request, 1)).ok).toBe(false)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await harness.fixturePage.keyboard.press("Escape")
  await stopped()
})

test("a lost startup reply still cleans the dispatched surface before ordinary Send is enabled", async () => {
  await harness.controller.locator("#prompt").fill("Keep this text after lost startup")
  await harness.controller.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: { method?: string }) => {
      const response = await original(message)
      if (message.method === "regionCapture.start")
        throw new Error("Fixture lost region startup reply")
      return response
    }) as typeof chrome.runtime.sendMessage
  })
  await harness.controller.locator("#region-capture").click()
  await expect(harness.controller.locator("#error")).toContainText(
    "Fixture lost region startup reply",
  )
  await stopped()
  expect(await regionRequests("regionCapture.stop")).toHaveLength(1)
  await expect(harness.controller.locator("#send")).toBeEnabled()
  await expect(harness.controller.locator(IMAGES)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
})

test("drawing and region selection exclude each other in panel and worker without cyclic startup cleanup", async () => {
  const page = harness.controller
  const drawingHost = "[data-pi-browser-agent-page-annotation]"
  await start()
  for (const id of ["page-pen", "element-picker", "voice-input"])
    await expect(page.locator(`#${id}`)).toBeDisabled()
  const drawingOwner = { clientId: crypto.randomUUID(), color: "red", width: 8, tool: "rectangle" }
  const deniedDrawing = await page.evaluate(
    (params) =>
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "pageAnnotation.start",
        params,
      }),
    drawingOwner,
  )
  expect(deniedDrawing.ok).toBe(false)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.fixturePage.locator(drawingHost)).toHaveCount(0)
  await page.locator("#region-capture").click()
  await stopped()
  await page.locator("#page-pen").click()
  await expect(harness.fixturePage.locator(drawingHost)).toHaveCount(1)
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
  await expect(harness.fixturePage.locator(drawingHost)).toHaveCount(1)
  await page.locator("#page-pen").click()
  await expect(page.locator("#page-pen")).toHaveAttribute("aria-pressed", "false")
  const results = await page.evaluate(
    async ({ drawingOwner, regionOwner }) => {
      const request = (method: string, params: object) =>
        chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method,
          params,
        })
      const results = await Promise.all([
        request("pageAnnotation.start", drawingOwner),
        request("regionCapture.start", regionOwner),
      ])
      await request("pageAnnotation.stop", { clientId: drawingOwner.clientId })
      await request("regionCapture.stop", regionOwner)
      return results
    },
    { drawingOwner, regionOwner },
  )
  expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(1)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.fixturePage.locator(drawingHost)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await start()
  await page.locator("#region-capture").click()
  await stopped()
})

test("region selection excludes picker and voice modes without capture", async () => {
  await harness.controller.addInitScript(() => {
    class FixtureRecognition {
      continuous = false
      interimResults = false
      lang = ""
      onresult = null
      onerror = null
      onend: (() => void) | null = null
      start(): void {}
      stop(): void {
        this.onend?.()
      }
      abort(): void {
        this.onend?.()
      }
    }
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    })
    for (const name of ["SpeechRecognition", "webkitSpeechRecognition"])
      Object.defineProperty(globalThis, name, { configurable: true, value: FixtureRecognition })
  })
  const page = harness.controller
  await page.reload()
  await waitForConversationReady(page)
  await harness.fixturePage.bringToFront()
  await page.locator("#element-picker").click()
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(1)
  await expect(page.locator("#region-capture")).toBeDisabled()
  await harness.fixturePage.keyboard.press("Escape")
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(0)
  await page.locator("#voice-input").click()
  await expect(page.locator("#voice-input")).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("#region-capture")).toBeDisabled()
  await page.locator("#voice-input").click()
  await expect(page.locator("#voice-input")).toHaveAttribute("aria-pressed", "false")
  await start()
  await expect(page.locator("#element-picker")).toBeDisabled()
  await expect(page.locator("#voice-input")).toBeDisabled()
  await page.locator("#region-capture").click()
  await stopped()
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
})

test("ships no point-comment or numeric region controls and rejects removed runtime methods", async () => {
  const page = harness.controller
  await expect(page.locator("#point-comments, #point-comment-cards")).toHaveCount(0)
  await expect(page.locator(REMOVED_UI)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Comment on elements", exact: true })).toHaveCount(
    0,
  )
  const responses = await page.evaluate(async () => {
    const clientId = crypto.randomUUID()
    const id = crypto.randomUUID()
    const methods = {
      start: { clientId, capacity: 5, nextNumber: 1 },
      remove: { clientId, id },
      reselect: { clientId, id, number: 1 },
      clear: { clientId },
      stop: { clientId },
    }
    return Promise.all([
      ...Object.entries(methods).map(([method, params]) =>
        chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method: `pointComments.${method}`,
          params,
        }),
      ),
      chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "regionCapture.update",
        params: {
          clientId,
          operationId: crypto.randomUUID(),
          rectangle: { x: 0, y: 0, width: 200, height: 150 },
        },
      }),
    ])
  })
  for (const response of responses)
    expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await start()
  await page.locator("#region-capture").click()
  await stopped()
})

test("compact capture icon and ordinary previews remain reachable at 320/360 px in both themes and forced colors", async () => {
  test.setTimeout(90_000)
  const page = harness.controller
  await start()
  const icon = page.locator("#region-capture")
  await expect(icon).toHaveAccessibleName("Cancel region capture")
  await expect(icon).toHaveAccessibleDescription(
    /Arrow keys move; Shift\+Arrow resizes; Alt uses 1 px/,
  )
  await expect(icon).toHaveAttribute("title", /Enter attaches; Escape cancels/)
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
          await icon.scrollIntoViewIfNeeded()
          await expect(icon).toBeInViewport()
          await expect(icon).toBeEnabled()
          await expect(page.locator(REMOVED_UI)).toHaveCount(0)
        }
      }
    }
  }
  // Test keyboard focus with a native Tab, then cancel from the same control.
  await page.locator("#prompt").focus()
  for (let i = 0; i < 12 && !(await icon.evaluate((node) => document.activeElement === node)); i++)
    await page.keyboard.press("Tab")
  await expect(icon).toBeFocused()
  expect(await icon.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await stopped()
  await harness.fixturePage.bringToFront()
  await start()
  await drawRegion()
  for (const width of [320, 360]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme, forcedColors: "none" })
      for (const selector of [IMAGES, ".remove-pasted-image", "#region-capture", "#send"]) {
        await page.locator(selector).scrollIntoViewIfNeeded()
        await expect(page.locator(selector)).toBeInViewport()
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true)
      await expect(page.locator(REMOVED_UI)).toHaveCount(0)
      await page.screenshot({
        path: test.info().outputPath(`region-${width}-24-${colorScheme}.png`),
      })
    }
  }
  expect(requests).toHaveLength(0)
  expect(await captures()).toBe(1)
})
