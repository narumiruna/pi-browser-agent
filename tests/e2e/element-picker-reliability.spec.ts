import { expect, type Page, test } from "@playwright/test"
import { type ExtensionHarness, launchExtensionHarness } from "./support/extension-harness.js"

const HOST = "[data-pi-browser-agent-element-picker]"
let harness: ExtensionHarness

async function startPicker(): Promise<void> {
  await harness.controller.locator("#element-picker").click()
  await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
}

async function clickTarget(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error("Missing target bounds")
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function installModal(withFrame?: "same-origin" | "cross-origin"): Promise<void> {
  const frameUrl = new URL("/picker-frame", harness.fixtureUrl)
  if (withFrame === "cross-origin") frameUrl.hostname = "localhost"
  await harness.context.route("**/picker-frame", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<button id="frame-button" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)">Private iframe text</button>',
    }),
  )
  await harness.fixturePage.evaluate(
    ({ withFrame, frameUrl }) => {
      const modal = document.createElement("dialog")
      modal.id = "picker-modal"
      modal.style.cssText = "width:550px;height:320px;background:white;color:black;padding:20px"
      modal.innerHTML =
        '<button id="modal-button" style="width:150px;height:50px;outline:none;background:#eee;color:#111;border:1px solid black">Modal target</button>'
      modal.querySelector("button")?.addEventListener("click", () => {
        modal.dataset.clicks = "1"
      })
      if (withFrame) {
        const frame = document.createElement("iframe")
        frame.src = frameUrl
        frame.style.cssText = "display:block;width:450px;height:180px"
        modal.append(frame)
      }
      document.body.append(modal)
      modal.showModal()
    },
    { withFrame, frameUrl: frameUrl.href },
  )
  if (withFrame)
    await expect(
      harness.fixturePage.frameLocator("#picker-modal iframe").locator("#frame-button"),
    ).toBeVisible()
}

test.beforeEach(async () => {
  harness = await launchExtensionHarness()
  await harness.fixturePage.evaluate(() => {
    const target = document.createElement("button")
    target.id = "picker-target"
    target.textContent = "Visible picker target"
    target.style.cssText =
      "position:fixed;left:80px;top:120px;width:180px;height:50px;outline:none;background:#eee;color:#111;border:1px solid black"
    target.addEventListener("click", () => {
      target.dataset.clicks = "1"
    })
    document.body.append(target)
  })
})

test.afterEach(async () => {
  const errors = harness?.pageErrors ?? []
  await harness?.close()
  expect(errors).toEqual([])
})

for (const mode of [
  "root zoom",
  "fractional zoom",
  "enlarged zoom",
  "transformed root",
  "important page styles",
] as const) {
  test(`selects safely with ${mode}`, async () => {
    await harness.fixturePage.evaluate((mode) => {
      if (mode === "root zoom") document.documentElement.style.zoom = "0.9"
      if (mode === "fractional zoom") document.documentElement.style.zoom = "0.777"
      if (mode === "enlarged zoom") document.documentElement.style.zoom = "1.25"
      if (mode === "transformed root") {
        document.documentElement.style.transform = "translateZ(0)"
        document.body.style.minHeight = "3000px"
        const target = document.querySelector<HTMLElement>("#picker-target")
        if (!target) throw new Error("Missing picker target")
        target.style.top = "900px"
        window.scrollTo(0, 800)
      }
      if (mode === "important page styles") {
        const style = document.createElement("style")
        style.textContent =
          "div { display: none !important; pointer-events:none !important; transform:translateX(100px) !important }"
        document.head.append(style)
      }
    }, mode)
    const before = await harness.fixturePage.evaluate(() => ({
      html: document.documentElement.getAttribute("style"),
      body: document.body.getAttribute("style"),
      rect: document.querySelector("#picker-target")?.getBoundingClientRect().toJSON(),
    }))
    const box = await harness.fixturePage.locator("#picker-target").boundingBox()
    if (!box) throw new Error("Missing CSS fixture target")
    const clip = { x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 }
    const beforeImage = await harness.fixturePage.screenshot({
      clip,
      path: test.info().outputPath("css-before.png"),
    })
    await startPicker()
    await harness.fixturePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await test.info().attach("css-before", { body: beforeImage, contentType: "image/png" })
    await test.info().attach("css-highlight", {
      body: await harness.fixturePage.screenshot({
        clip,
        path: test.info().outputPath("css-highlight.png"),
      }),
      contentType: "image/png",
    })
    await clickTarget(harness.fixturePage, "#picker-target")
    await expect(harness.controller.locator(".selected-element-chip")).toContainText(
      "button#picker-target",
    )
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(harness.fixturePage.locator("#picker-target")).not.toHaveAttribute(
      "data-clicks",
      "1",
    )
    expect(
      await harness.fixturePage.evaluate(() => ({
        html: document.documentElement.getAttribute("style"),
        body: document.body.getAttribute("style"),
        rect: document.querySelector("#picker-target")?.getBoundingClientRect().toJSON(),
      })),
    ).toEqual(before)
    await expect(harness.controller.locator("#error")).toBeEmpty()
  })
}

