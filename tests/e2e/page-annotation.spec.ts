import { expect, type Page, test } from "@playwright/test"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, type CodexRequest, finalTextResponse } from "./support/mock-codex.js"

const HOST = "[data-pi-browser-agent-page-annotation]"
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII="
type Probe = typeof globalThis & {
  annotationCaptureCount?: number
  annotationCaptureEntered?: boolean
  annotationCaptureSettled?: boolean
  releaseAnnotationCapture?: () => void
  annotationPreparationEntered?: boolean
  annotationPreparationSettled?: boolean
  releaseAnnotationPreparation?: () => void
}

let harness: ExtensionHarness
let requests: CodexRequest[]

test.beforeEach(async () => {
  harness = await launchExtensionHarness({ screenshots: true })
  requests = []
  // No real provider or authentication endpoint is permitted in these scenarios.
  await harness.context.route("https://**/*", (route) => route.abort("blockedbyclient"))
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    requests.push(route.request().postDataJSON() as CodexRequest)
    expect(await harness.fixturePage.locator(HOST).count()).toBe(0)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: finalTextResponse(requests.length, "Annotated viewport received."),
    })
  })
  await configureMockCodex(harness)
  await harness.fixturePage.setViewportSize({ width: 1000, height: 700 })
  await harness.fixturePage.evaluate(() => {
    document.body.style.cssText = "margin:0;background:white;min-height:2400px"
    const target = document.querySelector<HTMLButtonElement>("#complete")
    if (!target) throw new Error("Missing fixture target")
    target.style.cssText = "position:fixed;left:100px;top:100px;width:250px;height:80px"
  })
  await harness.fixturePage.bringToFront()
  await harness.worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    ;(globalThis as Probe).annotationCaptureCount = 0
    chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
      const state = globalThis as Probe
      state.annotationCaptureCount = (state.annotationCaptureCount ?? 0) + 1
      return Reflect.apply(original, chrome.tabs, args)
    }) as typeof chrome.tabs.captureVisibleTab
  })
})

test.afterEach(async () => {
  await harness?.close()
})

async function start(): Promise<void> {
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator("#page-pen")).toBeEnabled()
  await harness.controller.locator("#page-pen").click()
  await expect(harness.fixturePage.locator(HOST))
    .toHaveCount(1)
    .catch(async (error) => {
      console.log(
        "Annotation start diagnostics",
        await harness.controller.locator("#error").textContent(),
        harness.pageErrors,
      )
      throw error
    })
  await expect(harness.controller.locator("#page-pen-width")).toBeEnabled()
  await expect(harness.controller.locator("#page-pen")).toHaveAttribute("aria-pressed", "true")
}

async function stopped(): Promise<void> {
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.controller.locator("#page-pen")).toHaveAttribute("aria-pressed", "false")
  await expect(harness.controller.locator("#page-pen-controls")).toBeHidden()
}

async function stroke(y = 130): Promise<void> {
  const page = harness.fixturePage
  await page.mouse.move(120, y)
  await page.mouse.down()
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await page.mouse.move(300, y, { steps: 10 })
  await page.mouse.up()
  await expect(harness.controller.locator("#page-pen-undo")).toBeEnabled()
  await expect(harness.controller.locator("#send")).toBeEnabled()
}

async function captures(): Promise<number | undefined> {
  return harness.worker.evaluate(() => (globalThis as Probe).annotationCaptureCount)
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

async function complete(): Promise<void> {
  await expect(harness.controller.locator("#transcript")).toContainText(
    "Annotated viewport received.",
  )
  await expect(harness.controller.locator("#run-status")).toHaveText("Ready")
  await stopped()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  await expect(harness.controller.locator("#prompt")).toHaveValue("")
  await expect(harness.controller.locator("#error")).toBeEmpty()
}

async function paste(count = 1): Promise<void> {
  const previous = await harness.controller.locator("#pasted-images img").count()
  await harness.controller.evaluate(
    ({ png, count }) => {
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
      const clipboard = new DataTransfer()
      for (let index = 0; index < count; index++) {
        clipboard.items.add(new File([bytes], `fixture-${index}.png`, { type: "image/png" }))
      }
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
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(previous + count)
  await expect(harness.controller.locator("#send")).toBeEnabled()
}

async function gateCapture(): Promise<void> {
  await harness.controller.evaluate(() => {
    const state = globalThis as Probe
    state.annotationCaptureEntered = false
    state.annotationCaptureSettled = false
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    const gate = new Promise<void>((resolve) => {
      state.releaseAnnotationCapture = resolve
    })
    chrome.runtime.sendMessage = (async (message: { method?: string }) => {
      if (message.method !== "pageAnnotation.capture") return original(message)
      chrome.runtime.sendMessage = original
      const response = await original(message)
      state.annotationCaptureEntered = true
      await gate
      state.annotationCaptureSettled = true
      return response
    }) as typeof chrome.runtime.sendMessage
  })
}

async function waitCapture(): Promise<void> {
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).annotationCaptureEntered))
    .toBe(true)
}

