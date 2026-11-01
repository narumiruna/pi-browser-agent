import { expect, test } from "@playwright/test"
import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
} from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, type CodexRequest, finalTextResponse } from "./support/mock-codex.js"

const HOST = "[data-pi-browser-agent-element-picker]"
let harness: ExtensionHarness
let requests: CodexRequest[]

test.beforeEach(async () => {
  harness = await launchExtensionHarness()
  requests = []
  await harness.context.route("https://**/*", (route) => route.abort("blockedbyclient"))
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    requests.push(route.request().postDataJSON() as CodexRequest)
    expect(await harness.fixturePage.locator(HOST).count()).toBe(0)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: finalTextResponse(requests.length, "Point comments received."),
    })
  })
  await configureMockCodex(harness)
  await harness.controller.evaluate(() => {
    const state = globalThis as typeof globalThis & { pinClient?: string }
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (async (message: unknown) => {
      const request = message as { method?: string; params?: { clientId?: string } }
      if (request.method === "pointComments.start") state.pinClient = request.params?.clientId
      return send(message)
    }) as typeof chrome.runtime.sendMessage
  })
  await harness.fixturePage.evaluate(() => {
    document.body.style.cssText = "margin:0;min-height:2400px"
    const main = document.createElement("main")
    for (let number = 1; number <= 6; number++) {
      const target = document.createElement("button")
      target.id = `pin-target-${number}`
      target.textContent = `Target ${number}`
      target.style.cssText = `position:fixed;left:${number * 110}px;top:180px;width:90px;height:60px`
      target.addEventListener("click", () => {
        document.body.dataset.activated = "yes"
      })
      main.append(target)
    }
    document.body.append(main)
  })
  await harness.worker.evaluate(() => {
    chrome.tabs.captureVisibleTab = (() => {
      throw new Error("Point comments must never capture")
    }) as typeof chrome.tabs.captureVisibleTab
  })
})
test.afterEach(async () => {
  const errors = harness?.pageErrors ?? []
  await harness?.close()
  expect(errors).toEqual([])
})
async function start() {
  await harness.fixturePage.bringToFront()
  await expect(harness.controller.locator("#point-comments")).toBeEnabled()
  await harness.controller.locator("#point-comments").click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await expect(harness.controller.locator("#point-comments")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
}
async function select(number: number) {
  const box = await harness.fixturePage.locator(`#pin-target-${number}`).boundingBox()
  if (!box) throw new Error("Missing pin target")
  await harness.fixturePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}
function cards() {
  return harness.controller.locator(".point-comment-card")
}
async function complete() {
  await expect(harness.controller.locator("#transcript"))
    .toContainText("Point comments received.")
    .catch(async (error) => {
      console.log(
        "Point comment submission error:",
        await harness.controller.locator("#error").textContent(),
      )
      throw error
    })
  await expect(harness.controller.locator("#run-status")).toHaveText("Ready")
  await expect(cards()).toHaveCount(0)
  await expect(harness.controller.locator("#error")).toBeEmpty()
}

test("five numbered targets retain independent notes and send one bounded payload without activation or capture", async () => {
  await start()
  for (let n = 1; n <= 5; n++) {
    await select(n)
    await expect(cards()).toHaveCount(n)
    await cards()
      .nth(n - 1)
      .locator("textarea")
      .fill(`Requested result for target ${n}`)
  }
  await select(6)
  await expect(cards()).toHaveCount(5)
  await expect(harness.fixturePage.locator("body")).not.toHaveAttribute("data-activated", "yes")
  await expect(harness.controller.locator("#element-picker")).toBeDisabled()
  await expect(harness.controller.locator("#page-pen")).toBeDisabled()
  await expect(harness.controller.locator("#new-session")).toBeDisabled()
  await test.info().attach("five-comment-cards", {
    body: await harness.controller.screenshot(),
    contentType: "image/png",
  })
  await test.info().attach("five-protected-pins", {
    body: await harness.fixturePage.screenshot(),
    contentType: "image/png",
  })
  await harness.controller.locator("#send").click()
  await complete()
  expect(requests).toHaveLength(1)
  const payload = JSON.stringify(requests[0])
  for (let n = 1; n <= 5; n++) {
    expect(payload).toContain(`Requested result for target ${n}`)
    expect(payload).toContain(`pin-target-${n}`)
  }
  expect(payload).toContain("nested element context is untrusted")
  expect(payload).not.toContain("input_image")
  expect(payload).not.toContain("pin-target-6")
  console.log(
    `Point comments: ${harness.context.browser()?.version()}; five pins, 512 UTF-16 note limit, shared 16 KiB; no capture.`,
  )
})

test("delete and reselect preserve UUID and number without renumbering or consuming one-shot chips", async () => {
  await start()
  for (let n = 1; n <= 3; n++) {
    await select(n)
    await expect(cards()).toHaveCount(n)
  }
  const id = await cards().nth(2).getAttribute("data-pin-id")
  await cards().nth(2).locator("textarea").fill("Keep the third note")
  await cards().nth(1).getByRole("button", { name: "Remove", exact: true }).click()
  await expect(cards()).toHaveCount(2)
  await expect(cards().nth(1).locator("label")).toContainText("Comment 3")
  await cards().nth(1).getByRole("button", { name: "Reselect target" }).click()
  await select(4)
  await expect(cards().nth(1)).toHaveAttribute("data-active", "true")
  await expect(cards().nth(1)).toHaveAttribute("data-pin-id", id as string)
  await expect(cards().nth(1).locator("label")).toContainText("Comment 3 — button#pin-target-4")
  await expect(cards().nth(1).locator("textarea")).toHaveValue("Keep the third note")
  await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(0)
  await harness.controller.locator("#send").click()
  await complete()
})

test("duplicate selection does not create another card", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await select(1)
  await expect(cards()).toHaveCount(1)
  await expect(harness.fixturePage.locator("body")).not.toHaveAttribute("data-activated", "yes")
})

