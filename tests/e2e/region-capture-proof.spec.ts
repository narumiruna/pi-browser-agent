import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import type { RegionCaptureState } from "../../src/browser/runtime/region-capture.js"
import {
  configureMockCodex,
  launchExtensionHarness,
  waitForConversationReady,
} from "./support/extension-harness.js"

const HOST = "[data-pi-browser-agent-region-capture]"
const IMAGES = "#pasted-images img"
type Proof = typeof globalThis & {
  regionNativeCalls?: number
  regionNativeEntered?: boolean
  regionNativeStartedAt?: number
  regionNativeFinishedAt?: number
  regionSourceDimensions?: number[]
  regionCleanupEntered?: boolean
  regionHoldCleanup?: boolean
  regionReleaseNative?: () => void
  regionReleaseCleanup?: () => void
  regionProofClicks?: number[]
}

// Exercise the production surface, worker crop, and ordinary attachment boundary with real Chrome pixels.
for (const dpr of [1, 1.5]) {
  for (const modal of [false, true]) {
    for (const edge of [false, true]) {
      // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture parameter.
      test(`production inward crop: native DPR ${dpr}, modal ${modal}, edges ${edge}`, async ({}, info) => {
        test.setTimeout(60_000)
        const harness = await launchExtensionHarness({
          screenshots: true,
          browserArgs: [`--force-device-scale-factor=${dpr}`],
        })
        try {
          let providerRequests = 0
          await harness.context.route("https://**/*", (route) => {
            providerRequests++
            return route.abort("blockedbyclient")
          })
          await configureMockCodex(harness)
          const page = harness.fixturePage
          const panel = harness.controller
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
          const rectangle = edge
            ? { x: 0, y: 0, width: 1000, height: 700 }
            : { x: 100.2, y: 120.4, width: 200.6, height: 160.2 }
          await page.evaluate(
            ({ modal, url, rect }) => {
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
              let zoom = 1
              for (let node: Element | null = parent; node; node = node.parentElement) {
                const value = getComputedStyle(node).zoom
                zoom *= value.endsWith("%")
                  ? Number.parseFloat(value) / 100
                  : Number.parseFloat(value) || 1
              }
              // Outside magenta must never enter the inward-rounded green crop.
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
              pixels.fillRect(rect.x + rect.width / 2 - 10, rect.y + rect.height / 2 - 10, 20, 20)
              // Keep real native PNG encoding long enough to test input during the API interval.
              const texture = pixels.createImageData(
                Math.floor(backdrop.width / 2),
                Math.floor(backdrop.height / 2),
              )
              let seed = 12345
              for (let i = 0; i < texture.data.length; i += 4) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
                texture.data[i] = seed % 80
                texture.data[i + 1] = 128 + ((seed >>> 8) % 120)
                texture.data[i + 2] = (seed >>> 16) % 80
                texture.data[i + 3] = 255
              }
              pixels.putImageData(texture, Math.floor(backdrop.width / 2), 0)
              parent.append(backdrop)
              ;(globalThis as Proof).regionProofClicks = []
              // This earlier page listener observes events but does not authorize or synthesize them.
              window.addEventListener(
                "click",
                (event) => {
                  if (event.isTrusted) (globalThis as Proof).regionProofClicks?.push(Date.now())
                },
                { capture: true },
              )
            },
            { modal, url: frameUrl.href, rect: rectangle },
          )
          await expect(page.frameLocator("iframe").locator("button")).toBeVisible()
          const box = await page.frameLocator("iframe").locator("button").boundingBox()
          if (!box) throw new Error("Missing frame target")
          await expect
            .poll(async () => {
              const { targetInfos } = await cdp.send("Target.getTargets")
              return targetInfos.some(
                (target) => target.type === "iframe" && target.url === frameUrl.href,
              )
            })
            .toBe(true)
          await harness.worker.evaluate(() => {
            const probe = globalThis as Proof
            probe.regionNativeCalls = 0
            const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
            const nativeGate = new Promise<void>((resolve) => {
              probe.regionReleaseNative = resolve
            })
            chrome.tabs.captureVisibleTab = (async (...args: unknown[]) => {
              probe.regionNativeCalls = (probe.regionNativeCalls ?? 0) + 1
              probe.regionNativeEntered = true
              await nativeGate
              probe.regionNativeStartedAt = Date.now()
              const source = await Reflect.apply(original, chrome.tabs, args)
              probe.regionNativeFinishedAt = Date.now()
              const bytes = Uint8Array.from(
                atob(source.slice("data:image/png;base64,".length)),
                (c) => c.charCodeAt(0),
              )
              const header = new DataView(bytes.buffer)
              // Only dimensions leave this worker probe, never the full-viewport source.
              probe.regionSourceDimensions = [header.getUint32(16), header.getUint32(20)]
              return source
            }) as typeof chrome.tabs.captureVisibleTab
            const send = chrome.tabs.sendMessage.bind(chrome.tabs)
            const cleanupGate = new Promise<void>((resolve) => {
              probe.regionReleaseCleanup = resolve
            })
            chrome.tabs.sendMessage = (async (...args: unknown[]) => {
              if (
                probe.regionHoldCleanup &&
                (args[1] as { kind?: string })?.kind === "region-capture-stop"
              ) {
                probe.regionCleanupEntered = true
                await cleanupGate
              }
              return Reflect.apply(send, chrome.tabs, args)
            }) as typeof chrome.tabs.sendMessage
          })
          await page.bringToFront()
          await expect(panel.locator("#region-capture")).toBeEnabled()
          await panel.locator("#region-capture").click()
          await expect(page.locator(HOST)).toHaveCount(1)
          await expect(page.locator(HOST)).toBeFocused()
          await expect(
            panel.locator(
              "#region-selection, #region-preview-dialog, #region-x, #region-y, #region-width, #region-height",
            ),
          ).toHaveCount(0)
          await harness.worker.evaluate(() => {
            ;(globalThis as Proof).regionHoldCleanup = true
          })
          const shield = async () => {
            expect(
              await page.locator(HOST).evaluate((host) => ({
                background: getComputedStyle(host).backgroundColor,
                pointerEvents: getComputedStyle(host).pointerEvents,
                focused: document.activeElement === host,
                covered: [0.01, 0.5, 0.99].every((x) =>
                  [0.01, 0.5, 0.99].every(
                    (y) => document.elementFromPoint(innerWidth * x, innerHeight * y) === host,
                  ),
                ),
              })),
            ).toEqual({
              background: "rgba(0, 0, 0, 0.01)",
              pointerEvents: "auto",
              focused: true,
              covered: true,
            })
          }
          const click = async () => {
            await page.mouse.click(box.x + 40, box.y + 40)
            return page.evaluate(() => (globalThis as Proof).regionProofClicks?.at(-1))
          }
          await shield()
          const beforeCapture = await click()
          await page.mouse.click(box.x + 40, box.y + 40, { button: "right" })
          await page.mouse.wheel(0, 100)
          await page.keyboard.press("Space")
          await expect(page.frameLocator("iframe").locator("body")).not.toHaveAttribute(
            "data-activated",
            "true",
          )
          expect(await harness.worker.evaluate(() => (globalThis as Proof).regionNativeCalls)).toBe(
            0,
          )
          expect(providerRequests).toBe(0)
          if (edge) {
            // A trusted keyboard selection reaches all four viewport edges without numeric inputs.
            await page.keyboard.press("ArrowLeft")
            for (let i = 0; i < 80; i++) await page.keyboard.press("Shift+ArrowRight")
            for (let i = 0; i < 55; i++) await page.keyboard.press("Shift+ArrowDown")
            await page.keyboard.press("Enter")
          } else {
            // Fractional coordinates enter through real browser input, not a runtime rectangle update.
            await page.mouse.move(rectangle.x + rectangle.width, rectangle.y + rectangle.height)
            await page.mouse.down()
            await page.mouse.move(rectangle.x, rectangle.y, { steps: 4 })
            expect(
              await harness.worker.evaluate(() => (globalThis as Proof).regionNativeCalls),
            ).toBe(0)
            await page.mouse.up()
          }
          await expect
            .poll(() => harness.worker.evaluate(() => (globalThis as Proof).regionNativeEntered))
            .toBe(true)
          await shield()
          await expect(panel.locator(IMAGES)).toHaveCount(0)
          await expect(panel.locator("#send")).toBeDisabled()
          const [frozen] = await harness.worker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            if (tab?.id === undefined) throw new Error("Missing protected tab")
            return chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: "ISOLATED",
              func: async () => {
                const isolated = globalThis as typeof globalThis & {
                  __piBrowserAgentRegionCapture?: {
                    control: (operation: "state") => Promise<{ result: RegionCaptureState }>
                  }
                }
                return (await isolated.__piBrowserAgentRegionCapture?.control("state"))?.result
              },
            })
          })
          expect(frozen?.result).toMatchObject({ active: true, frozen: true, dragging: false })
          const state = frozen?.result
          if (!state?.active || !state.rectangle || state.committedRevision === null)
            throw new Error("Missing frozen trusted selection")
          expect(state.revision).toBeGreaterThan(state.committedRevision)
          for (const key of ["x", "y", "width", "height"] as const)
            expect(state.rectangle[key]).toBeCloseTo(rectangle[key], 3)
          const heldCapture = await click()
          const clickOffset = await page.evaluate(
            () => (globalThis as Proof).regionProofClicks?.length ?? 0,
          )
          // Keep real input in flight across the native API interval, not a delayed reply gate.
          const clicksDuringNative = (async () => {
            for (let i = 0; i < 64; i++) {
              await page.mouse.click(box.x + 40, box.y + 40)
              if (
                i > 0 &&
                (await harness.worker.evaluate(
                  () => (globalThis as Proof).regionNativeFinishedAt !== undefined,
                ))
              )
                break
            }
          })()
          await harness.worker.evaluate(() => (globalThis as Proof).regionReleaseNative?.())
          await clicksDuringNative
          await expect
            .poll(() => harness.worker.evaluate(() => (globalThis as Proof).regionCleanupEntered))
            .toBe(true)
          await shield()
          const duringCleanup = await click()
          await expect(panel.locator(IMAGES)).toHaveCount(0)
          await expect(panel.locator("#send")).toBeDisabled()
          await expect(page.frameLocator("iframe").locator("body")).not.toHaveAttribute(
            "data-activated",
            "true",
          )
          const native = await harness.worker.evaluate(() => {
            const probe = globalThis as Proof
            return {
              calls: probe.regionNativeCalls,
              startedAt: probe.regionNativeStartedAt,
              finishedAt: probe.regionNativeFinishedAt,
              source: probe.regionSourceDimensions,
            }
          })
          const clickTimes = await page.evaluate(
            (offset) => (globalThis as Proof).regionProofClicks?.slice(offset) ?? [],
            clickOffset,
          )
          const duringCapture = clickTimes.find(
            (time) => time >= (native.startedAt as number) && time <= (native.finishedAt as number),
          )
          expect(
            duringCapture,
            `A trusted click must occur inside the real native capture interval: ${JSON.stringify({ native, clickTimes })}`,
          ).toBeDefined()
          expect(beforeCapture).toBeLessThanOrEqual(native.startedAt as number)
          expect(heldCapture).toBeLessThanOrEqual(native.startedAt as number)
          expect(duringCapture).toBeGreaterThanOrEqual(native.startedAt as number)
          expect(duringCapture).toBeLessThanOrEqual(native.finishedAt as number)
          expect(duringCleanup).toBeGreaterThanOrEqual(native.finishedAt as number)
          expect(native.calls).toBe(1)
          expect(native.source).toEqual([1000 * dpr, 700 * dpr])
          expect(providerRequests).toBe(0)
          await harness.worker.evaluate(() => (globalThis as Proof).regionReleaseCleanup?.())
          await expect(page.locator(HOST)).toHaveCount(0)
          await expect(panel.locator(IMAGES)).toHaveCount(1)
          await expect(panel.locator("#region-capture")).toHaveAttribute("aria-pressed", "false")
          const source = await panel.locator(IMAGES).getAttribute("src")
          expect(source).toMatch(/^data:image\/png;base64,/)
          const crop = await panel.evaluate(async (source) => {
            const image = new Image()
            image.src = source
            await image.decode()
            const canvas = document.createElement("canvas")
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            const paint = canvas.getContext("2d")
            if (!paint) throw new Error("Missing crop decoder")
            paint.drawImage(image, 0, 0)
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
                (pixels[i + 2] ?? 0) > 150 &&
                (pixels[i] ?? 0) < 100 &&
                (pixels[i + 1] ?? 0) < 180
              )
                outline++
            }
            const sample = (x: number, y: number) => [...paint.getImageData(x, y, 1, 1).data]
            return {
              width: canvas.width,
              height: canvas.height,
              outside,
              outline,
              center: sample(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)),
              inside: sample(10, 10),
            }
          }, source as string)
          expect(crop.width).toBe(
            Math.floor((rectangle.x + rectangle.width) * dpr) - Math.ceil(rectangle.x * dpr),
          )
          expect(crop.height).toBe(
            Math.floor((rectangle.y + rectangle.height) * dpr) - Math.ceil(rectangle.y * dpr),
          )
          expect(crop.outside).toBe(0)
          expect(crop.outline).toBe(0)
          expect(crop.center).toEqual([252, 0, 0, 255])
          expect(crop.inside).toEqual([0, 252, 0, 255])
          await writeFile(
            info.outputPath("crop.png"),
            Buffer.from((source as string).slice("data:image/png;base64,".length), "base64"),
          )
          // The protected target is genuinely reachable only after confirmed surface removal.
          await click()
          await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
            "data-activated",
            "true",
          )
          await panel.reload()
          await waitForConversationReady(panel)
          await page.bringToFront()
          await expect(page.locator(HOST)).toHaveCount(0)
          await expect(panel.locator(IMAGES)).toHaveCount(0)
          expect(providerRequests).toBe(0)
          console.log(
            `Region production proof: Chromium ${harness.context.browser()?.version()}; native DPR ${dpr}; CSS zoom ${modal ? "0.9 × 1.25" : "1"}; viewport edges ${edge}; source ${native.source?.join("×")}; crop ${crop.width}×${crop.height}; outside/outline=0; real OOPIF blocked before/during/cleanup; no provider request.`,
          )
          expect(harness.pageErrors).toEqual([])
          await cdp.detach()
        } finally {
          await harness.close()
        }
      })
    }
  }
}
