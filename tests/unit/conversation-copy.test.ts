import { describe, expect, test } from "vitest"
import { activityText } from "../../src/browser/sidepanel/conversation-copy.js"

describe("browser action activity labels", () => {
  test.each([
    [
      "browser_find_text",
      "page.findText",
      "Reading the page",
      "Read the page",
      "Could not read the page",
    ],
    [
      "browser_get_select_options",
      "page.getSelectOptions",
      "Finding page controls",
      "Found page controls",
      "Could not find page controls",
    ],
    [
      "browser_set_checked",
      "page.setChecked",
      "Selecting a page control",
      "Selected a page control",
      "Could not select the page control",
    ],
    [
      "browser_wait_for",
      "page.waitFor",
      "Waiting for a page condition",
      "Observed the page condition",
      "Page condition was not observed",
    ],
  ])("maps %s and %s to bounded English labels", (tool, method, active, complete, error) => {
    for (const name of [tool, method]) {
      expect(activityText(name, "active")).toBe(active)
      expect(activityText(name, "complete")).toBe(complete)
      expect(activityText(name, "complete", true)).toBe(error)
    }
  })
})