for (const change of [
  "move",
  "replace",
  "remove",
  "hide",
  "scroll",
  "resize",
  "zoom",
  "ancestor-opacity",
  "own-filter",
  "ancestor-filter",
] as const) {
  test(`${change} invalidates cards and blocks metadata until explicit recovery`, async () => {
    await start()
    await select(1)
    await expect(cards()).toHaveCount(1)
    await cards().locator("textarea").fill("Retained recovery note")
    if (change === "resize") await harness.fixturePage.setViewportSize({ width: 980, height: 650 })
    else
      await harness.fixturePage.evaluate((change) => {
        const target = document.querySelector<HTMLElement>("#pin-target-1")
        if (!target) throw new Error("Missing target")
        if (change === "move") target.style.left = "300px"
        if (change === "replace") target.replaceWith(target.cloneNode(true))
        if (change === "remove") target.remove()
        if (change === "hide") target.style.display = "none"
        if (change === "scroll") window.scrollTo(0, 300)
        if (change === "zoom") document.documentElement.style.zoom = "0.9"
        const ancestor = target.parentElement
        if (change === "ancestor-opacity" && ancestor) ancestor.style.opacity = "0"
        if (change === "own-filter") target.style.filter = "opacity(0)"
        if (change === "ancestor-filter" && ancestor) ancestor.style.filter = "opacity(0)"
      }, change)
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(cards()).toHaveAttribute("data-active", "false")
    await expect(harness.controller.locator("#send")).toBeDisabled()
    await cards().getByRole("button", { name: "Use note only" }).click()
    await expect(harness.controller.locator("#prompt")).toHaveValue("Retained recovery note")
    await harness.controller.locator("#send").click()
    await complete()
    expect(JSON.stringify(requests[0])).not.toContain("pin-target-1")
  })
}

test("cancel retains notes; explicit reselect keeps the stable card ID", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  const id = await cards().getAttribute("data-pin-id")
  await cards().locator("textarea").fill("Do not discard this note")
  await harness.controller.keyboard.press("Escape")
  await expect(cards()).toHaveAttribute("data-active", "false")
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await cards().getByRole("button", { name: "Reselect target" }).click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await select(2)
  await expect(cards()).toHaveAttribute("data-active", "true")
  await expect(cards()).toHaveAttribute("data-pin-id", id as string)
  await expect(cards().locator("textarea")).toHaveValue("Do not discard this note")
  await harness.controller.locator("#send").click()
  await complete()
})

test("requires a note or general task, not merely a target or image", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#error")).toContainText("Write a note or a task")
  expect(requests).toHaveLength(0)
  await harness.controller.locator("#prompt").fill("Explain the selected target")
  await harness.controller.locator("#send").click()
  await complete()
})