async function releaseCapture(): Promise<void> {
  await harness.controller.evaluate(() => (globalThis as Probe).releaseAnnotationCapture?.())
  await expect
    .poll(() => harness.controller.evaluate(() => (globalThis as Probe).annotationCaptureSettled))
    .toBe(true)
}

test("sends marks alone as one colored PNG, clears the draft, and restores only the sent image", async () => {
  await harness.fixturePage.evaluate(() => {
    document.documentElement.style.zoom = "0.9"
  })
  await start()
  await expect(harness.controller.locator("#send")).toBeDisabled()
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await stroke()
  await harness.controller.locator("#page-pen-color").selectOption("blue")
  await expect(harness.controller.locator("#page-pen-color")).toBeEnabled()
  await stroke(210)
  await harness.fixturePage.mouse.click(180, 140, { button: "right" })
  await harness.fixturePage.mouse.wheel(0, 250)
  expect(await harness.fixturePage.evaluate(() => scrollY)).toBe(0)
  await expect(harness.fixturePage.locator("#result")).toHaveText("idle")
  await harness.controller.locator("#send").click()
  await complete()
  expect(requests).toHaveLength(1)
  expect(await captures()).toBe(1)
  const urls = imageUrls(requests[0])
  expect(urls).toHaveLength(1)
  expect(urls[0]).toMatch(/^data:image\/png;base64,/)
  expect(requests[0]?.input.some((item) => item.type === "function_call_output")).toBe(false)
  await expect(harness.controller.locator("#transcript .toolResult")).toHaveCount(0)
  const pixels = await harness.fixturePage.evaluate(async (source) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const paint = canvas.getContext("2d")
    if (!paint) throw new Error("Missing PNG decoder")
    paint.drawImage(image, 0, 0)
    const sample = (y: number) => [
      ...paint.getImageData((200 * image.width) / 1000, (y * image.height) / 700, 1, 1).data,
    ]
    return { red: sample(130), blue: sample(210) }
  }, urls[0] as string)
  expect(pixels).toEqual({ red: [239, 68, 68, 255], blue: [59, 130, 246, 255] })
  const sentImage = harness.controller.locator('#transcript img[alt="Pasted image"]')
  await expect(sentImage).toHaveCount(1)
  const source = await sentImage.getAttribute("src")
  await harness.controller.reload()
  await waitForConversationReady(harness.controller)
  await harness.fixturePage.bringToFront()
  await expect(sentImage).toHaveAttribute("src", source as string)
  await stopped()
  expect(requests).toHaveLength(1)
  expect(harness.pageErrors).toEqual([])
})

test("sends optional text with exactly one annotated input image", async () => {
  await harness.controller.locator("#prompt").fill("Review the blue mark.")
  await start()
  await harness.controller.locator("#page-pen-color").selectOption("blue")
  await expect(harness.controller.locator("#page-pen-color")).toBeEnabled()
  await stroke()
  await harness.controller.locator("#send").click()
  await complete()
  expect(requests).toHaveLength(1)
  expect(imageUrls(requests[0])).toHaveLength(1)
  expect(JSON.stringify(requests[0]?.input)).toContain("Review the blue mark.")
  expect(await captures()).toBe(1)
})

