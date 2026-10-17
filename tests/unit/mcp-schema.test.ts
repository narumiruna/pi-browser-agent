import { describe, expect, test } from "vitest"
import {
  boundedJson,
  checkSchema,
  mcpSchemaValidator,
  validateArguments,
} from "../../src/browser/mcp/schema.js"
import { schema } from "../support/mcp.js"

describe("bounded interpreted MCP schemas", () => {
  test("validates objects, scalars, arrays, enums, and output without eval", () => {
    checkSchema(schema)
    expect(() => validateArguments(schema, { text: "valid" })).not.toThrow()
    for (const value of [{}, { text: 42 }, { text: "x", extra: true }, { text: "x".repeat(101) }]) {
      expect(() => validateArguments(schema, value)).toThrow()
    }
    const output = {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "integer", minimum: 1, maximum: 5, enum: [1, 3, 5] },
    }
    checkSchema(output)
    const validator = mcpSchemaValidator.getValidator(output)
    expect(validator([1, 3]).valid).toBe(true)
    for (const value of [[], [1, 2], [7], [1.5], [1, 3, 5, 1]])
      expect(validator(value).valid).toBe(false)
    expect(mcpSchemaValidator.getValidator({ type: "boolean", const: true })(false).valid).toBe(
      false,
    )
    expect(mcpSchemaValidator.getValidator({ type: "null" })(null).valid).toBe(true)
  })

  test.each([
    { type: "string", pattern: "(a+)+$" },
    { $ref: "https://evil.example.com/schema" },
    { type: ["string", "null"] },
    { type: "string", format: "email" },
    { type: "object", oneOf: [] },
    { type: "object", additionalProperties: { type: "string" } },
    { type: "object", required: ["absent"] },
    { type: "string", minLength: -1 },
    { type: "string", maxLength: 1.5 },
    { type: "array" },
    { type: "object", properties: JSON.parse('{"__proto__":{"type":"string"}}') },
    { type: "object", properties: { constructor: { type: "string" } } },
  ])("rejects unsupported or hostile schema %j", (value) =>
    expect(() => checkSchema(value)).toThrow(),
  )

  test("bounds schema size, schema depth, argument bytes, and JSON depth", () => {
    expect(() => checkSchema({ type: "string", description: "x".repeat(16_384) })).toThrow()
    let deep: unknown = { type: "string" }
    for (let i = 0; i < 10; i++) deep = { type: "array", items: deep }
    expect(() => checkSchema(deep)).toThrow()
    expect(() => validateArguments({ type: "object" }, { text: "x".repeat(16_384) })).toThrow()
    let value: unknown = 1
    for (let i = 0; i < 18; i++) value = [value]
    expect(boundedJson(value)).toBe(false)
    expect(boundedJson(JSON.parse('{"__proto__":"bad"}'))).toBe(false)
    expect(boundedJson({ value: Infinity })).toBe(false)
  })
})