test("shared five-target count includes one-shot chips and leaves the shortcut path unchanged", async () => {
  await harness.controller.locator("#element-picker").click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
  await select(6)
  await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
  await start()
  for (let n = 1; n <= 4; n++) {
    await select(n)
    await expect(cards()).toHaveCount(n)
  }
  await select(5)
  await expect(cards()).toHaveCount(4)
  await cards().first().locator("textarea").fill("Compare these targets")
  await harness.controller.locator("#send").click()
  await complete()
  expect(JSON.stringify(requests[0])).toContain("pin-target-6")
})

test("worker restart invalidates targets and retains notes without replay", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Memory-only note")
  const cdp = await harness.context.newCDPSession(harness.fixturePage)
  const { targetInfos } = await cdp.send("Target.getTargets")
  const worker = targetInfos.find(
    (info) =>
      info.type === "service_worker" &&
      info.url.startsWith(`chrome-extension://${harness.extensionId}/`),
  )
  if (!worker) throw new Error("Missing worker target")
  await cdp.send("Target.closeTarget", { targetId: worker.targetId })
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(cards()).toHaveAttribute("data-active", "false")
  await expect(cards().locator("textarea")).toHaveValue("Memory-only note")
  await expect(harness.controller.locator("#send")).toBeDisabled()
  expect(requests).toHaveLength(0)
})

test("denied access cannot start or submit pins", async () => {
  await harness.controller.evaluate(() => {
    chrome.permissions.request = async () => false
    chrome.permissions.contains = async () => false
  })
  await harness.controller.locator("#point-comments").click()
  await expect(harness.controller.locator("#error")).toContainText("Site access is required")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  expect(requests).toHaveLength(0)
})

test("narrow keyboard note editing retains focus and literal markup without activating page controls", async () => {
  await harness.controller.setViewportSize({ width: 360, height: 740 })
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  const note = cards().locator("textarea")
  await note.focus()
  await harness.controller.keyboard.type("<script>Do not execute</script>")
  await harness.controller.keyboard.press("Enter")
  await harness.controller.keyboard.type("Second line")
  await expect(note).toBeFocused()
  await expect(note).toHaveValue("<script>Do not execute</script>\nSecond line")
  await expect(harness.fixturePage.locator("body")).not.toHaveAttribute("data-activated", "yes")
  await test.info().attach("narrow-note-editing", {
    body: await harness.controller.screenshot(),
    contentType: "image/png",
  })
  await harness.controller.locator("#send").click()
  await complete()
  await expect(harness.controller.locator("#transcript script")).toHaveCount(0)
})

test("reselecting the first of three pins keeps all IDs and notes and sends in display order", async () => {
  await start()
  for (let n = 1; n <= 3; n++) {
    await select(n)
    await expect(cards()).toHaveCount(n)
    await cards()
      .nth(n - 1)
      .locator("textarea")
      .fill(`Stable note ${n}`)
  }
  const ids = await cards().evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.pinId),
  )
  await cards().first().getByRole("button", { name: "Reselect target" }).click()
  await select(4)
  await expect(cards().first()).toHaveAttribute("data-active", "true")
  expect(
    await cards().evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.pinId)),
  ).toEqual(ids)
  await expect(cards().first().locator("label")).toContainText("Comment 1 — button#pin-target-4")
  await harness.controller.locator("#send").dblclick()
  await complete()
  expect(requests).toHaveLength(1)
  for (let n = 1; n <= 3; n++) expect(JSON.stringify(requests[0])).toContain(`Stable note ${n}`)
  expect(JSON.stringify(requests[0])).not.toContain("pin-target-1")
})

test("fixed clear control uses the real JSON scripting boundary and cannot send old cards", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Retained after clear")
  const cleared = await harness.controller.evaluate(async () => {
    const clientId = (globalThis as typeof globalThis & { pinClient?: string }).pinClient
    return chrome.runtime.sendMessage({
      kind: "request",
      requestId: crypto.randomUUID(),
      method: "pointComments.clear",
      params: { clientId },
    })
  })
  expect(cleared).toMatchObject({ ok: true })
  await harness.controller.locator("#send").click()
  await expect(cards()).toHaveAttribute("data-active", "false")
  expect(requests).toHaveLength(0)
})

