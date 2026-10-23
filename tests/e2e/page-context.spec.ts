import { expect, test } from "@playwright/test"
import type { RuntimeResponse } from "../../src/browser/runtime/messages.js"
import type { JsonObject, TabContext } from "../../src/browser/runtime/types.js"
import { launchExtensionHarness } from "./support/extension-harness.js"

test("keeps HTTPS form dispatch distinct from navigation and missing tabs", async () => {
  const harness = await launchExtensionHarness({ hostPatterns: ["https://context-fixture.test/*"] })
  try {
    let submissions = 0
    await harness.context.route("https://context-fixture.test/**", async (route) => {
      const submitted = new URL(route.request().url()).pathname === "/submitted"
      if (submitted) submissions++
      await route.fulfill({
        contentType: "text/html",
        body: submitted
          ? "<h1>Local submitted fixture</h1>"
          : '<h1>Local HTTPS fixture</h1><form action="/submitted"><label>Title<input id="title" name="title"></label><button id="submit">Save fixture</button></form>',
      })
    })
    await harness.controller.evaluate(async () => {
      await chrome.storage.local.set({
        piBrowserAgentApprovedHostPermissions: ["https://context-fixture.test/*"],
      })
    })
    const page = await harness.context.newPage()
    await page.goto("https://context-fixture.test/")
    await page.bringToFront()
    const send = (
      method: string,
      params: JsonObject = {},
      tabContext?: TabContext,
      confirmed?: boolean,
    ) =>
      harness.controller
        .evaluate(async (input) => {
          const request = JSON.parse(input)
          return JSON.stringify(
            await chrome.runtime.sendMessage({
              kind: "request",
              requestId: crypto.randomUUID(),
              ...request,
            }),
          )
        }, JSON.stringify({ method, params, tabContext, confirmed }))
        .then((response) => JSON.parse(response) as RuntimeResponse)
    const context = async () => {
      const response = await send("app.getState")
      if (!response.ok) throw new Error(response.error.code)
      return (response.result as { tabContext: TabContext | null }).tabContext
    }
    await expect.poll(async () => (await context())?.url).toBe("https://context-fixture.test/")
    const original = await context()
    if (!original) throw new Error("Missing fixture context")
    expect(await send("page.getVisibleText", {}, original)).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining("Local HTTPS fixture") },
    })
    expect(
      await send("page.type", { selector: "#title", text: "local-only" }, original),
    ).toMatchObject({ ok: true, result: { mutationOutcome: "dispatched" } })
    expect(await send("page.click", { selector: "#submit" }, original)).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", details: { mutationOutcome: "not_dispatched" } },
    })
    expect(submissions).toBe(0)
    const clicked = await send("page.click", { selector: "#submit" }, original, true)
    if (clicked.ok) expect(clicked.result).toMatchObject({ mutationOutcome: "dispatched" })
    else
      expect(clicked.error).toMatchObject({
        code: "ACTION_OUTCOME_UNKNOWN",
        details: { mutationOutcome: "outcome_unknown" },
      })
    await expect(page.getByRole("heading", { name: "Local submitted fixture" })).toBeVisible()
    expect(submissions).toBe(1)
    const after = await context()
    if (!after) throw new Error("Missing submitted fixture context")
    expect(await send("page.click", { selector: "#submit" }, original, true)).toMatchObject({
      ok: false,
      error: { code: "STALE_CONTEXT", details: { mutationOutcome: "not_dispatched" } },
    })
    expect(submissions).toBe(1)
    await page.close()
    expect(await send("page.getVisibleText", {}, after)).toMatchObject({
      ok: false,
      error: { code: "TAB_NOT_FOUND" },
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
