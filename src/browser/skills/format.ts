/** An extension-owned validation error, not a provider or browser diagnostic. */
export class SkillError extends Error {}

export const SKILL_LIMITS = Object.freeze({
  inputBytes: 65_536,
  name: 64,
  description: 512,
  installed: 20,
  storageBytes: 524_288,
  catalogBytes: 16_384,
  loadedBytes: 131_072,
})

export interface ParsedSkill {
  name: string
  description: string
  body: string
  warnings: string[]
}

const encoder = new TextEncoder()
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in untrusted metadata.
const metadataControls = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u
// biome-ignore lint/suspicious/noControlCharactersInRegex: Only tab, CR, and LF controls are supported.
const bodyControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

export function skillByteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** Metadata lengths use UTF-16 code units. Content budgets use UTF-8 bytes. */
export function validateSkillContent(
  skill: Pick<ParsedSkill, "name" | "description" | "body">,
): void {
  if (
    !skill ||
    typeof skill.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ||
    metadataControls.test(skill.name) ||
    skill.name.length > SKILL_LIMITS.name
  ) {
    throw new SkillError(
      `Skill name must be lowercase kebab-case, at most ${SKILL_LIMITS.name} characters`,
    )
  }
  if (
    typeof skill.description !== "string" ||
    !skill.description.trim() ||
    skill.description !== skill.description.trim() ||
    skill.description.length > SKILL_LIMITS.description ||
    metadataControls.test(skill.description) ||
    invalidUnicode.test(skill.description)
  ) {
    throw new SkillError(
      `Skill description must be one line of 1 to ${SKILL_LIMITS.description} characters without surrounding whitespace`,
    )
  }
  if (
    typeof skill.body !== "string" ||
    !skill.body.trim() ||
    bodyControls.test(skill.body) ||
    invalidUnicode.test(skill.body)
  ) {
    throw new SkillError("Skill body must contain valid Unicode text without control characters")
  }
  // Imported source includes frontmatter delimiters. Persisted content has no source;
  // enforce the same byte ceiling on its combined metadata and body on every read.
  if (skillByteLength(skill.name + skill.description + skill.body) > SKILL_LIMITS.inputBytes) {
    throw new SkillError(`Skill content exceeds the ${SKILL_LIMITS.inputBytes}-byte limit`)
  }
}

function scalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const result: unknown = JSON.parse(value)
      if (typeof result === "string") return result
    } catch {
      // Report the supported subset instead of exposing engine-specific JSON errors.
    }
    throw new SkillError("Invalid double-quoted frontmatter scalar; use JSON string syntax")
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) {
      throw new SkillError(
        "Invalid single-quoted frontmatter scalar; escape quotes as two single quotes",
      )
    }
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (
    !value ||
    /^[!&*|>{}[\],#%@`"']/.test(value) ||
    /^[-?:](?:\s|$)/.test(value) ||
    /:\s|:$|(?:^|\s)#/.test(value)
  ) {
    throw new SkillError("Unsupported YAML scalar; use a plain string or a quoted string")
  }
  return value
}

/**
 * Supported SKILL.md subset (no YAML dependency or evaluation):
 * - UTF-8, with an optional initial BOM; LF or CRLF delimiter lines exactly `---`.
 * - Only unindented `name: value` and `description: value`, once each; blank lines allowed.
 * - Values are plain strings (no implicit typing), JSON double-quoted strings, or
 *   YAML single-quoted strings (`''` escapes a quote). Outer scalar spaces are ignored.
 * - No comments, tabs, nested values, block scalars, tags, anchors, aliases, flow
 *   collections, unknown fields, or multiline metadata. Quote YAML punctuation.
 * - Body text and its line endings are preserved. Empty bodies and control characters
 *   other than tab, CR, and LF are rejected. Source bytes include the BOM and header.
 */
export function parseSkill(input: Uint8Array | string): ParsedSkill {
  const bytes = typeof input === "string" ? skillByteLength(input) : input.byteLength
  if (bytes > SKILL_LIMITS.inputBytes) {
    throw new SkillError(`Skill input exceeds the ${SKILL_LIMITS.inputBytes}-byte limit`)
  }
  let source: string
  if (typeof input === "string") {
    if (invalidUnicode.test(input)) throw new SkillError("Skill input must be valid UTF-8 text")
    source = input.replace(/^\uFEFF/, "")
  } else {
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(input)
    } catch {
      throw new SkillError("Skill input must be valid UTF-8 text")
    }
  }
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|(?![\s\S]))/.exec(source)
  if (header?.index !== 0) {
    throw new SkillError("Skill must start with frontmatter enclosed by --- delimiter lines")
  }
  const fields = new Map<string, string>()
  for (const rawLine of (header[1] ?? "").split(/\r?\n/)) {
    if (rawLine === "") continue
    const match = /^([^\s:]+): +(.*)$/.exec(rawLine)
    if (!match || metadataControls.test(rawLine)) {
      throw new SkillError(
        "Unsupported YAML frontmatter; use unindented name and description scalars",
      )
    }
    const key = match[1] ?? ""
    if (key !== "name" && key !== "description") {
      throw new SkillError(
        `Unknown frontmatter field: ${key}; only name and description are supported`,
      )
    }
    if (fields.has(key)) throw new SkillError(`Duplicate frontmatter field: ${key}`)
    fields.set(key, scalar((match[2] ?? "").trim()))
  }
  if (!fields.has("name") || !fields.has("description")) {
    throw new SkillError("Skill frontmatter requires name and description")
  }
  const skill: ParsedSkill = {
    name: fields.get("name") ?? "",
    description: fields.get("description") ?? "",
    body: source.slice(header[0].length),
    warnings: [
      "Only this SKILL.md text is imported. Scripts are not executed and supporting files are not imported or available.",
      "Dependency warnings use heuristics and cannot detect every script or supporting-file requirement. Review the skill before enabling it.",
    ],
  }
  validateSkillContent(skill)
  if (
    /\b(?:scripts?\/|references\/|assets\/|(?:python3?|bash|sh|node|bun|uv)\s+)|\.(?:py|sh|js|ts)\b/i.test(
      skill.body,
    )
  ) {
    skill.warnings.push(
      "This skill may require scripts, local tools, or supporting files that are not available. This heuristic warning is not a complete dependency check.",
    )
  }
  return skill
}
