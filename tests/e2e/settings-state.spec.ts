import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { expect, type Page, test } from "@playwright/test"
import {
  type ExtensionHarness,
  launchExtensionHarness as launchTemporaryHarness,
} from "./support/extension-harness.js"

const persistedLevels = ["minimal", "low", "medium", "high", "xhigh", "max"]
const openai = builtinProviders().find((provider) => provider.id === "openai")
if (!openai) throw new Error("Missing locked OpenAI catalog")
const catalog = openai.getModels()
const source = "settings-state-acceptance"

async function launchExtensionHarness(): Promise<ExtensionHarness> {
  const harness = await launchTemporaryHarness()
  await harness.context.route("https://**/*", (route) =>
    route.fulfill({ status: 500, body: "Unexpected external request" }),
  )
  return harness
}

function model(id: string) {
  const entry = catalog.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`Missing locked catalog fixture: ${id}`)
  return entry
}

async function openSettings(
  harness: ExtensionHarness,
  context?: { modelProvider: string; modelId: string; thinkingLevel: string },
): Promise<Page> {
  const page = await harness.context.newPage()
  const params = new URLSearchParams({ view: "settings", source, ...context })
  await page.goto(`${harness.controller.url()}?${params}`)
  await expect(page.locator("#settings-page")).toBeVisible()
  await expect(page.locator("#settings-auth-status")).not.toHaveText("Checking credential status…")
  return page
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click()
}

async function chooseProvider(page: Page, id: string): Promise<void> {
  const provider = builtinProviders().find((entry) => entry.id === id)
  if (!provider) throw new Error(`Missing provider fixture: ${id}`)
  await page.locator("#provider-search").fill(id)
  await page
    .locator("#provider-options")
    .getByRole("option", { name: `${provider.name} (${provider.getModels().length})`, exact: true })
    .click()
  await expect(page.locator("#provider")).toHaveValue(id)
}

async function chooseModel(page: Page, id: string): Promise<void> {
  const entry = model(id)
  await page.locator("#model-search").fill(id)
  await page
    .locator("#model-options")
    .getByRole("option", { name: entry.name === id ? id : `${entry.name} — ${id}`, exact: true })
    .click()
  await expect(page.locator("#model")).toHaveValue(id)
}

async function seedSettings(
  harness: ExtensionHarness,
  values: Record<string, unknown>,
): Promise<void> {
  await harness.controller.evaluate(async (values) => {
    await chrome.storage.local.set({
      piBrowserAgentSettings: { confirmationMode: "balanced", ...values },
    })
  }, values)
}

function readSettings(harness: ExtensionHarness) {
  return harness.controller.evaluate(async () => {
    const stored = await chrome.storage.local.get("piBrowserAgentSettings")
    return stored.piBrowserAgentSettings
  })
}

async function observeSaveEvents(harness: ExtensionHarness): Promise<void> {
  await harness.controller.evaluate(() => {
    const events: unknown[] = []
    Object.assign(window, { settingsAcceptanceEvents: events })
    chrome.runtime.onMessage.addListener((event) => {
      if (event?.kind === "event" && event.name === "settings.saved") events.push(event.payload)
    })
  })
}

function saveEvents(harness: ExtensionHarness) {
  return harness.controller.evaluate(
    () =>
      (window as typeof window & { settingsAcceptanceEvents: unknown[] }).settingsAcceptanceEvents,
  )
}

async function saveAndClose(page: Page): Promise<void> {
  const closed = page.waitForEvent("close")
  await page.locator("#save-settings").click()
  await closed
}

async function reviewSkill(page: Page): Promise<void> {
  await selectTab(page, "Skills")
  await page.locator("#skills-file-input").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "---\nname: state-review\ndescription: Harmless local acceptance review\n---\nKeep this plain-text review.",
    ),
  })
  await expect(page.locator("#skills-import-reviewed")).toBeEnabled()
}

