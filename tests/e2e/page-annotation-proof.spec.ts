import { expect, test } from "@playwright/test"
import { launchExtensionHarness } from "./support/extension-harness.js"

// Test-only prototype. No production injection or capture implementation is used.
test("captures a protected top-layer canvas at CSS zoom and non-default device scale", async () => {
  const harness = await launchExtensionHarness({
    screenshots: true,
    browserArgs: ["--force-device-scale-factor=1.5"],
  })
  try {
    const page = harness.fixturePage
    const cdp = await harness.context.newCDPSession(page)
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 700,
      deviceScaleFactor: 1.5,
      mobile: false,
    })
    const frameUrl = new URL("/proof-frame", harness.fixtureUrl)
    frameUrl.hostname = "localhost"
    await harness.context.route("**/proof-frame", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button style="width:300px;height:100px;background:white;border:0" onclick="document.body.dataset.clicks=\'activated\'">Harmless frame target</button>',
      }),
    )
    await page.evaluate((url) => {
      document.documentElement.style.zoom = "0.9"
      document.body.innerHTML = ""
      document.body.style.background = "white"
      const style = document.createElement("style")
      style.textContent = "#proof-modal::backdrop { background: transparent }"
      document.head.append(style)
      const dialog = document.createElement("dialog")
      dialog.id = "proof-modal"
      dialog.style.cssText = "width:600px;height:350px;zoom:1.25;background:white"
      const iframe = document.createElement("iframe")
      iframe.src = url
      iframe.style.cssText = "width:450px;height:180px"
      dialog.append(iframe)
      document.body.append(dialog)
      dialog.showModal()
    }, frameUrl.href)
    const target = page.frameLocator("iframe").locator("button")
    await expect(target).toBeVisible()
    const targetBox = await target.boundingBox()
    if (!targetBox) throw new Error("Missing frame target")
    await page.bringToFront()
    const click = () => page.mouse.click(targetBox.x + 40, targetBox.y + 40)
    await click()
    await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
      "data-clicks",
      "activated",
    )
    await page
      .frameLocator("iframe")
      .locator("body")
      .evaluate((body) => {
        delete body.dataset.clicks
      })
    const setup = await harness.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id === undefined) throw new Error("Missing proof tab")
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const parent = document
            .elementFromPoint(innerWidth / 2, innerHeight / 2)
            ?.closest("dialog:modal")
          if (!parent) throw new Error("Missing active modal")
          const host = document.createElement("div")
          host.id = "proof-shield"
          host.popover = "manual"
          host.tabIndex = -1
          for (const [key, value] of Object.entries({
            all: "initial",
            position: "fixed",
            inset: "0",
            margin: "0",
            padding: "0",
            width: "calc(100vw + 1px)",
            height: "calc(100vh + 1px)",
            display: "block",
            "pointer-events": "auto",
            "touch-action": "none",
            "background-color": "rgba(0, 0, 0, 0.01)",
            opacity: "1",
            filter: "none",
            cursor: "crosshair",
            outline: "none",
            "forced-color-adjust": "none",
          }))
            host.style.setProperty(key, value, "important")
          let zoom = 1
          for (let node: Element | null = parent; node; node = node.parentElement) {
            const value = getComputedStyle(node).zoom
            zoom *= value.endsWith("%")
              ? Number.parseFloat(value) / 100
              : Number.parseFloat(value) || 1
          }
          host.style.setProperty("zoom", String(1 / zoom), "important")
          const shadow = host.attachShadow({ mode: "closed" })
          const style = document.createElement("style")
          style.textContent =
            ":host::backdrop { background:transparent!important;pointer-events:none!important }"
          const canvas = document.createElement("canvas")
          canvas.width = innerWidth * devicePixelRatio
          canvas.height = innerHeight * devicePixelRatio
          canvas.style.cssText = `width:${innerWidth}px;height:${innerHeight}px;pointer-events:none`
          shadow.append(style, canvas)
          parent.append(host)
          host.showPopover()
          host.focus({ preventScroll: true })
          const paint = canvas.getContext("2d")
          if (!paint) throw new Error("Missing proof context")
          paint.scale(devicePixelRatio, devicePixelRatio)
          paint.lineWidth = 16
          paint.lineCap = "round"
          paint.strokeStyle = "#ff0000"
          paint.beginPath()
          paint.moveTo(100, 100)
          paint.lineTo(300, 100)
          paint.stroke()
          paint.strokeStyle = "#0000ff"
          paint.beginPath()
          paint.moveTo(100, 160)
          paint.lineTo(300, 160)
          paint.stroke()
          let intercepted = 0
          for (const name of [
            "pointerdown",
            "pointerup",
            "click",
            "contextmenu",
            "keydown",
            "wheel",
          ]) {
            window.addEventListener(
              name,
              (event) => {
                event.preventDefault()
                event.stopImmediatePropagation()
                if (name === "click") {
                  host.dataset.clicks = String(++intercepted)
                  const times = JSON.parse(host.dataset.clickTimes ?? "[]") as number[]
                  times.push(Date.now())
                  host.dataset.clickTimes = JSON.stringify(times)
                }
              },
              { capture: true, passive: false },
            )
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          )
          return {
            dpr: devicePixelRatio,
            covered: [0.05, 0.5, 0.95].every((x) =>
              [0.05, 0.5, 0.95].every(
                (y) => document.elementFromPoint(innerWidth * x, innerHeight * y) === host,
              ),
            ),
            focused: document.activeElement === host,
            canvasOnly: shadow.children.length === 2 && shadow.textContent === style.textContent,
          }
        },
      })
    })
    expect(setup[0]?.result).toEqual({ dpr: 1.5, covered: true, focused: true, canvasOnly: true })
    // Test-only compositor flush. DOM coverage and two rAF callbacks alone do not
    // prove that the OOPIF hit-test frame containing the shield has been committed.
    await page.screenshot()
    await click() // Before capture.
    await expect(page.locator("#proof-shield")).toHaveAttribute("data-clicks", "1")
    const [capture] = await Promise.all([
      harness.worker.evaluate(async () => {
        const startedAt = Date.now()
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" })
        return { dataUrl, startedAt, finishedAt: Date.now() }
      }),
      click(), // Keep the shield mounted and intercepting while capture is pending.
    ])
    await click() // After capture, before any cleanup.
    await expect(page.locator("#proof-shield")).toHaveAttribute("data-clicks", "3")
    const clickTimes = JSON.parse(
      (await page.locator("#proof-shield").getAttribute("data-click-times")) ?? "[]",
    ) as number[]
    expect(clickTimes[0]).toBeLessThanOrEqual(capture.startedAt)
    expect(clickTimes[1]).toBeGreaterThanOrEqual(capture.startedAt)
    expect(clickTimes[1]).toBeLessThanOrEqual(capture.finishedAt)
    expect(clickTimes[2]).toBeGreaterThanOrEqual(capture.finishedAt)
    await expect(page.frameLocator("iframe").locator("body")).not.toHaveAttribute(
      "data-clicks",
      "activated",
    )
    const pixels = await page.evaluate(async (source) => {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.width
      canvas.height = image.height
      const paint = canvas.getContext("2d")
      if (!paint) throw new Error("Missing decoder")
      paint.drawImage(image, 0, 0)
      const sample = (x: number, y: number) => [...paint.getImageData(x * 1.5, y * 1.5, 1, 1).data]
      return {
        width: image.width,
        height: image.height,
        red: sample(200, 100),
        blue: sample(200, 160),
        clear: sample(200, 200),
      }
    }, capture.dataUrl)
    expect(pixels).toEqual({
      width: 1500,
      height: 1050,
      red: [255, 0, 0, 255],
      blue: [0, 0, 255, 255],
      clear: [252, 252, 252, 255],
    })
    console.log(
      `Annotation capture proof: ${harness.context.browser()?.version()}; CSS zoom 0.9 × 1.25; DPR 1.5; red/blue aligned; modal/OOPIF protected before/during/after capture; canvas-only, no toolbar/custom cursor.`,
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