test("keeps editable marks after a capture API failure and supports undo, clear, and explicit retry", async () => {
  await start()
  await stroke()
  await harness.worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    chrome.tabs.captureVisibleTab = (async () => {
      chrome.tabs.captureVisibleTab = original
      throw new Error("Fixture capture failure")
    }) as typeof chrome.tabs.captureVisibleTab
  })
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#error")).toContainText("Could not capture page drawing")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#page-pen-undo")).toBeEnabled()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  expect(requests).toHaveLength(0)
  await harness.controller.locator("#page-pen-undo").click()
  await expect(harness.controller.locator("#page-pen-clear")).toBeDisabled()
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await stroke(200)
  await harness.controller.locator("#page-pen-clear").click()
  await expect(harness.controller.locator("#page-pen-undo")).toBeDisabled()
  await stroke(240)
  await harness.controller.locator("#send").click()
  await complete()
  expect(requests).toHaveLength(1)
})

test("retains captured drafts after preparation failure or cancellation; retries never recapture", async () => {
  await harness.controller.locator("#prompt").fill("Keep this draft after preparation fails.")
  await start()
  await stroke()
  // Fail the existing public storage API used by run preparation, after capture and cleanup.
  await harness.controller.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = (async (keys: unknown) => {
      if (keys === "piBrowserAgentSkillsV1") {
        chrome.storage.local.get = original
        throw new Error("Fixture run preparation failure")
      }
      return Reflect.apply(original, chrome.storage.local, [keys])
    }) as typeof chrome.storage.local.get
  })
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#error")).toContainText(
    "Fixture run preparation failure",
  )
  await stopped()
  await expect(harness.controller.locator("#prompt")).toHaveValue(
    "Keep this draft after preparation fails.",
  )
  const preview = harness.controller.locator("#pasted-images img")
  await expect(preview).toHaveCount(1)
  const retained = await preview.getAttribute("src")
  expect(await captures()).toBe(1)
  expect(requests).toHaveLength(0)
  await expect(harness.controller.locator(".remove-pasted-image")).toBeEnabled()
  await harness.controller.locator("#send").click()
  await complete()
  expect(requests).toHaveLength(1)
  expect(imageUrls(requests[0])).toEqual([retained])
  expect(await captures()).toBe(1)

  await test.step("Escape while preparation waits after surface cleanup", async () => {
    await harness.controller.locator("#account-menu-trigger").click()
    await harness.controller.locator("#new-session").click()
    await expect(harness.controller.locator("#transcript .message")).toHaveCount(0)
    requests = []
    await harness.controller.locator("#prompt").fill("Keep the cancelled preparation draft.")
    await start()
    await stroke(240)
    await harness.controller.evaluate(() => {
      const state = globalThis as Probe
      const original = chrome.storage.local.get.bind(chrome.storage.local)
      const gate = new Promise<void>((resolve) => {
        state.releaseAnnotationPreparation = resolve
      })
      chrome.storage.local.get = (async (keys: unknown) => {
        if (keys === "piBrowserAgentSkillsV1") {
          chrome.storage.local.get = original
          state.annotationPreparationEntered = true
          await gate
          state.annotationPreparationSettled = true
        }
        return Reflect.apply(original, chrome.storage.local, [keys])
      }) as typeof chrome.storage.local.get
    })
    await harness.controller.locator("#send").click()
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (globalThis as Probe).annotationPreparationEntered),
      )
      .toBe(true)
    await stopped()
    await expect(preview).toHaveCount(1)
    const cancelled = await preview.getAttribute("src")
    expect(await captures()).toBe(2)
    await harness.controller.keyboard.press("Escape")
    await harness.controller.evaluate(() => (globalThis as Probe).releaseAnnotationPreparation?.())
    await expect
      .poll(() =>
        harness.controller.evaluate(() => (globalThis as Probe).annotationPreparationSettled),
      )
      .toBe(true)
    await expect(harness.controller.locator("#send")).toBeEnabled()
    await expect(harness.controller.locator("#run-status")).toHaveText("Ready")
    await expect(preview).toHaveAttribute("src", cancelled as string)
    await expect(harness.controller.locator("#prompt")).toHaveValue(
      "Keep the cancelled preparation draft.",
    )
    expect(requests).toHaveLength(0)
    await harness.controller.locator("#send").click()
    await complete()
    expect(requests).toHaveLength(1)
    expect(imageUrls(requests[0])).toEqual([cancelled])
    expect(await captures()).toBe(2)
  })
})

