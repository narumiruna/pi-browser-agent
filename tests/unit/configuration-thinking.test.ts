import type { ThinkingLevelMap } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, test, vi } from "vitest"
import { BrowserConfiguration } from "../../src/browser/configuration.js"
import { isThinkingLevel, THINKING_LEVELS } from "../../src/browser/storage.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(reasoning: boolean, thinkingLevelMap?: ThinkingLevelMap) {
  const set = vi.fn()
  vi.stubGlobal("chrome", { storage: { local: { set } } })
  const configuration = new BrowserConfiguration(() => {})
  const model = {
    ...configuration.defaultModel,
    id: "thinking-fixture",
    name: "Thinking fixture",
    reasoning,
    thinkingLevelMap,
  }
  const getModels = vi.spyOn(configuration.models, "getModels").mockReturnValue([model])
  return { configuration, model, getModels, set }
}

describe("derived model thinking metadata", () => {
  test("keeps the default reasoning levels and excludes off", () => {
    const { configuration, model, getModels, set } = setup(true)
    const [summary] = configuration.getModels(model.provider)

    expect(getModels).toHaveBeenCalledWith(model.provider)
    expect(summary).toEqual({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: true,
      imageInput: model.input.includes("image"),
      thinkingLevels: ["minimal", "low", "medium", "high"],
    })
    expect(set).not.toHaveBeenCalled()
    expect(model.thinkingLevelMap).toBeUndefined()
  })

  test("exposes no persistable levels for a non-reasoning model", () => {
    const { configuration, model } = setup(false, { xhigh: "enabled", max: "enabled" })
    expect(configuration.getModels(model.provider)[0]?.thinkingLevels).toEqual([])
  })

  test("filters null mappings and includes explicitly mapped extended levels", () => {
    const map = {
      off: null,
      minimal: null,
      low: "provider-low",
      medium: null,
      high: "provider-high",
      xhigh: "provider-extra",
      max: null,
    }
    const { configuration, model } = setup(true, map)
    expect(configuration.getModels(model.provider)[0]?.thinkingLevels).toEqual([
      "low",
      "high",
      "xhigh",
    ])
    expect(model.thinkingLevelMap).toEqual(map)
  })

  test("returns an empty list when only off is supported", () => {
    const { configuration, model } = setup(true, {
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    })
    expect(configuration.getModels(model.provider)[0]?.thinkingLevels).toEqual([])
  })

  test("intersects all supported levels with the unchanged storage enum", () => {
    const { configuration, model, set } = setup(true, {
      off: "disabled",
      xhigh: "extra-high",
      max: "maximum",
    })
    const levels = configuration.getModels(model.provider)[0]?.thinkingLevels
    expect(levels).toEqual(THINKING_LEVELS)
    expect(levels?.every(isThinkingLevel)).toBe(true)
    expect(levels).not.toContain("off")
    expect(set).not.toHaveBeenCalled()
  })

  test("derives each model separately without changing catalog objects", () => {
    const { configuration, model, getModels } = setup(true)
    const nonReasoning = { ...model, id: "plain-fixture", reasoning: false }
    getModels.mockReturnValue([model, nonReasoning])
    const summaries = configuration.getModels(model.provider)
    expect(summaries.map((summary) => summary.thinkingLevels)).toEqual([
      ["minimal", "low", "medium", "high"],
      [],
    ])
    summaries[0]?.thinkingLevels.push("max")
    expect(configuration.getModels(model.provider)[0]?.thinkingLevels).not.toContain("max")
    expect(model).not.toHaveProperty("thinkingLevels")
    expect(nonReasoning).not.toHaveProperty("thinkingLevels")
  })
})
