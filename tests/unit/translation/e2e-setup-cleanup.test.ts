import { expect, test, vi } from "vitest"
import { setupTranslation } from "../../e2e/support/translation.js"

const mocks = vi.hoisted(() => ({ launch: vi.fn(), configure: vi.fn() }))
vi.mock("../../e2e/support/extension-harness.js", () => ({
  launchExtensionHarness: mocks.launch,
  configureMockCodex: mocks.configure,
}))
test.each(["credentials", "settings", "approved origins", "route"])(
  "setup failure during %s closes the acquired harness and preserves its error",
  async (stage) => {
    const original = new Error(`Failed ${stage}`)
    const fail = (current: string) => {
      if (current === stage) throw original
    }
    let evaluate = 0
    const harness = {
      close: vi.fn(async () => {
        throw new Error("Secondary cleanup failure")
      }),
      context: { route: vi.fn(async () => fail("route")) },
      controller: {
        evaluate: vi.fn(async () => {
          evaluate += 1
          fail(evaluate === 1 ? "settings" : "approved origins")
        }),
      },
    }
    mocks.launch.mockResolvedValue(harness)
    mocks.configure.mockImplementation(async () => fail("credentials"))
    await expect(setupTranslation({ hostPatterns: ["https://fixture.example/*"] })).rejects.toBe(
      original,
    )
    expect(harness.close).toHaveBeenCalledTimes(1)
  },
)
