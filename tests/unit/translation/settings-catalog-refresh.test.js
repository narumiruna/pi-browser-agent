import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, expect, test, vi } from "vitest"
import { initializeTranslationSettings } from "../../../src/browser/sidepanel/translation-settings.js"

vi.mock("../../../src/browser/translation/provider.js", () => ({
  TranslationProvider: class {
    async scoped() {
      return { getModelEndpointPatterns: async () => ["https://radius.pi.dev/*"] }
    }
  },
}))
let dom
afterEach(() => {
  dom?.window.close()
  vi.unstubAllGlobals()
})
test("successful credential setup immediately refreshes the translation model catalog", async () => {
  dom = new JSDOM(readFileSync("src/browser/sidepanel/index.html", "utf8"))
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("Option", dom.window.Option)
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => ({
          piBrowserAgentTranslationSettingsV1: {
            version: 1,
            settings: { provider: "radius", model: "existing" },
          },
        }),
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  })
  const models = [{ id: "existing", name: "Existing", reasoning: false }]
  const configuration = {
    getProviders: () => [{ id: "radius", name: "Radius" }],
    getModels: () => [...models],
  }
  const configure = vi.fn(async () => {
    models.push({ id: "newly-discovered", name: "New catalog entry", reasoning: false })
    return true
  })
  await initializeTranslationSettings(configuration, { configure }, () => {})
  const picker = document.querySelector("#translation-model")
  expect([...picker.options].map((option) => option.value)).toEqual(["existing"])
  document.querySelector('button[aria-label="Add or update provider credential"]').click()
  await vi.waitFor(() =>
    expect([...picker.options].map((option) => option.value)).toEqual([
      "existing",
      "newly-discovered",
    ]),
  )
  expect(configure).toHaveBeenCalledWith(undefined, "radius")
})
