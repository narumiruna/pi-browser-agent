import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"
import { configureMockCodex, launchExtensionHarness } from "./support/extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse, toolCallResponse } from "./support/mock-codex.js"

test("classifies Chrome, local files, PDF and restricted web origins without page access", async () => {
  const harness = await launchExtensionHarness()
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-page-types-"))
  try {
    const textPath = join(directory, "private.txt")
    const pdfPath = join(directory, "private.pdf")
    await writeFile(textPath, "private local text")
    await writeFile(pdfPath, "%PDF-1.4\n%%EOF")
    const verify = async (url: string, kind: string) => {
      const tab = await harness.context.newPage()
      await tab.goto(url, { waitUntil: "commit" }).catch(() => undefined)
      await tab.bringToFront()
      await expect
        .poll(async () =>
          harness.controller.evaluate(async () => {
            const response = (await chrome.runtime.sendMessage({
              kind: "request",
              requestId: crypto.randomUUID(),
              method: "app.getState",
              params: {},
            })) as { result: { page: { kind: string }; tabContext: unknown } }
            return response.result
          }),
        )
        .toMatchObject({ page: { kind }, tabContext: null })
      await expect(harness.controller.locator("#page-status")).toContainText(
        "cannot read or operate",
      )
      await tab.close()
    }
    await verify("chrome://settings/", "restricted")
    await verify("chrome://newtab/", "restricted")
    await harness.context.route("https://chromewebstore.google.com/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Store</title>" }),
    )
    await verify("https://chromewebstore.google.com/detail/example", "restricted")
    const initialFileAccess = await harness.controller.evaluate(() =>
      chrome.extension.isAllowedFileSchemeAccess(),
    )
    await verify(pathToFileURL(textPath).href, "file")
    await verify(pathToFileURL(pdfPath).href, "pdf")
    const networkPdf = new URL("/report.pdf", harness.fixtureUrl).href
    await harness.context.route(networkPdf, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4\n%%EOF",
      }),
    )
    await verify(networkPdf, "pdf")
    const extensions = await harness.context.newPage()
    await extensions.goto(`chrome://extensions/?id=${harness.extensionId}`)
    const fileAccess = extensions.locator("#allow-on-file-urls")
    await expect(fileAccess).toBeVisible()
    if (initialFileAccess) await expect(fileAccess).toHaveAttribute("checked", "")
    else await expect(fileAccess).not.toHaveAttribute("checked", "")
    await fileAccess.click()
    // Chrome unloads an unpacked extension when this setting changes. A restart is needed
    // to test the opposite setting; the page classifier never opts local files into page tools.
    if (initialFileAccess) await expect(fileAccess).not.toHaveAttribute("checked", "")
    else await expect(fileAccess).toHaveAttribute("checked", "")
    await harness.restart()
    await expect
      .poll(() => harness.controller.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()))
      .toBe(!initialFileAccess)
    await verify(pathToFileURL(textPath).href, "file")
    await verify(pathToFileURL(pdfPath).href, "pdf")
  } finally {
    await rm(directory, { recursive: true, force: true })
    await harness.close()
  }
})

test("keeps the context-free composer accessible at narrow width, dark theme and reduced motion", async () => {
  const harness = await launchExtensionHarness()
  try {
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    await harness.controller.setViewportSize({ width: 320, height: 720 })
    await harness.controller.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await expect(harness.controller.locator("#run-status")).toHaveText("Waiting for a web page")
    await expect(harness.controller.locator("#prompt")).toHaveAttribute(
      "placeholder",
      "Ask a question or describe a task",
    )
    await expect(harness.controller.locator("#send")).toBeEnabled()
    await expect(harness.controller.locator(".page-actions")).toHaveCount(0)
    expect(
      await harness.controller.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        animation: getComputedStyle(document.querySelector(".status-dot") ?? document.body)
          .animationName,
      })),
    ).toEqual({ overflow: false, animation: "none" })
  } finally {
    await harness.close()
  }
})