test("keeps a zoomed modal protected after viewport resize", async () => {
  await installModal()
  await harness.fixturePage.evaluate(() => {
    document.documentElement.style.zoom = "0.9"
    const modal = document.querySelector<HTMLElement>("#picker-modal")
    if (!modal) throw new Error("Missing modal")
    modal.style.zoom = "1.25"
  })
  await startPicker()
  await harness.fixturePage.setViewportSize({ width: 1000, height: 680 })
  await expect(harness.fixturePage.locator(HOST)).toBeVisible()
  await clickTarget(harness.fixturePage, "#modal-button")
  await expect(harness.controller.locator(".selected-element-chip")).toContainText(
    "button#modal-button",
  )
  await expect(harness.fixturePage.locator("#picker-modal")).not.toHaveAttribute("data-clicks", "1")
})

test("protects a dynamically inserted cross-origin iframe in the existing modal", async () => {
  await installModal()
  await startPicker()
  const url = new URL("/picker-frame", harness.fixtureUrl)
  url.hostname = "localhost"
  await harness.fixturePage.evaluate((url) => {
    const frame = document.createElement("iframe")
    frame.src = url
    document.querySelector("#picker-modal")?.append(frame)
  }, url.href)
  const frame = harness.fixturePage.frameLocator("#picker-modal iframe")
  await expect(frame.locator("#frame-button")).toBeVisible()
  const box = await frame.locator("#frame-button").boundingBox()
  if (!box) throw new Error("Missing dynamic frame")
  await harness.fixturePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(frame.locator("body")).not.toHaveAttribute("data-clicks", "1")
  await expect(harness.controller.locator(".selected-element-chip")).toContainText("iframe")
})

test("background navigation cannot silently cancel the button's permission preflight", async () => {
  const backgroundId = await harness.worker.evaluate(async () => {
    const tab = await chrome.tabs.create({ active: false, url: "about:blank" })
    if (tab.id === undefined) throw new Error("Missing background tab")
    return tab.id
  })
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator("#element-picker")).toBeEnabled()
  await harness.worker.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      pickerGate?: { entered: boolean; release: () => void }
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    state.pickerGate = { entered: false, release }
    const original = chrome.permissions.contains.bind(chrome.permissions)
    chrome.permissions.contains = (async (permissions) => {
      if (permissions.origins?.includes("http://127.0.0.1/*")) {
        chrome.permissions.contains = original
        if (state.pickerGate) state.pickerGate.entered = true
        await gate
      }
      return original(permissions)
    }) as typeof chrome.permissions.contains
  })
  await harness.controller.locator("#element-picker").click()
  await expect
    .poll(() =>
      harness.worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { pickerGate?: { entered: boolean } }).pickerGate
            ?.entered,
      ),
    )
    .toBe(true)
  await harness.worker.evaluate(
    async ({ id, url }) => {
      await new Promise<void>((resolve) => {
        const updated = (tabId: number, info: chrome.tabs.OnUpdatedInfo): void => {
          if (tabId !== id || info.status !== "loading") return
          chrome.tabs.onUpdated.removeListener(updated)
          resolve()
        }
        chrome.tabs.onUpdated.addListener(updated)
        void chrome.tabs.update(id, { url })
      })
    },
    { id: backgroundId, url: `${harness.fixtureUrl}?background=1` },
  )
  await harness.worker.evaluate(() =>
    (
      globalThis as typeof globalThis & { pickerGate?: { release: () => void } }
    ).pickerGate?.release(),
  )
  await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await clickTarget(harness.fixturePage, "#picker-target")
  await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
  await expect(harness.controller.locator("#error")).toBeEmpty()
})

