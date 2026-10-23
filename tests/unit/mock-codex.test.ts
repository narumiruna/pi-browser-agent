import { describe, expect, test } from "vitest"
import { declaredToolNames } from "../e2e/support/mock-codex.js"

describe("Codex request tool declarations", () => {
  test("reads top-level declarations", () => {
    expect(
      declaredToolNames({
        instructions: "",
        tools: [{ name: "browser_read_page" }],
        input: [],
      }),
    ).toEqual(["browser_read_page"])
  })

  test("reads additional_tools declarations without top-level tools", () => {
    expect(
      declaredToolNames({
        instructions: "",
        input: [
          { type: "additional_tools", tools: [{ name: "browser_read_page" }] },
          { type: "additional_tools", tools: [{ name: "skills_load" }] },
        ],
      }),
    ).toEqual(["browser_read_page", "skills_load"])
  })

  test("reads both declaration locations and ignores other input items", () => {
    expect(
      declaredToolNames({
        instructions: "",
        tools: [{ name: "browser_read_page" }],
        input: [
          { type: "additional_tools" },
          { type: "additional_tools", tools: [{ name: "skills_load" }] },
          { role: "user", content: "browser_click", tools: [{ name: "not_a_declaration" }] },
          { type: "function_call", content: "browser_click" },
        ],
      }),
    ).toEqual(["browser_read_page", "skills_load"])
  })

  test("retains historical declarations when a developer notice removes availability", () => {
    expect(
      declaredToolNames({
        instructions: "",
        input: [
          { type: "additional_tools", tools: [{ name: "skills_load" }] },
          {
            role: "developer",
            content:
              "The following tools are no longer available. Do not call them:\n- skills_load",
          },
        ],
      }),
    ).toEqual(["skills_load"])
  })

  test("handles a missing captured request", () => {
    expect(declaredToolNames(undefined)).toEqual([])
  })
})
