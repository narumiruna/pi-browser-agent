import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { launchExtensionHarness } from "./support/extension-harness.js"

// Test-only prototype. This gate runs before production region capture integration.
for (const dpr of [1, 1.5]) {
  for (const modal of [false, true]) {
    for (const edge of [false, true]) {
      // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture parameter.
      test(`protected inward crop: native DPR ${dpr}, modal ${modal}, edges ${edge}`, async ({}, info) => {
        const harness = await launchExtensionHarness({
          screenshots: true,
          browserArgs: [`--force-device-scale-factor=${dpr}`],
        })
        try {
          const page = harness.fixturePage
          const cdp = await harness.context.newCDPSession(page)
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: 1000,
            height: 700,
            deviceScaleFactor: dpr,
            mobile: false,
          })
          const frameUrl = new URL("/region-proof-frame", harness.fixtureUrl)
          frameUrl.hostname = "localhost"
          await harness.context.route("**/region-proof-frame", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<button style="width:300px;height:100px" onclick="document.body.dataset.activated=\'true\'">Harmless target</button>',
            }),
          )
          await page.evaluate(
            ({ modal, url }) => {
              document.body.innerHTML = ""
              document.documentElement.style.zoom = modal ? "0.9" : "1"
              const parent = modal ? document.createElement("dialog") : document.body
              if (parent instanceof HTMLDialogElement) {
                parent.id = "region-proof-modal"
                parent.style.cssText = "width:600px;height:350px;zoom:1.25;background:white"
                document.body.append(parent)
                parent.showModal()
              }
              const frame = document.createElement("iframe")
              frame.src = url
              frame.style.cssText = "width:450px;height:180px"
              parent.append(frame)
            },
            { modal, url: frameUrl.href },
          )
          await expect(page.frameLocator("iframe").locator("button")).toBeVisible()
          const box = await page.frameLocator("iframe").locator("button").boundingBox()
          if (!box) throw new Error("Missing frame target")
          await page.bringToFront()
          const rectangle = edge
            ? { x: 0, y: 0, width: 1000, height: 700 }
            : { x: 100.2, y: 120.4, width: 200.6, height: 160.2 }
          const setup = await harness.worker.evaluate(
            async ({ modal, rectangle }) => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
              if (tab?.id === undefined) throw new Error("Missing proof tab")
              return chrome.scripting.executeScript({
                target: { tabId: tab.id },
                args: [modal, rectangle],
                func: async (
                  modal: boolean,
                  rect: { x: number; y: number; width: number; height: number },
                ) => {
                  const parent = modal
                    ? document.querySelector("dialog:modal")
                    : document.documentElement
                  if (!parent) throw new Error("Missing parent")
                  let zoom = 1
                  for (let node: Element | null = parent; node; node = node.parentElement) {
                    const value = getComputedStyle(node).zoom
                    zoom *= value.endsWith("%")
                      ? Number.parseFloat(value) / 100
                      : Number.parseFloat(value) || 1
                  }
                  // Page pixels: outside magenta; inside green, with a red center sentinel.
                  const backdrop = document.createElement("canvas")
                  backdrop.width = innerWidth * devicePixelRatio
                  backdrop.height = innerHeight * devicePixelRatio
                  backdrop.style.cssText = `position:fixed;inset:0;width:${innerWidth}px;height:${innerHeight}px;zoom:${1 / zoom};pointer-events:none`
                  const pixels = backdrop.getContext("2d")
                  if (!pixels) throw new Error("Missing page raster")
                  pixels.scale(devicePixelRatio, devicePixelRatio)
                  pixels.fillStyle = "#ff00ff"
                  pixels.fillRect(0, 0, innerWidth, innerHeight)
                  pixels.fillStyle = "#00ff00"
                  pixels.fillRect(rect.x, rect.y, rect.width, rect.height)
                  pixels.fillStyle = "#ff0000"
                  pixels.fillRect(
                    rect.x + rect.width / 2 - 10,
                    rect.y + rect.height / 2 - 10,
                    20,
                    20,
                  )
                  // A bounded textured area makes PNG encoding long enough to exercise real input
                  // during the native API interval, instead of relying on a near-empty PNG race.
                  const texture = pixels.createImageData(
                    Math.floor(backdrop.width / 3),
                    Math.floor(backdrop.height / 3),
                  )
                  let seed = 12345
                  for (let i = 0; i < texture.data.length; i += 4) {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
                    texture.data[i] = seed % 80
                    texture.data[i + 1] = 128 + ((seed >>> 8) % 120)
                    texture.data[i + 2] = (seed >>> 16) % 80
                    texture.data[i + 3] = 255
                  }
                  pixels.putImageData(
                    texture,
                    Math.floor((backdrop.width * 2) / 3),
                    Math.floor((backdrop.height * 2) / 3),
                  )
                  parent.append(backdrop)
                  const host = document.createElement("div")
                  host.id = "region-proof-shield"
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
                    outline: "none",
                    "forced-color-adjust": "none",
                    zoom: String(1 / zoom),
                  }))
                    host.style.setProperty(key, value, "important")
                  const shadow = host.attachShadow({ mode: "closed" })
                  const style = document.createElement("style")
                  style.textContent =
                    ":host::backdrop{background:transparent!important;pointer-events:none!important}"
                  const outline = document.createElement("div")
                  outline.style.cssText = `position:absolute;box-sizing:border-box;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:8px solid #0000ff;pointer-events:none`
                  shadow.append(style, outline)
                  parent.append(host)
                  host.showPopover()
                  host.focus({ preventScroll: true })
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
                          const times = JSON.parse(host.dataset.times ?? "[]") as number[]
                          times.push(Date.now())
                          host.dataset.times = JSON.stringify(times)
                        }
                      },
                      { capture: true, passive: false },
                    )
                  }
                  const paint = () =>
                    new Promise<void>((resolve) =>
                      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    )
                  await paint()
                  const visible = getComputedStyle(outline).borderTopColor === "rgb(0, 0, 255)"
                  // Freeze hides only painted selection, never the input shield.
                  outline.style.visibility = "hidden"
                  await paint()
                  return {
                    dpr: devicePixelRatio,
                    width: innerWidth,
                    height: innerHeight,
                    visible,
                    covered: [0.01, 0.5, 0.99].every((x) =>
                      [0.01, 0.5, 0.99].every(
                        (y) => document.elementFromPoint(innerWidth * x, innerHeight * y) === host,
                      ),
                    ),
                    focused: document.activeElement === host,
                  }
                },
              })
            },
            { modal, rectangle },
          )
          expect(setup[0]?.result).toEqual({
            dpr,
            width: 1000,
            height: 700,
            visible: true,
            covered: true,
            focused: true,
          })
          const click = () => page.mouse.click(box.x + 40, box.y + 40)
          await click()
          const [capture] = await Promise.all([
            harness.worker.evaluate(async (rect) => {
              const startedAt = Date.now()
              let source = await chrome.tabs.captureVisibleTab({ format: "png" })
              const finishedAt = Date.now()
              const blob = new Blob(
                [
                  Uint8Array.from(atob(source.slice("data:image/png;base64,".length)), (c) =>
                    c.charCodeAt(0),
                  ),
                ],
                { type: "image/png" },
              )
              source = ""
              const bitmap = await createImageBitmap(blob)
              const x = Math.ceil((rect.x * bitmap.width) / 1000)
              const y = Math.ceil((rect.y * bitmap.height) / 700)
              const right = Math.floor(((rect.x + rect.width) * bitmap.width) / 1000)
              const bottom = Math.floor(((rect.y + rect.height) * bitmap.height) / 700)
              const canvas = new OffscreenCanvas(right - x, bottom - y)
              try {
                const paint = canvas.getContext("2d")
                if (!paint) throw new Error("Missing worker raster")
                paint.drawImage(
                  bitmap,
                  x,
                  y,
                  right - x,
                  bottom - y,
                  0,
                  0,
                  canvas.width,
                  canvas.height,
                )
                const pixels = paint.getImageData(0, 0, canvas.width, canvas.height).data
                let outside = 0
                let outline = 0
                for (let i = 0; i < pixels.length; i += 4) {
                  if (
                    (pixels[i] ?? 0) > 200 &&
                    (pixels[i + 2] ?? 0) > 200 &&
                    (pixels[i + 1] ?? 0) < 100
                  )
                    outside++
                  if (
                    (pixels[i + 2] ?? 0) > 200 &&
                    (pixels[i] ?? 0) < 100 &&
                    (pixels[i + 1] ?? 0) < 100
                  )
                    outline++
                }
                const sample = (x: number, y: number) => [...paint.getImageData(x, y, 1, 1).data]
                const result = await canvas.convertToBlob({ type: "image/png" })
                const bytes = new Uint8Array(await result.arrayBuffer())
                let binary = ""
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
                return {
                  startedAt,
                  finishedAt,
                  sourceWidth: bitmap.width,
                  sourceHeight: bitmap.height,
                  width: canvas.width,
                  height: canvas.height,
                  outside,
                  outline,
                  center: sample(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)),
                  inside: sample(10, 10),
                  crop: btoa(binary),
                }
              } finally {
                bitmap.close()
                canvas.width = canvas.height = 1
              }
            }, rectangle),
            click(),
          ])
          await click()
          const times = JSON.parse(
            (await page.locator("#region-proof-shield").getAttribute("data-times")) ?? "[]",
          ) as number[]
          expect(times).toHaveLength(3)
          expect(times[0]).toBeLessThanOrEqual(capture.startedAt)
          expect(times[1]).toBeGreaterThanOrEqual(capture.startedAt)
          expect(times[1]).toBeLessThanOrEqual(capture.finishedAt)
          expect(times[2]).toBeGreaterThanOrEqual(capture.finishedAt)
          await expect(page.frameLocator("iframe").locator("body")).not.toHaveAttribute(
            "data-activated",
            "true",
          )
          expect(capture.sourceWidth).toBe(1000 * dpr)
          expect(capture.sourceHeight).toBe(700 * dpr)
          expect(capture.width).toBe(
            Math.floor((rectangle.x + rectangle.width) * dpr) - Math.ceil(rectangle.x * dpr),
          )
          expect(capture.height).toBe(
            Math.floor((rectangle.y + rectangle.height) * dpr) - Math.ceil(rectangle.y * dpr),
          )
          expect(capture.outside).toBe(0)
          expect(capture.outline).toBe(0)
          expect(capture.center).toEqual([252, 0, 0, 255])
          expect(capture.inside).toEqual([0, 252, 0, 255])
          await writeFile(info.outputPath("crop.png"), Buffer.from(capture.crop, "base64"))
          console.log(
            `Region proof: Chromium ${harness.context.browser()?.version()}; native DPR ${dpr}; CSS zoom ${modal ? "0.9 × 1.25" : "1"}; viewport edges ${edge}; source ${capture.sourceWidth}×${capture.sourceHeight}; crop ${capture.width}×${capture.height}; outside/outline=0; iframe protected before/during/after.`,
          )
          expect(harness.pageErrors).toEqual([])
        } finally {
          await harness.close()
        }
      })
    }
  }
}