test("chats on a protected page without exposing page tools", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    await expect
      .poll(async () => {
        const state = (await harness.controller.evaluate(async () =>
          chrome.runtime.sendMessage({
            kind: "request",
            requestId: crypto.randomUUID(),
            method: "app.getState",
            params: {},
          }),
        )) as { result: { tabContext: unknown; page: { kind: string } } }
        return [state.result.page.kind, state.result.tabContext]
      })
      .toEqual(["restricted", null])
    await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
    await expect(harness.controller.locator("#element-picker")).toBeDisabled()
    await expect(harness.controller.locator("#send")).toBeEnabled()
    const requests: unknown[] = []
    let index = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index++ === 0
            ? toolCallResponse(1, "browser_read_page")
            : finalTextResponse(2, "I can still answer without reading Chrome settings."),
      })
    })
    const before = harness.context.pages().length
    await harness.controller.locator("#prompt").fill("What can you do here?")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#transcript")).toContainText(
      "I can still answer without reading Chrome settings.",
    )
    expect(harness.context.pages()).toHaveLength(before)
    expect(JSON.stringify(requests)).toContain("does not use page context")
    expect(JSON.stringify(requests)).not.toContain("chrome://settings")
    await expect(harness.controller.locator("#error")).toBeEmpty()

    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("keeps a protected-page turn isolated after its visible tab changes", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness()
  let releaseFirst: () => void = () => undefined
  try {
    await configureMockCodex(harness)
    await harness.fixturePage.bringToFront()
    await expect(harness.controller.locator("#page-status")).toContainText(
      "available with site access",
    )
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let index = 0
    const requests: unknown[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      if (index++ === 0) await gate
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index === 1
            ? toolCallResponse(21, "browser_read_page")
            : finalTextResponse(22, "No page content used."),
      })
    })
    await harness.controller.locator("#prompt").fill("Answer without this page")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#run-status")).toHaveText("Working")
    await harness.fixturePage.bringToFront()
    releaseFirst()
    await expect(harness.controller.locator("#transcript")).toContainText("No page content used.")
    expect(JSON.stringify(requests[1])).toContain("does not use page context")
    expect(JSON.stringify(requests)).not.toContain("meadow-42")
  } finally {
    releaseFirst()
    await harness.close()
  }
})

test("keeps a protected-page turn context-free when a web tab appears before a queued instruction", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness()
  let releaseFirst: () => void = () => undefined
  try {
    await configureMockCodex(harness)
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
    await harness.controller.evaluate(() => {
      const originalRequest = chrome.permissions.request.bind(chrome.permissions)
      const state = window as typeof window & {
        requestedOrigins?: Array<string[] | undefined>
        restorePermissionRequests?: () => void
      }
      state.requestedOrigins = []
      chrome.permissions.request = (async (permissions) => {
        state.requestedOrigins?.push(permissions.origins)
        return originalRequest(permissions)
      }) as typeof chrome.permissions.request
      state.restorePermissionRequests = () => {
        chrome.permissions.request = originalRequest
      }
    })
    let markFirstStarted: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const requests: unknown[] = []
    let index = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      const current = index++
      if (current === 0) {
        markFirstStarted()
        await firstResponse
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          current === 0
            ? toolCallResponse(51, "browser_read_page")
            : finalTextResponse(
                52 + current,
                current === 1 ? "First response finished." : "Queued without page context.",
              ),
      })
    })
    await harness.controller.locator("#prompt").fill("Start a protected-page chat")
    await harness.controller.locator("#send").click()
    await firstStarted
    await expect(harness.controller.locator("#run-status")).toHaveText("Working")
    await harness.fixturePage.bringToFront()
    await expect(harness.controller.locator("#page-status")).toContainText("not used")
    await expect(harness.controller.locator("#element-picker")).toBeDisabled()
    await expect(harness.controller.locator("#grant-site")).toBeDisabled()
    await harness.controller.locator("#prompt").fill("Continue without page context")
    await harness.controller.locator("#queue-instruction").click()
    releaseFirst()
    await expect(harness.controller.locator("#transcript")).toContainText(
      "Queued without page context.",
    )
    expect(JSON.stringify(requests)).toContain("does not use page context")
    expect(requests.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(requests.slice(2))).toContain("Continue without page context")
    expect(JSON.stringify(requests)).not.toContain("meadow-42")
    const requestedOrigins = await harness.controller.evaluate(
      () =>
        (window as typeof window & { requestedOrigins?: Array<string[] | undefined> })
          .requestedOrigins,
    )
    expect(JSON.stringify(requestedOrigins)).not.toContain("127.0.0.1")
    expect(harness.pageErrors).toEqual([])
  } finally {
    releaseFirst()
    await harness.controller
      .evaluate(() => {
        ;(
          window as typeof window & { restorePermissionRequests?: () => void }
        ).restorePermissionRequests?.()
      })
      .catch(() => undefined)
    await harness.close()
  }
})

