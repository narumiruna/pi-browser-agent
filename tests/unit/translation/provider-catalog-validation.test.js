import { afterEach, expect, test, vi } from "vitest"
import { createBrowserProviders } from "../../../src/browser/auth/provider.js"

vi.mock("../../../src/browser/permissions.js", () => ({
  hasApprovedHostPermission: async () => true,
}))
afterEach(() => vi.unstubAllGlobals())
const model = {
  id: "valid",
  name: "Valid model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 4000,
}
test.each([
  { ...model, input: undefined },
  { ...model, input: ["executable"] },
  { ...model, contextWindow: -1 },
  { ...model, cost: {} },
  { ...model, id: "" },
])("invalid Radius metadata does not replace a usable catalog: %j", async (invalid) => {
  const radius = createBrowserProviders().find((provider) => provider.id === "radius")
  const previous = {
    ...model,
    id: "previous",
    provider: "radius",
    api: "pi-messages",
    baseUrl: "https://radius.pi.dev",
  }
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ baseUrl: "https://radius.pi.dev", models: [invalid] })),
  )
  const publish = vi.fn(async ({ update }) => {
    update()
    return true
  })
  await expect(
    radius.refreshModels({
      stored: { models: [previous] },
      allowNetwork: true,
      credential: { type: "api_key", key: "fixture-radius-key" },
      signal: new AbortController().signal,
      publish,
    }),
  ).rejects.toThrow("Radius model catalog is invalid")
  expect(radius.getModels().map((item) => item.id)).toEqual(["previous"])
  expect(publish).toHaveBeenCalledTimes(1)
})
test("valid Radius metadata still refreshes the catalog", async () => {
  const radius = createBrowserProviders().find((provider) => provider.id === "radius")
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify({ baseUrl: "https://radius.pi.dev", models: [model] })),
  )
  await radius.refreshModels({
    allowNetwork: true,
    credential: { type: "api_key", key: "fixture-radius-key" },
    signal: new AbortController().signal,
    publish: async ({ update }) => {
      update()
      return true
    },
  })
  expect(radius.getModels().map((item) => item.id)).toEqual(["valid"])
})