for (const origin of ["same-origin", "cross-origin"] as const) {
  test(`intercepts a ${origin} modal iframe without reading or activating it`, async () => {
    await installModal(origin)
    const frame = harness.fixturePage.frameLocator("#picker-modal iframe")
    const box = await frame.locator("#frame-button").boundingBox()
    if (!box) throw new Error("Missing iframe target")
    await startPicker()
    await harness.fixturePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(frame.locator("body")).not.toHaveAttribute("data-clicks", "1")
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
    await expect(harness.controller.locator(".selected-element-chip")).toContainText("iframe")
    await expect(harness.controller.locator(".selected-element-chip")).not.toContainText(
      "Private iframe text",
    )
    await expect(harness.fixturePage.locator("#picker-modal")).toHaveAttribute("open", "")
  })

  test(`blocks keyboard activation and Escape after ${origin} iframe focus`, async () => {
    await installModal(origin)
    const frame = harness.fixturePage.frameLocator("#picker-modal iframe")
    await frame.locator("#frame-button").focus()
    await startPicker()
    await harness.fixturePage.keyboard.press("Enter")
    await expect(frame.locator("body")).not.toHaveAttribute("data-clicks", "1")
    await harness.fixturePage.keyboard.press("Escape")
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    await expect(harness.fixturePage.locator("#picker-modal")).toHaveAttribute("open", "")
    await expect(harness.controller.locator("#error")).toBeEmpty()
  })

  test(`stops safely when a page moves focus into a ${origin} iframe`, async () => {
    await installModal(origin)
    const frame = harness.fixturePage.frameLocator("#picker-modal iframe")
    await startPicker()
    await frame.locator("#frame-button").focus()
    await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(harness.controller.locator("#error")).toContainText("lost its protection")
    await expect(frame.locator("body")).not.toHaveAttribute("data-clicks", "1")
    await startPicker()
    await harness.fixturePage.keyboard.press("Enter")
    await expect(frame.locator("body")).not.toHaveAttribute("data-clicks", "1")
    await harness.fixturePage.keyboard.press("Escape")
    await expect(harness.controller.locator("#error")).toBeEmpty()
  })
}

test("forced colors preserve first-click OOPIF protection and modal highlighting", async () => {
  await harness.fixturePage.emulateMedia({ forcedColors: "active" })
  await installModal("cross-origin")
  const frame = harness.fixturePage.frameLocator("#picker-modal iframe")
  const frameBox = await frame.locator("#frame-button").boundingBox()
  if (!frameBox) throw new Error("Missing forced-colors iframe target")
  await startPicker()
  // Do not take a screenshot before the first OOPIF click: that would force painting.
  await harness.fixturePage.mouse.click(
    frameBox.x + frameBox.width / 2,
    frameBox.y + frameBox.height / 2,
  )
  await expect(frame.locator("body")).not.toHaveAttribute("data-clicks", "1")
  await expect(harness.controller.locator(".selected-element-chip")).toContainText("iframe")
  await harness.controller.locator(".remove-selected-element").click()
  const box = await harness.fixturePage.locator("#modal-button").boundingBox()
  if (!box) throw new Error("Missing forced-colors modal target")
  const clip = { x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 }
  await harness.fixturePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await startPicker()
  const before = await harness.fixturePage.screenshot({
    clip,
    path: test.info().outputPath("forced-colors-before.png"),
  })
  await harness.fixturePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const after = await harness.fixturePage.screenshot({
    clip,
    path: test.info().outputPath("forced-colors-after.png"),
  })
  expect(after.equals(before)).toBe(false)
  await test
    .info()
    .attach("forced-colors-highlight-before", { body: before, contentType: "image/png" })
  await test
    .info()
    .attach("forced-colors-highlight-after", { body: after, contentType: "image/png" })
  await harness.fixturePage.keyboard.press("Escape")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.fixturePage.locator("#picker-modal")).toHaveAttribute("open", "")
  await expect(harness.controller.locator("#error")).toBeEmpty()
})