test("accepts a refreshed page epoch after permission preflight without selected elements", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    await harness.fixturePage.bringToFront()
    await expect(harness.controller.locator("#page-status")).toContainText(
      "available with site access",
    )
    await harness.controller.evaluate(() => {
      const originalRequest = chrome.permissions.request.bind(chrome.permissions)
      let markEntered: () => void = () => undefined
      let release: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      chrome.permissions.request = (async (permissions) => {
        markEntered()
        await gate
        return originalRequest(permissions)
      }) as typeof chrome.permissions.request
      ;(
        window as typeof window & {
          preflightGate?: { entered: Promise<void>; release: () => void; restore: () => void }
        }
      ).preflightGate = {
        entered,
        release,
        restore: () => {
          chrome.permissions.request = originalRequest
        },
      }
    })
    const requests: unknown[] = []
    let index = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index++ === 0
            ? toolCallResponse(41, "browser_read_page")
            : finalTextResponse(42, "The refreshed web page is readable."),
      })
    })
    const getContext = () =>
      harness.controller.evaluate(async () => {
        const state = (await chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method: "app.getState",
          params: {},
        })) as { result: { tabContext: { epoch: number; url: string } | null } }
        return state.result.tabContext
      })
    await harness.controller.locator("#prompt").fill("Read the current page")
    await harness.controller.locator("#send").click()
    await harness.controller.evaluate(async () => {
      const gate = (window as typeof window & { preflightGate?: { entered: Promise<void> } })
        .preflightGate
      if (!gate) throw new Error("Missing permission preflight gate")
      await gate.entered
    })
    const beforeReload = await getContext()
    if (!beforeReload) throw new Error("Missing preflight tab context")
    await harness.fixturePage.reload()
    await harness.fixturePage.bringToFront()
    await expect.poll(async () => (await getContext())?.epoch).toBeGreaterThan(beforeReload.epoch)
    expect((await getContext())?.url).toBe(beforeReload.url)
    await harness.controller.evaluate(() => {
      ;(
        window as typeof window & { preflightGate?: { release: () => void } }
      ).preflightGate?.release()
    })
    await expect(harness.controller.locator("#transcript")).toContainText(
      "The refreshed web page is readable.",
    )
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain("meadow-42")
    await expect(harness.controller.locator("#error")).toBeEmpty()
  } finally {
    await harness.controller
      .evaluate(() => {
        const gate = (
          window as typeof window & {
            preflightGate?: { release: () => void; restore: () => void }
          }
        ).preflightGate
        gate?.release()
        gate?.restore()
      })
      .catch(() => undefined)
    await harness.close()
  }
})

test("confirms a bookmark read on a protected page without a page permission", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness({ bookmarks: true })
  try {
    await configureMockCodex(harness)
    const bookmarkId = await harness.controller.evaluate(
      async () =>
        (
          await chrome.bookmarks.create({
            title: "No-page bookmark needle",
            url: "https://docs.example.test/",
          })
        ).id,
    )
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
    const requests: unknown[] = []
    let index = 0
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          index++ === 0
            ? toolCallResponse(11, "browser_search_bookmarks", { query: "No-page bookmark needle" })
            : finalTextResponse(12, "Bookmark found without reading this page."),
      })
    })
    await harness.controller.locator("#prompt").fill("Find my no-page bookmark")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
    await harness.controller.locator("#confirm-action").click()
    await expect(harness.controller.locator("#transcript")).toContainText(
      "Bookmark found without reading this page.",
    )
    expect(JSON.stringify(requests[1])).toContain("No-page bookmark needle")
    expect(JSON.stringify(requests)).not.toContain("chrome://settings")
    await harness.controller.evaluate(async (id) => chrome.bookmarks.remove(id), bookmarkId)
  } finally {
    await harness.close()
  }
})

