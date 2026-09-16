import { describe, expect, test } from "vitest"
import { BoundTabState } from "../../src/browser/sidepanel/tab-state.js"

describe("Side Panel bound-tab state", () => {
  test("applies tab events synchronously and ignores older refreshes", () => {
    const state = new BoundTabState()
    const staleRefresh = state.beginRefresh()

    state.applyEvent({ tabId: 1, url: "https://new.test/page", epoch: 2 })

    expect(state.url).toBe("https://new.test/page")
    expect(
      state.applyRefresh(staleRefresh, {
        tabId: 1,
        url: "https://old.test/page",
        epoch: 1,
      }),
    ).toBe(false)
    expect(state.url).toBe("https://new.test/page")
  })

  test("keeps only the newest asynchronous refresh", () => {
    const state = new BoundTabState()
    const first = state.beginRefresh()
    const second = state.beginRefresh()

    expect(state.applyRefresh(second, { url: "https://second.test" })).toBe(true)
    expect(state.applyRefresh(first, { url: "https://first.test" })).toBe(false)
    expect(state.url).toBe("https://second.test")
  })
})