test("renders highlight pixels above a modal without changing its state", async () => {
  const testInfo = test.info()
  await installModal()
  const box = await harness.fixturePage.locator("#modal-button").boundingBox()
  if (!box) throw new Error("Missing modal target")
  const clip = { x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 }
  await harness.fixturePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await startPicker()
  // Compare with the same active shield so its background cannot fake a highlight.
  const before = await harness.fixturePage.screenshot({
    clip,
    path: testInfo.outputPath("modal-before.png"),
  })
  await harness.fixturePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const after = await harness.fixturePage.screenshot({
    clip,
    path: testInfo.outputPath("modal-after.png"),
  })
  await testInfo.attach("modal-highlight-before", { body: before, contentType: "image/png" })
  await testInfo.attach("modal-highlight-after", { body: after, contentType: "image/png" })
  expect(after.equals(before)).toBe(false)
  await clickTarget(harness.fixturePage, "#modal-button")
  await expect(harness.controller.locator(".selected-element-chip")).toContainText(
    "button#modal-button",
  )
  await expect(harness.fixturePage.locator("#picker-modal")).not.toHaveAttribute("data-clicks", "1")
  await expect(harness.fixturePage.locator("#picker-modal")).toHaveAttribute("open", "")
})

for (const loss of [
  "detached",
  "closed",
  "tampered",
  "unpainted",
  "new modal",
  "new popover",
] as const) {
  test(`explains protection loss after ${loss} and allows a fresh start`, async () => {
    await startPicker()
    await harness.fixturePage.evaluate((loss) => {
      const host = document.querySelector<HTMLElement>("[data-pi-browser-agent-element-picker]")
      if (!host) throw new Error("Missing picker host")
      if (loss === "detached") host.remove()
      if (loss === "closed") host.hidePopover()
      if (loss === "tampered") host.style.setProperty("pointer-events", "none", "important")
      if (loss === "unpainted") host.style.setProperty("opacity", "0.001", "important")
      if (loss === "new modal") {
        const modal = document.createElement("dialog")
        modal.id = "new-surface"
        modal.innerHTML = "<button>New modal target</button>"
        document.body.append(modal)
        modal.showModal()
      }
      if (loss === "new popover") {
        const popover = document.createElement("div")
        popover.id = "new-surface"
        popover.popover = "auto"
        popover.textContent = "New page popover"
        document.body.append(popover)
        popover.showPopover()
      }
    }, loss)
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    await expect(harness.controller.locator("#error")).toContainText("lost its protection")
    await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(0)
    await startPicker()
    if (loss === "new modal")
      await expect(harness.fixturePage.locator("#new-surface")).toHaveAttribute("open", "")
    if (loss === "new popover")
      expect(
        await harness.fixturePage
          .locator("#new-surface")
          .evaluate((surface) => surface.matches(":popover-open")),
      ).toBe(true)
    await harness.fixturePage.keyboard.press("Escape")
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(harness.controller.locator("#error")).toBeEmpty()
  })
}