test("injection failure leaves no surface or provider request", async () => {
  await harness.worker.evaluate(() => {
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (async (
      options: chrome.scripting.ScriptInjection<unknown[], unknown> & { args?: unknown[] },
    ) => {
      if (
        options.args?.[4] &&
        typeof options.args[4] === "object" &&
        "generation" in options.args[4]
      )
        throw new Error("Fixture injection failure")
      return execute(options)
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#point-comments").click()
  await expect(harness.controller.locator("#error")).toContainText("Fixture injection failure")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  expect(requests).toHaveLength(0)
})

test("failed cleanup stays blocked across repeated failures and explicit Stop can recover", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Keep through failed cleanup")
  await harness.worker.evaluate(() => {
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    ;(globalThis as typeof globalThis & { restorePinCleanup?: () => void }).restorePinCleanup =
      () => {
        chrome.scripting.executeScript = execute
      }
    chrome.scripting.executeScript = (async (
      options: chrome.scripting.ScriptInjection<unknown[], unknown> & { args?: unknown[] },
    ) => {
      if (
        ["stop", "submit"].includes(String(options.args?.[0])) &&
        typeof options.args?.[1] === "string"
      )
        throw new Error("Fixture cleanup failure")
      return execute(options)
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#send").click()
  await expect(harness.controller.locator("#error")).toContainText("cleanup")
  await expect(harness.controller.locator("#send")).toBeDisabled()
  await harness.controller.locator("#point-comments").click()
  await expect(harness.controller.locator("#send")).toBeDisabled()
  expect(requests).toHaveLength(0)
  await harness.worker.evaluate(() =>
    (globalThis as typeof globalThis & { restorePinCleanup?: () => void }).restorePinCleanup?.(),
  )
  await harness.controller.locator("#point-comments").click()
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(cards().getByRole("button", { name: "Use note only" })).toBeVisible()
  await expect(cards().locator("textarea")).toHaveValue("Keep through failed cleanup")
})

for (const failure of ["failure", "escape"] as const) {
  test(`${failure} during runtime preparation retains inactive notes and never dispatches`, async () => {
    await start()
    await select(1)
    await expect(cards()).toHaveCount(1)
    await cards().locator("textarea").fill("Retain after preparation")
    await harness.controller.evaluate((failure) => {
      const state = globalThis as typeof globalThis & {
        pinPreparing?: boolean
        releasePinPreparation?: () => void
      }
      const get = chrome.storage.local.get.bind(chrome.storage.local)
      const gate = new Promise<void>((resolve) => {
        state.releasePinPreparation = resolve
      })
      chrome.storage.local.get = (async (keys: unknown) => {
        if (keys === "piBrowserAgentSkillsV1") {
          chrome.storage.local.get = get
          state.pinPreparing = true
          if (failure === "failure") throw new Error("Fixture pin preparation failure")
          await gate
        }
        return Reflect.apply(get, chrome.storage.local, [keys])
      }) as typeof chrome.storage.local.get
    }, failure)
    await harness.controller.locator("#send").click()
    await expect
      .poll(() =>
        harness.controller.evaluate(
          () => (globalThis as typeof globalThis & { pinPreparing?: boolean }).pinPreparing,
        ),
      )
      .toBe(true)
    if (failure === "escape") {
      await harness.controller.keyboard.press("Escape")
      await harness.controller.evaluate(() =>
        (
          globalThis as typeof globalThis & { releasePinPreparation?: () => void }
        ).releasePinPreparation?.(),
      )
    } else
      await expect(harness.controller.locator("#error")).toContainText(
        "Fixture pin preparation failure",
      )
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    await expect(cards()).toHaveAttribute("data-active", "false")
    await expect(cards().locator("textarea")).toHaveValue("Retain after preparation")
    await expect(harness.controller.locator("#send")).toBeDisabled()
    expect(requests).toHaveLength(0)
  })
}

test("tab change while submit cleanup waits cannot dispatch a late prompt", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Original document only")
  await harness.worker.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      pinCleanupEntered?: boolean
      releasePinCleanup?: () => void
    }
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    const gate = new Promise<void>((resolve) => {
      state.releasePinCleanup = resolve
    })
    chrome.scripting.executeScript = (async (
      options: chrome.scripting.ScriptInjection<unknown[], unknown> & { args?: unknown[] },
    ) => {
      if (
        ["stop", "submit"].includes(String(options.args?.[0])) &&
        typeof options.args?.[1] === "string"
      ) {
        chrome.scripting.executeScript = execute
        state.pinCleanupEntered = true
        await gate
      }
      return execute(options)
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#send").click()
  await expect
    .poll(() =>
      harness.worker.evaluate(
        () => (globalThis as typeof globalThis & { pinCleanupEntered?: boolean }).pinCleanupEntered,
      ),
    )
    .toBe(true)
  await harness.worker.evaluate(async () => {
    await chrome.tabs.create({ url: "about:blank", active: true })
  })
  await harness.worker.evaluate(() =>
    (globalThis as typeof globalThis & { releasePinCleanup?: () => void }).releasePinCleanup?.(),
  )
  await expect(cards()).toHaveAttribute("data-active", "false")
  await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
  await expect(harness.controller.locator("#send")).toBeDisabled()
  expect(requests).toHaveLength(0)
})

test("pins read only the active page while unrelated background tabs remain untouched", async () => {
  const background = await harness.worker.evaluate(
    async () => (await chrome.tabs.create({ active: false, url: "about:blank" })).id,
  )
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Read only this target")
  await harness.worker.evaluate(() => {
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    ;(globalThis as typeof globalThis & { pinScriptTabs?: number[] }).pinScriptTabs = []
    chrome.scripting.executeScript = (async (
      options: chrome.scripting.ScriptInjection<unknown[], unknown> & { args?: unknown[] },
    ) => {
      ;(globalThis as typeof globalThis & { pinScriptTabs?: number[] }).pinScriptTabs?.push(
        options.target.tabId,
      )
      return execute(options)
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#send").click()
  await complete()
  expect(
    await harness.worker.evaluate(
      () => (globalThis as typeof globalThis & { pinScriptTabs?: number[] }).pinScriptTabs,
    ),
  ).not.toContain(background)
})

for (const count of [5, 4]) {
  test(`all ${count} inactive cards can be explicitly reselected without losing slots or notes`, async () => {
    if (count === 4) {
      await harness.controller.locator("#element-picker").click()
      await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
      await select(6)
      await expect(harness.controller.locator(".selected-element-chip")).toHaveCount(1)
    }
    await start()
    for (let n = 1; n <= count; n++) {
      await select(n)
      await expect(cards()).toHaveCount(n)
      await cards()
        .nth(n - 1)
        .locator("textarea")
        .fill(`Recovered note ${n}`)
    }
    const ids = await cards().evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.pinId),
    )
    await harness.controller.keyboard.press("Escape")
    await expect(harness.fixturePage.locator(HOST)).toHaveCount(0)
    for (let n = 1; n <= count; n++) {
      await cards()
        .nth(n - 1)
        .getByRole("button", { name: "Reselect target" })
        .click()
      await expect(harness.fixturePage.locator(HOST)).toHaveCount(1)
      await select(n)
      await expect(cards().nth(n - 1)).toHaveAttribute("data-active", "true")
      await expect(
        cards()
          .nth(n - 1)
          .locator("textarea"),
      ).toHaveValue(`Recovered note ${n}`)
    }
    expect(
      await cards().evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.pinId),
      ),
    ).toEqual(ids)
    await select(count + 1)
    await expect(cards()).toHaveCount(count)
    await harness.controller.locator("#send").click()
    await complete()
    expect(requests).toHaveLength(1)
  })
}

test("a mutation immediately before final injected submit cannot send old metadata", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Retain this note after a final mutation")
  await harness.worker.evaluate(() => {
    const execute = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = (async (
      options: chrome.scripting.ScriptInjection<unknown[], unknown> & { args?: unknown[] },
    ) => {
      if (options.args?.[0] === "submit") {
        chrome.scripting.executeScript = execute
        await execute({
          target: options.target,
          world: "ISOLATED",
          func: () => {
            const target = document.querySelector("#pin-target-1")
            if (!target) throw new Error("Missing mutation target")
            target.replaceWith(target.cloneNode(true))
          },
        })
      }
      return execute(options)
    }) as typeof chrome.scripting.executeScript
  })
  await harness.controller.locator("#send").click()
  await expect(cards()).toHaveAttribute("data-active", "false")
  await expect(cards().locator("textarea")).toHaveValue("Retain this note after a final mutation")
  await expect(harness.controller.locator("#send")).toBeDisabled()
  expect(requests).toHaveLength(0)
})

test("comment controls fit narrow layouts and retain editable note focus", async () => {
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  const page = harness.controller
  for (const width of [320, 360])
    for (const size of [12, 24])
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 820 })
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
        await page.evaluate(
          (size) => document.documentElement.style.setProperty("--app-font-size", `${size}px`),
          size,
        )
        await expect(page.locator("html")).toHaveCSS("font-size", `${size}px`)
        await cards().locator("textarea").fill("Keyboard note")
        await expect(cards().locator("textarea")).toBeFocused()
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.body.scrollWidth <= innerWidth,
          ),
        ).toBe(true)
        for (const name of ["Remove", "Reselect target"]) {
          const button = cards().getByRole("button", { name, exact: true })
          await expect(button).toBeVisible()
          const box = await button.boundingBox()
          expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
        }
        await test.info().attach(`comments-${width}-${size}-${colorScheme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        })
      }
  await page.emulateMedia({ forcedColors: "active" })
  await expect(page.locator("#point-comments")).toHaveAttribute("aria-pressed", "true")
  await test
    .info()
    .attach("comments-forced-colors", { body: await page.screenshot(), contentType: "image/png" })
  await page.keyboard.press("Escape")
  await expect(cards()).toHaveAttribute("data-active", "false")
})

test("production pins protect a zoomed modal and OOPIF and exclude hidden, field and child data", async () => {
  const frameUrl = new URL("/point-protection-frame", harness.fixtureUrl)
  frameUrl.hostname = "localhost"
  await harness.context.route("**/point-protection-frame", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<button onclick=\"document.body.dataset.activated='yes'\">PRIVATE CHILD CONTENT</button>",
    }),
  )
  await harness.fixturePage.evaluate((url) => {
    document.documentElement.style.zoom = "0.9"
    document.documentElement.style.filter = "opacity(0)"
    const modal = document.createElement("dialog")
    modal.id = "pin-protection-modal"
    modal.style.cssText = "width:650px;height:350px;zoom:1.25;background:white"
    const target = document.createElement("button")
    target.id = "pin-protection-target"
    target.style.cssText = "display:block;width:240px;height:60px"
    target.innerHTML =
      'Public target<span hidden>HIDDEN PAGE CONTENT</span><input hidden type="password" value="PRIVATE FIELD VALUE">'
    target.setAttribute("href", "https://private-user:private-password@example.test/path")
    target.addEventListener("click", () => {
      modal.dataset.activated = "yes"
    })
    const frame = document.createElement("iframe")
    frame.src = url
    frame.style.cssText = "display:block;width:450px;height:180px"
    modal.append(target, frame)
    document.body.append(modal)
    modal.showModal()
  }, frameUrl.href)
  const child = harness.fixturePage.frameLocator("#pin-protection-modal iframe").locator("button")
  await expect(child).toBeVisible()
  await start()
  const targetBox = await harness.fixturePage.locator("#pin-protection-target").boundingBox()
  const frameBox = await child.boundingBox()
  if (!targetBox || !frameBox) throw new Error("Missing protected target bounds")
  await harness.fixturePage.mouse.click(targetBox.x + 15, targetBox.y + 15)
  await expect(cards()).toHaveCount(1)
  await cards().first().locator("textarea").fill("Top-layer target note")
  await harness.fixturePage.mouse.click(frameBox.x + 5, frameBox.y + 5)
  await expect(cards()).toHaveCount(2)
  await cards().nth(1).locator("textarea").fill("Frame wrapper note")
  await expect(harness.fixturePage.locator("#pin-protection-modal")).not.toHaveAttribute(
    "data-activated",
    "yes",
  )
  await expect(
    harness.fixturePage.frameLocator("#pin-protection-modal iframe").locator("body"),
  ).not.toHaveAttribute("data-activated", "yes")
  await harness.controller.locator("#send").click()
  await complete()
  const payload = JSON.stringify(requests[0])
  for (const privateText of [
    "HIDDEN PAGE CONTENT",
    "PRIVATE FIELD VALUE",
    "PRIVATE CHILD CONTENT",
    "private-user",
    "private-password",
    "<button",
  ])
    expect(payload).not.toContain(privateText)
  expect(payload).toContain("pin-protection-target")
  expect(payload).toContain("iframe")
})

test("boxless filter ancestors do not invalidate visible pins", async () => {
  await harness.fixturePage.evaluate(() => {
    const target = document.querySelector("#pin-target-1")
    const boxless = document.createElement("div")
    boxless.style.cssText = "display:contents;filter:opacity(0)"
    target?.before(boxless)
    if (target) boxless.append(target)
  })
  await start()
  await select(1)
  await expect(cards()).toHaveCount(1)
  await cards().locator("textarea").fill("Visible through a boxless ancestor")
  await expect(cards()).toHaveAttribute("data-active", "true")
  await harness.controller.locator("#send").click()
  await complete()
})
