import { expect, test } from "@playwright/test"
import { launchExtensionHarness } from "./support/extension-harness.js"

// Test-only serialized prototype. Run this gate before production multi-selection integration.
test("repeated protected selection survives panel note editing in a zoomed modal with OOPIF", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = harness.fixturePage
    const frameUrl = new URL("/pin-proof-frame", harness.fixtureUrl)
    frameUrl.hostname = "localhost"
    await harness.context.route("**/pin-proof-frame", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<button onclick=\"document.body.dataset.activated='yes'\">Private child content</button>",
      }),
    )
    await page.evaluate((url) => {
      document.documentElement.style.zoom = "0.9"
      const modal = document.createElement("dialog")
      modal.style.cssText = "width:650px;height:350px;zoom:1.25;background:white"
      modal.innerHTML = '<button id="pin-proof-target">Top-frame target</button>'
      modal.querySelector("button")?.addEventListener("click", () => {
        modal.dataset.activated = "yes"
      })
      const frame = document.createElement("iframe")
      frame.src = url
      frame.style.cssText = "display:block;width:450px;height:180px"
      modal.append(frame)
      document.body.append(modal)
      modal.showModal()
    }, frameUrl.href)
    await expect(page.frameLocator("iframe").locator("button")).toBeVisible()
    const setup = await harness.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id === undefined) throw new Error("Missing proof tab")
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const parent = document.querySelector("dialog:modal")
          if (!parent) throw new Error("Missing modal")
          const host = document.createElement("div")
          host.id = "pin-proof-shield"
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
            "background-color": "rgba(0,0,0,0.01)",
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
            ":host::backdrop{background:transparent!important;pointer-events:none!important}"
          shadow.append(style)
          parent.append(host)
          host.showPopover()
          host.focus({ preventScroll: true })
          let sequence = 0
          for (const name of [
            "pointerdown",
            "pointerup",
            "click",
            "keydown",
            "contextmenu",
            "dragstart",
          ]) {
            window.addEventListener(
              name,
              (event) => {
                event.preventDefault()
                event.stopImmediatePropagation()
                if (name !== "click" || !(event instanceof MouseEvent) || !event.isTrusted) return
                const target = document
                  .elementsFromPoint(event.clientX, event.clientY)
                  .find((node) => node !== host)
                if (!target) return
                const number = ++sequence
                const badge = document.createElement("span")
                badge.textContent = String(number)
                badge.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;background:#222;color:white;padding:4px;pointer-events:none`
                shadow.append(badge)
                host.dataset.selections = JSON.stringify(
                  Array.from(shadow.querySelectorAll("span"), (node) => node.textContent),
                )
                host.dataset.tags = `${host.dataset.tags ?? ""}${target.tagName.toLowerCase()},`
              },
              { capture: true, passive: false },
            )
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          )
          return [0.05, 0.5, 0.95].every((x) =>
            [0.05, 0.5, 0.95].every(
              (y) => document.elementFromPoint(innerWidth * x, innerHeight * y) === host,
            ),
          )
        },
      })
    })
    expect(setup[0]?.result).toBe(true)
    const top = await page.locator("#pin-proof-target").boundingBox()
    const frame = await page.frameLocator("iframe").locator("button").boundingBox()
    if (!top || !frame) throw new Error("Missing proof geometry")
    await page.mouse.click(top.x + 10, top.y + 10)
    await expect(page.locator("#pin-proof-shield")).toHaveAttribute("data-selections", '["1"]')
    await harness.controller.evaluate(() => {
      const note = document.createElement("textarea")
      note.id = "pin-proof-note"
      document.body.append(note)
    })
    await harness.controller.locator("#pin-proof-note").fill("Keep this note paired with target 1")
    await page.mouse.click(frame.x + 10, frame.y + 10)
    await expect(page.locator("#pin-proof-shield")).toHaveAttribute("data-selections", '["1","2"]')
    await expect(page.locator("#pin-proof-shield")).toHaveAttribute("data-tags", "button,iframe,")
    await expect(harness.controller.locator("#pin-proof-note")).toHaveValue(
      "Keep this note paired with target 1",
    )
    await expect(page.locator("dialog")).not.toHaveAttribute("data-activated", "yes")
    await expect(page.frameLocator("iframe").locator("body")).not.toHaveAttribute(
      "data-activated",
      "yes",
    )
    await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(0)
    await test
      .info()
      .attach("protected-pins", { body: await page.screenshot(), contentType: "image/png" })
    console.log(
      `Point-comments proof: ${harness.context.browser()?.version()}; serialized fixed function; zoom 0.9 × 1.25; modal/OOPIF; repeated selections; panel editing; no one-shot selection or activation.`,
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