test("keeps a selection made while startup is still waiting for paint", async () => {
  await harness.worker.evaluate(() => {
    const original = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (async (injection) => {
      if (!("args" in injection) || injection.args?.[0] !== "start") return original(injection)
      chrome.scripting.executeScript = original
      await original({
        target: injection.target,
        world: "ISOLATED",
        func: () => {
          const state = globalThis as typeof globalThis & {
            __pickerTestRaf?: typeof requestAnimationFrame
          }
          state.__pickerTestRaf = requestAnimationFrame
          globalThis.requestAnimationFrame = () => 0
        },
      })
      try {
        return await original(injection)
      } finally {
        await original({
          target: injection.target,
          world: "ISOLATED",
          func: () => {
            const state = globalThis as typeof globalThis & {
              __pickerTestRaf?: typeof requestAnimationFrame
            }
            if (state.__pickerTestRaf) globalThis.requestAnimationFrame = state.__pickerTestRaf
            delete state.__pickerTestRaf
          },
        })
      }
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#element-picker").click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#element-picker")).toBeDisabled()
  await clickTarget(harness.fixturePage, "#picker-target")
  await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
  await expect(harness.controller.locator(".selected-element-chip")).toContainText(
    "button#picker-target",
  )
  await expect(harness.controller.locator("#element-picker")).toBeEnabled()
  await expect(harness.controller.locator("#error")).toBeEmpty()
})

test("reports setup failure without marking the page inaccessible, then starts on retry", async () => {
  await harness.worker.evaluate(() => {
    const original = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (async (injection) => {
      if ("args" in injection && injection.args?.[0] === "start") {
        chrome.scripting.executeScript = original
        return [
          {
            frameId: 0,
            result: { ok: true, result: { started: false, reason: "overlay-unavailable" } },
          },
        ]
      }
      return original(injection)
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#element-picker").click()
  await expect(harness.controller.locator("#error")).toContainText(
    "Could not protect element selection",
  )
  await expect(harness.controller.locator("#element-picker")).toBeEnabled()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await startPicker()
  await clickTarget(harness.fixturePage, "#picker-target")
  await expect(harness.controller.locator(".selected-element-chip")).toContainText(
    "button#picker-target",
  )
  await expect(harness.controller.locator("#error")).toBeEmpty()
})

for (const replacement of ["successful", "failed"] as const) {
  test(`ignores a failed old start after a newer ${replacement} start`, async () => {
    await harness.controller.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const state = window as typeof window & {
        releaseOldPicker?: () => void
        oldPickerEntered?: boolean
        oldPickerSettled?: boolean
      }
      state.releaseOldPicker = release
      chrome.runtime.sendMessage = (async (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "elementPicker.start"
        ) {
          chrome.runtime.sendMessage = original
          state.oldPickerEntered = true
          await gate
          state.oldPickerSettled = true
          throw new Error("Obsolete picker failure")
        }
        return original(message)
      }) as typeof chrome.runtime.sendMessage
    })
    await harness.controller.locator("#element-picker").click()
    await expect
      .poll(() =>
        harness.controller.evaluate(
          () => (window as typeof window & { oldPickerEntered?: boolean }).oldPickerEntered,
        ),
      )
      .toBe(true)
    await expect(harness.controller.locator("#element-picker")).toBeDisabled()
    await harness.controller.keyboard.press("Escape")
    await expect(harness.controller.locator("#element-picker")).toBeEnabled()
    if (replacement === "failed") {
      await harness.controller.evaluate(() => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime)
        chrome.runtime.sendMessage = (async (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "method" in message &&
            message.method === "elementPicker.start"
          ) {
            chrome.runtime.sendMessage = original
            throw new Error("New picker setup failure")
          }
          return original(message)
        }) as typeof chrome.runtime.sendMessage
      })
      await harness.controller.locator("#element-picker").click()
      await expect(harness.controller.locator("#error")).toContainText("New picker setup failure")
    } else await startPicker()
    await harness.controller.evaluate(() =>
      (window as typeof window & { releaseOldPicker?: () => void }).releaseOldPicker?.(),
    )
    await expect
      .poll(() =>
        harness.controller.evaluate(
          () => (window as typeof window & { oldPickerSettled?: boolean }).oldPickerSettled,
        ),
      )
      .toBe(true)
    if (replacement === "failed") {
      await expect(harness.controller.locator("#error")).toContainText("New picker setup failure")
      await expect(harness.controller.locator("#element-picker")).toBeEnabled()
      await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    } else {
      await expect(harness.controller.locator("#error")).toBeEmpty()
      await expect(harness.controller.locator("#element-picker")).toHaveAttribute(
        "aria-pressed",
        "true",
      )
      await clickTarget(harness.fixturePage, "#picker-target")
      await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
      await expect(harness.controller.locator("#error")).toBeEmpty()
    }
  })
}
