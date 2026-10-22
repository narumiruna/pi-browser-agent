import { Value } from "typebox/value"
import { describe, expect, test, vi } from "vitest"
import { createBrowserTools } from "../../src/browser/agent/browser-tools.js"
import { parseRuntimeRequest } from "../../src/browser/runtime/messages.js"

const reference = { snapshotId: "11111111-1111-1111-1111-111111111111", ref: "e1" }
const contracts = [
  {
    name: "browser_list_elements",
    method: "page.listElements",
    valid: [
      {},
      { role: "", type: "", name: "" },
      { role: "button", type: "submit", name: "Buy", offset: 0 },
      { offset: 2000 },
    ],
    invalid: [
      { selector: "main" },
      { snapshotId: reference.snapshotId },
      { limit: 50 },
      { role: 1 },
      { type: null },
      { name: false },
    ],
    strings: [
      ["role", 64, {}],
      ["type", 64, {}],
      ["name", 256, {}],
    ],
    offset: { maximum: 2000, rest: {} },
  },
  {
    name: "browser_find_text",
    method: "page.findText",
    valid: [{ query: "a" }, { query: " " }, { query: "[a.*]", selector: "main", offset: 100_000 }],
    invalid: [
      {},
      { query: "" },
      { query: 1 },
      { query: "x", selector: "" },
      { query: "x", ...reference },
    ],
    strings: [
      ["query", 256, {}],
      ["selector", 2048, { query: "x" }],
    ],
    offset: { maximum: 100_000, rest: { query: "x" } },
  },
  {
    name: "browser_wait_for",
    method: "page.waitFor",
    valid: [
      ...["present", "absent", "visible", "hidden", "enabled", "disabled"].map((state) => ({
        selector: "#x",
        state,
      })),
      { text: "x" },
      { text: " " },
      { text: "[a.*]", selector: "main", timeoutMs: 1 },
      { selector: "#x", state: "present", timeoutMs: 10_000 },
    ],
    invalid: [
      {},
      { selector: "#x" },
      { state: "present" },
      { text: "" },
      { text: false },
      { text: "x", selector: "" },
      { selector: "", state: "present" },
      { selector: "#x", state: "present", text: "x" },
      { text: "x", state: "present" },
      { selector: "#x", state: "unknown" },
      { selector: "#x", state: ["present"] },
      { selector: "#x", state: null },
      { text: "x", offset: 0 },
      { text: "x", intervalMs: 250 },
      ...[0, -1, 10_001, 1.5, "5000", null].map((timeoutMs) => ({ text: "x", timeoutMs })),
    ],
    strings: [
      ["text", 256, {}],
      ["selector", 2048, { state: "present" }],
    ],
  },
  {
    name: "browser_set_checked",
    method: "page.setChecked",
    valid: [
      { ...reference, checked: true },
      { ...reference, checked: false },
    ],
    invalid: [
      reference,
      { checked: true },
      { selector: "#x", checked: true },
      { ...reference, selector: "#x", checked: true },
      { ...reference, checked: "true" },
      { ...reference, checked: 1 },
      { ...reference, checked: null },
      { ...reference, checked: true, offset: 0 },
    ],
    strings: [],
  },
  {
    name: "browser_get_select_options",
    method: "page.getSelectOptions",
    valid: [reference, { ...reference, offset: 0 }, { ...reference, offset: 2000 }],
    invalid: [
      {},
      { selector: "#x" },
      { ...reference, selector: "#x" },
      { ...reference, value: "private" },
      { ...reference, label: "x" },
    ],
    strings: [],
    offset: { maximum: 2000, rest: reference },
  },
] as const

const tools = createBrowserTools(vi.fn())

function check(name: string, method: string, params: object, valid: boolean): void {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  expect(Value.Check(tool.parameters, params), `${name}: ${JSON.stringify(params)}`).toBe(valid)
  const parse = () => parseRuntimeRequest({ kind: "request", requestId: "1", method, params })
  if (valid) expect(parse()).toMatchObject({ method, params })
  else expect(parse).toThrow("Malformed or unknown")
}

describe("browser action schema/parser agreement", () => {
  for (const contract of contracts) {
    test(`${contract.name} accepts valid calls and rejects unknown or conflicting fields`, () => {
      for (const params of contract.valid) {
        check(contract.name, contract.method, params, true)
        check(contract.name, contract.method, { ...params, unknown: true }, false)
      }
      for (const params of contract.invalid) check(contract.name, contract.method, params, false)
    })

    test(`${contract.name} preserves string boundaries without trimming literals`, () => {
      for (const [key, maximum, rest] of contract.strings) {
        for (const character of ["x", "😀"]) {
          for (const length of [maximum - 1, maximum])
            check(
              contract.name,
              contract.method,
              { ...rest, [key]: character.repeat(length) },
              true,
            )
          check(
            contract.name,
            contract.method,
            { ...rest, [key]: character.repeat(maximum + 1) },
            false,
          )
        }
      }
    })

    if ("offset" in contract) {
      test(`${contract.name} accepts only bounded integer offsets`, () => {
        const { rest, maximum } = contract.offset
        for (const offset of [0, 1, maximum])
          check(contract.name, contract.method, { ...rest, offset }, true)
        for (const offset of [-1, maximum + 1, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1])
          check(contract.name, contract.method, { ...rest, offset }, false)
      })
    }
  }

  test.each(["browser_set_checked", "browser_get_select_options"])(
    "%s requires a complete bounded reference",
    (name) => {
      const method = name === "browser_set_checked" ? "page.setChecked" : "page.getSelectOptions"
      const extra = name === "browser_set_checked" ? { checked: true } : {}
      for (const target of [
        { ref: "e1" },
        { snapshotId: reference.snapshotId },
        { ...reference, ref: "e0" },
        { ...reference, ref: "e12345678" },
        { ...reference, snapshotId: "x".repeat(36) },
        { ...reference, snapshotId: `${reference.snapshotId}a` },
      ])
        check(name, method, { ...target, ...extra }, false)
      check(name, method, { ...reference, ref: "e1234567", ...extra }, true)
    },
  )
})