test("pristine, edited, reverted, and mixed-scope summaries follow their draft owners", async () => {
  const harness = await launchExtensionHarness()
  try {
    const page = await openSettings(harness)
    const initial = await readSettings(harness)
    await expect(page.locator("#save-settings")).toBeDisabled()
    await expect(page.locator("#settings-save-status")).toHaveText("No unsaved general changes")
    await expect(page.locator("#settings-draft-status")).toBeEmpty()
    await selectTab(page, "Instructions")
    const baseline = await page.locator("#system-prompt").inputValue()
    await page.locator("#system-prompt").fill("General draft")
    await expect(page.locator("#save-settings")).toBeEnabled()
    await expect(page.locator("#settings-save-status")).toHaveText("Unsaved general changes")
    await page.locator("#system-prompt").fill(baseline)
    await expect(page.locator("#save-settings")).toBeDisabled()
    await expect(page.locator("#settings-save-status")).toHaveText("No unsaved general changes")
    await selectTab(page, "Tools")
    const strict = page.locator('input[name="confirmation-mode"][value="strict"]')
    await strict.check()
    await expect(page.locator("#save-settings")).toBeEnabled()
    await page.locator('input[name="confirmation-mode"][value="balanced"]').check()
    await expect(page.locator("#save-settings")).toBeDisabled()
    await selectTab(page, "MCP")
    await page.locator("#mcp-name").fill("Unsaved local server")
    await expect(page.locator("#settings-draft-status")).toHaveText("Server edits not saved")
    await expect(page.locator("#save-settings")).toBeDisabled()
    await reviewSkill(page)
    await expect(page.locator("#settings-draft-status")).toHaveText(
      "Server edits not saved · Skill review not imported",
    )
    await selectTab(page, "Instructions")
    await page.locator("#system-prompt").fill("Mixed-scope general draft")
    await expect(page.locator("#settings-save-status")).toHaveText("Unsaved general changes")
    await expect(page.locator("#settings-draft-status")).toContainText("Skill review not imported")
    await page.locator("#save-settings").click()
    await expect(page.locator("#settings-confirm-title")).toHaveText(
      "Unsaved MCP or Skills changes",
    )
    await page.locator("#settings-confirm-cancel").click()
    await expect(page.locator("#system-prompt")).toHaveValue("Mixed-scope general draft")
    await selectTab(page, "MCP")
    await expect(page.locator("#mcp-name")).toHaveValue("Unsaved local server")
    await selectTab(page, "Skills")
    await expect(page.locator("#skills-preview")).toContainText("Keep this plain-text review.")
    expect(await readSettings(harness)).toEqual(initial)
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("independent resource and approval saves are not reported as general changes", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route("https://**/*", async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 500, body: "Unexpected request" })
    })
    const page = await openSettings(harness)
    const initial = await readSettings(harness)
    await selectTab(page, "MCP")
    await page.locator("#mcp-name").fill("Saved separately")
    await page.locator("#mcp-endpoint").fill("https://settings-state.example.com/mcp")
    await page.locator("#mcp-save").click()
    await expect(page.locator("#mcp-status")).toContainText("Saved disconnected")
    await expect(
      page.locator('#mcp-servers button[data-server-id][aria-pressed="true"]'),
    ).toHaveCount(1)
    await expect(page.locator("#settings-draft-status")).toBeEmpty()
    await expect(page.locator("#save-settings")).toBeDisabled()
    await reviewSkill(page)
    await page.locator("#skills-import-reviewed").click()
    await expect(page.locator("#skills-status")).toContainText("Skill imported disabled")
    await expect(page.locator("#skills-list button[data-skill-id]")).toHaveCount(1)
    await expect(page.locator("#settings-draft-status")).toBeEmpty()
    await selectTab(page, "Tools")
    await page.locator("#clear-confirmation-approvals").click()
    await expect(page.locator("#confirmation-approvals-status")).toHaveText(
      "Remembered approvals cleared",
    )
    await expect(page.locator("#settings-save-status")).toHaveText("No unsaved general changes")
    await expect(page.locator("#save-settings")).toBeDisabled()
    expect(await readSettings(harness)).toEqual(initial)
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("thinking options match the locked SDK intersected with the six persisted non-off levels", async () => {
  const harness = await launchExtensionHarness()
  try {
    await seedSettings(harness, {
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "medium",
    })
    const page = await openSettings(harness)
    for (const id of ["gpt-5-mini", "gpt-5.1", "gpt-5.4", "o3-mini"]) {
      await chooseModel(page, id)
      const supported = getSupportedThinkingLevels(model(id)).filter((level) =>
        persistedLevels.includes(level),
      )
      expect(supported.length).toBeGreaterThan(0)
      await expect(page.locator("#thinking-level")).toBeEnabled()
      expect(
        await page
          .locator("#thinking-level option")
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
      ).toEqual(supported)
      expect(supported).not.toContain("off")
    }
    await chooseModel(page, "gpt-4o")
    expect(getSupportedThinkingLevels(model("gpt-4o"))).toEqual(["off"])
    await expect(page.locator("#thinking-level")).toBeDisabled()
    await expect(page.locator("#thinking-level option")).toHaveText("Not applicable")
    await expect(page.locator("#thinking-level-hint")).toContainText("saved preference is retained")
    await chooseProvider(page, "openai-codex")
    await expect(page.locator("#model")).not.toHaveValue("gpt-4o")
    await expect(page.locator("#thinking-level")).toBeEnabled()
    expect(await readSettings(harness)).toMatchObject({
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "medium",
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("a non-reasoning model saves with the prior thinking preference and no thinking apply intent", async () => {
  const harness = await launchExtensionHarness()
  try {
    await seedSettings(harness, {
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "high",
    })
    await observeSaveEvents(harness)
    const page = await openSettings(harness)
    await chooseModel(page, "gpt-4o")
    await expect(page.locator("#thinking-level")).toBeDisabled()
    await expect(page.locator("#thinking-level")).toHaveValue("high")
    await saveAndClose(page)
    expect(await readSettings(harness)).toMatchObject({
      modelProvider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "high",
    })
    await expect
      .poll(() => saveEvents(harness))
      .toEqual([
        {
          settingsContextId: source,
          applyModelToActiveSession: true,
          applyThinkingToActiveSession: false,
        },
      ])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("an unsupported explicit model choice has a local focused error and retains all drafts without saving", async () => {
  const harness = await launchExtensionHarness()
  try {
    await seedSettings(harness, {
      modelProvider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "max",
    })
    await observeSaveEvents(harness)
    const initial = await readSettings(harness)
    const page = await openSettings(harness)
    await chooseModel(page, "gpt-5-mini")
    await expect(page.locator("#thinking-level")).toHaveValue("")
    await selectTab(page, "Instructions")
    await page.locator("#agent-instructions").fill("Retain these validation-test instructions")
    await page.locator("#save-settings").click()
    await expect(page.locator("#thinking-level-error")).toHaveText(
      "Choose a thinking level supported by this model.",
    )
    await expect(page.locator("#thinking-level")).toHaveAttribute("aria-invalid", "true")
    await expect(page.locator("#thinking-level")).toHaveAttribute(
      "aria-describedby",
      /thinking-level-error/,
    )
    await expect(page.locator("#thinking-level")).toBeFocused()
    await expect(page.getByRole("tab", { name: "Model", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect(page.locator("#model")).toHaveValue("gpt-5-mini")
    await selectTab(page, "Instructions")
    await expect(page.locator("#agent-instructions")).toHaveValue(
      "Retain these validation-test instructions",
    )
    expect(await readSettings(harness)).toEqual(initial)
    expect(await saveEvents(harness)).toEqual([])
    await selectTab(page, "Model")
    await page.locator("#thinking-level").selectOption("high")
    await expect(page.locator("#thinking-level-error")).toBeHidden()
    await saveAndClose(page)
    expect(await readSettings(harness)).toMatchObject({
      modelId: "gpt-5-mini",
      thinkingLevel: "high",
      agentInstructions: "Retain these validation-test instructions",
    })
    await expect
      .poll(() => saveEvents(harness))
      .toEqual([
        {
          settingsContextId: source,
          applyModelToActiveSession: true,
          applyThinkingToActiveSession: true,
        },
      ])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

test("an unrelated save preserves an unsupported old preference and the opener selection stays separate from saved model", async () => {
  const harness = await launchExtensionHarness()
  try {
    await seedSettings(harness, {
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "max",
    })
    await observeSaveEvents(harness)
    // The opener supplies a different valid model and a preference unsupported by that model.
    const page = await openSettings(harness, {
      modelProvider: "openai",
      modelId: "gpt-5.1",
      thinkingLevel: "max",
    })
    await expect(page.locator("#model")).toHaveValue("gpt-5.1")
    await expect(page.locator("#thinking-level")).toHaveValue("")
    await expect(page.locator("#save-settings")).toBeDisabled()
    await selectTab(page, "Instructions")
    await page.locator("#system-prompt").fill("Unrelated general save")
    await saveAndClose(page)
    expect(await readSettings(harness)).toMatchObject({
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "max",
      systemPrompt: "Unrelated general save",
    })
    await expect
      .poll(() => saveEvents(harness))
      .toEqual([
        {
          settingsContextId: source,
          applyModelToActiveSession: false,
          applyThinkingToActiveSession: false,
        },
      ])
    const reopened = await openSettings(harness)
    await expect(reopened.locator("#model")).toHaveValue("gpt-5-mini")
    await expect(reopened.locator("#thinking-level")).toHaveValue("")
    await expect(reopened.locator("#save-settings")).toBeDisabled()
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})

for (const returnToReasoning of [false, true]) {
  test(`an explicit thinking draft survives a non-reasoning model visit; return=${returnToReasoning}`, async () => {
    const harness = await launchExtensionHarness()
    try {
      await seedSettings(harness, {
        modelProvider: "openai",
        modelId: "gpt-5-mini",
        thinkingLevel: "medium",
      })
      await observeSaveEvents(harness)
      const page = await openSettings(harness)
      await page.locator("#thinking-level").selectOption("high")
      await chooseModel(page, "gpt-4o")
      await expect(page.locator("#thinking-level")).toBeDisabled()
      if (returnToReasoning) {
        await chooseModel(page, "gpt-5-mini")
        await expect(page.locator("#thinking-level")).toHaveValue("high")
      }
      await saveAndClose(page)
      expect(await readSettings(harness)).toMatchObject({
        modelId: returnToReasoning ? "gpt-5-mini" : "gpt-4o",
        thinkingLevel: returnToReasoning ? "high" : "medium",
      })
      await expect
        .poll(() => saveEvents(harness))
        .toEqual([
          {
            settingsContextId: source,
            applyModelToActiveSession: true,
            applyThinkingToActiveSession: returnToReasoning,
          },
        ])
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

for (const changedAfterOpen of [false, true]) {
  test(`model-only save validates the persisted thinking candidate with separate opener state; changed-after-open=${changedAfterOpen}`, async () => {
    const harness = await launchExtensionHarness()
    try {
      await seedSettings(harness, {
        modelProvider: "openai",
        modelId: "gpt-5.4",
        thinkingLevel: changedAfterOpen ? "high" : "max",
      })
      await observeSaveEvents(harness)
      const page = await openSettings(harness, {
        modelProvider: "openai",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
      })
      await chooseModel(page, "gpt-5-mini")
      if (changedAfterOpen) {
        await expect(page.locator("#thinking-level")).toHaveValue("high")
        await seedSettings(harness, {
          modelProvider: "openai",
          modelId: "gpt-5.4",
          thinkingLevel: "max",
        })
      } else {
        await expect(page.locator("#thinking-level")).toHaveValue("")
      }
      const before = await readSettings(harness)
      await page.locator("#save-settings").click()
      await expect(page.locator("#thinking-level-error")).toBeVisible()
      await expect(page.locator("#thinking-level")).toBeFocused()
      await expect(page.locator("#thinking-level")).toHaveValue("")
      expect(await readSettings(harness)).toEqual(before)
      expect(await saveEvents(harness)).toEqual([])
      await page.locator("#thinking-level").selectOption("high")
      await saveAndClose(page)
      expect(await readSettings(harness)).toMatchObject({
        modelId: "gpt-5-mini",
        thinkingLevel: "high",
      })
      await expect
        .poll(() => saveEvents(harness))
        .toEqual([
          {
            settingsContextId: source,
            applyModelToActiveSession: true,
            applyThinkingToActiveSession: true,
          },
        ])
      expect(harness.pageErrors).toEqual([])
    } finally {
      await harness.close()
    }
  })
}

test("visible credential status distinguishes missing, API key, and Account without a provider probe", async () => {
  const harness = await launchExtensionHarness()
  try {
    const requests: string[] = []
    await harness.context.route("https://**/*", async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 500, body: "Unexpected credential probe" })
    })
    await seedSettings(harness, {
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "medium",
    })
    const page = await openSettings(harness)
    await expect(page.locator("#settings-auth-status")).toHaveText("OpenAI credential missing")
    await expect(page.locator("#configure-provider")).toHaveText("Add credential")
    await harness.controller.evaluate(async () => {
      await chrome.storage.local.set({
        piBrowserAgentCredentialsV1: {
          openai: { type: "api_key", key: "fake-settings-acceptance-key" },
        },
      })
    })
    await expect(page.locator("#settings-auth-status")).toHaveText(
      "OpenAI credential configured — API key",
    )
    await expect(page.locator("#configure-provider")).toHaveText("Update credential")
    await expect(page.locator("#save-settings")).toBeDisabled()
    await harness.controller.evaluate(async () => {
      const payload = btoa(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "fake-settings-account" },
        }),
      )
      await chrome.storage.local.set({
        piBrowserAgentCredentialsV1: {
          openai: { type: "api_key", key: "fake-settings-acceptance-key" },
          "openai-codex": {
            type: "oauth",
            access: `e30.${payload}.signature`,
            refresh: "fake-settings-refresh",
            expires: Date.now() + 3_600_000,
            accountId: "fake-settings-account",
          },
        },
      })
    })
    await chooseProvider(page, "openai-codex")
    await expect(page.locator("#settings-auth-status")).toContainText(
      "credential configured — Account",
    )
    const visible = await page.locator("body").textContent()
    expect(visible).not.toContain("fake-settings-acceptance-key")
    expect(visible).not.toContain("fake-settings-refresh")
    expect(requests).toEqual([])
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