test("guards duplicate Send and discards a cancelled late capture reply", async () => {
  await start()
  await stroke()
  await gateCapture()
  await harness.controller.locator("#send").click()
  await waitCapture()
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await harness.controller.locator("#send").dispatchEvent("click")
  expect(await captures()).toBe(1)
  await harness.controller.keyboard.press("Escape")
  await stopped()
  await releaseCapture()
  await expect(harness.controller.locator("#send")).toBeEnabled()
  await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
  expect(requests).toHaveLength(0)
  await start()
  await stroke(210)
  await gateCapture()
  await harness.controller.locator("#send").click()
  await waitCapture()
  await harness.controller.locator("#send").dispatchEvent("click")
  await releaseCapture()
  await complete()
  expect(requests).toHaveLength(1)
  expect(imageUrls(requests[0])).toHaveLength(1)
  expect(await captures()).toBe(2)
})

test("cancels safely on toggle, Escape, scroll, zoom, tab change, and panel reload", async () => {
  test.setTimeout(60_000)
  for (const reason of [
    "toggle",
    "page Escape",
    "panel Escape",
    "scroll",
    "zoom",
    "tab",
    "panel reload",
  ] as const) {
    await test.step(reason, async () => {
      await start()
      await stroke()
      if (reason === "toggle") await harness.controller.locator("#page-pen").click()
      if (reason === "page Escape") await harness.fixturePage.keyboard.press("Escape")
      if (reason === "panel Escape") await harness.controller.keyboard.press("Escape")
      if (reason === "scroll") await harness.fixturePage.evaluate(() => scrollTo(0, 100))
      if (reason === "zoom")
        await harness.fixturePage.evaluate(() => {
          document.documentElement.style.zoom = "1.1"
        })
      if (reason === "tab") {
        const other = await harness.context.newPage()
        await other.goto(harness.fixtureUrl)
        await other.bringToFront()
        await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
        await other.close()
        await harness.fixturePage.bringToFront()
      }
      if (reason === "panel reload") {
        await harness.controller.reload()
        await waitForConversationReady(harness.controller)
        await harness.fixturePage.bringToFront()
      }
      await stopped()
      await expect(harness.controller.locator("#pasted-images img")).toHaveCount(0)
      await harness.fixturePage.evaluate(() => {
        document.documentElement.style.zoom = "1"
        scrollTo(0, 0)
      })
      expect(requests).toHaveLength(0)
      expect(await captures()).toBe(0)
    })
  }
})

test("cleans the original drawing after an MV3 worker restart and a window switch", async () => {
  const [otherPage, otherWindow] = await Promise.all([
    harness.context.waitForEvent("page"),
    harness.controller.evaluate(
      (url) => chrome.windows.create({ url, focused: false }),
      harness.fixtureUrl,
    ),
  ])
  await otherPage.waitForLoadState("domcontentloaded")
  const windowId = otherWindow?.id
  if (windowId === undefined) throw new Error("Missing second fixture window")
  await start()
  await stroke()
  const cdp = await harness.context.browser()?.newBrowserCDPSession()
  if (!cdp) throw new Error("Missing browser CDP session")
  try {
    const targets = await cdp.send("Target.getTargets")
    const target = targets.targetInfos.find(
      (target) => target.type === "service_worker" && target.url === harness.worker.url(),
    )
    if (!target) throw new Error("Missing extension worker")
    await cdp.send("Target.closeTarget", { targetId: target.targetId })
    // Focus B before explicitly waking the replacement worker. Cleanup must still target A.
    await harness.controller.evaluate(async (windowId) => {
      await chrome.windows.update(windowId, { focused: true })
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
    await stroke(210)
    await harness.controller.locator("#page-pen-cancel").click()
    await stopped()
  } finally {
    await otherPage.close().catch(() => undefined)
    await cdp.detach()
  }
})

test("keeps picker and voice modes exclusive and checks image capacity before capture", async () => {
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
    Object.defineProperty(globalThis, "SpeechRecognition", {
      configurable: true,
      value: FixtureRecognition,
    })
    Object.defineProperty(globalThis, "webkitSpeechRecognition", {
      configurable: true,
      value: FixtureRecognition,
    })
  })
  await harness.controller.reload()
  await waitForConversationReady(harness.controller)
  await harness.fixturePage.bringToFront()
  await harness.controller.locator("#element-picker").click()
  await expect(harness.fixturePage.locator("[data-pi-browser-agent-element-picker]")).toHaveCount(1)
  await expect(harness.controller.locator("#page-pen")).toBeDisabled()
  await harness.fixturePage.keyboard.press("Escape")
  await harness.controller.locator("#voice-input").click()
  await expect(harness.controller.locator("#voice-input")).toHaveAttribute("aria-pressed", "true")
  await expect(harness.controller.locator("#page-pen")).toBeDisabled()
  await harness.controller.locator("#voice-input").click()
  await expect(harness.controller.locator("#voice-input")).toHaveAttribute("aria-pressed", "false")
  await paste(4)
  await start()
  await expect(harness.controller.locator("#element-picker")).toBeDisabled()
  await expect(harness.controller.locator("#voice-input")).toBeDisabled()
  await stroke()
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#error")).toContainText("Attach up to 4 images")
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await harness.controller.locator(".remove-pasted-image").first().click()
  await harness.controller.locator("#send").click()
  await complete()
  expect(imageUrls(requests[0])).toHaveLength(4)
  expect(await captures()).toBe(1)
})

