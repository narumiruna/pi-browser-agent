import { Composer, type CST, isMap, isScalar, Parser, Scalar } from "yaml"

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

const yamlLimits = { containers: 8, nodes: 256 } as const
const optionalFields = new Set(["license", "compatibility", "metadata", "allowed-tools"])

/** Inspect the iterative CST before the composer's recursive scalar resolution. */
function validateYamlTokens(tokens: CST.Token[]): void {
  const pending = tokens.map((token) => ({ token, depth: 0 }))
  let nodes = 0
  let documents = 0
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) break
    const { token, depth } = entry
    const add = (child: CST.Token, childDepth = depth) => {
      pending.push({ token: child, depth: childDepth })
    }
    switch (token.type) {
      case "document":
        documents++
        for (const child of token.start) add(child)
        for (const child of token.end ?? []) add(child)
        if (token.value) add(token.value)
        break
      case "block-map":
      case "block-seq":
      case "flow-collection": {
        nodes++
        if (depth >= yamlLimits.containers) {
          throw new SkillError("Skill frontmatter exceeds 8 container levels or 256 nodes")
        }
        if (token.type === "flow-collection") {
          add(token.start)
          for (const child of token.end) add(child)
        }
        for (const item of token.items) {
          for (const child of item.start) add(child)
          for (const child of item.sep ?? []) add(child)
          const implicitMap =
            token.type === "flow-collection" && token.start.type === "flow-seq-start" && !!item.sep
          const map =
            implicitMap ||
            token.type === "block-map" ||
            (token.type === "flow-collection" && token.start.type === "flow-map-start")
          const childDepth = depth + 1 + Number(implicitMap)
          if (implicitMap) {
            nodes++
            if (childDepth > yamlLimits.containers) {
              throw new SkillError("Skill frontmatter exceeds 8 container levels or 256 nodes")
            }
          }
          if (item.key) add(item.key, childDepth)
          else if (map) nodes++
          if (item.value) add(item.value, childDepth)
          else nodes++
        }
        break
      }
      case "block-scalar":
        nodes++
        for (const child of token.props) add(child)
        break
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        nodes++
        for (const child of token.end ?? []) add(child)
        break
      case "anchor":
      case "alias":
      case "tag":
      case "directive":
      case "directive-line":
      case "doc-start":
      case "doc-end":
        throw new SkillError(
          "Skill frontmatter must not contain tags, anchors, aliases, directives, or document markers",
        )
      case "error":
        throw new SkillError("Invalid YAML frontmatter")
    }
    if (nodes > yamlLimits.nodes) {
      throw new SkillError("Skill frontmatter exceeds 8 container levels or 256 nodes")
    }
  }
  if (documents !== 1) throw new SkillError("Skill frontmatter requires one YAML document")
}

function frontmatter(header: string): Map<string, string> {
  // Line separators are structural; all other metadata controls remain forbidden.
  if (metadataControls.test(header.replaceAll("\r\n", "\n").replaceAll("\n", ""))) {
    throw new SkillError(
      "Skill frontmatter must contain valid Unicode text without control characters",
    )
  }
  // The previous format ignored all outer scalar whitespace, including Unicode
  // spaces. Keep that behavior on required field lines, not on folded content.
  const yaml = header.replace(
    /^(name|description): +(.*)$/gm,
    (_line, key, value: string) => `${key}: ${value.trim()}`,
  )
  const tokens = [...new Parser().parse(`${yaml}\n`)]
  validateYamlTokens(tokens)
  const [document] = new Composer({
    schema: "failsafe", // Preserve number-looking, Boolean-looking, and null-looking strings.
    resolveKnownTags: false,
    customTags: [],
    merge: false,
    stringKeys: true,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
    logLevel: "silent",
  }).compose(tokens)
  if (!document || document.errors.length || document.warnings.length) {
    throw new SkillError("Invalid YAML frontmatter")
  }
  if (!isMap(document.contents)) {
    throw new SkillError("Skill frontmatter must be a mapping with string keys")
  }
  const fields = new Map<string, string>()
  for (const { key, value } of document.contents.items) {
    if (!isScalar(key) || typeof key.value !== "string") {
      throw new SkillError("Skill frontmatter must be a mapping with string keys")
    }
    const field = key.value
    if (field !== "name" && field !== "description" && !optionalFields.has(field)) {
      throw new SkillError(
        "Skill frontmatter fields must be name, description, license, compatibility, metadata, or allowed-tools",
      )
    }
    const text = (node: unknown): string => {
      if (!isScalar(node) || typeof node.value !== "string") {
        throw new SkillError(
          "Skill frontmatter values must be strings; metadata must be a string-to-string map",
        )
      }
      // Only folded descriptions lose YAML's final line break. Internal line breaks
      // and surrounding spaces still fail the existing description validation.
      const result =
        field === "description" && node.type === Scalar.BLOCK_FOLDED
          ? node.value.replace(/\n+$/, "")
          : node.value
      if (metadataControls.test(result) || invalidUnicode.test(result)) {
        throw new SkillError(
          "Skill frontmatter must contain valid Unicode text without control characters",
        )
      }
      return result
    }
    if (field === "metadata") {
      if (!isMap(value)) {
        throw new SkillError(
          "Skill frontmatter values must be strings; metadata must be a string-to-string map",
        )
      }
      for (const pair of value.items) {
        text(pair.key)
        text(pair.value)
      }
    } else {
      const result = text(value)
      if (field === "compatibility" && result.length > 500) {
        throw new SkillError("Skill compatibility must be at most 500 characters")
      }
      fields.set(field, result)
    }
  }
  return fields
}

/**
 * Parse bounded UTF-8 SKILL.md text with bundled, string-only YAML frontmatter.
 * Optional standard fields are validated for source review, not returned or stored.
 * Delimiters use LF or CRLF. Body text and its line endings remain unchanged.
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
  const fields = frontmatter(header[1] ?? "")
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
