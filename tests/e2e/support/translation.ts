import {
  configureMockCodex,
  type ExtensionHarness,
  launchExtensionHarness,
} from "./extension-harness.js"
import { CODEX_RESPONSES_URL, finalTextResponse } from "./mock-codex.js"

export async function setupTranslation(options: { hostPatterns?: string[] } = {}) {
  const harness = await launchExtensionHarness({ contextMenuEvents: true, ...options })
  await configureMockCodex(harness)
  await harness.controller.evaluate(async () => {
    await chrome.storage.local.set({
      piBrowserAgentTranslationSettingsV1: {
        version: 1,
        settings: {
          provider: "openai-codex",
          model: "gpt-6.1-sol",
          thinkingLevel: "default",
        },
      },
    })
  })
  if (options.hostPatterns?.length)
    await harness.controller.evaluate(async (patterns) => {
      const key = "piBrowserAgentApprovedHostPermissions"
      const previous = (await chrome.storage.local.get(key))[key] as string[]
      await chrome.storage.local.set({ [key]: [...previous, ...patterns] })
    }, options.hostPatterns)
  let requests = 0
  await harness.context.route(CODEX_RESPONSES_URL, async (route) => {
    const body = route.request().postDataJSON()
    const text = body.input
      .flatMap((item: { content?: { text?: string }[] }) =>
        Array.isArray(item.content) ? item.content.map((block) => block.text ?? "") : [],
      )
      .join("\n")
    const source = JSON.parse(
      text.slice(text.lastIndexOf("Source payload:\n") + "Source payload:\n".length),
    )
    const items = source.items ?? [source]
    requests += 1
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: finalTextResponse(
        requests,
        JSON.stringify({
          translations: items.map((item: { id: string; text: string }) => ({
            id: item.id,
            translatedText: `${source.targetLanguage === "Japanese" ? "日本語" : "譯文"} ${item.text}`,
          })),
        }),
      ),
    })
  })
  return { harness, requests: () => requests }
}

export async function menu(harness: ExtensionHarness, menuItemId: string, selectionText?: string) {
  await harness.fixturePage.bringToFront()
  await harness.worker.evaluate(
    async ({ menuItemId, selectionText }) => {
      const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      const listeners = (
        globalThis as typeof globalThis & {
          __piTestMenus: Array<(info: unknown, tab: unknown) => void>
        }
      ).__piTestMenus
      for (const listener of listeners) listener({ menuItemId, frameId: 0, selectionText }, tab)
    },
    { menuItemId, selectionText },
  )
}