test("does not offer drawing for a text-only model", async () => {
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
  await expect(harness.controller.locator("#error")).toBeEmpty()
  await expect(harness.controller.locator("#page-pen")).toBeDisabled()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  expect(await captures()).toBe(0)
  expect(requests).toHaveLength(0)
})

async function reachable(page: Page): Promise<void> {
  const controls = page.locator(
    "#page-pen, #page-pen-color, #page-pen-width, #page-pen-undo, #page-pen-clear, #page-pen-cancel, #send",
  )
  for (const control of await controls.all()) {
    await expect(control).toHaveAccessibleName(/\S/)
    await expect(control).toBeVisible()
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport({ ratio: 1 })
    const box = await control.boundingBox()
    if (!box) throw new Error("Missing drawing control geometry")
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1)
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
}

test("records narrow UI evidence with named reachable controls and native palette keyboard operation", async () => {
  test.setTimeout(90_000)
  await start()
  await stroke()
  const page = harness.controller
  for (const width of [320, 360]) {
    for (const fontSize of [12, 24]) {
      for (const colorScheme of ["light", "dark"] as const) {
        for (const forcedColors of ["none", "active"] as const) {
          await test.step(`${width}px / ${fontSize}px / ${colorScheme} / ${forcedColors}`, async () => {
            await page.setViewportSize({ width, height: 900 })
            await page.emulateMedia({ colorScheme, forcedColors, reducedMotion: "reduce" })
            await page.evaluate(
              (size) => document.documentElement.style.setProperty("--app-font-size", `${size}px`),
              fontSize,
            )
            await expect(page.locator("html")).toHaveCSS("font-size", `${fontSize}px`)
            await reachable(page)
            const colors = page.locator("#page-pen-color")
            await colors.focus()
            await expect(colors).toBeFocused()
            await colors.press("Home")
            await expect(colors).toHaveValue("red")
            await expect(colors).toBeEnabled()
            await colors.press("ArrowDown")
            await expect(colors).toHaveValue("yellow")
            await expect(colors).toBeEnabled()
            await colors.press("End")
            await expect(colors).toHaveValue("black")
            await expect(colors).toBeEnabled()
            await expect(colors.locator("option:checked")).toHaveText("Black")
            await expect(colors).toBeFocused()
            await page.screenshot({
              path: test
                .info()
                .outputPath(`pen-${width}-${fontSize}-${colorScheme}-${forcedColors}.png`),
            })
          })
        }
      }
    }
  }
  await page.locator("#prompt").fill("Keep this unsent drawing draft")
  await paste()
  const preview = await page.locator("#pasted-images img").getAttribute("src")
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    const current = stored.piBrowserAgentSettings
    const settings =
      typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}
    await chrome.storage.local.set({
      piBrowserAgentSettings: { ...settings, language: "zh-TW" },
    })
  })
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page.locator("#page-pen")).toHaveAccessibleName("Cancel page drawing")
  await page.locator("#page-pen-cancel").focus()
  await page.keyboard.press("Enter")
  await stopped()
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW")
  await expect(page.locator("#page-pen")).toHaveAccessibleName("在頁面上繪圖")
  await expect(page.locator("#page-pen-color")).toHaveAccessibleName("筆觸顏色")
  await expect(page.locator("#prompt")).toHaveValue("Keep this unsent drawing draft")
  await expect(page.locator("#pasted-images img")).toHaveAttribute("src", preview as string)
  expect(requests).toHaveLength(0)
  expect(await captures()).toBe(0)
})
