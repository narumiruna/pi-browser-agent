import { describe, expect, test } from "vitest"
import { pageCapabilityFrom } from "../../src/browser/runtime/messages.js"
import { classifyPage } from "../../src/browser/runtime/page-capability.js"

describe("page capability classification", () => {
  test.each([
    [undefined, "none"],
    ["chrome://settings", "restricted"],
    ["chrome://newtab/", "restricted"],
    ["chrome-extension://id/panel.html", "restricted"],
    ["https://chromewebstore.google.com/detail/a", "restricted"],
    ["https://chrome.google.com/webstore/detail/a", "restricted"],
    ["https://example.test/", "web"],
    ["http://127.0.0.1/path", "web"],
    ["file:///tmp/private.txt", "file"],
    ["file:///tmp/private.pdf", "pdf"],
    ["https://example.test/report.pdf?download=0", "pdf"],
    ["garbage", "restricted"],
  ] as const)("classifies %s as %s", (url, kind) => {
    expect(classifyPage(url, "Title").kind).toBe(kind)
  })

  test("accepts only a bounded capability from the worker", () => {
    expect(pageCapabilityFrom({ kind: "file", title: "Local file" })).toEqual({
      kind: "file",
      title: "Local file",
    })
    for (const value of [
      null,
      { kind: "other", title: "secret" },
      { kind: "web", title: "x".repeat(161) },
      { kind: "file", title: "secret", url: "file:///private" },
    ]) {
      expect(pageCapabilityFrom(value)).toEqual({ kind: "none", title: "" })
    }
  })

  test("keeps raw URLs and local paths out of the display status", () => {
    expect(classifyPage("file:///private/secret.pdf", "secret.pdf")).toEqual({
      kind: "pdf",
      title: "",
    })
    expect(classifyPage("https://example.test/report.pdf", "report.pdf").title).toBe("")
    expect(classifyPage("https://example.test", "t".repeat(500)).title).toBe("t".repeat(160))
  })
})
