import type {
  JsonSchemaType,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js"
import { stableJson } from "../agent/confirmation-policy.js"
import { byteLength, MCP_LIMITS } from "./policy.js"

type Schema = Record<string, unknown>
const annotations = new Set(["title", "description", "$schema", "default"])
const keywords = new Set([
  ...annotations,
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
])
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
function object(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Deliberately small, interpreted JSON Schema subset: no eval, refs, regex, or remote resolution. */
export function checkSchema(value: unknown, depth = 0): asserts value is Schema {
  if (
    !object(value) ||
    depth > MCP_LIMITS.schemaDepth ||
    byteLength(value) > MCP_LIMITS.schemaBytes ||
    Object.keys(value).some((key) => !keywords.has(key)) ||
    !types.has(String(value.type))
  ) {
    throw new Error("Unsupported MCP JSON Schema")
  }
  for (const key of annotations) {
    if (key !== "default" && key in value && typeof value[key] !== "string") {
      throw new Error("Invalid MCP schema annotation")
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]) {
    if (
      key in value &&
      (typeof value[key] !== "number" ||
        !Number.isFinite(value[key]) ||
        (key !== "minimum" &&
          key !== "maximum" &&
          (!Number.isInteger(value[key]) || value[key] < 0)))
    ) {
      throw new Error("Invalid MCP schema limit")
    }
  }
  if (
    "enum" in value &&
    (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 100)
  ) {
    throw new Error("Invalid MCP schema enum")
  }
  if ("properties" in value) {
    if (value.type !== "object" || !object(value.properties))
      throw new Error("Invalid MCP properties")
    for (const [key, child] of Object.entries(value.properties)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("Invalid MCP property")
      checkSchema(child, depth + 1)
    }
  }
  if (
    "required" in value &&
    (value.type !== "object" ||
      !Array.isArray(value.required) ||
      value.required.some(
        (key) => typeof key !== "string" || !Object.hasOwn(value.properties ?? {}, key),
      ))
  ) {
    throw new Error("Invalid MCP required properties")
  }
  if (
    "additionalProperties" in value &&
    (value.type !== "object" || typeof value.additionalProperties !== "boolean")
  ) {
    throw new Error("Unsupported MCP additional properties")
  }
  if (value.type === "array") {
    checkSchema(value.items, depth + 1)
  } else if ("items" in value) throw new Error("Invalid MCP items")
}

function matches(schema: Schema, value: unknown): boolean {
  if ("const" in schema && stableJson(value) !== stableJson(schema.const)) return false
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => stableJson(v) === stableJson(value)))
    return false
  switch (schema.type) {
    case "null":
      return value === null
    case "boolean":
      return typeof value === "boolean"
    case "string":
      return (
        typeof value === "string" &&
        [...value].length >= Number(schema.minLength ?? 0) &&
        [...value].length <= Number(schema.maxLength ?? Infinity)
      )
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isInteger(value)) &&
        value >= Number(schema.minimum ?? -Infinity) &&
        value <= Number(schema.maximum ?? Infinity)
      )
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= Number(schema.minItems ?? 0) &&
        value.length <= Number(schema.maxItems ?? Infinity) &&
        value.every((v) => matches(schema.items as Schema, v))
      )
    case "object": {
      if (!object(value)) return false
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      if ((schema.required as string[] | undefined)?.some((key) => !Object.hasOwn(value, key)))
        return false
      return Object.entries(value).every(([key, item]) =>
        Object.hasOwn(properties, key)
          ? matches(properties[key] as Schema, item)
          : schema.additionalProperties !== false,
      )
    }
    default:
      return false
  }
}

/** Also bounds arbitrary JSON depth before schemas with open object properties are evaluated. */
export function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((v) => boundedJson(v, depth + 1))
  return (
    object(value) &&
    Object.entries(value).every(
      ([key, v]) =>
        !["__proto__", "constructor", "prototype"].includes(key) && boundedJson(v, depth + 1),
    )
  )
}

export function validateArguments(schema: Schema, value: unknown): void {
  if (
    byteLength(value) > MCP_LIMITS.requestBytes ||
    !boundedJson(value) ||
    !matches(schema, value)
  ) {
    throw new Error("Invalid MCP arguments or JSON limits exceeded")
  }
}

export const mcpSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    checkSchema(schema)
    return (value: unknown) =>
      boundedJson(value) && matches(schema as Schema, value)
        ? { valid: true, data: value as T, errorMessage: undefined }
        : {
            valid: false,
            data: undefined,
            errorMessage: "MCP output does not match the supported schema",
          }
  },
}