test("lets the agent choose a tab only after user confirmation", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    const tabId = await harness.controller.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      harness.fixtureUrl,
    )
    if (tabId === undefined) throw new Error("Fixture tab missing")
    let index = 0
    const requests: unknown[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      const response = [
        toolCallResponse(1, "browser_list_tabs"),
        toolCallResponse(2, "browser_switch_tab", { id: tabId }),
        toolCallResponse(3, "browser_read_page"),
        finalTextResponse(4, "Found the page."),
      ][index++]
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: response })
    })
    await harness.controller.locator("#prompt").fill("Read the existing web tab")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
    await expect(harness.controller.locator("#confirm-message")).toContainText("Use the tab")
    await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")
    await harness.controller.locator("#confirm-action").click()
    await expect(harness.controller.locator("#transcript")).toContainText("Found the page.")
    expect(JSON.stringify(requests[3])).toContain("meadow-42")
    await expect(harness.controller.locator("#page-status")).toContainText(
      "available with site access",
    )
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("opens a website only after the agent's destination is confirmed", async () => {
  const harness = await launchExtensionHarness()
  try {
    await configureMockCodex(harness)
    const protectedPage = await harness.context.newPage()
    await protectedPage.goto("chrome://settings/")
    await protectedPage.bringToFront()
    const before = harness.context.pages().length
    let index = 0
    const requests: unknown[] = []
    await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
      requests.push(route.request().postDataJSON())
      const response = [
        toolCallResponse(1, "browser_open_website", { url: harness.fixtureUrl }),
        finalTextResponse(2, "Cancelled."),
        toolCallResponse(3, "browser_open_website", { url: harness.fixtureUrl }),
        toolCallResponse(4, "browser_read_page"),
        finalTextResponse(5, "Opened and read the page."),
      ][index++]
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: response })
    })
    await harness.controller.locator("#prompt").fill("Open this website")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
    await expect(harness.controller.locator("#confirm-message")).toContainText(harness.fixtureUrl)
    await harness.controller
      .locator("#confirm-dialog")
      .getByRole("button", { name: "Cancel" })
      .click()
    await expect(harness.controller.locator("#transcript")).toContainText("Cancelled.")
    expect(harness.context.pages()).toHaveLength(before)
    await harness.controller.locator("#prompt").fill("Try opening the website again")
    await harness.controller.locator("#send").click()
    await expect(harness.controller.locator("#confirm-dialog")).toBeVisible()
    await harness.controller.locator("#confirm-action").click()
    await expect(harness.controller.locator("#transcript")).toContainText(
      "Opened and read the page.",
    )
    expect(harness.context.pages()).toHaveLength(before + 1)
    expect(JSON.stringify(requests[4])).toContain("meadow-42")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("does not mark an ordinary ungranted site as restricted when tab metadata is requested", async () => {
  const harness = await launchExtensionHarness()
  try {
    const ungrantedUrl = harness.fixtureUrl.replace("127.0.0.1", "localhost")
    const tab = await harness.context.newPage()
    await tab.goto(ungrantedUrl)
    await tab.bringToFront()
    const getState = () =>
      harness.controller.evaluate(async () => {
        const response = (await chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method: "app.getState",
          params: {},
        })) as {
          result: {
            page: { kind: string }
            tabContext: { tabId: number; url: string; epoch: number } | null
          }
        }
        return response.result
      })
    await expect.poll(async () => (await getState()).tabContext?.url).toBe(ungrantedUrl)
    const context = (await getState()).tabContext
    if (!context) throw new Error("Missing ungranted tab context")
    const response = await harness.controller.evaluate(async (tabContext) => {
      return chrome.runtime.sendMessage({
        kind: "request",
        requestId: crypto.randomUUID(),
        method: "tabs.getActive",
        params: {},
        tabContext,
      })
    }, context)
    expect(response).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } })
    expect((await getState()).page.kind).toBe("web")
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("fails closed on an extensionless PDF before capturing or picking a page", async () => {
  test.setTimeout(60_000)
  const harness = await launchExtensionHarness({ screenshots: true })
  try {
    const pdfUrl = new URL("/download?id=123", harness.fixtureUrl).href
    await harness.context.route(pdfUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4\n%%EOF",
      }),
    )
    const getState = () =>
      harness.controller.evaluate(async () => {
        const response = (await chrome.runtime.sendMessage({
          kind: "request",
          requestId: crypto.randomUUID(),
          method: "app.getState",
          params: {},
        })) as {
          result: {
            page: { kind: string }
            tabContext: { tabId: number; url: string; epoch: number } | null
          }
        }
        return response.result
      })
    const send = (
      method:
        | "tabs.getActive"
        | "tabs.navigate"
        | "page.captureVisible"
        | "page.getVisibleText"
        | "elementPicker.start",
      context: object,
    ) =>
      harness.controller.evaluate(
        async ({ method, context, destination }) =>
          chrome.runtime.sendMessage({
            kind: "request",
            requestId: crypto.randomUUID(),
            method,
            params:
              method === "elementPicker.start"
                ? { clientId: crypto.randomUUID() }
                : method === "tabs.navigate"
                  ? { url: destination }
                  : {},
            tabContext: context,
            confirmed: true,
          }),
        { method, context, destination: harness.fixtureUrl },
      ) as Promise<{ ok: boolean; error?: { code: string } }>

    const metadataTab = await harness.context.newPage()
    await metadataTab.goto(pdfUrl, { waitUntil: "commit" }).catch(() => undefined)
    await metadataTab.bringToFront()
    await expect.poll(async () => (await getState()).tabContext?.url).toBe(pdfUrl)
    const metadataContext = (await getState()).tabContext
    if (!metadataContext) throw new Error("Missing initial PDF metadata context")
    expect(await send("tabs.getActive", metadataContext)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    await expect.poll(async () => (await getState()).page.kind).toBe("restricted")

    const navigationTab = await harness.context.newPage()
    await navigationTab.goto(pdfUrl, { waitUntil: "commit" }).catch(() => undefined)
    await navigationTab.bringToFront()
    await expect.poll(async () => (await getState()).tabContext?.url).toBe(pdfUrl)
    const navigationContext = (await getState()).tabContext
    if (!navigationContext) throw new Error("Missing initial PDF navigation context")
    expect(await send("tabs.navigate", navigationContext)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    await expect(navigationTab).toHaveURL(pdfUrl)
    await expect.poll(async () => (await getState()).page.kind).toBe("restricted")

    const readTab = await harness.context.newPage()
    await readTab.goto(pdfUrl, { waitUntil: "commit" }).catch(() => undefined)
    await readTab.bringToFront()
    await expect.poll(async () => (await getState()).tabContext?.url).toBe(pdfUrl)
    const readContext = (await getState()).tabContext
    if (!readContext) throw new Error("Missing initial PDF read context")
    expect(await send("page.getVisibleText", readContext)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    await expect.poll(async () => (await getState()).page.kind).toBe("restricted")

    const screenshotTab = await harness.context.newPage()
    await screenshotTab.goto(pdfUrl, { waitUntil: "commit" }).catch(() => undefined)
    await screenshotTab.bringToFront()
    await expect.poll(async () => (await getState()).tabContext?.url).toBe(pdfUrl)
    const screenshotContext = (await getState()).tabContext
    if (!screenshotContext) throw new Error("Missing initial PDF tab context")
    expect(await send("page.captureVisible", screenshotContext)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    await expect.poll(async () => (await getState()).page.kind).toBe("restricted")
    await expect(harness.controller.locator("#page-status")).toContainText("cannot read or operate")

    const pickerTab = await harness.context.newPage()
    await pickerTab.goto(pdfUrl, { waitUntil: "commit" }).catch(() => undefined)
    await pickerTab.bringToFront()
    await expect.poll(async () => (await getState()).tabContext?.url).toBe(pdfUrl)
    const pickerContext = (await getState()).tabContext
    if (!pickerContext) throw new Error("Missing initial picker tab context")
    expect(await send("elementPicker.start", pickerContext)).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    })
    await expect.poll(async () => (await getState()).page.kind).toBe("restricted")
    await expect(harness.controller.locator("#element-picker")).toBeDisabled()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
