import { expect, test } from "@playwright/test"
import { finalTextResponse } from "./support/mock-codex.js"
import { menu, setupTranslation } from "./support/translation.js"

test("Custom Responses uses the exact model and approved base path without replacing chat settings", async () => {
  const { harness } = await setupTranslation({ hostPatterns: ["https://custom-api.example/*"] })
  let calls = 0
  try {
    await harness.controller.evaluate(async () => {
      const key = "piBrowserAgentCredentialsV1"
      const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown>
      await chrome.storage.local.set({
        piBrowserAgentSettings: {
          modelProvider: "openai-codex",
          modelId: "gpt-6.1-sol",
          systemPrompt: "retained-chat-prompt",
        },
        [key]: {
          ...stored,
          "openai-compatible": { type: "api_key", key: "custom-fixture-private-key" },
        },
        piBrowserAgentTranslationSettingsV1: {
          version: 1,
          settings: {
            provider: "openai-compatible",
            model: "exact-custom-model",
            customBaseUrl: "https://custom-api.example/prefix/v1",
          },
        },
      })
    })
    await harness.context.route("https://custom-api.example/prefix/v1/responses", async (route) => {
      calls++
      const body = route.request().postDataJSON()
      expect(body.model).toBe("exact-custom-model")
      expect(route.request().headers().authorization).toBe("Bearer custom-fixture-private-key")
      const sourceText = body.input
        .flatMap((item: { content?: { text?: string }[] }) =>
          Array.isArray(item.content) ? item.content.map((block) => block.text ?? "") : [],
        )
        .join("\n")
      const source = JSON.parse(
        sourceText.slice(sourceText.lastIndexOf("Source payload:\n") + "Source payload:\n".length),
      )
      const items = source.items ?? [source]
      await route.fulfill({
        contentType: "text/event-stream",
        body: finalTextResponse(
          calls,
          JSON.stringify({
            translations: items.map((item: { id: string; text: string }) => ({
              id: item.id,
              translatedText: `CUSTOM ${item.text}`,
            })),
          }),
        ),
      })
    })
    await harness.fixturePage.evaluate(() => {
      document.body.innerHTML =
        "<main><article><p>This visible paragraph uses an explicitly configured custom model through the Responses protocol.</p></article></main>"
    })
    await menu(harness, "pi-translate-page")
    await expect(
      harness.fixturePage.locator('[data-ot-role="note-body"][data-state="ready"]'),
    ).toContainText("CUSTOM", { timeout: 15000 })
    expect(calls).toBe(1)
    const snapshot = await harness.controller.evaluate(async () => ({
      settings: (await chrome.storage.local.get("piBrowserAgentSettings")).piBrowserAgentSettings,
      routing: JSON.stringify(await chrome.storage.session.get(null)),
    }))
    expect(snapshot.routing).not.toContain("custom-fixture-private-key")
    expect(snapshot.settings).toEqual({
      modelProvider: "openai-codex",
      modelId: "gpt-6.1-sol",
      systemPrompt: "retained-chat-prompt",
    })
    expect(harness.pageErrors).toEqual([])
  } finally {
    await harness.close()
  }
})
